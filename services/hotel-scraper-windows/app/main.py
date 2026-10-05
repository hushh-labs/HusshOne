import os
import re
import sys
import time
import asyncio
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Optional, Dict, Any, List, Mapping, Tuple, Callable

from fastapi import FastAPI, Depends, Query, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, or_, and_, not_, case, cast, String
from sqlalchemy.exc import OperationalError, InterfaceError, SQLAlchemyError
from sqlalchemy.orm import Session

from app import database, cloud_proxy, chrome_scraper
from app.config import settings
from app.database import init_db, get_db, DatabaseUnavailable, db_state, schema_state
from app.models import ZipCode, Hotel, PhotoSpend
from app.worker import worker_instance
from app.chrome_auth import check_session_status, open_interactive_login
from app.zip_data import MAJOR_US_HOTEL_ZIPS, haversine_distance_km
from app.runtime_logging import configure_logging
from app.run_journal import RunJournal, RunJournalError, RunNotFoundError
from app.schema_guard import compare_schema
from app.data_quality import audit_hotels


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Test/SQLite runs intentionally stay self-contained; real local and
    # Cloud SQL processes configure persistent LocalAppData logging here.
    if settings.DB_BACKEND != "sqlite":
        configure_logging()
    cloud_proxy.start_watchdog()
    await asyncio.to_thread(init_db)
    yield
    if worker_instance.is_running:
        await worker_instance.stop()
    await chrome_scraper.close_browser()


app = FastAPI(
    title=settings.APP_NAME,
    description="Control Panel & Directory Explorer for HusshOne Hotel/Business Scraper",
    version="2.0.0",
    lifespan=lifespan,
)

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    bundle_dir = getattr(sys, "_MEIPASS")
    templates_dir = os.path.join(bundle_dir, "app", "templates")
    if not os.path.exists(templates_dir):
        templates_dir = os.path.join(bundle_dir, "templates")
    static_dir = os.path.join(bundle_dir, "app", "static")
    if not os.path.exists(static_dir):
        static_dir = os.path.join(bundle_dir, "static")
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    static_dir = os.path.join(base_dir, "static")
    templates_dir = os.path.join(base_dir, "templates")

if os.path.exists(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

templates = Jinja2Templates(directory=templates_dir)


# ==========================================
# ERRORS & CACHING
# ==========================================

def _db_unavailable(exc: Exception) -> JSONResponse:
    msg = str(exc).splitlines()[0][:200] if str(exc) else "database unavailable"
    db_state.update(connected=False, error=msg)
    return JSONResponse(status_code=503, content={"detail": f"Database unavailable: {msg}"})


async def _require_write_contract() -> None:
    """Guard every API path that can mutate the shared Cloud SQL tables."""
    try:
        await asyncio.to_thread(database.assert_write_safe)
    except database.SchemaIncompatible as exc:
        raise HTTPException(
            status_code=409,
            detail=f"Schema guard blocked writes: {str(exc).splitlines()[0][:300]}",
        ) from exc
    except DatabaseUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Database unavailable: {str(exc).splitlines()[0][:300]}",
        ) from exc


@app.exception_handler(DatabaseUnavailable)
async def _handle_db_unavailable(_: Request, exc: DatabaseUnavailable):
    return _db_unavailable(exc)


@app.exception_handler(OperationalError)
async def _handle_operational(_: Request, exc: OperationalError):
    return _db_unavailable(exc)


@app.exception_handler(InterfaceError)
async def _handle_interface(_: Request, exc: InterfaceError):
    return _db_unavailable(exc)


_cache: Dict[str, Tuple[float, Any]] = {}


def cached(key: str, ttl: float, fn: Callable[[], Any]) -> Any:
    """Tiny TTL cache so dashboard polling never turns into repeated table scans."""
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    value = fn()
    _cache[key] = (now, value)
    return value


def invalidate_cache():
    _cache.clear()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ==========================================
# READ-ONLY REVIEW HELPERS
# ==========================================

# The production ``raw`` column is JSONB while development uses SQLite JSON.
# SQLAlchemy's ``as_string`` produces a text scalar expression for both.  Keep
# all provenance reads behind these helpers so a dashboard never needs to
# know which database dialect it is talking to.
_REVIEW_DATE_FIELDS = {"first_seen", "last_seen", "scraped_at"}
_REVIEW_SCOPES = {"all", "scraper_traced", "legacy_or_untraced"}


def _review_json_text(key: str):
    """Return a portable, whitespace-normalized JSON scalar expression."""
    return func.trim(Hotel.raw[key].as_string())


def _review_scraped_via():
    return _review_json_text("scraped_via")


def _review_run_id():
    """Prefer the explicit durable run id, with compatibility for old rows."""
    return func.coalesce(
        func.nullif(_review_json_text("scrape_run_id"), ""),
        func.nullif(_review_json_text("run_id"), ""),
    )


def _scraper_traced_predicate():
    scraped_via = _review_scraped_via()
    return and_(scraped_via.is_not(None), scraped_via != "")


def _legacy_or_untraced_predicate():
    scraped_via = _review_scraped_via()
    return or_(scraped_via.is_(None), scraped_via == "")


def _review_text(value: Optional[str], *, field: str, max_length: int = 256) -> Optional[str]:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned or "\x00" in cleaned or len(cleaned) > max_length:
        raise ValueError(f"{field} must be 1-{max_length} non-NUL characters")
    return cleaned


def _review_day(value: Optional[str], *, field: str) -> Optional[date]:
    if value is None:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO YYYY-MM-DD date") from exc


