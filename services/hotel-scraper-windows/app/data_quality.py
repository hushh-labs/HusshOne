"""Read-only, incremental data-quality audits for the ``hotels`` table.

The worker validates records before it writes them.  This module provides the
other half of that protection: it can periodically inspect rows that already
exist in Cloud SQL without changing any of them.  It intentionally uses only
``SELECT`` statements and wraps every query in ``Session.no_autoflush`` so an
audit cannot flush unrelated pending changes in a caller-owned session.

``audit_hotels`` is designed for a scheduler.  Duplicate CID and coordinate
checks are global, while the more detailed shape inspection is keyset-paged by
hotel id.  Persist ``next_shape_cursor`` and call again until it is ``None`` to
cover a large table without loading it all into memory.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import math
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import Hotel, ZipCode
from app.scrape_contract import haversine_km


# This is deliberately a broad operating envelope rather than a political
# boundary.  It includes Alaska, Hawaii, Puerto Rico, and the US Virgin
# Islands, while catching the accidental Europe/India/zero-coordinate rows
# that are the operational concern.  Border/ocean precision belongs in a GIS
# polygon audit, not in a lightweight daily health check.
US_LATITUDE_RANGE: Tuple[float, float] = (17.0, 72.0)
US_LONGITUDE_RANGE: Tuple[float, float] = (-180.0, -64.0)


@dataclass(frozen=True)
class DuplicateGoogleCid:
    """A non-empty ``raw.google_cid`` shared by multiple hotel rows."""

    google_cid: str
    count: int
    sample_hotel_ids: Tuple[int, ...]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "google_cid": self.google_cid,
            "count": self.count,
            "sample_hotel_ids": list(self.sample_hotel_ids),
        }


@dataclass(frozen=True)
class QualityIssue:
    """One row-level quality issue with deliberately small, safe evidence."""

    rule: str
    hotel_id: int
    evidence: Mapping[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "rule": self.rule,
            "hotel_id": self.hotel_id,
            "evidence": dict(self.evidence),
        }


@dataclass(frozen=True)
class DataQualityReport:
    """Structured output suitable for a log, alert, or a later API endpoint."""

    generated_at: datetime
    duplicate_google_cids: Tuple[DuplicateGoogleCid, ...]
    coordinate_issues: Tuple[QualityIssue, ...]
    shape_issues: Tuple[QualityIssue, ...]
    shape_rows_scanned: int
    next_shape_cursor: Optional[int]
    duplicate_google_cids_truncated: bool = False
    coordinate_issues_truncated: bool = False
    shape_issues_truncated: bool = False

    @property
    def is_clean(self) -> bool:
        # A capped/page-one result is not evidence that the database is clean.
        return not self.is_partial and not (
            self.duplicate_google_cids
            or self.coordinate_issues
            or self.shape_issues
        )

    @property
    def is_partial(self) -> bool:
        """Whether caps/page boundaries mean a follow-up audit is needed."""
        return bool(
            self.duplicate_google_cids_truncated
            or self.coordinate_issues_truncated
            or self.shape_issues_truncated
            or self.next_shape_cursor is not None
        )

    def summary(self) -> Dict[str, Any]:
        return {
            "duplicate_google_cids": len(self.duplicate_google_cids),
            "coordinate_issues": len(self.coordinate_issues),
            "shape_issues": len(self.shape_issues),
            "shape_rows_scanned": self.shape_rows_scanned,
            "is_clean": self.is_clean,
            "is_partial": self.is_partial,
        }

    def as_dict(self) -> Dict[str, Any]:
        return {
            "generated_at": self.generated_at.isoformat(),
            "summary": self.summary(),
            "duplicate_google_cids": [row.as_dict() for row in self.duplicate_google_cids],
            "coordinate_issues": [row.as_dict() for row in self.coordinate_issues],
            "shape_issues": [row.as_dict() for row in self.shape_issues],
            "next_shape_cursor": self.next_shape_cursor,
            "truncated": {
                "duplicate_google_cids": self.duplicate_google_cids_truncated,
                "coordinate_issues": self.coordinate_issues_truncated,
                "shape_issues": self.shape_issues_truncated,
            },
        }


def _require_positive(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _as_finite_float(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _is_us_operating_coordinate(lat: float, lng: float) -> bool:
    return (
        US_LATITUDE_RANGE[0] <= lat <= US_LATITUDE_RANGE[1]
        and US_LONGITUDE_RANGE[0] <= lng <= US_LONGITUDE_RANGE[1]
    )


def _cid_expression():
    """Portable JSON scalar expression for PostgreSQL JSONB and SQLite JSON."""
    # ``as_string`` compiles to JSON ``->>`` on PostgreSQL and JSON_EXTRACT on
    # SQLite.  TRIM canonicalizes harmless scraper whitespace before grouping.
    return func.trim(Hotel.raw["google_cid"].as_string())


def _limited_rows(session: Session, statement: Any, limit: int) -> Tuple[List[Any], bool]:
    """Fetch one extra row so capped audit output is never silently incomplete."""
    rows = list(session.execute(statement.limit(limit + 1)).all())
    return rows[:limit], len(rows) > limit


def _duplicate_cids(
    session: Session,
    *,
    finding_limit: int,
    sample_id_limit: int,
) -> Tuple[Tuple[DuplicateGoogleCid, ...], bool]:
    cid = _cid_expression().label("google_cid")
    row_count = func.count(Hotel.id).label("row_count")
    groups = (
        select(cid, row_count)
        .where(cid.is_not(None), cid != "")
        .group_by(cid)
        .having(func.count(Hotel.id) > 1)
        .order_by(row_count.desc(), cid.asc())
    )
    group_rows, truncated = _limited_rows(session, groups, finding_limit)

    findings: List[DuplicateGoogleCid] = []
    raw_cid = _cid_expression()
    for group in group_rows:
        value = str(group.google_cid)
        sample_rows = session.execute(
            select(Hotel.id)
            .where(raw_cid == value)
            .order_by(Hotel.id.asc())
            .limit(sample_id_limit)
        ).all()
        findings.append(
            DuplicateGoogleCid(
                google_cid=value,
                count=int(group.row_count),
                sample_hotel_ids=tuple(int(row.id) for row in sample_rows),
            )
        )
    return tuple(findings), truncated


def _coordinate_issues(
    session: Session,
    *,
    finding_limit: int,
) -> Tuple[Tuple[QualityIssue, ...], bool]:
    """Find invalid-Earth and clearly non-US rows with SQL-side filtering."""
    lat, lng = Hotel.lat, Hotel.lng
    invalid_earth = or_(
        and_(lat.is_not(None), or_(lat < -90, lat > 90)),
        and_(lng.is_not(None), or_(lng < -180, lng > 180)),
    )
    outside_us = and_(
        lat.is_not(None),
        lng.is_not(None),
        lat >= -90,
        lat <= 90,
        lng >= -180,
        lng <= 180,
        or_(
            lat < US_LATITUDE_RANGE[0],
            lat > US_LATITUDE_RANGE[1],
            lng < US_LONGITUDE_RANGE[0],
            lng > US_LONGITUDE_RANGE[1],
        ),
    )
    statement = (
        select(Hotel.id, lat.label("lat"), lng.label("lng"))
        .where(or_(invalid_earth, outside_us))
        .order_by(Hotel.id.asc())
    )
    rows, truncated = _limited_rows(session, statement, finding_limit)

    issues: List[QualityIssue] = []
    for row in rows:
        row_lat, row_lng = _as_finite_float(row.lat), _as_finite_float(row.lng)
        if (
            row_lat is None
            or row_lng is None
            or not -90 <= row_lat <= 90
            or not -180 <= row_lng <= 180
        ):
            rule = "coordinates_outside_earth_bounds"
        elif not _is_us_operating_coordinate(row_lat, row_lng):
            rule = "coordinates_outside_us_bounds"
        else:
            # This should only be reachable for non-finite driver values that
            # were matched oddly by a database.  Keep the audit conservative.
            rule = "coordinates_invalid"
        issues.append(
            QualityIssue(rule=rule, hotel_id=int(row.id), evidence={"lat": row.lat, "lng": row.lng})
        )
    return tuple(issues), truncated


def _source_values(value: Any) -> Optional[List[str]]:
    if not isinstance(value, (list, tuple)):
        return None
    values: List[str] = []
    for source in value:
        if not isinstance(source, str):
            return None
        values.append(source.strip())
    return values


def _shape_issues_for_row(
    row: Mapping[str, Any],
    *,
    max_zip_distance_km: float,
) -> Iterable[QualityIssue]:
    hotel_id = int(row["id"])
    name = row["name"]
    if not isinstance(name, str) or not name.replace("\x00", "").strip():
        yield QualityIssue("empty_name", hotel_id, {"name": name})

    dedup_key = row["dedup_key"]
    if not isinstance(dedup_key, str) or not dedup_key.strip():
        yield QualityIssue("missing_dedup_key", hotel_id)

    lat, lng = _as_finite_float(row["lat"]), _as_finite_float(row["lng"])
    if lat is None and lng is None:
        yield QualityIssue("coordinates_missing", hotel_id)
    elif lat is None or lng is None:
        yield QualityIssue("coordinates_partial_or_nonfinite", hotel_id, {"lat": row["lat"], "lng": row["lng"]})
    elif not -90 <= lat <= 90 or not -180 <= lng <= 180:
        yield QualityIssue("coordinates_outside_earth_bounds", hotel_id, {"lat": row["lat"], "lng": row["lng"]})

    rating = row["rating"]
    if rating is not None:
        normalized_rating = _as_finite_float(rating)
        if normalized_rating is None or not 1 <= normalized_rating <= 5:
            yield QualityIssue("rating_outside_1_5", hotel_id, {"rating": rating})

    sources = _source_values(row["sources"])
    if not sources or any(source not in {"places", "osm"} for source in sources):
        yield QualityIssue("invalid_sources", hotel_id, {"sources": row["sources"]})

    raw = row["raw"]
    if raw is not None and not isinstance(raw, dict):
        yield QualityIssue("raw_not_object", hotel_id, {"raw_type": type(raw).__name__})
    elif isinstance(raw, dict) and raw.get("scraped_via") == "chrome_google_maps":
        cid = raw.get("google_cid")
        if not isinstance(cid, str) or not cid.strip():
            yield QualityIssue("maps_record_missing_google_cid", hotel_id)
        run_id = raw.get("scrape_run_id") or raw.get("run_id")
        if not isinstance(run_id, str) or not run_id.strip():
            yield QualityIssue("maps_record_missing_run_id", hotel_id)

    query_zip = row["query_zip"]
    zip_lat, zip_lng = _as_finite_float(row["zip_lat"]), _as_finite_float(row["zip_lng"])
    if query_zip and (zip_lat is None or zip_lng is None):
        yield QualityIssue("query_zip_reference_missing", hotel_id, {"query_zip": query_zip})
    elif lat is not None and lng is not None and zip_lat is not None and zip_lng is not None:
        distance = haversine_km(zip_lat, zip_lng, lat, lng)
        if distance > max_zip_distance_km:
            yield QualityIssue(
                "coordinates_far_from_query_zip",
                hotel_id,
                {
                    "query_zip": query_zip,
                    "distance_km": round(distance, 1),
                    "max_distance_km": max_zip_distance_km,
                },
            )


def _shape_issues(
    session: Session,
    *,
    finding_limit: int,
    scan_limit: int,
    cursor_after_id: Optional[int],
    max_zip_distance_km: float,
) -> Tuple[Tuple[QualityIssue, ...], int, Optional[int], bool]:
    statement = (
        select(
            Hotel.id.label("id"),
            Hotel.dedup_key.label("dedup_key"),
            Hotel.name.label("name"),
            Hotel.lat.label("lat"),
            Hotel.lng.label("lng"),
            Hotel.rating.label("rating"),
            Hotel.sources.label("sources"),
            Hotel.raw.label("raw"),
            Hotel.query_zip.label("query_zip"),
            ZipCode.lat.label("zip_lat"),
            ZipCode.lng.label("zip_lng"),
        )
        .outerjoin(ZipCode, Hotel.query_zip == ZipCode.zip)
        .order_by(Hotel.id.asc())
    )
    if cursor_after_id is not None:
        statement = statement.where(Hotel.id > cursor_after_id)

    raw_rows = list(session.execute(statement.limit(scan_limit + 1)).mappings().all())
    has_more = len(raw_rows) > scan_limit
    rows = raw_rows[:scan_limit]
    next_cursor = int(rows[-1]["id"]) if rows and has_more else None

    issues: List[QualityIssue] = []
    truncated = False
    for row in rows:
        for issue in _shape_issues_for_row(row, max_zip_distance_km=max_zip_distance_km):
            if len(issues) < finding_limit:
                issues.append(issue)
            else:
                truncated = True
    return tuple(issues), len(rows), next_cursor, truncated


def audit_hotels(
    session: Session,
    *,
    finding_limit: int = 100,
    shape_scan_limit: int = 10_000,
    shape_cursor_after_id: Optional[int] = None,
    max_zip_distance_km: float = 75.0,
    duplicate_sample_id_limit: int = 10,
) -> DataQualityReport:
    """Inspect hotel quality without issuing a mutation or committing a transaction.

    Args:
        session: A SQLAlchemy session bound to the database being audited.
        finding_limit: Maximum reported findings in each category.  The report
            explicitly marks capped categories as truncated.
        shape_scan_limit: Number of hotel rows to inspect in this shape-audit
            pass.  Use ``next_shape_cursor`` for the next keyset page.
        shape_cursor_after_id: Resume a prior shape scan after this hotel id.
        max_zip_distance_km: Same conservative ZIP-centroid threshold used by
            write-time record validation.
        duplicate_sample_id_limit: Number of associated hotel IDs retained per
            duplicate CID finding.

    The broad US coordinate envelope is intentionally an operational sanity
    check, not a legal/geographic determination of US borders.
    """
    _require_positive(finding_limit, "finding_limit")
    _require_positive(shape_scan_limit, "shape_scan_limit")
    _require_positive(duplicate_sample_id_limit, "duplicate_sample_id_limit")
    if shape_cursor_after_id is not None and (
        isinstance(shape_cursor_after_id, bool) or not isinstance(shape_cursor_after_id, int)
    ):
        raise ValueError("shape_cursor_after_id must be an integer or None")
    if not isinstance(max_zip_distance_km, (int, float)) or isinstance(max_zip_distance_km, bool) or max_zip_distance_km <= 0:
        raise ValueError("max_zip_distance_km must be a positive number")

    # no_autoflush is important: callers commonly retain a dashboard session,
    # and audit reads must never flush an unrelated pending ORM change.
    with session.no_autoflush:
        duplicates, duplicates_truncated = _duplicate_cids(
            session,
            finding_limit=finding_limit,
            sample_id_limit=duplicate_sample_id_limit,
        )
        coordinates, coordinates_truncated = _coordinate_issues(session, finding_limit=finding_limit)
        shapes, rows_scanned, next_cursor, shapes_truncated = _shape_issues(
            session,
            finding_limit=finding_limit,
            scan_limit=shape_scan_limit,
            cursor_after_id=shape_cursor_after_id,
            max_zip_distance_km=float(max_zip_distance_km),
        )

    return DataQualityReport(
        generated_at=datetime.now(timezone.utc),
        duplicate_google_cids=duplicates,
        coordinate_issues=coordinates,
        shape_issues=shapes,
        shape_rows_scanned=rows_scanned,
        next_shape_cursor=next_cursor,
        duplicate_google_cids_truncated=duplicates_truncated,
        coordinate_issues_truncated=coordinates_truncated,
        shape_issues_truncated=shapes_truncated,
    )


# A verb-friendly alias for schedulers/call sites that read better as a job.
run_data_quality_audit = audit_hotels