def _review_date_conditions(
    *,
    date_from: Optional[str],
    date_to: Optional[str],
    date_field: str,
) -> Tuple[List[Any], Dict[str, Optional[str]]]:
    """Build inclusive UTC-calendar-date filters without using DB mutation.

    ``scraped_at`` intentionally matches the date prefix of the scraper's
    ISO-8601 raw trace.  ``first_seen`` and ``last_seen`` use timestamp
    ranges, so they remain correct for PostgreSQL timestamptz values.
    """
    normalized_field = (date_field or "last_seen").strip().lower()
    if normalized_field not in _REVIEW_DATE_FIELDS:
        allowed = ", ".join(sorted(_REVIEW_DATE_FIELDS))
        raise ValueError(f"date_field must be one of: {allowed}")

    start_day = _review_day(date_from, field="date_from")
    end_day = _review_day(date_to, field="date_to")
    if start_day and end_day and start_day > end_day:
        raise ValueError("date_from must be on or before date_to")

    conditions: List[Any] = []
    if normalized_field == "scraped_at":
        # The worker records ISO timestamps in UTC.  Prefix comparison avoids
        # a dialect-specific JSON-to-timestamp cast while retaining clear day
        # semantics for the operator.
        value = func.substr(_review_json_text("scraped_at"), 1, 10)
        if start_day:
            conditions.append(value >= start_day.isoformat())
        if end_day:
            conditions.append(value <= end_day.isoformat())
    else:
        value = getattr(Hotel, normalized_field)
        if start_day:
            start = datetime(start_day.year, start_day.month, start_day.day, tzinfo=timezone.utc)
            conditions.append(value >= start)
        if end_day:
            end_exclusive_day = end_day + timedelta(days=1)
            end = datetime(
                end_exclusive_day.year,
                end_exclusive_day.month,
                end_exclusive_day.day,
                tzinfo=timezone.utc,
            )
            conditions.append(value < end)

    return conditions, {
        "date_from": start_day.isoformat() if start_day else None,
        "date_to": end_day.isoformat() if end_day else None,
        "date_field": normalized_field,
    }


def _review_trace(raw: Any) -> Dict[str, Any]:
    """Return just the trace keys useful for review, not an opaque raw blob."""
    data: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}

    def text_value(key: str) -> Optional[str]:
        value = data.get(key)
        if not isinstance(value, str):
            return None
        value = value.strip()
        return value or None

    run_id = text_value("scrape_run_id") or text_value("run_id")
    scraped_via = text_value("scraped_via")
    return {
        "scraper_traced": bool(scraped_via),
        "scraped_via": scraped_via,
        "run_id": run_id,
        "scraped_at": text_value("scraped_at"),
        "google_cid": text_value("google_cid"),
        "source_url": text_value("source_url"),
    }


def _review_hotel_payload(hotel: Hotel, *, include_raw: bool = False) -> Dict[str, Any]:
    payload = hotel.to_dict()
    payload["trace"] = _review_trace(hotel.raw)
    payload["website_enrichment"] = (hotel.raw or {}).get("website_enrichment") if isinstance(hotel.raw, dict) else None
    if include_raw:
        # The raw record is source evidence, never credentials.  It is opt-in
        # so routine dashboard polling stays small even for verbose records.
        payload["raw"] = hotel.raw
    return payload


def _review_snapshot_differences(after: Any, current: Hotel) -> List[str]:
    """Name observable fields changed since the journal's write snapshot."""
    if not isinstance(after, Mapping):
        return []
    fields = (
        "dedup_key", "place_id", "name", "formatted_address", "zip",
        "query_zip", "state", "lat", "lng", "rating", "sources",
        "google_maps_uri",
    )
    changed: List[str] = []
    for field in fields:
        if field not in after:
            continue
        before_value = after.get(field)
        current_value = getattr(current, field)
        if isinstance(before_value, tuple):
            before_value = list(before_value)
        if isinstance(current_value, tuple):
            current_value = list(current_value)
        if before_value != current_value:
            changed.append(field)
    return changed


def _journal_hotel_id(value: Any) -> Optional[int]:
    try:
        if value is None or isinstance(value, bool):
            return None
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _reconcile_run_records(db: Session, changes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Match immutable journal evidence to the current DB without writes.

    An exact id is preferred, then a dedup key, then CID.  Ambiguous CID-only
    matches are deliberately surfaced instead of guessing which existing row
    represents the journal entry.
    """
    ids = {_journal_hotel_id(change.get("hotel_id")) for change in changes}
    ids.discard(None)
    dedup_keys = {
        str(change["dedup_key"]).strip()
        for change in changes
        if isinstance(change.get("dedup_key"), str) and change["dedup_key"].strip()
    }
    cids = {
        str(change["cid"]).strip()
        for change in changes
        if isinstance(change.get("cid"), str) and change["cid"].strip()
    }
    conditions: List[Any] = []
    if ids:
        conditions.append(Hotel.id.in_(ids))
    if dedup_keys:
        conditions.append(Hotel.dedup_key.in_(dedup_keys))
    if cids:
        conditions.append(_review_json_text("google_cid").in_(cids))

    rows: List[Hotel] = []
    if conditions:
        with db.no_autoflush:
            rows = db.query(Hotel).filter(or_(*conditions)).order_by(Hotel.id.asc()).all()
    by_id = {int(row.id): row for row in rows}
    by_dedup: Dict[str, List[Hotel]] = {}
    by_cid: Dict[str, List[Hotel]] = {}
    for row in rows:
        by_dedup.setdefault(row.dedup_key, []).append(row)
        trace = _review_trace(row.raw)
        if trace["google_cid"]:
            by_cid.setdefault(trace["google_cid"], []).append(row)

    records: List[Dict[str, Any]] = []
    present = missing = ambiguous = changed_since_snapshot = 0
    for change in changes:
        hotel_id = _journal_hotel_id(change.get("hotel_id"))
        dedup_key = change.get("dedup_key") if isinstance(change.get("dedup_key"), str) else None
        cid = change.get("cid") if isinstance(change.get("cid"), str) else None
        candidates: List[Hotel] = []
        matched_by: Optional[str] = None
        if hotel_id is not None and hotel_id in by_id:
            candidates = [by_id[hotel_id]]
            matched_by = "hotel_id"
        elif dedup_key and by_dedup.get(dedup_key):
            candidates = by_dedup[dedup_key]
            matched_by = "dedup_key"
        elif cid and by_cid.get(cid):
            candidates = by_cid[cid]
            matched_by = "google_cid"

        current: Optional[Hotel] = candidates[0] if len(candidates) == 1 else None
        if current is None:
            if candidates:
                ambiguous += 1
                match_status = "ambiguous"
            else:
                missing += 1
                match_status = "missing"
            differences: List[str] = []
        else:
            present += 1
            match_status = "present"
            differences = _review_snapshot_differences(change.get("after"), current)
            if differences:
                changed_since_snapshot += 1

        records.append({
            "change": change,
            "current_record": _review_hotel_payload(current, include_raw=True) if current else None,
            "verification": {
                "status": match_status,
                "matched_by": matched_by,
                "candidate_hotel_ids": [int(row.id) for row in candidates],
                "observable_fields_changed_since_snapshot": differences,
            },
        })

    return {
        "records": records,
        "reconciliation": {
            "records_returned": len(records),
            "current_records_present": present,
            "current_records_missing": missing,
            "ambiguous_current_matches": ambiguous,
            "records_changed_since_snapshot": changed_since_snapshot,
        },
    }


# ==========================================
# PAGE
# ==========================================

@app.get("/", response_class=HTMLResponse)
async def index_page(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "app_name": settings.APP_NAME,
            "gcp_project": settings.GCP_PROJECT,
            "cloud_sql_instance": settings.CLOUD_SQL_INSTANCE,
            "major_cities_count": len(MAJOR_US_HOTEL_ZIPS),
        },
    )


# ==========================================
# LIVE STATUS (worker + dashboard numbers)
# ==========================================

def _contains(column, value: str):
    """`sources` contains value: native array @> on PostgreSQL, JSON text match on SQLite."""
    if database.is_sqlite():
        return cast(column, String).like(f'%"{value}"%')
    return column.contains([value])


def _snapshot(db: Session) -> Dict[str, Any]:
    """Every headline number in ONE query (the DB is ~250ms away, so round trips are the cost)."""
    def load():
        def zips_with(status: str):
            return db.query(func.count(ZipCode.zip)).filter(ZipCode.places_status == status).scalar_subquery()
        row = db.query(
            db.query(func.count(Hotel.id)).scalar_subquery(),
            db.query(func.count(ZipCode.zip)).scalar_subquery(),
            zips_with("done"), zips_with("pending"), zips_with("error"),
            db.query(func.max(ZipCode.last_scraped_at)).scalar_subquery(),
        ).one()
        return {"hotels_total": row[0] or 0, "zips_total": row[1] or 0, "done": row[2] or 0,
                "pending": row[3] or 0, "error": row[4] or 0, "last_scraped": row[5]}
    return cached("snapshot", 2.5, load)


def build_status(db: Optional[Session]) -> Dict[str, Any]:
    status = worker_instance.get_status()
    try:
        if db is None:
            raise DatabaseUnavailable(db_state.get("error") or "Database not configured")
        snap = _snapshot(db)
        total, done = snap["zips_total"], snap["done"]
        status["queue"] = {
            "total_zips": total,
            "places_done": done,
            "places_error": snap["error"],
            "places_pending": snap["pending"],
            "pct_completed": round(done / total * 100, 2) if total else 0,
        }
        db_state.update(connected=True, error=None)
    except (SQLAlchemyError, DatabaseUnavailable) as e:
        db_state.update(connected=False, error=str(e).splitlines()[0][:200])
        status["queue"] = {"total_zips": 0, "places_done": 0, "places_error": 0, "places_pending": 0, "pct_completed": 0}
    status["db"] = dict(db_state)
    status["schema"] = dict(schema_state)
    return status


def build_overview(db: Optional[Session]) -> Dict[str, Any]:
    stats = worker_instance.get_status()["stats"]
    uptime = throughput = None
    if stats.get("started_at"):
        try:
            started = datetime.fromisoformat(stats["started_at"])
            uptime = max((datetime.utcnow() - started).total_seconds(), 0)
            if uptime >= 60:
                throughput = round(stats.get("hotels_added", 0) / (uptime / 3600), 1)
        except ValueError:
            pass

    hotels = {"total": 0, "places_only": 0, "osm_only": 0, "merged": 0}
    zips = {"total_loaded": 0, "completed": 0, "pending": 0, "failed": 0, "completion_percentage": 0, "failed_zips_detail": []}
    media_fetches = 0
    last_scraped = None
    try:
        if db is None:
            raise DatabaseUnavailable(db_state.get("error") or "Database not configured")
        snap = _snapshot(db)
        hotels["total"] = snap["hotels_total"]

        def breakdown():
            hp, ho = _contains(Hotel.sources, "places"), _contains(Hotel.sources, "osm")
            row = db.query(
                func.sum(case((and_(hp, ho), 1), else_=0)),
                func.sum(case((and_(hp, not_(ho)), 1), else_=0)),
                func.sum(case((and_(ho, not_(hp)), 1), else_=0)),
            ).one()
            return [int(v or 0) for v in row]
        merged, places_only, osm_only = cached("hotel_breakdown", 30, breakdown)
        hotels.update(merged=merged, places_only=places_only, osm_only=osm_only)

        total = snap["zips_total"]
        zips.update(
            total_loaded=total,
            completed=snap["done"],
            pending=snap["pending"],
            failed=snap["error"],
            completion_percentage=round(snap["done"] / total * 100, 2) if total else 0,
        )
        if snap["error"]:
            zips["failed_zips_detail"] = cached("failed_zips", 10, lambda: [
                z.to_dict() for z in db.query(ZipCode).filter(ZipCode.places_status == "error").limit(50).all()
            ])
        media_fetches = cached("media_fetches", 60, lambda: int(db.query(func.sum(PhotoSpend.media_fetches)).scalar() or 0))
        last_scraped = snap["last_scraped"]
        db_state.update(connected=True, error=None)
    except (SQLAlchemyError, DatabaseUnavailable) as e:
        db_state.update(connected=False, error=str(e).splitlines()[0][:200])

    return {
        "generated_at": datetime.utcnow().isoformat(),
        "is_postgres_connected": db_state.get("backend") == "postgresql" and db_state.get("connected", False),
        "db": dict(db_state),
        "gcp_project": settings.GCP_PROJECT,
        "cloud_sql_instance": settings.CLOUD_SQL_INSTANCE,
        "database": settings.DB_NAME,
        "hotels": hotels,
        "zips": zips,
        "api_metrics": {"photo_media_fetches": media_fetches},
        "system": {
            "db_backend": db_state.get("backend"),
            "worker_started_at": stats.get("started_at"),
            "uptime_seconds": uptime,
            "zips_processed_session": stats.get("zips_processed", 0),
            "hotels_found_session": stats.get("hotels_found", 0),
            "hotels_added_session": stats.get("hotels_added", 0),
            "errors_session": stats.get("errors_encountered", 0),
            "throughput_hotels_per_hour": throughput,
            "last_scraped_at": last_scraped.isoformat() if last_scraped else None,
        },
    }


def _live_session() -> Optional[Session]:
    try:
        return database.get_readonly_db_session()
    except (DatabaseUnavailable, SQLAlchemyError) as exc:
        db_state.update(
            connected=False,
            error=str(exc).splitlines()[0][:200] if str(exc) else "database unavailable",
        )
        return None


@app.get("/api/status")
def get_worker_status():
    db = _live_session()
    try:
        return build_status(db)
    finally:
        if db:
            db.close()


@app.get("/api/stats/overview")
def get_stats_overview():
    db = _live_session()
    try:
        return build_overview(db)
    finally:
        if db:
            db.close()


@app.get("/api/live")
def get_live():
    """One request per dashboard tick: worker status + overview."""
    db = _live_session()
    try:
        return {"status": build_status(db), "overview": build_overview(db)}
    finally:
        if db:
            db.close()


@app.get("/api/schema/compatibility")
def get_schema_compatibility():
    """Read-only Cloud SQL catalog comparison used by the startup write gate."""
    eng = database.ensure_engine()
    if eng is None:
        raise DatabaseUnavailable(database.db_state.get("error") or "Database not configured")
    if database.is_sqlite():
        return {
            "checked": False,
            "compatible": False,
            "reason": "Schema guard applies only to the production PostgreSQL backend.",
        }
    return {"checked": True, **compare_schema(eng).as_dict()}


@app.get("/api/reports/writes-today")
def get_writes_today(day: Optional[str] = Query(None, description="UTC date in YYYY-MM-DD form")):
    """Read-only local audit view of the scraper's writes and quarantines."""
    try:
        return RunJournal().daily_report(day or utcnow().date().isoformat())
    except (ValueError, RunJournalError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/reports/runs/{run_id}")
def get_run_write_report(run_id: str):
    """Return immutable before/after evidence for one scraper run."""
    try:
        return RunJournal().run_report(run_id)
    except RunNotFoundError:
        raise HTTPException(status_code=404, detail="Run not found")
    except (ValueError, RunJournalError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/audits/data-quality")
def get_data_quality_audit(
    finding_limit: int = Query(100, ge=1, le=1_000),
    shape_scan_limit: int = Query(10_000, ge=1, le=200_000),
    shape_cursor_after_id: Optional[int] = Query(None, ge=0),
    db: Session = Depends(get_db),
):
    """Run a read-only, paged audit of existing production hotel data."""
    return audit_hotels(
        db,
        finding_limit=finding_limit,
        shape_scan_limit=shape_scan_limit,
        shape_cursor_after_id=shape_cursor_after_id,
        max_zip_distance_km=settings.ZIP_MAX_DISTANCE_KM,
    ).as_dict()


# ==========================================
# DATA REVIEW (READ ONLY)
# ==========================================

@app.get("/api/review/summary")
def get_review_summary(
    date_from: Optional[str] = Query(None, description="Inclusive YYYY-MM-DD date"),
    date_to: Optional[str] = Query(None, description="Inclusive YYYY-MM-DD date"),
    date_field: str = Query(
        "last_seen",
        description="Timestamp used for the date filter: first_seen, last_seen, or scraped_at",
    ),
    db: Session = Depends(get_db),
):
    """Compare all production rows with rows carrying scraper trace evidence.

    A row is *scraper traced* only when ``raw.scraped_via`` is populated.  It
    intentionally does not treat the pre-existing ``sources=['places']`` rows
    as new scraper output, so the operator can distinguish the existing
    directory from records this pipeline can account for.
    """
    try:
        date_conditions, filters = _review_date_conditions(
            date_from=date_from,
            date_to=date_to,
            date_field=date_field,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    traced = _scraper_traced_predicate()
    run_id = _review_run_id()
    scraped_via = _review_scraped_via()
    with db.no_autoflush:
        totals = db.query(
            func.count(Hotel.id).label("all_total"),
            func.coalesce(func.sum(case((traced, 1), else_=0)), 0).label("traced_total"),
            func.coalesce(
                func.sum(case((and_(traced, run_id.is_not(None)), 1), else_=0)), 0
            ).label("traced_with_run_id"),
            func.coalesce(func.sum(case((_contains(Hotel.sources, "places"), 1), else_=0)), 0).label("places"),
            func.coalesce(func.sum(case((_contains(Hotel.sources, "osm"), 1), else_=0)), 0).label("osm"),
            func.coalesce(
                func.sum(
                    case((and_(_contains(Hotel.sources, "places"), _contains(Hotel.sources, "osm")), 1), else_=0)
                ),
                0,
            ).label("merged"),
        ).filter(*date_conditions).one()
        provenance_rows = (
            db.query(scraped_via.label("scraped_via"), func.count(Hotel.id).label("count"))
            .filter(*date_conditions)
            .filter(traced)
            .group_by(scraped_via)
            .order_by(func.count(Hotel.id).desc(), scraped_via.asc())
            .all()
        )
        zip_status_rows = (
            db.query(ZipCode.places_status, func.count(ZipCode.zip))
            .group_by(ZipCode.places_status)
            .all()
        )

    all_total = int(totals.all_total or 0)
    traced_total = int(totals.traced_total or 0)
    by_scraped_via = {
        str(row.scraped_via): int(row.count or 0)
        for row in provenance_rows
        if row.scraped_via
    }
    zips_by_places_status = {
        str(status or "unknown"): int(count or 0)
        for status, count in zip_status_rows
    }
    return {
        "generated_at": utcnow().isoformat(),
        "scope": {
            **filters,
            "date_note": (
                "scraped_at uses raw scraper evidence; first_seen and last_seen use database timestamps."
            ),
        },
        "all": {"total": all_total},
        "scraper_traced": {
            "total": traced_total,
            "with_run_id": int(totals.traced_with_run_id or 0),
            "by_scraped_via": by_scraped_via,
        },
        "legacy_or_untraced": {"total": max(all_total - traced_total, 0)},
        "sources": {
            "places": int(totals.places or 0),
            "osm": int(totals.osm or 0),
            "merged": int(totals.merged or 0),
        },
        "inventory": {
            "hotels_total": all_total,
            "zips_total": sum(zips_by_places_status.values()),
            "zips_by_places_status": zips_by_places_status,
        },
    }


@app.get("/api/review/hotels")
def list_review_hotels(
    scope: str = Query(
        "all",
        description="all, scraper_traced, or legacy_or_untraced",
    ),
    provenance: Optional[str] = Query(
        None,
        description="Exact raw.scraped_via value, for example chrome_google_maps",
    ),
    run_id: Optional[str] = Query(
        None,
        description="Current raw scrape_run_id/run_id. Use the per-run endpoint for immutable history.",
    ),
    date_from: Optional[str] = Query(None, description="Inclusive YYYY-MM-DD date"),
    date_to: Optional[str] = Query(None, description="Inclusive YYYY-MM-DD date"),
    date_field: str = Query("last_seen", description="first_seen, last_seen, or scraped_at"),
    q: Optional[str] = Query(None, description="Name or address search"),
    zip_code: Optional[str] = Query(None, alias="zip"),
    include_raw: bool = Query(False, description="Include full source evidence in each response item"),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Page current hotel rows with trace-aware filters, without any mutation."""
    try:
        normalized_scope = _review_text(scope, field="scope", max_length=64)
        normalized_scope = normalized_scope.lower() if normalized_scope else "all"
        if normalized_scope not in _REVIEW_SCOPES:
            allowed = ", ".join(sorted(_REVIEW_SCOPES))
            raise ValueError(f"scope must be one of: {allowed}")
        normalized_provenance = _review_text(provenance, field="provenance")
        normalized_run_id = _review_text(run_id, field="run_id", max_length=128)
        normalized_query = _review_text(q, field="q", max_length=256)
        normalized_zip = _review_text(zip_code, field="zip", max_length=5)
        if normalized_zip and (not normalized_zip.isdigit() or len(normalized_zip) != 5):
            raise ValueError("zip must be a five-digit ZIP code")
        date_conditions, date_filter = _review_date_conditions(
            date_from=date_from,
            date_to=date_to,
            date_field=date_field,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    query = db.query(Hotel).filter(*date_conditions)
    if normalized_scope == "scraper_traced":
        query = query.filter(_scraper_traced_predicate())
    elif normalized_scope == "legacy_or_untraced":
        query = query.filter(_legacy_or_untraced_predicate())
    if normalized_provenance:
        query = query.filter(_review_scraped_via() == normalized_provenance)
    if normalized_run_id:
        query = query.filter(_review_run_id() == normalized_run_id)
    if normalized_query:
        like = f"%{normalized_query}%"
        query = query.filter(or_(Hotel.name.ilike(like), Hotel.formatted_address.ilike(like)))
    if normalized_zip:
        query = query.filter(or_(Hotel.zip == normalized_zip, Hotel.query_zip == normalized_zip))

    with db.no_autoflush:
        total_matches = query.count()
        rows = (
            query.order_by(Hotel.last_seen.desc().nullslast(), Hotel.id.asc())
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )
    return {
        "filters": {
            "scope": normalized_scope,
            "provenance": normalized_provenance,
            "run_id": normalized_run_id,
            "q": normalized_query,
            "zip": normalized_zip,
            **date_filter,
            "run_id_note": (
                "This matches the current row trace. For immutable historical run evidence, use /api/review/runs/{run_id}."
            ),
        },
        "page": page,
        "limit": limit,
        "total": total_matches,
        "total_pages": (total_matches + limit - 1) // limit if total_matches else 1,
        "items": [_review_hotel_payload(hotel, include_raw=include_raw) for hotel in rows],
    }


@app.get("/api/review/runs")
def list_review_runs(
    limit: int = Query(50, ge=1, le=500),
    status: Optional[str] = Query(None, description="Optional journal run status"),
):
    """List local immutable scrape journals so the dashboard can select a run."""
    try:
        return {"items": RunJournal().list_runs(limit=limit, status=status), "limit": limit}
    except (ValueError, RunJournalError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/review/runs/{run_id}")
def get_review_run_detail(
    run_id: str,
    limit: int = Query(200, ge=1, le=500, description="Maximum records returned in each detail category"),
):
    """Return immutable run evidence plus a read-only current-row reconciliation.

    The local journal remains useful during a Cloud SQL outage.  In that case
    this endpoint still returns the before/after snapshots and clearly marks
    the current-database reconciliation as unavailable.
    """
    try:
        normalized_run_id = _review_text(run_id, field="run_id", max_length=128)
        journal = RunJournal()
        run = journal.get_run(normalized_run_id)
        if run is None:
            raise RunNotFoundError(normalized_run_id)
        raw_changes = journal.hotel_changes_for_run(normalized_run_id, limit=limit + 1)
        raw_outcomes = journal.zip_outcomes_for_run(normalized_run_id, limit=limit + 1)
        raw_reports = journal.report_rows_for_run(normalized_run_id, limit=limit + 1)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc
    except (ValueError, RunJournalError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    changes, outcomes, reports = raw_changes[:limit], raw_outcomes[:limit], raw_reports[:limit]
    has_more = {
        "records": len(raw_changes) > limit,
        "zip_outcomes": len(raw_outcomes) > limit,
        "report_rows": len(raw_reports) > limit,
    }
    db = _live_session()
    database_error: Optional[str] = None
    if db is None:
        reconciled = {
            "records": [
                {
                    "change": change,
                    "current_record": None,
                    "verification": {
                        "status": "database_unavailable",
                        "matched_by": None,
                        "candidate_hotel_ids": [],
                        "observable_fields_changed_since_snapshot": [],
                    },
                }
                for change in changes
            ],
            "reconciliation": {
                "records_returned": len(changes),
                "current_records_present": 0,
                "current_records_missing": 0,
                "ambiguous_current_matches": 0,
                "records_changed_since_snapshot": 0,
            },
        }
        database_error = db_state.get("error") or "Database unavailable"
    else:
        try:
            reconciled = _reconcile_run_records(db, changes)
        except SQLAlchemyError as exc:
            database_error = str(exc).splitlines()[0][:200] or "Database unavailable"
            db_state.update(connected=False, error=database_error)
            reconciled = {
                "records": [
                    {
                        "change": change,
                        "current_record": None,
                        "verification": {
                            "status": "database_unavailable",
                            "matched_by": None,
                            "candidate_hotel_ids": [],
                            "observable_fields_changed_since_snapshot": [],
                        },
                    }
                    for change in changes
                ],
                "reconciliation": {
                    "records_returned": len(changes),
                    "current_records_present": 0,
                    "current_records_missing": 0,
                    "ambiguous_current_matches": 0,
                    "records_changed_since_snapshot": 0,
                },
            }
        finally:
            db.close()

    counts = {
        "records_returned": len(changes),
        "records_inserted_returned": sum(change["operation"] == "inserted" for change in changes),
        "records_touched_returned": sum(change["operation"] == "touched" for change in changes),
        "zip_outcomes_returned": len(outcomes),
        "quarantined_zips_returned": sum(outcome["quarantined"] for outcome in outcomes),
        "report_rows_returned": len(reports),
    }
    return {
        "run": run,
        "records": reconciled["records"],
        "zip_outcomes": outcomes,
        "report_rows": reports,
        "counts": counts,
        "detail": {"limit_per_category": limit, "has_more": has_more},
        "database": {
            "available": database_error is None,
            "read_only": True,
            "error": database_error,
            **reconciled["reconciliation"],
        },
    }


@app.get("/api/recovery")
def get_recovery_status():
    """Expose a strictly read-only restart/recovery inspection for the dashboard."""
    try:
        # Imported lazily so an older packaged desktop build can still show a
        # useful degraded state instead of failing the entire API at import.
        from app.recovery import inspect_startup_recovery

        return inspect_startup_recovery(max_items=50).as_dict()
    except Exception as exc:
        # No recovery action is attempted from a dashboard GET.  The worker's
        # startup path owns replay; this response simply tells the operator
        # that evidence could not be inspected.
        message = str(exc).splitlines()[0][:200] if str(exc) else "Recovery inspection unavailable"
        return {
            "generated_at": utcnow().isoformat(),
            "recovery_mode": "inspection_unavailable",
            "safe_to_resume": False,
            "needs_operator_review": True,
            "journal": {
                "path": None,
                "state": "unavailable",
                "error": message,
                "integrity_errors": [],
                "run_count": 0,
                "unfinished_run_count": 0,
                "unfinished_runs": [],
                "anomalies": [],
            },
            "outbox": {
                "path": None,
                "state": "unavailable",
                "error": message,
                "integrity_errors": [],
                "batch_count": 0,
                "pending_batch_count": 0,
                "pending_record_count": 0,
                "pending_batches": [],
                "anomalies": [],
            },
            "recommended_actions": [{
                "code": "inspect_recovery_status",
                "severity": "critical",
                "automatic": False,
                "message": "Inspect the local recovery journal before resuming the worker.",
                "details": {"error": message},
            }],
            "error": message,
        }


# ==========================================
# WORKER CONTROL
# ==========================================

@app.post("/api/control/start")
async def start_worker():
    return await worker_instance.start()


@app.post("/api/control/pause")
async def pause_worker():
    return await worker_instance.pause()


@app.post("/api/control/stop")
async def stop_worker():
    return await worker_instance.stop()


@app.post("/api/control/retry-failed")
async def retry_failed_zips():
    await _require_write_contract()
    result = await worker_instance.retry_failed_zips()
    invalidate_cache()
    return result


@app.get("/api/control/mode")
async def get_scraper_mode():
    return {"mode": worker_instance.scraper_mode}


@app.post("/api/control/mode")
async def set_scraper_mode(mode: str = Query(..., description="'defined_zips' or 'radial'")):
    if mode not in ("defined_zips", "radial"):
        raise HTTPException(status_code=400, detail="Invalid mode. Choose 'defined_zips' or 'radial'.")
    new_mode = worker_instance.set_mode(mode)
    return {"status": "success", "mode": new_mode, "message": f"Scraper mode switched to: {new_mode.upper()}."}


@app.get("/api/chrome/status")
def get_chrome_status():
    return check_session_status()


@app.post("/api/chrome/login")
async def trigger_chrome_login():
    # The profile can only be opened by one Chrome at a time.
    await chrome_scraper.close_browser()
    asyncio.create_task(asyncio.to_thread(open_interactive_login, "husshpuppy5@gmail.com"))
    return {"status": "launched", "message": "Opened Google Chrome window. Complete Google login to save session."}


# ==========================================
# ZIP QUEUE
# ==========================================

def _resolve_zips(db: Session, token: str) -> List[ZipCode]:
    """Maps a 5-digit ZIP or 'City[, ST]' to existing rows of the `zips` table."""
    t = token.strip()
    if re.fullmatch(r"\d{5}", t):
        row = db.get(ZipCode, t)
        if row:
            return [row]
        item = next((i for i in MAJOR_US_HOTEL_ZIPS if i["zip"] == t), None)
        if item:
            row = ZipCode(
                zip=item["zip"], city=item["city"], state=item["state"][:2], county=item.get("county"),
                lat=item["lat"], lng=item["lng"],
                dist_km_from_kirkland=haversine_distance_km(item["lat"], item["lng"]),
                osm_status="pending", places_status="pending", places_calls=0, hotels_found=0,
            )
            db.add(row)
            return [row]
        return []
    parts = [p.strip() for p in t.split(",")]
    q = db.query(ZipCode).filter(ZipCode.city.ilike(f"{parts[0]}%"))
    if len(parts) > 1 and parts[1]:
        q = q.filter(ZipCode.state == parts[1].upper()[:2])
    return q.order_by(ZipCode.zip).limit(50).all()


async def _autostart_worker() -> Optional[str]:
    if worker_instance.is_running:
        return None
    result = await worker_instance.start()
    return result["message"] if result.get("status") == "error" else None


def _queue_tokens(db: Session, tokens: List[str]) -> Tuple[List[Dict[str, str]], List[str]]:
    queued, skipped, now = [], [], utcnow()
    for token in tokens:
        rows = _resolve_zips(db, token)
        if not rows:
            skipped.append(token)
            continue
        for z in rows:
            z.places_status = "pending"
            z.last_error = None
            z.updated_at = now
            queued.append({"zip": z.zip, "city": z.city, "state": z.state})
    db.commit()
    invalidate_cache()
    return queued, skipped


@app.post("/api/zips/add")
async def queue_locations(query: str = Query(..., description="ZIP codes (comma/space separated) or 'City, ST'")):
    await _require_write_contract()
    q = query.strip()
    tokens = re.findall(r"\d{5}", q) if re.fullmatch(r"[\d\s,;]+", q) else [q]

    def work():
        db = database.get_db_session()
        try:
            return _queue_tokens(db, tokens)
        finally:
            db.close()

    queued, skipped = await asyncio.to_thread(work)
    if not queued:
        raise HTTPException(status_code=404, detail=f"No matching ZIP codes found for '{query}'.")
    err = await _autostart_worker()
    msg = f"Queued {len(queued)} ZIP code(s) with priority."
    if skipped:
        msg += f" Not found: {', '.join(skipped)}."
    if err:
        msg += f" Worker not started: {err}"
    return {"status": "success", "queued_count": len(queued), "queued": queued[:50], "skipped": skipped, "message": msg}


@app.post("/api/zips/batch-add")
async def add_batch_defined_zips(zips_input: str = Query(...)):
    return await queue_locations(query=zips_input)


@app.post("/api/zips/queue-major-cities")
async def queue_major_cities():
    await _require_write_contract()
    def work():
        db = database.get_db_session()
        try:
            return _queue_tokens(db, [i["zip"] for i in MAJOR_US_HOTEL_ZIPS])
        finally:
            db.close()

    queued, _ = await asyncio.to_thread(work)
    err = await _autostart_worker()
    msg = f"Queued {len(queued)} major US tourism ZIP codes."
    return {"status": "success", "queued_count": len(queued), "message": msg + (f" Worker not started: {err}" if err else " Background worker is active.")}


@app.post("/api/zips/requeue-all")
async def requeue_all_zips(confirm: bool = Query(False)):
    """Resets every finished ZIP to pending (a full recrawl). Requires confirm=true."""
    if not confirm:
        raise HTTPException(status_code=400, detail="This re-crawls every ZIP. Pass confirm=true.")
    await _require_write_contract()

    def work() -> int:
        db = database.get_db_session()
        try:
            n = db.query(ZipCode).filter(ZipCode.places_status != "pending").update(
                {"places_status": "pending", "last_error": None, "updated_at": utcnow()},
                synchronize_session=False,
            )
            db.commit()
            return n
        finally:
            db.close()

    count = await asyncio.to_thread(work)
    invalidate_cache()
    err = await _autostart_worker()
    return {"status": "success", "count": count,
            "message": f"Reset {count} ZIP code(s) to 'pending'." + (f" Worker not started: {err}" if err else "")}


@app.get("/api/zips")
def list_zips(
    status: Optional[str] = Query(None, description="places_status filter: done, pending, error"),
    search: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    query = db.query(ZipCode)
    if status:
        query = query.filter(ZipCode.places_status == status)
    if search:
        like = f"%{search}%"
        query = query.filter(or_(ZipCode.zip.ilike(like), ZipCode.city.ilike(like), ZipCode.state.ilike(like)))
    return [z.to_dict() for z in query.order_by(ZipCode.dist_km_from_kirkland.asc()).limit(limit).all()]


# ==========================================
# HOTEL DIRECTORY
# ==========================================

@app.get("/api/hotels")
def list_hotels(
    q: Optional[str] = Query(None, description="Search term for name or address"),
    city: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    zip_code: Optional[str] = Query(None, alias="zip"),
    source: Optional[str] = Query("all", description="Filter: all, places, osm, merged"),
    min_rating: Optional[float] = Query(None, ge=0.0, le=5.0),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    query = db.query(Hotel)
    if q:
        like = f"%{q}%"
        query = query.filter(or_(Hotel.name.ilike(like), Hotel.formatted_address.ilike(like)))
    if city:
        query = query.filter(Hotel.formatted_address.ilike(f"%{city}%"))
    if state:
        query = query.filter(Hotel.state == state.upper()[:2])
    if zip_code:
        query = query.filter(or_(Hotel.zip == zip_code, Hotel.query_zip == zip_code))
    if min_rating is not None:
        query = query.filter(Hotel.rating >= min_rating)
    if source == "places":
        query = query.filter(_contains(Hotel.sources, "places"))
    elif source == "osm":
        query = query.filter(_contains(Hotel.sources, "osm"))
    elif source == "merged":
        query = query.filter(_contains(Hotel.sources, "places"), _contains(Hotel.sources, "osm"))

    total_matches = query.count()
    rows = (
        query.order_by(Hotel.rating.desc().nullslast(), Hotel.id)
        .offset((page - 1) * limit).limit(limit).all()
    )
    return {
        "page": page,
        "limit": limit,
        "total": total_matches,
        "total_pages": (total_matches + limit - 1) // limit if total_matches else 1,
        "items": [h.to_dict() for h in rows],
    }


@app.get("/api/hotels/{hotel_id}")
def get_hotel(hotel_id: int, db: Session = Depends(get_db)):
    hotel = db.get(Hotel, hotel_id)
    if not hotel:
        raise HTTPException(status_code=404, detail="Hotel not found")
    return _review_hotel_payload(hotel)


@app.post("/api/hotels/{hotel_id}/website-enrichment")
async def queue_hotel_website(hotel_id: int, db: Session = Depends(get_db)):
    """Queue one existing hotel's public website; no remote mutation here."""
    from app.website_queue import WebsiteQueue
    from app.website_enrichment import safe_url
    from app.config import database_target
    if not settings.WEBSITE_ENRICHMENT_ENABLED:
        raise HTTPException(status_code=409, detail="Website enrichment is disabled")
    hotel = db.get(Hotel, hotel_id)
    if not hotel:
        raise HTTPException(status_code=404, detail="Hotel not found")
    try:
        safe_url(hotel.website)
    except ValueError:
        raise HTTPException(status_code=400, detail="Hotel has no usable public website URL")
    record = hotel.to_dict()
    record["raw"] = {**(hotel.raw or {}), "scraped_at": datetime.now(timezone.utc).isoformat()}
    target = database_target()
    def enqueue():
        WebsiteQueue().enqueue(record, "website-review-" + uuid.uuid4().hex, target)
    await asyncio.to_thread(enqueue)
    return {"status": "queued", "hotel_id": hotel_id, "message": "Website queued locally; start the worker to collect evidence."}
