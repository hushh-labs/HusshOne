"""Production-safe background Maps worker."""
from __future__ import annotations

import asyncio
import logging
import random
import re
import sqlite3
import tempfile
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import func, or_, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, load_only

from app import chrome_scraper, database
from app.canary import assess_canary
from app.config import settings, database_target
from app.database import get_db_session
from app.data_quality import audit_hotels
from app.free_scraper import generate_dedup_key
from app.models import Hotel, ZipCode
from app.outbox import LocalOutbox, OutboxBatch, OutboxError, require_matching_target
from app.power import worker_wake_lock
from app.website_queue import WebsiteQueue
from app.website_enrichment import collect_website
from app.website_backfill import FIELDS as WEBSITE_FILL_FIELDS, blank, fill_candidates
from app.recovery import inspect_startup_recovery
from app.run_journal import RunJournal
from app.scrape_contract import ScrapeResult, ScrapeStatus, google_cid, validate_records


logger = logging.getLogger("hotel_scraper.worker")
ADVISORY_LOCK_KEY = 704_220_118
ZIP_IN_ADDRESS = re.compile(r"\b(\d{5})(?:-\d{4})?\b")
FAILURES_BEFORE_COOLDOWN = 5
SCRAPED_VIA = "chrome_google_maps"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean(value: Any) -> Optional[str]:
    return value.replace("\x00", "").strip() or None if isinstance(value, str) else None


def _reason(value: Any, limit: int = 500) -> str:
    result = str(value).splitlines()[0] if value is not None else ""
    return (result or "unknown error")[:limit]


def _status(value: Any) -> Optional[ScrapeStatus]:
    if isinstance(value, ScrapeStatus):
        return value
    try:
        return ScrapeStatus(str(getattr(value, "value", value)).strip().lower())
    except (TypeError, ValueError):
        return None


class ZipQuarantined(RuntimeError):
    """A ZIP must be parked without persisting its hotel rows."""

    def __init__(
        self,
        zip_code: str,
        reason: str,
        *,
        evidence: Optional[Mapping[str, Any]] = None,
        hotels_seen: Optional[int] = None,
        hotels_new: Optional[int] = None,
    ):
        super().__init__(reason)
        self.zip_code = zip_code
        self.reason = reason
        self.evidence = dict(evidence or {})
        self.hotels_seen = hotels_seen
        self.hotels_new = hotels_new


class DataLossSuspected(RuntimeError):
    """A read-only inventory check observed a lower historical watermark.

    The worker never tries to repair, delete, or otherwise "fix" the
    directory in this situation.  It stops before another result write and
    leaves the durable journal/outbox evidence for an operator to review.
    """

    def __init__(
        self,
        *,
        phase: str,
        expected: Mapping[str, Any],
        observed: Mapping[str, Any],
    ) -> None:
        self.phase = str(phase)
        self.expected = dict(expected)
        self.observed = dict(observed)
        differences: List[str] = []
        expected_count = self.expected.get("hotel_count")
        observed_count = self.observed.get("hotel_count")
        if isinstance(expected_count, int) and isinstance(observed_count, int):
            if observed_count < expected_count:
                differences.append(f"hotel count {expected_count} -> {observed_count}")
        expected_max = self.expected.get("max_hotel_id")
        observed_max = self.observed.get("max_hotel_id")
        if isinstance(expected_max, int) and (
            not isinstance(observed_max, int) or observed_max < expected_max
        ):
            differences.append(f"maximum hotel id {expected_max} -> {observed_max}")
        detail = "; ".join(differences) or "inventory watermark no longer matches"
        super().__init__(f"DataLossSuspected during {self.phase}: {detail}")

    def as_dict(self) -> Dict[str, Any]:
        return {
            "code": "data_loss_suspected",
            "phase": self.phase,
            "message": str(self),
            "expected": dict(self.expected),
            "observed": dict(self.observed),
        }


@dataclass
class _PendingBatch:
    """A Maps result held in memory while Cloud SQL write work is retried."""

    zip_code: str
    city: str
    state: str
    lat: float
    lng: float
    result: ScrapeResult
    records: Optional[List[Dict[str, Any]]] = None
    rejected: List[Dict[str, Optional[str]]] = field(default_factory=list)
    failure_recorded: bool = False
    error_marked: bool = False
    backoff_done: bool = False
    db_retry_recorded: bool = False
    quarantine: Optional[ZipQuarantined] = None
    quarantine_journaled: bool = False
    quarantine_marked: bool = False
    outbox_batch_id: Optional[str] = None


class ScraperBackgroundWorker:
    def __init__(self):
        self._is_running = False
        self._is_paused = False
        self._scraper_mode = "defined_zips"
        self._task: Optional[asyncio.Task] = None
        self._lock_conn = None
        self._consecutive_failures = 0
        self._zip_failures: Dict[str, int] = {}
        self._captcha_failures = 0
        self._maps_call_day: date = _now().date()
        self._maps_calls_today = 0
        self._last_canary_at: Optional[float] = None
        self._canary_failed = False
        self._last_data_quality_audit: Optional[float] = None
        self._data_quality_cursor: Optional[int] = None
        self._last_outbox_prune: Optional[float] = None
        self._journal: Optional[RunJournal] = None
        self._outbox: Optional[LocalOutbox] = None
        self._run_id: Optional[str] = None
        self._journal_finished = False
        self._stop_requested = False
        # Kept only in local worker state and the durable run journal.  A
        # lower value is treated as evidence of an external deletion or an
        # unexpected restore, never as an invitation to overwrite data.
        self._inventory_start: Optional[Dict[str, Any]] = None
        self._inventory_watermark: Optional[Dict[str, Any]] = None
        self._inventory_blocked: Optional[Dict[str, Any]] = None
        self._startup_recovery: Optional[Dict[str, Any]] = None
        self._website_queue = None
        self._website_turn = 0
        self._website_pressure = False
        self._website_activity = {"state": "idle", "hotel": None}
        self._logs: deque = deque(maxlen=200)
        self._stats = {
            "started_at": None,
            "zips_processed": 0,
            "zips_quarantined": 0,
            "records_rejected": 0,
            "hotels_found": 0,
            "hotels_added": 0,
            "outbox_pending": 0,
            "api_calls": 0,
            "errors_encountered": 0,
            "current_action": "Idle",
            "current_zip": None,
        }
        self._log("Background worker initialized and ready.")

    def _log(self, message: str, level: str = "INFO") -> None:
        self._logs.append({
            "timestamp": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC"),
            "level": level,
            "message": message,
        })
        getattr(logger, {"ERROR": "error", "WARNING": "warning"}.get(level, "info"))(message)

    @property
    def is_running(self) -> bool:
        return self._is_running

    @property
    def is_paused(self) -> bool:
        return self._is_paused

    @property
    def scraper_mode(self) -> str:
        return self._scraper_mode

    def set_mode(self, mode: str) -> str:
        if mode in ("defined_zips", "radial"):
            self._scraper_mode = mode
            self._log(f"Scraper execution mode updated to: {mode.upper()}")
        return self._scraper_mode

    def get_status(self) -> Dict[str, Any]:
        if self._outbox is not None:
            try:
                self._stats["outbox_pending"] = self._outbox.count("pending")
            except Exception as exc:
                self._log(f"Could not read local outbox status: {_reason(exc)}", "ERROR")
        return {
            "website_enrichment": {"enabled": settings.WEBSITE_ENRICHMENT_ENABLED,
                                   "jobs": self._website_queue.counts() if self._website_queue else {},
                                   "scheduler": self._website_queue.scheduler_status() if self._website_queue else {},
                                   "activity": {**dict(self._website_activity), "collectors": sum(not t.done() for t in getattr(self, '_website_fetches', {}).values()),
                                                "fetch_progress": dict(getattr(self, '_website_fetch_stats', {}))},
                                   "maps_throttled": False, "backlog_pressure": self._website_pressure,
                                   "backfill": self._website_queue.backfill_status() if self._website_queue else {"state": "not_loaded"}},
            "is_running": self._is_running,
            "is_paused": self._is_paused,
            "scraper_mode": self._scraper_mode,
            "stats": self._stats,
            "inventory_guard": {
                "start": dict(self._inventory_start or {}),
                "watermark": dict(self._inventory_watermark or {}),
                "blocked": dict(self._inventory_blocked or {}),
            },
            "startup_recovery": dict(self._startup_recovery or {}),
            "logs": list(self._logs),
        }

    # ---- singleton and run lifecycle ---------------------------------
    def _acquire_lock(self) -> bool:
        if database.engine is None or database.is_sqlite():
            return True
        try:
            conn = database.engine.connect()
            acquired = conn.execute(
                text("SELECT pg_try_advisory_lock(:k)"), {"k": ADVISORY_LOCK_KEY}
            ).scalar()
            if not acquired:
                conn.close()
                return False
            self._lock_conn = conn
            return True
        except (SQLAlchemyError, DatabaseUnavailable) as exc:
            self._log(f"Could not acquire worker lock: {_reason(exc)}", "ERROR")
            return False

    def _release_lock(self) -> None:
        if self._lock_conn is not None:
            try:
                self._lock_conn.close()
            except Exception:
                pass
            self._lock_conn = None

    def _open_durable_state(self) -> Tuple[RunJournal, LocalOutbox]:
        """Open the local audit files without starting a new run yet."""
        # Never switch to a shared temporary spool: it can hide pending work
        # and mix development batches with production recovery.
        return RunJournal(), LocalOutbox()

    def _open_journal_run(
        self,
        *,
        journal: Optional[RunJournal] = None,
        outbox: Optional[LocalOutbox] = None,
        inventory_start: Optional[Mapping[str, Any]] = None,
        historical_inventory: Optional[Mapping[str, Any]] = None,
        recovery: Optional[Mapping[str, Any]] = None,
    ) -> str:
        """Start a new local run after all read-only startup checks pass."""
        if journal is None or outbox is None:
            journal, outbox = self._open_durable_state()
        metadata: Dict[str, Any] = {
            "database_target": database_target(),
            "scraped_via": SCRAPED_VIA,
            "worker": "background",
            "scraper_mode": self._scraper_mode,
        }
        if inventory_start:
            metadata["hotel_inventory_start"] = dict(inventory_start)
        if historical_inventory:
            metadata["historical_hotel_inventory_watermark"] = dict(historical_inventory)
        if recovery:
            metadata["startup_recovery"] = {
                "safe_to_resume": bool(recovery.get("safe_to_resume")),
                "recovery_mode": recovery.get("recovery_mode"),
            }
        run_id = journal.start_run(metadata)
        self._journal = journal
        self._outbox = outbox
        self._run_id = run_id
        self._journal_finished = False
        return run_id

    def _finish_journal_run(self, status: str, error: Optional[str] = None) -> None:
        if self._journal is None or self._run_id is None or self._journal_finished:
            return
        try:
            self._journal.finish_run(
                self._run_id,
                status=status,
                error=error,
                metadata_patch={
                    "zips_processed": self._stats["zips_processed"],
                    "zips_quarantined": self._stats["zips_quarantined"],
                    "records_rejected": self._stats["records_rejected"],
                    "hotels_found": self._stats["hotels_found"],
                    "hotels_added": self._stats["hotels_added"],
                    "maps_calls": self._stats["api_calls"],
                    "errors": self._stats["errors_encountered"],
                    "outbox_pending": self._outbox_pending_count(),
                    "hotel_inventory_end": dict(self._inventory_watermark or {}),
                    "hotel_inventory_guard": dict(self._inventory_blocked or {}),
                },
            )
            self._journal_finished = True
        except Exception as exc:
            self._log(f"Could not finish local scrape journal: {_reason(exc)}", "ERROR")

    def _journal_safe(self, method: str, *args: Any, **kwargs: Any) -> Any:
        if self._journal is None or self._run_id is None:
            return None
        try:
            return getattr(self._journal, method)(self._run_id, *args, **kwargs)
        except Exception as exc:
            self._log(f"Could not journal {method}: {_reason(exc)}", "ERROR")
            return None

    async def _journal_event(self, method: str, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._journal_safe, method, *args, **kwargs)

    # ---- non-destructive inventory guard -----------------------------
    @staticmethod
    def _inventory_int(value: Any, *, field: str) -> Optional[int]:
        """Return a non-negative journal inventory value or fail closed."""
        if value is None:
            return None
        if isinstance(value, bool):
            raise ValueError(f"{field} must be a non-negative integer")
        try:
            number = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field} must be a non-negative integer") from exc
        if number < 0:
            raise ValueError(f"{field} must be a non-negative integer")
        return number

    @classmethod
    def _normalise_inventory_watermark(
        cls, value: Mapping[str, Any], *, field: str
    ) -> Dict[str, Any]:
        if not isinstance(value, Mapping):
            raise ValueError(f"{field} must be an object")
        count = cls._inventory_int(
            value.get("hotel_count", value.get("count")), field=f"{field}.hotel_count"
        )
        max_id = cls._inventory_int(
            value.get("max_hotel_id", value.get("max_id")), field=f"{field}.max_hotel_id"
        )
        if count is None and max_id is None:
            raise ValueError(f"{field} does not contain a hotel count or maximum id")
        result: Dict[str, Any] = {
            "hotel_count": count,
            "max_hotel_id": max_id,
        }
        observed_at = value.get("observed_at")
        if isinstance(observed_at, str) and observed_at.strip():
            result["observed_at"] = observed_at.strip()[:100]
        return result

    @staticmethod
    def _merge_inventory_watermarks(
        first: Optional[Mapping[str, Any]], second: Mapping[str, Any]
    ) -> Dict[str, Any]:
        """Keep the highest known count and id; a later decrease is unsafe."""
        current = dict(first or {})
        for key in ("hotel_count", "max_hotel_id"):
            left, right = current.get(key), second.get(key)
            if isinstance(right, int) and (not isinstance(left, int) or right > left):
                current[key] = right
            elif key not in current:
                current[key] = right
        current["observed_at"] = second.get("observed_at") or current.get("observed_at")
        return current

    def _read_hotel_inventory(self) -> Dict[str, Any]:
        """Read the two cheap, order-independent hotel inventory watermarks."""
        db = get_db_session()
        try:
            count = int(db.query(func.count(Hotel.id)).scalar() or 0)
            max_id = db.query(func.max(Hotel.id)).scalar()
            return {
                "hotel_count": count,
                "max_hotel_id": int(max_id) if max_id is not None else None,
                "observed_at": _now().isoformat(),
            }
        finally:
            db.close()

    def _historical_inventory_watermark(self, journal: RunJournal) -> Optional[Dict[str, Any]]:
        """Read the high-water evidence left by prior completed/interrupted runs."""
        watermark: Optional[Dict[str, Any]] = None
        sources: List[str] = []
        for run in journal.list_runs(limit=1_000):
            metadata = run.get("metadata")
            if not isinstance(metadata, Mapping):
                # RunJournal normally rejects this before returning it.  Keep
                # the fallback here so a malformed historical record can never
                # silently lower the protection boundary.
                raise ValueError(f"journal run {run.get('run_id')} has invalid metadata")
            # An explicit, backed-up operator cleanup may legitimately lower
            # inventory. Newer run watermarks still take precedence.
            checkpoint = metadata.get("operator_inventory_checkpoint")
            if checkpoint is not None and metadata.get("database_target") == database_target():
                candidate = self._normalise_inventory_watermark(checkpoint, field="operator cleanup checkpoint")
                watermark = self._merge_inventory_watermarks(watermark, candidate)
                sources.append(str(run.get("run_id")))
                break
            for key in (
                "hotel_inventory_end",
                "hotel_inventory_watermark",
                "hotel_inventory_start",
            ):
                if key not in metadata:
                    continue
                candidate = self._normalise_inventory_watermark(
                    metadata[key], field=f"journal run {run.get('run_id')}.{key}"
                )
                watermark = self._merge_inventory_watermarks(watermark, candidate)
                sources.append(str(run.get("run_id")))
        if watermark is not None:
            watermark["source_run_ids"] = sorted(set(sources))[:50]
        return watermark

    @staticmethod
    def _inventory_shortfall(
        expected: Mapping[str, Any], observed: Mapping[str, Any]
    ) -> bool:
        expected_count, observed_count = expected.get("hotel_count"), observed.get("hotel_count")
        if isinstance(expected_count, int) and isinstance(observed_count, int):
            if observed_count < expected_count:
                return True
        expected_max, observed_max = expected.get("max_hotel_id"), observed.get("max_hotel_id")
        if isinstance(expected_max, int) and (
            not isinstance(observed_max, int) or observed_max < expected_max
        ):
            return True
        return False

    def _record_inventory_guard_event(
        self,
        *,
        phase: str,
        status: str,
        expected: Mapping[str, Any],
        observed: Mapping[str, Any],
    ) -> None:
        self._journal_safe(
            "record_report_row",
            {
                "phase": phase,
                "status": status,
                "expected": dict(expected),
                "observed": dict(observed),
            },
            kind="inventory_guard",
        )

    def _assert_inventory_safe(self, phase: str) -> Dict[str, Any]:
        """Read current inventory and pause before any downward watermark."""
        observed = self._read_hotel_inventory()
        expected = self._inventory_watermark
        if expected and self._inventory_shortfall(expected, observed):
            error = DataLossSuspected(phase=phase, expected=expected, observed=observed)
            self._inventory_blocked = error.as_dict()
            self._record_inventory_guard_event(
                phase=phase,
                status="suspected_loss",
                expected=expected,
                observed=observed,
            )
            raise error
        self._inventory_watermark = self._merge_inventory_watermarks(expected, observed)
        return observed

    async def _pause_for_inventory_loss(self, error: DataLossSuspected) -> None:
        """Pause without converting safety evidence into a Maps scrape error."""
        self._is_paused = True
        self._inventory_blocked = error.as_dict()
        self._stats["current_action"] = f"Paused: {error}"
        self._log(self._stats["current_action"], "ERROR")
        await self._journal_event(
            "record_report_row",
            {
                "phase": error.phase,
                "status": "paused_for_review",
                "expected": error.expected,
                "observed": error.observed,
            },
            kind="inventory_guard",
        )

    def _outbox_pending_count(self) -> int:
        if self._outbox is None:
            return 0
        try:
            count = self._outbox.count("pending")
        except Exception as exc:
            self._log(f"Could not read local outbox count: {_reason(exc)}", "ERROR")
            return -1
        self._stats["outbox_pending"] = count
        return count

    async def _maybe_prune_outbox(self) -> None:
        """Bound local transport-spool growth without touching pending work."""
        if self._outbox is None:
            return
        retention_days = int(settings.OUTBOX_RETENTION_DAYS)
        if retention_days <= 0:
            return
        now = time.monotonic()
        if (
            self._last_outbox_prune is not None
            and now - self._last_outbox_prune < max(0.0, float(settings.OUTBOX_PRUNE_INTERVAL_SEC))
        ):
            return
        self._last_outbox_prune = now
        removed = await asyncio.to_thread(
            self._outbox.prune_terminal,
            _now() - timedelta(days=retention_days),
        )
        if removed:
            self._log(f"Pruned {removed} terminal local outbox batch(es) older than {retention_days} day(s).")

    @staticmethod
    def _schema_diagnostic() -> str:
        diagnostics = database.schema_state.get("diagnostics") or []
        if not diagnostics:
            return "production schema is incompatible"
        first = diagnostics[0]
        if isinstance(first, Mapping):
            return str(first.get("message") or first.get("code") or "production schema is incompatible")
        return str(first)

    def _inspect_recovery(self, **paths: Any) -> Dict[str, Any]:
        """Return a detached local recovery report; this call never mutates Cloud SQL."""
        report = inspect_startup_recovery(**paths)
        if hasattr(report, "as_dict"):
            payload = report.as_dict()
        elif isinstance(report, Mapping):
            payload = dict(report)
        else:
            raise TypeError("startup recovery inspection returned an invalid report")
        if not isinstance(payload.get("safe_to_resume"), bool):
            raise ValueError("startup recovery report is missing safe_to_resume")
        self._startup_recovery = payload
        return payload

    @staticmethod
    def _recovery_block_message(report: Mapping[str, Any]) -> str:
        mode = str(report.get("recovery_mode") or "hold_for_review")
        actions = report.get("recommended_actions")
        first = actions[0] if isinstance(actions, list) and actions else None
        if isinstance(first, Mapping) and first.get("message"):
            return f"Startup recovery blocked writes ({mode}): {first['message']}"
        return f"Startup recovery blocked writes ({mode}); inspect the local recovery evidence."

    # ---- public controls ----------------------------------------------
    async def start(self) -> Dict[str, Any]:
        if self._is_running:
            if self._is_paused:
                if database.ensure_engine() is None or not await asyncio.to_thread(database.check_connection):
                    message = f"Database unreachable: {database.db_state.get('error') or 'not configured'}"
                    self._log(message, "ERROR")
                    return {"status": "error", "message": message}
                try:
                    schema_compatible = await asyncio.to_thread(database.check_schema_compatible, False)
                except Exception as exc:
                    message = f"Schema guard check failed: {_reason(exc)}"
                    self._log(message, "ERROR")
                    return {"status": "error", "message": message}
                if not schema_compatible:
                    message = f"Schema guard blocked resume: {self._schema_diagnostic()}"
                    self._log(message, "ERROR")
                    return {"status": "error", "message": message}
                try:
                    recovery = await asyncio.to_thread(self._inspect_recovery)
                except Exception as exc:
                    message = f"Startup recovery inspection failed; resume blocked: {_reason(exc)}"
                    self._log(message, "ERROR")
                    return {"status": "error", "message": message}
                if not recovery["safe_to_resume"]:
                    message = self._recovery_block_message(recovery)
                    self._stats["current_action"] = f"Paused: {message}"
                    self._log(message, "ERROR")
                    return {"status": "error", "message": message}
                try:
                    await asyncio.to_thread(self._assert_inventory_safe, "resume")
                except DataLossSuspected as exc:
                    await self._pause_for_inventory_loss(exc)
                    return {"status": "error", "message": str(exc)}
                except Exception as exc:
                    message = f"Hotel inventory guard check failed; resume blocked: {_reason(exc)}"
                    self._log(message, "ERROR")
                    return {"status": "error", "message": message}
                if self._inventory_blocked:
                    # A data-loss pause is intentionally sticky.  A schema
                    # check (or even a now-healthy count) is not an operator
                    # acknowledgement of the immutable evidence; stop and
                    # make a fresh, journal-backed start after review.
                    message = (
                        "Data-loss guard remains paused for operator review; "
                        "inspect the run evidence, then stop and start a new run."
                    )
                    self._stats["current_action"] = f"Paused: {message}"
                    self._log(message, "ERROR")
                    return {"status": "error", "message": message}
                self._is_paused = False
                self._stats["current_action"] = "Resuming queue execution..."
                self._log("Background worker resumed.")
                return {"status": "resumed", "message": "Worker resumed from pause."}
            return {"status": "already_running", "message": "Worker is already active."}

        if database.ensure_engine() is None or not await asyncio.to_thread(database.check_connection):
            message = f"Database unreachable: {database.db_state.get('error') or 'not configured'}"
            self._log(message, "ERROR")
            return {"status": "error", "message": message}
        try:
            schema_compatible = await asyncio.to_thread(database.check_schema_compatible, False)
        except Exception as exc:
            message = f"Schema guard check failed: {_reason(exc)}"
            self._log(message, "ERROR")
            return {"status": "error", "message": message}
        if not schema_compatible:
            message = f"Schema guard blocked writes: {self._schema_diagnostic()}"
            self._log(message, "ERROR")
            return {"status": "error", "message": message}
        # This is deliberately before opening a new local run or claiming a
        # ZIP.  A malformed local outbox/journal must never be auto-repaired
        # by a process that is about to write production data.
        try:
            recovery = await asyncio.to_thread(self._inspect_recovery)
        except Exception as exc:
            message = f"Startup recovery inspection failed; writes blocked: {_reason(exc)}"
            self._log(message, "ERROR")
            return {"status": "error", "message": message}
        if not recovery["safe_to_resume"]:
            message = self._recovery_block_message(recovery)
            self._stats["current_action"] = f"Paused: {message}"
            self._log(message, "ERROR")
            return {"status": "error", "message": message}
        if not await asyncio.to_thread(self._acquire_lock):
            message = "Another scraper instance is already running against this database."
            self._log(message, "ERROR")
            return {"status": "error", "message": message}

        if not worker_wake_lock.acquire():
            self._log("Could not enable sleep prevention; worker will continue.", "WARNING")
        try:
            journal, outbox = await asyncio.to_thread(self._open_durable_state)
            # A policy-restricted default path can make the worker fall back
            # to a durable temp path.  Inspect the actual selected pair too,
            # before starting a run or replaying any of its outbox rows.
            opened_recovery = await asyncio.to_thread(
                self._inspect_recovery,
                journal_path=journal.path,
                outbox_path=outbox.path,
            )
            if not opened_recovery["safe_to_resume"]:
                raise RuntimeError(self._recovery_block_message(opened_recovery))
            # The default user-local journal can outlive a development SQLite
            # database.  Only Cloud SQL history participates in the hard
            # high-water comparison; SQLite still records its fresh baseline
            # for deterministic local testing and diagnostics.
            historical_inventory = (
                await asyncio.to_thread(self._historical_inventory_watermark, journal)
                if not database.is_sqlite()
                else None
            )
            inventory_start = await asyncio.to_thread(self._read_hotel_inventory)
        except Exception as exc:
            worker_wake_lock.release()
            self._release_lock()
            message = f"Could not establish durable recovery/inventory evidence: {_reason(exc)}"
            self._log(message, "ERROR")
            return {"status": "error", "message": message}

        self._inventory_start = dict(inventory_start)
        self._inventory_watermark = self._merge_inventory_watermarks(
            historical_inventory, inventory_start
        )
        self._inventory_blocked = None
        try:
            run_id = await asyncio.to_thread(
                self._open_journal_run,
                journal=journal,
                outbox=outbox,
                inventory_start=inventory_start,
                historical_inventory=historical_inventory,
                recovery=opened_recovery,
            )
        except Exception as exc:
            worker_wake_lock.release()
            self._release_lock()
            message = f"Could not open durable scrape journal: {_reason(exc)}"
            self._log(message, "ERROR")
            return {"status": "error", "message": message}

        if historical_inventory and self._inventory_shortfall(historical_inventory, inventory_start):
            error = DataLossSuspected(
                phase="startup",
                expected=historical_inventory,
                observed=inventory_start,
            )
            # The closing snapshot records what was actually observed; the
            # immutable guard report below separately preserves the higher
            # historical watermark that caused this refusal.
            self._inventory_watermark = dict(inventory_start)
            self._inventory_blocked = error.as_dict()
            self._record_inventory_guard_event(
                phase="startup",
                status="suspected_loss",
                expected=historical_inventory,
                observed=inventory_start,
            )
            self._finish_journal_run("blocked", str(error))
            worker_wake_lock.release()
            self._release_lock()
            self._stats["current_action"] = f"Writes refused: {error}"
            self._log(self._stats["current_action"], "ERROR")
            return {"status": "error", "message": str(error)}

        self._record_inventory_guard_event(
            phase="startup",
            status="passed",
            expected=historical_inventory or inventory_start,
            observed=inventory_start,
        )

        self._is_running = True
        self._is_paused = False
        self._stop_requested = False
        self._consecutive_failures = 0
        self._captcha_failures = 0
        self._stats["started_at"] = datetime.utcnow().isoformat()
        self._stats["current_action"] = "Starting scraper background loop..."
        self._log(f"Background worker started (run {run_id}).")
        self._task = asyncio.create_task(self._run_loop())
        return {"status": "started", "message": "Background worker process started successfully."}

    async def pause(self) -> Dict[str, Any]:
        if not self._is_running:
            return {"status": "not_running", "message": "Worker is not running."}
        self._is_paused = True
        self._stats["current_action"] = "Paused"
        self._log("Background worker paused by operator.")
        return {"status": "paused", "message": "Worker paused."}

    async def stop(self) -> Dict[str, Any]:
        if not self._is_running:
            return {"status": "not_running", "message": "Worker is already stopped."}
        self._stop_requested = True
        self._is_running = False
        self._is_paused = False
        self._stats["current_action"] = "Stopped"
        if self._task and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        self._release_lock()
        worker_wake_lock.release()
        await chrome_scraper.close_browser()
        await asyncio.to_thread(self._finish_journal_run, "stopped")
        self._log("Background worker stopped by operator.")
        self._stats['current_action'] = 'Stopped'
        return {"status": "stopped", "message": "Worker stopped."}

    async def retry_failed_zips(self) -> Dict[str, Any]:
        try:
            await asyncio.to_thread(database.assert_write_safe)
        except database.SchemaIncompatible as exc:
            message = f"Schema guard blocked ZIP retry: {_reason(exc)}"
            self._log(message, "ERROR")
            return {"status": "error", "message": message}
        except database.DatabaseUnavailable as exc:
            message = f"Database unavailable; ZIP retry not attempted: {_reason(exc)}"
            self._log(message, "ERROR")
            return {"status": "error", "message": message}

        def work() -> int:
            db = get_db_session()
            try:
                count = (
                    db.query(ZipCode)
                    .filter(ZipCode.places_status.in_(("error", "quarantined")))
                    .update(
                        {"places_status": "pending", "last_error": None, "updated_at": _now()},
                        synchronize_session=False,
                    )
                )
                db.commit()
                return count
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

        try:
            count = await asyncio.to_thread(work)
            message = f"Reset {count} failed or quarantined ZIP code(s) back to pending."
            self._log(message)
            return {"status": "success", "reset_count": count, "message": message}
        except Exception as exc:
            message = f"Failed to reset failed ZIPs: {_reason(exc)}"
            self._log(message, "ERROR")
            return {"status": "error", "message": message}

    # ---- queue ---------------------------------------------------------
    def _claim_next_zip(self, db: Session) -> Optional[Tuple[str, str, str, float, float]]:
        self._assert_current_write_contract()
        # Only recover expired browser claims; VM claims have their own recovery.
        db.query(ZipCode).filter(
            ZipCode.places_status == "in_progress",
            ZipCode.last_error.like("husshone-browser:%"),
            ZipCode.updated_at < _now() - timedelta(minutes=30),
        ).update({"places_status": "pending", "last_error": None, "updated_at": _now()}, synchronize_session=False)
        query = db.query(ZipCode).filter(ZipCode.places_status == "pending")
        if self._scraper_mode == "defined_zips":
            row = query.order_by(ZipCode.updated_at.desc()).with_for_update(skip_locked=True).first()
        else:
            row = query.order_by(ZipCode.dist_km_from_kirkland.asc().nullslast()).with_for_update(skip_locked=True).first()
        if row is None and settings.REFRESH_AFTER_DAYS > 0:
            cutoff = _now() - timedelta(days=settings.REFRESH_AFTER_DAYS)
            row = (
                db.query(ZipCode)
                .filter(
                    ZipCode.places_status == "done",
                    or_(ZipCode.last_scraped_at.is_(None), ZipCode.last_scraped_at < cutoff),
                )
                # Never-scraped and oldest rows lead; among equally stale
                # areas, denser ZIPs refresh first. The daily Maps cap spreads
                # this queue across days instead of creating a burst.
                .order_by(
                    ZipCode.last_scraped_at.asc().nullsfirst(),
                    ZipCode.hotels_found.desc(),
                    ZipCode.updated_at.asc(),
                )
                .with_for_update(skip_locked=True).first()
            )
        if row is None:
            db.commit()
            return None
        result = row.zip, row.city or "", (row.state or "").strip(), row.lat, row.lng
        token = "husshone-browser:" + uuid.uuid4().hex
        row.places_status, row.last_error, row.updated_at = "in_progress", token, _now()
        db.commit()
        if not hasattr(self, "_zip_claims"):
            self._zip_claims = {}
        self._zip_claims[result[0]] = token
        return result

    def _lock_owned_zip(self, db: Session, zip_code: str) -> ZipCode:
        row = db.query(ZipCode).filter(ZipCode.zip == zip_code).with_for_update().one()
        token = getattr(self, "_zip_claims", {}).get(zip_code)
        if token and (row.places_status != "in_progress" or row.last_error != token):
            raise database.DatabaseUnavailable("ZIP lease lost; retaining batch for recovery")
        if not token and not database.is_sqlite():
            raise database.DatabaseUnavailable("ZIP write requires an owned claim")
        return row

    def _heartbeat_claims(self) -> None:
        claims = dict(getattr(self, "_zip_claims", {}))
        if not claims:
            return
        self._assert_current_write_contract()
        db = get_db_session()
        try:
            for zip_code, token in claims.items():
                db.query(ZipCode).filter(
                    ZipCode.zip == zip_code, ZipCode.places_status == "in_progress",
                    ZipCode.last_error == token,
                ).update({"updated_at": _now()}, synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _release_zip_claims(self) -> None:
        claims = dict(getattr(self, "_zip_claims", {}))
        if not claims:
            return
        self._assert_current_write_contract()
        db = get_db_session()
        try:
            for zip_code, token in claims.items():
                db.query(ZipCode).filter(
                    ZipCode.zip == zip_code, ZipCode.places_status == "in_progress",
                    ZipCode.last_error == token,
                ).update({"places_status": "pending", "last_error": None,
                          "updated_at": _now()}, synchronize_session=False)
            db.commit()
            self._zip_claims.clear()
        finally:
            db.close()

    async def _lease_heartbeat_loop(self) -> None:
        while self._is_running:
            try:
                await asyncio.to_thread(self._heartbeat_claims)
            except Exception as exc:
                self._log(f"ZIP lease heartbeat failed: {_reason(exc)}", "WARNING")
            await asyncio.sleep(30)

    def _claim_outbox_zip(self, entry: OutboxBatch) -> None:
        self._assert_current_write_contract()
        db = get_db_session()
        try:
            row = db.query(ZipCode).filter(ZipCode.zip == entry.zip_code).with_for_update().one()
            token = entry.metadata.get("claim_token") or "husshone-browser:" + uuid.uuid4().hex
            if row.places_status == "in_progress" and row.last_error != token:
                raise database.DatabaseUnavailable("Another worker owns the outbox ZIP; waiting")
            row.places_status, row.last_error, row.updated_at = "in_progress", token, _now()
            db.commit()
            if not hasattr(self, "_zip_claims"):
                self._zip_claims = {}
            self._zip_claims[entry.zip_code] = token
        finally:
            db.close()

    def _next_zip_sync(self) -> Optional[Tuple[str, str, str, float, float]]:
        db = get_db_session()
        try:
            return self._claim_next_zip(db)
        finally:
            db.close()

    # ---- scraper result contract --------------------------------------
    @staticmethod
    def _normalize_scrape_result(value: Any) -> ScrapeResult:
        """Normalise modern results and old list test doubles.

        An empty legacy list is selector failure, never explicit empty.
        """
        if isinstance(value, ScrapeResult):
            result = ScrapeResult(
                _status(value.status) or ScrapeStatus.TRANSPORT_FAILURE,
                records=list(value.records or []),
                reason=value.reason,
                query=value.query,
                selector=value.selector,
            )
        elif isinstance(value, list):
            result = (
                ScrapeResult(ScrapeStatus.SUCCESS, records=value)
                if value
                else ScrapeResult(
                    ScrapeStatus.SELECTOR_FAILURE,
                    reason="legacy scraper returned an unqualified empty result",
                )
            )
        elif isinstance(value, Mapping):
            rows = value.get("records", value.get("results", []))
            rows = list(rows) if isinstance(rows, (list, tuple)) else []
            result = ScrapeResult(
                _status(value.get("status"))
                or (ScrapeStatus.SUCCESS if rows else ScrapeStatus.SELECTOR_FAILURE),
                records=rows,
                reason=value.get("reason"),
                query=value.get("query"),
                selector=value.get("selector"),
            )
        elif hasattr(value, "status") and hasattr(value, "records"):
            rows = getattr(value, "records", [])
            result = ScrapeResult(
                _status(getattr(value, "status", None)) or ScrapeStatus.TRANSPORT_FAILURE,
                records=list(rows) if isinstance(rows, (list, tuple)) else [],
                reason=getattr(value, "reason", None),
                query=getattr(value, "query", None),
                selector=getattr(value, "selector", None),
            )
        elif value is None:
            result = ScrapeResult(ScrapeStatus.TRANSPORT_FAILURE, reason="Maps scraper returned no result")
        else:
            result = ScrapeResult(
                ScrapeStatus.TRANSPORT_FAILURE,
                reason=f"unsupported Maps result type: {type(value).__name__}",
            )
        if result.status == ScrapeStatus.SUCCESS and not result.records:
            return ScrapeResult(
                ScrapeStatus.SELECTOR_FAILURE,
                reason=result.reason or "Maps returned success without parseable records",
                query=result.query,
                selector=result.selector,
            )
        return result

    async def _scrape_maps(self, city: str, state: str, zip_code: str) -> ScrapeResult:
        self._maps_calls_today += 1
        self._stats["api_calls"] += 1
        try:
            result = await chrome_scraper.scrape_google_maps_hotels(
                city, state, zip_code, settings.MAPS_MAX_RESULTS
            )
            result = self._normalize_scrape_result(result)
            if result.status == ScrapeStatus.SUCCESS:
                from app.vm_runtime import map_browser_results
                result.records = await map_browser_results(result.records, city, state, zip_code)
            return result
        except chrome_scraper.ScrapeBlocked as exc:
            return ScrapeResult(ScrapeStatus.BLOCKED, reason=_reason(exc))
        except Exception as exc:
            return ScrapeResult(ScrapeStatus.TRANSPORT_FAILURE, reason=_reason(exc))

    def _canary_metadata(self, zip_code: str) -> Optional[Tuple[str, str, float, float]]:
        """Read the configured canary ZIP only; this method makes no writes."""
        db = get_db_session()
        try:
            row = db.get(ZipCode, zip_code)
            if row is None:
                return None
            return row.city or "", (row.state or "").strip(), row.lat, row.lng
        finally:
            db.close()

    async def _maybe_run_canary(self) -> bool:
        """Run a no-write Maps health probe when configured and due.

        A failed canary pauses the worker. Resuming it retries the failed
        canary immediately, rather than letting normal ZIP writes bypass it.
        """
        zip_code = (settings.CANARY_ZIP or "").strip()
        if not zip_code:
            return True
        now = time.monotonic()
        interval = max(0.0, float(settings.CANARY_INTERVAL_SEC))
        if (
            not self._canary_failed
            and self._last_canary_at is not None
            and now - self._last_canary_at < interval
        ):
            return True
        self._last_canary_at = now
        metadata = await asyncio.to_thread(self._canary_metadata, zip_code)
        if metadata is None:
            reason = f"configured canary ZIP {zip_code} is not present in zips"
            self._canary_failed = True
            self._is_paused = True
            self._stats["current_action"] = f"Paused: {reason}"
            self._log(reason, "ERROR")
            await self._journal_event(
                "record_zip_outcome",
                zip_code,
                "canary_failure",
                reason=reason,
                evidence={"canary": True, "maps_status": "not_configured"},
                hotels_seen=0,
                hotels_new=0,
            )
            return False

        city, state, _lat, _lng = metadata
        result = await self._scrape_maps(city, state, zip_code)
        assessment = assess_canary(result, int(settings.CANARY_MIN_RESULTS))
        evidence = {
            "canary": True,
            "maps_status": result.status.value,
            "reason": result.reason,
            "minimum_results": settings.CANARY_MIN_RESULTS,
            "result_count": assessment.result_count,
        }
        await self._journal_event(
            "record_zip_outcome",
            zip_code,
            "canary_success" if assessment.healthy else "canary_failure",
            reason=None if assessment.healthy else assessment.reason,
            evidence=evidence,
            hotels_seen=assessment.result_count,
            hotels_new=0,
        )
        if assessment.healthy:
            self._canary_failed = False
            self._log(f"Canary ZIP {zip_code} healthy ({assessment.result_count} results).")
            return True

        self._canary_failed = True
        self._is_paused = True
        self._stats["current_action"] = f"Paused: canary failed ({assessment.reason})"
        self._log(
            f"Canary ZIP {zip_code} failed: {assessment.reason}; worker auto-paused.",
            "ERROR",
        )
        return False

    def _run_data_quality_audit_sync(self):
        db = get_db_session()
        try:
            return audit_hotels(
                db,
                finding_limit=int(settings.DATA_QUALITY_AUDIT_FINDING_LIMIT),
                shape_scan_limit=int(settings.DATA_QUALITY_AUDIT_SCAN_LIMIT),
                shape_cursor_after_id=self._data_quality_cursor,
                max_zip_distance_km=float(settings.ZIP_MAX_DISTANCE_KM),
            )
        finally:
            db.close()

    async def _maybe_run_data_quality_audit(self) -> None:
        """Run one read-only, keyset-paged quality pass at a bounded cadence."""
        interval = float(settings.DATA_QUALITY_AUDIT_INTERVAL_SEC)
        if interval <= 0:
            return
        now = time.monotonic()
        if self._last_data_quality_audit is not None and now - self._last_data_quality_audit < interval:
            return
        # Mark the attempt before doing the work so a transient failure cannot
        # turn a large read-only audit into a tight retry loop.
        self._last_data_quality_audit = now
        report = await asyncio.to_thread(self._run_data_quality_audit_sync)
        self._data_quality_cursor = report.next_shape_cursor
        await self._journal_event("record_report_row", report.as_dict(), kind="data_quality")
        summary = report.summary()
        level = "WARNING" if not report.is_clean else "INFO"
        suffix = (
            f"; next shape cursor {report.next_shape_cursor}"
            if report.next_shape_cursor is not None
            else ""
        )
        self._log(
            "Data-quality audit: "
            f"{summary['duplicate_google_cids']} duplicate CID group(s), "
            f"{summary['coordinate_issues']} coordinate issue(s), "
            f"{summary['shape_issues']} shape issue(s) across {summary['shape_rows_scanned']} rows"
            f"{suffix}.",
            level,
        )

    # ---- validation and secondary identities --------------------------
    @staticmethod
    def _merge_records(current: Dict[str, Any], incoming: Dict[str, Any]) -> None:
        current["sources"] = sorted(set(current.get("sources", [])) | set(incoming.get("sources", [])))
        for name in (
            "place_id", "osm_id", "formatted_address", "rating", "user_ratings_total",
            "price_level", "phone", "website", "google_maps_uri", "primary_type",
            "types", "business_status",
        ):
            if current.get(name) is None and incoming.get(name) is not None:
                current[name] = incoming[name]
        old_raw = current.get("raw") if isinstance(current.get("raw"), dict) else {}
        incoming_raw = incoming.get("raw") if isinstance(incoming.get("raw"), dict) else {}
        current["raw"] = {**old_raw, **incoming_raw}

    def _collapse_records(self, rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        output: List[Dict[str, Any]] = []
        by_key: Dict[str, Dict[str, Any]] = {}
        by_place: Dict[str, Dict[str, Any]] = {}
        by_cid: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            key = row["dedup_key"]
            place_id = _clean(row.get("place_id"))
            cid = google_cid(row)
            existing = (
                (by_place.get(place_id) if place_id else None)
                or (by_cid.get(cid) if cid else None)
                or by_key.get(key)
            )
            if existing is None:
                existing = row
                output.append(existing)
            else:
                if existing["dedup_key"] != key:
                    self._log(
                        f"Collapsed Maps cards with shared identity and different keys for {existing['name']}",
                        "WARNING",
                    )
                self._merge_records(existing, row)
            by_key[key] = existing
            if place_id:
                by_place[place_id] = existing
            if cid:
                by_cid[cid] = existing
        return output

    def _prepare_records(
        self,
        zip_code: str,
        zip_lat: float,
        zip_lng: float,
        candidates: Sequence[Any],
        *,
        run_id: Optional[str],
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Optional[str]]]]:
        try:
            centroid_lat, centroid_lng = float(zip_lat), float(zip_lng)
        except (TypeError, ValueError) as exc:
            raise ZipQuarantined(
                zip_code,
                "ZIP has invalid centroid coordinates",
                evidence={"zip_lat": zip_lat, "zip_lng": zip_lng},
            ) from exc

        maps: List[Dict[str, Any]] = []
        rejected: List[Dict[str, Optional[str]]] = []
        for candidate in candidates:
            if isinstance(candidate, Mapping):
                maps.append(dict(candidate))
            else:
                rejected.append({"name": None, "reason": "record is not an object"})
        valid, failures = validate_records(
            maps,
            zip_lat=centroid_lat,
            zip_lng=centroid_lng,
            max_distance_km=settings.ZIP_MAX_DISTANCE_KM,
        )
        rejected.extend(failure.as_dict() for failure in failures)

        prepared: List[Dict[str, Any]] = []
        for row in valid:
            row = dict(row)
            row["dedup_key"] = generate_dedup_key(row["name"], row["lat"], row["lng"])
            row["place_id"] = _clean(row.get("place_id"))
            raw = dict(row.get("raw") or {})
            raw["scraped_via"] = SCRAPED_VIA if "places" in row["sources"] else "osm_overpass"
            # This is the collection time, distinct from the database-managed
            # first_seen/last_seen timestamps and useful when replaying a run.
            raw.setdefault("scraped_at", _now().isoformat())
            cid = google_cid(row)
            if cid:
                raw["google_cid"] = cid
            if run_id:
                raw["scrape_run_id"] = run_id
                raw["run_id"] = run_id
            row["raw"] = raw
            prepared.append(row)
        return self._collapse_records(prepared), rejected

    @staticmethod
    def _snapshot(row: Hotel) -> Dict[str, Any]:
        return {column.name: getattr(row, column.name) for column in Hotel.__table__.columns}

    @staticmethod
    def _snapshot_cid(snapshot: Mapping[str, Any]) -> Optional[str]:
        raw = snapshot.get("raw")
        return google_cid({"raw": raw}) if isinstance(raw, dict) else None

    def _assert_current_write_contract(self) -> None:
        """Recheck the cached catalog contract during long-lived operation."""
        if database.is_sqlite():
            return
        if not database.check_schema_compatible():
            diagnostics = database.schema_state.get("diagnostics") or []
            if any(
                isinstance(diagnostic, Mapping) and diagnostic.get("code") == "inspection_error"
                for diagnostic in diagnostics
            ):
                raise database.DatabaseUnavailable(self._schema_diagnostic())
            raise database.SchemaIncompatible(self._schema_diagnostic())

    def _existing_rows(
        self, db: Session, records: Sequence[Dict[str, Any]]
    ) -> Tuple[Dict[str, List[Hotel]], Dict[str, List[Hotel]], Dict[str, List[Hotel]]]:
        keys = [record["dedup_key"] for record in records]
        place_ids = sorted({
            _clean(record.get("place_id"))
            for record in records
            if _clean(record.get("place_id"))
        })
        cids = sorted({google_cid(record) for record in records if google_cid(record)})
        conditions = [Hotel.dedup_key.in_(keys)]
        if place_ids:
            conditions.append(Hotel.place_id.in_(place_ids))
        if cids:
            conditions.append(Hotel.raw["google_cid"].as_string().in_(cids))
        rows = db.query(Hotel).filter(or_(*conditions)).order_by(Hotel.id).with_for_update().all()
        by_key: Dict[str, List[Hotel]] = {}
        by_place: Dict[str, List[Hotel]] = {}
        by_cid: Dict[str, List[Hotel]] = {}
        for row in rows:
            by_key.setdefault(row.dedup_key, []).append(row)
            if row.place_id:
                by_place.setdefault(row.place_id, []).append(row)
            cid = google_cid({"raw": row.raw}) if isinstance(row.raw, dict) else None
            if cid:
                by_cid.setdefault(cid, []).append(row)
        return by_key, by_place, by_cid

    @staticmethod
    def _unique_rows(rows: Iterable[Hotel]) -> List[Hotel]:
        output: Dict[Any, Hotel] = {}
        for row in rows:
            output[row.id if getattr(row, "id", None) is not None else id(row)] = row
        return list(output.values())

    def _resolve_existing(
        self,
        zip_code: str,
        record: Dict[str, Any],
        by_key: Mapping[str, List[Hotel]],
        by_place: Mapping[str, List[Hotel]],
        by_cid: Mapping[str, List[Hotel]],
    ) -> Optional[Hotel]:
        matches: List[Hotel] = list(by_key.get(record["dedup_key"], []))
        place_id = _clean(record.get("place_id"))
        cid = google_cid(record)
        if place_id:
            matches.extend(by_place.get(place_id, []))
        if cid:
            matches.extend(by_cid.get(cid, []))
        matches = self._unique_rows(matches)
        if len(matches) > 1:
            raise ZipQuarantined(
                zip_code,
                "record identity resolves to multiple production hotels",
                evidence={
                    "name": record["name"],
                    "dedup_key": record["dedup_key"],
                    "place_id": place_id,
                    "google_cid": cid,
                    "hotel_ids": [row.id for row in matches],
                },
            )
        return matches[0] if matches else None

    @staticmethod
    def _new_row(zip_code: str, state: str, record: Dict[str, Any], now: datetime) -> Dict[str, Any]:
        address = _clean(record.get("formatted_address"))
        zip_match = ZIP_IN_ADDRESS.findall(address) if address else []
        return {
            "dedup_key": record["dedup_key"],
            "place_id": _clean(record.get("place_id")),
            "osm_id": _clean(record.get("osm_id")),
            "sources": record["sources"],
            "name": record["name"],
            "formatted_address": address,
            "zip": _clean(record.get("zip")) or (zip_match[-1] if zip_match else None),
            "query_zip": zip_code,
            "state": (_clean(record.get("state")) or state or "")[:2] or None,
            "lat": record["lat"],
            "lng": record["lng"],
            "rating": record.get("rating"),
            "user_ratings_total": record.get("user_ratings_total"),
            "price_level": _clean(record.get("price_level")),
            "phone": _clean(record.get("phone")),
            "website": _clean(record.get("website")),
            "google_maps_uri": _clean(record.get("google_maps_uri")),
            "primary_type": _clean(record.get("primary_type")) or "hotel",
            "types": record.get("types") or ["hotel", "lodging"],
            "business_status": _clean(record.get("business_status")),
            "raw": dict(record.get("raw") or {}),
            "first_seen": now,
            "last_seen": now,
            "photo_refs": [],
            "photos": [],
            "photos_status": "pending",
            "photos_count": 0,
        }

    @staticmethod
    def _touch_row(row: Hotel, record: Dict[str, Any], now: datetime) -> None:
        # An outbox can survive for days. Never replace newer VM enrichment
        # with an older observation replayed after a database outage.
        collected_at = (record.get("raw") or {}).get("scraped_at")
        if collected_at and row.last_seen:
            try:
                collected = datetime.fromisoformat(collected_at.replace("Z", "+00:00"))
                previous = row.last_seen
                if previous.tzinfo is None:
                    previous = previous.replace(tzinfo=timezone.utc)
                if collected.tzinfo is None:
                    collected = collected.replace(tzinfo=timezone.utc)
                if previous > collected:
                    return
            except (TypeError, ValueError):
                raise ValueError("Invalid scraped_at timestamp; refusing hotel refresh")
        row.sources = sorted(set(row.sources or []) | set(record["sources"]))
        if record.get("rating") is not None and "places" in record["sources"]:
            row.rating = record["rating"]
        for field_name in ("user_ratings_total", "price_level", "business_status"):
            if record.get(field_name) is not None and "places" in record["sources"]:
                setattr(row, field_name, record[field_name])
        for field_name in ("formatted_address", "zip", "state", "osm_id"):
            if not getattr(row, field_name) and record.get(field_name):
                setattr(row, field_name, record[field_name])
        if not row.phone and _clean(record.get("phone")):
            row.phone = _clean(record.get("phone"))
        if not row.website and _clean(record.get("website")):
            row.website = _clean(record.get("website"))
        if not row.google_maps_uri and _clean(record.get("google_maps_uri")):
            row.google_maps_uri = _clean(record.get("google_maps_uri"))
        if not row.place_id and _clean(record.get("place_id")):
            row.place_id = _clean(record.get("place_id"))
        raw = dict(row.raw) if isinstance(row.raw, dict) else {}
        raw.update(dict(record.get("raw") or {}))
        row.raw = raw
        row.last_seen = now

    # ---- durable local outbox -----------------------------------------
    def _outbox_metadata(self, batch: _PendingBatch) -> Dict[str, Any]:
        return {
            "database_target": database_target(),
            "city": batch.city,
            "state": batch.state,
            "zip_lat": batch.lat,
            "zip_lng": batch.lng,
            "scraped_via": SCRAPED_VIA,
            "maps_status": batch.result.status.value,
            "query": batch.result.query,
            "selector": batch.result.selector,
            "claim_token": getattr(self, "_zip_claims", {}).get(batch.zip_code),
        }

    async def _enqueue_outbox_batch(self, batch: _PendingBatch) -> OutboxBatch:
        """Persist a validated Maps batch before any Cloud SQL mutation."""
        if self._outbox is None or self._run_id is None:
            raise OutboxError("Durable local outbox is not initialized")
        if batch.records is None:
            raise OutboxError("Cannot enqueue an unprepared Maps batch")
        if batch.outbox_batch_id:
            return await asyncio.to_thread(self._outbox.get, batch.outbox_batch_id)

        # This stable ID makes a retry after a process interruption harmless.
        # One run can remain alive across multiple 30-day refresh cycles.
        # Include the stable claim token so a later pass is a new delivery.
        claim_token = getattr(self, "_zip_claims", {}).get(batch.zip_code)
        batch_id = f"{self._run_id}:{batch.zip_code}:{claim_token or batch.records[0]['raw']['scraped_at']}"
        entry = await asyncio.to_thread(
            self._outbox.enqueue,
            self._run_id,
            batch.zip_code,
            batch.records,
            metadata=self._outbox_metadata(batch),
            batch_id=batch_id,
        )
        batch.outbox_batch_id = entry.batch_id
        self._outbox_pending_count()
        self._log(
            f"ZIP {batch.zip_code}: durably queued {entry.record_count} Maps record(s) in local outbox."
        )
        return entry

    @staticmethod
    def _outbox_location(entry: OutboxBatch) -> Tuple[str, float, float]:
        metadata = entry.metadata
        try:
            state = str(metadata.get("state") or "").strip()[:2]
            lat = float(metadata["zip_lat"])
            lng = float(metadata["zip_lng"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ZipQuarantined(
                entry.zip_code,
                "local outbox batch is missing valid ZIP metadata",
                evidence={"outbox_batch_id": entry.batch_id, "metadata": metadata},
                hotels_seen=entry.record_count,
                hotels_new=0,
            ) from exc
        return state, lat, lng

    async def _flush_outbox_entry(self, entry: OutboxBatch) -> Tuple[int, int]:
        """Commit one durable batch, then acknowledge it locally.

        A crash between the Cloud SQL commit and the local acknowledgement is
        safe: replay resolves through the existing dedup/place/CID identities.
        """
        if self._outbox is None:
            raise OutboxError("Durable local outbox is not initialized")
        # Check before claiming a ZIP or opening any remote transaction.
        require_matching_target(entry.metadata)
        if settings.WEBSITE_ENRICHMENT_ENABLED:
            await asyncio.to_thread(self._queue_websites, entry)
        state, lat, lng = self._outbox_location(entry)
        await asyncio.to_thread(self._claim_outbox_zip, entry)
        # The outbox is durable, not implicitly trusted: validate the decoded
        # payload again before a replayed batch can reach Cloud SQL.
        records, rejected = self._prepare_records(
            entry.zip_code,
            lat,
            lng,
            entry.records,
            run_id=entry.run_id,
        )
        if rejected or not records:
            raise ZipQuarantined(
                entry.zip_code,
                "local outbox batch failed replay validation",
                evidence={
                    "outbox_batch_id": entry.batch_id,
                    "rejected_records": rejected[:25],
                },
                hotels_seen=entry.record_count,
                hotels_new=0,
            )
        touched, added = await asyncio.to_thread(
            self._save_results,
            entry.zip_code,
            state,
            lat,
            lng,
            records,
            run_id=entry.run_id,
            validated=True,
        )
        await asyncio.to_thread(
            self._outbox.mark_delivered,
            entry.batch_id,
            delivery_metadata={
                "touched": touched,
                "inserted": added,
                "cloud_sql_committed_at": _now().isoformat(),
            },
        )
        self._outbox_pending_count()
        return touched, added

    async def _flush_one_outbox_batch(self) -> bool:
        """Flush the oldest pending batch before new Maps work begins."""
        if self._outbox is None:
            return False
        pending = await asyncio.to_thread(self._outbox.pending, limit=1)
        if not pending:
            self._outbox_pending_count()
            return False
        entry = pending[0]
        self._stats["current_action"] = (
            f"Flushing durable outbox batch for ZIP {entry.zip_code} ({entry.record_count} records)"
        )
        try:
            touched, added = await self._flush_outbox_entry(entry)
        except ZipQuarantined as exc:
            evidence = dict(exc.evidence)
            evidence["outbox_batch_id"] = entry.batch_id
            await asyncio.to_thread(self._mark_zip_quarantined, entry.zip_code, exc.reason)
            await asyncio.to_thread(
                self._outbox.mark_quarantined,
                entry.batch_id,
                exc.reason,
                evidence=evidence,
            )
            self._stats["zips_quarantined"] += 1
            self._outbox_pending_count()
            await self._journal_event(
                "quarantine_zip",
                entry.zip_code,
                reason=exc.reason,
                evidence=evidence,
                hotels_seen=exc.hotels_seen,
                hotels_new=exc.hotels_new,
            )
            self._log(f"Outbox batch for ZIP {entry.zip_code} quarantined: {exc.reason}", "WARNING")
            return True

        self._stats["zips_processed"] += 1
        self._stats["hotels_found"] += entry.record_count
        self._stats["hotels_added"] += added
        await self._journal_event(
            "record_zip_outcome",
            entry.zip_code,
            "outbox_flushed",
            evidence={"outbox_batch_id": entry.batch_id, "touched": touched},
            hotels_seen=entry.record_count,
            hotels_new=added,
        )
        self._log(
            f"Flushed durable outbox batch for ZIP {entry.zip_code}: {added} new, {touched} updated."
        )
        return True

    # ---- persistence ---------------------------------------------------
    def _queue_websites(self, entry):
        if self._website_queue is None:
            self._website_queue = WebsiteQueue()
        for record in entry.records:
            if blank(record.get("website")) and settings.WEBSITE_DISCOVERY_BACKFILL:
                from app.website_discovery import maps_identity_url
                try:
                    maps_identity_url(record)
                except ValueError:
                    continue
                record = {**record, "_discover_website": True}
            self._website_queue.enqueue(record, entry.run_id, entry.metadata["database_target"],
                                        fill_missing=settings.WEBSITE_FILL_MISSING_FIELDS)

    def _scan_website_backfill(self):
        """Keyset scan of a fixed inventory snapshot; no Cloud SQL mutation."""
        if not settings.WEBSITE_FILL_MISSING_FIELDS:
            return
        status = self._website_queue.backfill_status()
        if (settings.WEBSITE_AUTONOMOUS and settings.WEBSITE_BACKFILL_AUTO_START
                and (status["state"] == "not_started" or (status["state"] == "completed"
                    and time.time() - status.get("updated_at", time.time()) >= max(3600, settings.WEBSITE_BACKFILL_REFRESH_SEC)))):
            db = get_db_session()
            try:
                if db.bind.dialect.name == "postgresql":
                    db.execute(text("SET TRANSACTION READ ONLY"))
                ceiling = db.query(func.max(Hotel.id)).scalar() or 0
                status = self._website_queue.start_backfill(ceiling)
            finally:
                db.close()
        if status["state"] != "running":
            return
        # Historical admission has its own bounded lane; normal discovery
        # must not monopolize every slot and permanently starve old rows.
        counts = status.get("jobs", {})
        active = sum(counts.get(s, 0) for s in ("pending", "retry", "fetched"))
        slots = max(0, min(1000, settings.WEBSITE_BACKFILL_MAX_PENDING) - active)
        if not slots:
            return
        db = get_db_session()
        try:
            if db.bind.dialect.name == "postgresql":
                db.execute(text("SET TRANSACTION READ ONLY"))
            columns = [Hotel.id, Hotel.dedup_key, Hotel.place_id, Hotel.name, Hotel.website,
                       Hotel.phone, Hotel.formatted_address, Hotel.zip, Hotel.state,
                       Hotel.lat, Hotel.lng, Hotel.query_zip, Hotel.sources, Hotel.raw, Hotel.last_seen, Hotel.google_maps_uri]
            scan_fields = (*WEBSITE_FILL_FIELDS, "website") if settings.WEBSITE_DISCOVERY_BACKFILL else WEBSITE_FILL_FIELDS
            filters = [or_(getattr(Hotel, f).is_(None), func.trim(getattr(Hotel, f)) == "") for f in scan_fields]
            rows = db.query(Hotel).options(load_only(*columns)).filter(
                Hotel.id > status["cursor"], Hotel.id <= status["ceiling"], or_(*filters)
            ).order_by(Hotel.id).limit(min(1000, max(1, settings.WEBSITE_BACKFILL_BATCH_SIZE))).all()
            cursor, scanned, missing = status["cursor"], 0, 0
            for row in rows:
                if not slots:
                    break
                cursor, scanned = row.id, scanned + 1
                if blank(row.website):
                    missing += 1
                record = {column.key: getattr(row, column.key) for column in columns if column.key != "last_seen"}
                raw = row.raw if isinstance(row.raw, dict) else {}
                record["raw"] = {"google_cid": raw.get("google_cid"),
                    "website_enrichment": raw.get("website_enrichment"),
                    "scraped_at": row.last_seen.isoformat() if row.last_seen else None}
                if blank(row.website):
                    if not settings.WEBSITE_DISCOVERY_BACKFILL:
                        continue
                    from app.website_discovery import maps_identity_url
                    try:
                        maps_identity_url(record)
                    except ValueError:
                        continue
                    record["_discover_website"] = True
                self._website_queue.enqueue(record, status["run_id"], database_target(),
                                            fill_missing=True, backfill_id=status["run_id"])
                slots -= 1
            # Enqueue first, checkpoint second. A crash in between repeats
            # deterministic job IDs, not a skipped hotel or duplicate fetch.
            exhausted = not rows
            self._website_queue.checkpoint_backfill(status["run_id"],
                status["ceiling"] if exhausted else cursor, scanned, missing, exhausted)
        finally:
            db.close()

    def _apply_website_evidence(self, job):
        require_matching_target(job["payload"])
        self._assert_current_write_contract()
        self._assert_inventory_safe("before_website_enrichment")
        record = job["payload"]["record"]
        db = get_db_session()
        try:
            indexes = self._existing_rows(db, [record])
            row = self._resolve_existing(record.get("query_zip") or "", record, *indexes)
            if row is None:
                # A quarantined/uncommitted Maps batch must never create a row
                # through the website path. Retain its evidence locally only.
                db.rollback()
                return False
            result = job["result"]
            discovery = record.get("_discover_website")
            prior_fields = (row.raw or {}).get("website_field_fills", {})
            prior_website = prior_fields.get("website", {}) if isinstance(prior_fields, dict) else {}
            replayed_discovery = (discovery and isinstance(prior_website, dict)
                and prior_website.get("job_id") == job["id"]
                and row.website == prior_website.get("value") == result.get("requested_url"))
            if row.website != record.get("website") and not replayed_discovery:
                db.rollback()
                return False
            raw = dict(row.raw or {})
            previous = raw.get("website_enrichment") or {}
            if previous.get("collected_at", "") > result.get("collected_at", ""):
                db.rollback()
                return False
            if previous.get("status") == "collected" and result.get("status") != "collected":
                db.rollback()
                return False
            before = self._snapshot(row)
            # Recheck blanks while holding the hotel row lock. A VM/user may
            # have populated a column since this website job was queued.
            fills = {}
            if discovery and not replayed_discovery:
                from app.website_enrichment import matched_business, safe_url
                current = {field: getattr(row, field, None) for field in ("name", "phone", "formatted_address", "lat", "lng")}
                if (not blank(row.website) or result.get("status") != "collected"
                        or result.get("identity") != "corroborated_public_data"
                        or not isinstance(result.get("identity_node"), dict)
                        or not matched_business(result["identity_node"], current)
                        or not job["payload"].get("fill_missing") or not settings.WEBSITE_FILL_MISSING_FIELDS):
                    db.rollback()
                    return False
                value = safe_url(result.get("requested_url"))
                fills["website"] = {"previous": row.website, "value": value,
                    "source_url": result.get("discovery_source_url"), "collected_at": result.get("collected_at"),
                    "run_id": job["payload"]["run_id"], "job_id": job["id"]}
                row.website = value
            if job["payload"].get("fill_missing") and settings.WEBSITE_FILL_MISSING_FIELDS:
                for field, (value, evidence) in fill_candidates(row, result).items():
                    fills[field] = {"previous": getattr(row, field), "value": value,
                        "source_url": evidence["source_url"], "collected_at": evidence.get("collected_at"),
                        "run_id": job["payload"]["run_id"], "job_id": job["id"]}
                    setattr(row, field, value)
            if fills:
                prior_fills = raw.get("website_field_fills")
                raw["website_field_fills"] = {**(prior_fills if isinstance(prior_fills, dict) else {}), **fills}
            raw["website_enrichment"] = {**result, "run_id": job["payload"]["run_id"],
                                          "job_id": job["id"]}
            row.raw = raw
            db.commit()
            after = self._snapshot(row)
            self._journal_safe("record_hotel_touch", before=before, after=after,
                               hotel_id=row.id, dedup_key=row.dedup_key,
                               cid=self._snapshot_cid(after))
            filled_fields = [field for field, evidence in (raw.get("website_field_fills") or {}).items()
                             if isinstance(evidence, dict) and evidence.get("job_id") == job["id"]]
            return {"hotel_id": row.id, "filled_fields": filled_fields}
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _website_backpressure(self):
        if not settings.WEBSITE_ENRICHMENT_ENABLED or self._website_queue is None:
            self._website_pressure = False
            return False
        queued = self._website_queue.scheduler_status()["queued"]
        high = max(1, settings.WEBSITE_BACKLOG_HIGH)
        low = min(high - 1, max(0, settings.WEBSITE_BACKLOG_LOW))
        if queued >= high:
            self._website_pressure = True
        elif queued <= low:
            self._website_pressure = False
        return self._website_pressure

    def _has_website_headroom(self):
        from app.resource_budget import available_memory_bytes
        available = available_memory_bytes()
        return available is not None and available >= max(2, settings.WEBSITE_MIN_FREE_RAM_GB) * 1024 ** 3

    async def _prefetch_website_pair(self):
        """Overlap two distinct hosts; remote writes remain in the normal serial path."""
        if settings.WEBSITE_FETCH_CONCURRENCY < 2 or not settings.WEBSITE_ENRICHMENT_ENABLED or self._website_queue is None:
            return False
        if not self._has_website_headroom():
            return False
        from urllib.parse import urlsplit
        selected, excluded, hosts = [], [], set()
        for _ in range(8):
            job = await asyncio.to_thread(self._website_queue.next_job,
                prefer_backfill=bool((self._website_turn + len(selected)) % 2), exclude_ids=excluded)
            if not job or job["state"] == "fetched":
                return False
            excluded.append(job["id"])
            record = job["payload"]["record"]
            if record.get("_discover_website"):
                if not selected:
                    return False  # Maps discovery stays serial and rate-capped.
                continue
            host = (urlsplit(record.get("website") or "").hostname or "").removeprefix("www.")
            if not host or host in hosts:
                continue
            selected.append(job)
            hosts.add(host)
            if len(selected) == 2:
                break
        if len(selected) != 2 or self._is_paused or not self._is_running:
            return False
        names = [job["payload"]["record"]["name"] for job in selected]
        self._website_activity = {"state": "processing", "hotel": " + ".join(names), "collectors": 2}
        self._stats["current_action"] = "Collecting two independent websites (low-priority, GPU disabled)"
        async def fetch_and_persist(job):
            result = await collect_website(job["payload"]["record"])
            await asyncio.to_thread(self._website_queue.save_result, job, result)
        results = await asyncio.gather(*(fetch_and_persist(job) for job in selected), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        return True

    async def _fill_website_fetch_pool(self):
        """Launch independent collectors; only local durable evidence is saved.

        Database application stays in the main worker loop. Slow hosts cannot
        block other collectors or Maps, and restart leaves unfinished jobs due.
        """
        if not settings.WEBSITE_ENRICHMENT_ENABLED or not self._is_running or self._is_paused:
            return
        if not hasattr(self, '_fetch_fill_lock'):
            self._fetch_fill_lock = asyncio.Lock()
        async with self._fetch_fill_lock:
            from app.performance import collector_limit
            from urllib.parse import urlsplit
            for key, task in list(self._website_fetches.items()):
                if task.done():
                    task.result()
                    self._website_fetches.pop(key)
            if self._website_queue is None:
                self._website_queue = await asyncio.to_thread(WebsiteQueue)
            cap = collector_limit(len(self._website_fetches))
            excluded = list(self._website_fetches)
            for _ in range(128):
                if len(self._website_fetches) >= cap or self._is_paused:
                    break
                job = await asyncio.to_thread(self._website_queue.next_job, network_only=True,
                                             exclude_ids=excluded, prefer_backfill=bool(self._website_turn % 2))
                if not job:
                    break
                excluded.append(job['id'])
                record = job['payload']['record']
                discovery = bool(record.get('_discover_website'))
                host = '__maps_discovery__' if discovery else (urlsplit(record.get('website') or '').hostname or '').removeprefix('www.')
                if not host or host in self._website_hosts:
                    continue
                if discovery:
                    if self._maps_cap_reached():
                        await asyncio.to_thread(self._website_queue.defer, job, 300)
                        continue
                    self._maps_calls_today += 1
                    self._stats['api_calls'] += 1
                self._website_hosts.add(host)
                self._website_turn += 1
                async def fetch_one(job=job, host=host):
                    try:
                        result = await collect_website(job['payload']['record'], timeout=max(15, min(150, settings.WEBSITE_PROCESS_TIMEOUT_SEC)))
                        await asyncio.to_thread(self._website_queue.save_result, job, result)
                        self._website_fetch_stats['completed'] += 1
                        self._website_fetch_stats['last_finished_at'] = _now().isoformat()
                        if result.get('status') == 'retry':
                            self._website_fetch_stats['retries'] += 1
                    except asyncio.CancelledError:
                        # No dequeue/delete. The next launch safely retries this job.
                        raise
                    except Exception as exc:
                        self._is_paused = True
                        self._log(f'Website evidence persistence failed; writes paused: {_reason(exc)}', 'ERROR')
                    finally:
                        self._website_hosts.discard(host)
                self._website_fetches[job['id']] = asyncio.create_task(fetch_one())

    async def _website_fetch_loop(self):
        next_scan = 0
        while self._is_running:
            try:
                if not self._is_paused:
                    if time.monotonic() >= next_scan:
                        await asyncio.to_thread(self._scan_website_backfill)
                        next_scan = time.monotonic() + 15
                    await self._fill_website_fetch_pool()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if database.is_database_exception(exc):
                    self._log('Backfill database temporarily unavailable; collectors retry without discarding jobs', 'WARNING')
                    await asyncio.sleep(5)
                else:
                    self._is_paused = True
                    self._log(f'Website scheduler paused safely: {_reason(exc)}', 'ERROR')
            await asyncio.sleep(0.25)

    async def _drain_website_cycle(self):
        """Bounded, sequential burst; retain the single-writer/process guards."""
        deadline = time.monotonic() + max(1, min(120, settings.WEBSITE_CYCLE_BUDGET_SEC))
        progressed = False
        try:
            for index in range(max(1, min(32, settings.WEBSITE_JOBS_PER_CYCLE))):
                if not self._is_running or self._is_paused or (index and time.monotonic() >= deadline):
                    break
                if getattr(self, '_website_pipeline_enabled', False):
                    await self._fill_website_fetch_pool()
                else:
                    await self._prefetch_website_pair()
                if not await self._flush_one_website_job():
                    break
                progressed = True
            return progressed
        finally:
            self._website_activity = {"state": "idle", "hotel": None}

    async def _flush_one_website_job(self):
        if not settings.WEBSITE_ENRICHMENT_ENABLED:
            return False
        if self._website_queue is None:
            self._website_queue = await asyncio.to_thread(WebsiteQueue)
        pipeline = getattr(self, '_website_pipeline_enabled', False)
        if not pipeline:
            await asyncio.to_thread(self._scan_website_backfill)
        job = await asyncio.to_thread(self._website_queue.next_job, prefer_backfill=bool(self._website_turn % 2), fetched_only=pipeline)
        if not job:
            return False
        self._website_turn += 1
        self._website_activity = {"state": "processing", "hotel": job["payload"]["record"]["name"]}
        self._stats["current_action"] = f"Collecting business website for {job['payload']['record']['name']}"
        if job["state"] != "fetched":
            if getattr(self, '_website_pipeline_enabled', False):
                # Collectors run independently. Never wait for a slow network
                # job in the Maps/database application loop.
                return False
            record = job["payload"]["record"]
            if record.get("_discover_website"):
                if self._maps_cap_reached():
                    await asyncio.to_thread(self._website_queue.defer, job)
                    return True
                self._maps_calls_today += 1
                self._stats["api_calls"] += 1
            cached = (record.get("raw") or {}).get("website_enrichment")
            if (not record.get("_discover_website") and job["payload"].get("backfill_id") and isinstance(cached, dict)
                    and cached.get("status") == "collected" and cached.get("business_name") == record["name"]):
                result = cached
            else:
                result = await collect_website(record)
            ready = await asyncio.to_thread(self._website_queue.save_result, job, result)
            if not ready:
                self._log("Business website unavailable; durable retry scheduled.", "WARNING")
                return True
            job = {**job, "result": result}
            if result["status"] == "retry":
                job["result"] = {**result, "status": "failed"}
        if job["result"].get("status") == "needs_review":
            await asyncio.to_thread(self._website_queue.hold_for_review, job)
            self._log("Website could not be verified; left existing data unchanged and continued automatically.", "INFO")
            return True
        if job["payload"]["record"].get("_discover_website") and job["result"].get("status") != "collected":
            await asyncio.to_thread(self._website_queue.finish, job["id"], "skipped")
            return True
        applied = await asyncio.to_thread(self._apply_website_evidence, job)
        if applied:
            self._stats['website_records_written'] = self._stats.get('website_records_written',0) + 1
        filled_fields = applied.get("filled_fields", []) if isinstance(applied, dict) else []
        self._stats['blank_fields_filled'] = self._stats.get('blank_fields_filled',0) + len(filled_fields)
        await asyncio.to_thread(self._website_queue.finish, job["id"], "applied" if applied else "skipped", filled_fields)
        self._log(f"Business website evidence: {job['result']['status']} ({'saved' if applied else 'stale or unmatched job skipped'}) for {job['payload']['record']['name']}")
        return True

    def _save_results(
        self,
        zip_code: str,
        state: str,
        lat: float,
        lng: float,
        scraped: Sequence[Any],
        *,
        run_id: Optional[str] = None,
        validated: bool = False,
    ) -> Tuple[int, int]:
        """Validate, preflight, then merge. Returns touched and inserted counts."""
        active_run_id = run_id or self._run_id
        if validated:
            records = self._collapse_records([
                dict(record) for record in scraped if isinstance(record, Mapping)
            ])
            rejected: List[Dict[str, Optional[str]]] = []
        else:
            records, rejected = self._prepare_records(
                zip_code, lat, lng, list(scraped), run_id=active_run_id
            )
        if rejected:
            self._log(f"ZIP {zip_code}: rejected {len(rejected)} invalid record(s).", "WARNING")
        if scraped and not records:
            raise ZipQuarantined(
                zip_code,
                "all Maps records failed validation",
                evidence={"rejected_records": rejected[:25]},
                hotels_seen=len(scraped),
                hotels_new=0,
            )

        self._assert_current_write_contract()
        # The guard uses separate read-only sessions so it cannot become part
        # of, or accidentally alter, this result transaction.  A lower count
        # or maximum id pauses the worker before any new hotel merge begins.
        self._assert_inventory_safe("before_result_save")
        db = get_db_session()
        try:
            self._lock_owned_zip(db, zip_code)
            by_key, by_place, by_cid = self._existing_rows(db, records) if records else ({}, {}, {})
            resolved = [
                (record, self._resolve_existing(zip_code, record, by_key, by_place, by_cid))
                for record in records
            ]
            predicted_new = sum(1 for _, existing in resolved if existing is None)
            limit = int(settings.ZIP_MAX_NEW_HOTELS or 0)
            if limit > 0 and predicted_new > limit:
                raise ZipQuarantined(
                    zip_code,
                    f"Maps result would create {predicted_new} hotels (limit {limit})",
                    evidence={
                        "maps_status": "success",
                        "records_valid": len(records),
                        "records_rejected": rejected[:25],
                        "zip_max_new_hotels": limit,
                    },
                    hotels_seen=len(records),
                    hotels_new=predicted_new,
                )

            now = _now()
            touched = 0
            touches: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
            new_rows: List[Dict[str, Any]] = []
            for record, existing in resolved:
                if existing is None:
                    new_rows.append(self._new_row(zip_code, state, record, now))
                    continue
                before = self._snapshot(existing)
                self._touch_row(existing, record, now)
                touches.append((before, self._snapshot(existing)))
                touched += 1

            inserts: List[Dict[str, Any]] = []
            if new_rows:
                if database.is_sqlite():
                    for values in new_rows:
                        try:
                            with db.begin_nested():
                                row = Hotel(**values)
                                db.add(row)
                                db.flush()
                                inserts.append(self._snapshot(row))
                        except IntegrityError:
                            self._log(f"Skipped '{values['name']}' (unique-key conflict)", "WARNING")
                else:
                    statement = (
                        pg_insert(Hotel.__table__)
                        .values(new_rows)
                        .on_conflict_do_nothing()
                        .returning(*Hotel.__table__.c)
                    )
                    inserts = [dict(row) for row in db.execute(statement).mappings().all()]
                    if len(inserts) < len(new_rows):
                        self._log(
                            f"{len(new_rows) - len(inserts)} hotel(s) skipped (already present)",
                            "WARNING",
                        )

            db.flush()
            inventory_count = db.query(Hotel).filter(Hotel.query_zip == zip_code).count()
            db.query(ZipCode).filter(ZipCode.zip == zip_code).update(
                {
                    "places_status": "done",
                    "hotels_found": inventory_count,
                    "last_scraped_at": now,
                    "last_error": None,
                    "updated_at": now,
                },
                synchronize_session=False,
            )
            db.commit()

            # Commit is deliberately followed by another independent read:
            getattr(self, "_zip_claims", {}).pop(zip_code, None)
            # a concurrent external delete or unexpected restore must stop
            # future writes even though this transaction itself is durable.
            self._assert_inventory_safe("after_result_commit")

            # A journal entry only describes committed writes; a journal error
            # cannot make a committed production transaction roll back.
            if active_run_id:
                for before, after in touches:
                    self._journal_safe(
                        "record_hotel_touch",
                        before=before,
                        after=after,
                        hotel_id=after.get("id"),
                        dedup_key=after.get("dedup_key"),
                        cid=self._snapshot_cid(after),
                    )
                for after in inserts:
                    self._journal_safe(
                        "record_hotel_insert",
                        after=after,
                        hotel_id=after.get("id"),
                        dedup_key=after.get("dedup_key"),
                        cid=self._snapshot_cid(after),
                    )
            return touched, len(inserts)
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    # ---- ZIP state -----------------------------------------------------
    def _set_zip_state(self, zip_code: str, values: Dict[str, Any]) -> None:
        self._assert_current_write_contract()
        db = get_db_session()
        try:
            self._lock_owned_zip(db, zip_code)
            db.query(ZipCode).filter(ZipCode.zip == zip_code).update(
                values, synchronize_session=False
            )
            db.commit()
            getattr(self, "_zip_claims", {}).pop(zip_code, None)
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _historical_hotel_count(self, zip_code: str) -> int:
        db = get_db_session()
        try:
            return max(int(db.query(ZipCode.hotels_found).filter(ZipCode.zip == zip_code).scalar() or 0),
                       db.query(Hotel).filter(Hotel.query_zip == zip_code).count())
        finally:
            db.close()

    def _mark_zip_empty_done(self, zip_code: str) -> None:
        now = _now()
        self._set_zip_state(
            zip_code,
            {
                "places_status": "done",
                "hotels_found": 0,
                "last_scraped_at": now,
                "last_error": None,
                "updated_at": now,
            },
        )

    def _mark_zip_error(self, zip_code: str, reason: str) -> None:
        self._set_zip_state(
            zip_code,
            {"places_status": "error", "last_error": reason[:500], "updated_at": _now()},
        )

    def _mark_zip_quarantined(self, zip_code: str, reason: str) -> None:
        self._set_zip_state(
            zip_code,
            {"places_status": "quarantined", "last_error": reason[:500], "updated_at": _now()},
        )

    # ---- outcome handling ---------------------------------------------
    @staticmethod
    def _evidence(batch: _PendingBatch) -> Dict[str, Any]:
        evidence: Dict[str, Any] = {"maps_status": batch.result.status.value}
        if batch.outbox_batch_id:
            evidence["outbox_batch_id"] = batch.outbox_batch_id
        if batch.result.reason:
            evidence["reason"] = batch.result.reason
        if batch.result.query:
            evidence["query"] = batch.result.query
        if batch.result.selector:
            evidence["selector"] = batch.result.selector
        if batch.rejected:
            evidence["rejected_records"] = batch.rejected[:25]
        return evidence

    def _reset_scrape_failures(self, zip_code: str) -> None:
        self._consecutive_failures = 0
        self._captcha_failures = 0
        self._zip_failures.pop(zip_code, None)

    async def _handle_success(self, batch: _PendingBatch) -> None:
        if batch.records is None:
            batch.records, batch.rejected = self._prepare_records(
                batch.zip_code,
                batch.lat,
                batch.lng,
                batch.result.records,
                run_id=self._run_id,
            )
            self._stats["records_rejected"] += len(batch.rejected)
            if batch.rejected:
                self._log(
                    f"ZIP {batch.zip_code}: rejected {len(batch.rejected)} invalid Maps record(s).",
                    "WARNING",
                )
            if batch.result.records and not batch.records:
                raise ZipQuarantined(
                    batch.zip_code,
                    "all Maps records failed validation",
                    evidence=self._evidence(batch),
                    hotels_seen=len(batch.result.records),
                    hotels_new=0,
                )

        entry = await self._enqueue_outbox_batch(batch)
        touched, added = await self._flush_outbox_entry(entry)
        self._reset_scrape_failures(batch.zip_code)
        self._stats["zips_processed"] += 1
        self._stats["hotels_found"] += len(batch.records)
        self._stats["hotels_added"] += added
        await self._journal_event(
            "record_zip_outcome",
            batch.zip_code,
            "success",
            evidence=self._evidence(batch),
            hotels_seen=len(batch.records),
            hotels_new=added,
        )
        self._log(
            f"ZIP {batch.zip_code} ({batch.city}, {batch.state}): "
            f"{len(batch.records)} valid found, {added} new, {touched} updated."
        )

    async def _handle_explicit_empty(self, batch: _PendingBatch) -> None:
        historical = await asyncio.to_thread(self._historical_hotel_count, batch.zip_code)
        if historical > 0:
            evidence = self._evidence(batch)
            evidence["historical_hotels_found"] = historical
            raise ZipQuarantined(
                batch.zip_code,
                "Maps explicitly returned empty for a ZIP with historical hotels",
                evidence=evidence,
                hotels_seen=0,
                hotels_new=0,
            )
        await asyncio.to_thread(self._mark_zip_empty_done, batch.zip_code)
        self._reset_scrape_failures(batch.zip_code)
        self._stats["zips_processed"] += 1
        await self._journal_event(
            "record_zip_outcome",
            batch.zip_code,
            "explicit_empty",
            evidence=self._evidence(batch),
            hotels_seen=0,
            hotels_new=0,
        )
        self._log(f"ZIP {batch.zip_code}: Maps explicitly reported no hotels.")

    async def _captcha_backoff(self, batch: _PendingBatch) -> None:
        if batch.backoff_done:
            return
        self._captcha_failures += 1
        steps = (
            settings.CAPTCHA_BACKOFF_1_SEC,
            settings.CAPTCHA_BACKOFF_2_SEC,
            settings.CAPTCHA_BACKOFF_3_SEC,
        )
        index = min(self._captcha_failures - 1, len(steps) - 1)
        delay = max(0.0, float(steps[index])) * random.uniform(0.85, 1.15)
        self._stats["current_action"] = (
            f"Maps block for ZIP {batch.zip_code}; backing off {round(delay)}s "
            f"(step {index + 1}/{len(steps)})"
        )
        self._log(self._stats["current_action"], "WARNING")
        batch.backoff_done = True
        await asyncio.sleep(delay)

    async def _generic_failure_pause(self) -> None:
        if self._consecutive_failures >= FAILURES_BEFORE_COOLDOWN:
            self._stats["current_action"] = (
                f"Cooling down {settings.FAILURE_COOLDOWN_SEC}s after "
                f"{self._consecutive_failures} consecutive scrape failures"
            )
            self._log(self._stats["current_action"], "WARNING")
            await chrome_scraper.close_browser()
            await asyncio.sleep(max(0.0, float(settings.FAILURE_COOLDOWN_SEC)))
            self._consecutive_failures = 0
        else:
            await asyncio.sleep(5.0)

    async def _handle_scrape_failure(self, batch: _PendingBatch) -> None:
        if not batch.failure_recorded:
            self._stats["errors_encountered"] += 1
            self._consecutive_failures += 1
            self._zip_failures[batch.zip_code] = self._zip_failures.get(batch.zip_code, 0) + 1
            await self._journal_event(
                "record_zip_outcome",
                batch.zip_code,
                batch.result.status.value,
                reason=batch.result.reason,
                evidence=self._evidence(batch),
                hotels_seen=0,
                hotels_new=0,
            )
            self._log(
                f"Maps {batch.result.status.value} for ZIP {batch.zip_code}: "
                f"{batch.result.reason or 'no reason supplied'}",
                "WARNING",
            )
            batch.failure_recorded = True

        failures = self._zip_failures.get(batch.zip_code, 0)
        # CAPTCHA blocks remain pending so all configured backoff steps can run.
        # Selector and transport failures are parked after two attempts.
        if (
            batch.result.status != ScrapeStatus.BLOCKED
            and failures >= 2
            and not batch.error_marked
        ):
            await asyncio.to_thread(
                self._mark_zip_error,
                batch.zip_code,
                f"{batch.result.status.value}: {batch.result.reason or 'Maps scrape failed'}",
            )
            batch.error_marked = True
            self._zip_failures.pop(batch.zip_code, None)
            self._log(f"ZIP {batch.zip_code} parked as error after {failures} Maps failures.", "WARNING")
        if batch.result.status == ScrapeStatus.BLOCKED:
            await self._captcha_backoff(batch)
        else:
            await self._generic_failure_pause()

    async def _quarantine(self, batch: _PendingBatch) -> None:
        quarantine = batch.quarantine
        if quarantine is None:
            return
        evidence = self._evidence(batch)
        evidence.update(quarantine.evidence)
        if not batch.quarantine_journaled:
            await self._journal_event(
                "quarantine_zip",
                quarantine.zip_code,
                reason=quarantine.reason,
                evidence=evidence,
                hotels_seen=quarantine.hotels_seen,
                hotels_new=quarantine.hotels_new,
            )
            batch.quarantine_journaled = True
        if not batch.quarantine_marked:
            await asyncio.to_thread(
                self._mark_zip_quarantined, quarantine.zip_code, quarantine.reason
            )
            batch.quarantine_marked = True
            self._stats["zips_quarantined"] += 1
        if batch.outbox_batch_id and self._outbox is not None:
            await asyncio.to_thread(
                self._outbox.mark_quarantined,
                batch.outbox_batch_id,
                quarantine.reason,
                evidence=evidence,
            )
            self._outbox_pending_count()
        self._zip_failures.pop(quarantine.zip_code, None)
        self._log(f"ZIP {quarantine.zip_code} quarantined: {quarantine.reason}", "WARNING")

    async def _database_retry(self, batch: Optional[_PendingBatch], exc: BaseException) -> None:
        """Database waits preserve the same Maps result and no failure counters."""
        error = _reason(exc)
        if isinstance(exc, database.SchemaIncompatible):
            self._is_paused = True
            self._stats["current_action"] = f"Paused: schema guard blocked writes ({error})"
            self._log(self._stats["current_action"], "ERROR")
            return
        self._stats["errors_encountered"] += 1
        if batch is not None and not batch.db_retry_recorded:
            evidence = self._evidence(batch)
            evidence["database_error"] = error
            await self._journal_event(
                "record_zip_outcome",
                batch.zip_code,
                "database_retry",
                reason=error,
                evidence=evidence,
                hotels_seen=len(batch.records or batch.result.records or []),
                hotels_new=None,
            )
            batch.db_retry_recorded = True
        self._stats["current_action"] = (
            f"Database unavailable; retrying the same pending batch in {settings.DB_OFFLINE_RETRY_SEC}s"
        )
        self._log(f"{self._stats['current_action']}: {error}", "ERROR")
        await asyncio.sleep(max(0.0, float(settings.DB_OFFLINE_RETRY_SEC)))

    def _maps_cap_reached(self) -> bool:
        today = _now().date()
        if today != self._maps_call_day:
            self._maps_call_day = today
            self._maps_calls_today = 0
        cap = int(settings.DAILY_MAPS_CALL_CAP or 0)
        return cap > 0 and self._maps_calls_today >= cap

    async def _process_batch(self, batch: _PendingBatch) -> None:
        if batch.result.status == ScrapeStatus.SUCCESS:
            await self._handle_success(batch)
        elif batch.result.status == ScrapeStatus.EXPLICIT_EMPTY:
            await self._handle_explicit_empty(batch)
        else:
            await self._handle_scrape_failure(batch)

    # ---- main loop -----------------------------------------------------
    async def _run_loop(self) -> None:
        pending: Optional[_PendingBatch] = None
        self._log("Worker background task entered execution loop.")
        heartbeat_task = asyncio.create_task(self._lease_heartbeat_loop())
        self._website_pipeline_enabled = True
        self._website_fetches = {}
        self._website_hosts = set()
        self._website_fetch_stats = {'completed': 0, 'retries': 0, 'last_finished_at': None}
        fetch_task = asyncio.create_task(self._website_fetch_loop())
        try:
            while self._is_running:
                if self._is_paused:
                    await asyncio.sleep(1.0)
                    continue

                if pending is None:
                    try:
                        await self._maybe_prune_outbox()
                    except Exception as exc:
                        # Storage cleanup is non-critical; retaining terminal
                        # records is safer than interrupting pending work.
                        self._log(f"Could not prune terminal local outbox records: {_reason(exc)}", "WARNING")
                    try:
                        await self._maybe_run_data_quality_audit()
                    except Exception as exc:
                        if database.is_database_exception(exc):
                            await self._database_retry(None, exc)
                            continue
                        self._stats["errors_encountered"] += 1
                        self._log(f"Read-only data-quality audit failed: {_reason(exc)}", "ERROR")
                        await asyncio.sleep(5.0)
                        continue
                    # Never allow fresh scraping to outrun durable batches
                    # that survived a prior Cloud SQL outage or process crash.
                    try:
                        if await self._flush_one_outbox_batch():
                            continue
                    except DataLossSuspected as exc:
                        await self._pause_for_inventory_loss(exc)
                        continue
                    except Exception as exc:
                        if database.is_database_exception(exc):
                            await self._database_retry(None, exc)
                            continue
                        self._stats["errors_encountered"] += 1
                        self._log(f"Could not flush local outbox: {_reason(exc)}", "ERROR")
                        await asyncio.sleep(5.0)
                        continue
                    try:
                        # Drain a bounded fair burst; backpressure below keeps
                        # new Maps batches from outrunning durable enrichment.
                        website_progress = await self._drain_website_cycle()
                        website_pressure = self._website_backpressure()
                    except DataLossSuspected as exc:
                        await self._pause_for_inventory_loss(exc)
                        continue
                    except Exception as exc:
                        if database.is_database_exception(exc):
                            await self._database_retry(None, exc)
                            continue
                        # Corrupt/foreign local jobs fail closed, never silently
                        # skipped or converted into a production write.
                        self._is_paused = True
                        self._log(f"Website queue held for review: {_reason(exc)}", "ERROR")
                        continue
                    # Website pressure is a monitoring signal, not a blanket
                    # Maps veto. Independent collectors drain the durable queue
                    # while each main-loop cycle still advances a ZIP.
                    if self._maps_cap_reached():
                        self._stats["current_action"] = (
                            f"Daily Maps call cap ({settings.DAILY_MAPS_CALL_CAP}) reached; "
                            "waiting for the next UTC day."
                        )
                        self._log(self._stats["current_action"], "WARNING")
                        await chrome_scraper.close_browser_if_idle(0)
                        await asyncio.sleep(1.0 if website_progress else 60.0)
                        continue
                    try:
                        if not await self._maybe_run_canary():
                            continue
                    except Exception as exc:
                        if database.is_database_exception(exc):
                            await self._database_retry(None, exc)
                            continue
                        self._stats["errors_encountered"] += 1
                        self._log(f"Canary check failed unexpectedly: {_reason(exc)}", "ERROR")
                        await asyncio.sleep(5.0)
                        continue
                    try:
                        claimed = await asyncio.to_thread(self._next_zip_sync)
                    except Exception as exc:
                        if database.is_database_exception(exc):
                            await self._database_retry(None, exc)
                            continue
                        self._stats["errors_encountered"] += 1
                        self._log(f"Could not claim next ZIP: {_reason(exc)}", "ERROR")
                        await asyncio.sleep(5.0)
                        continue
                    if claimed is None:
                        self._stats["current_action"] = "Queue idle — no pending ZIPs. Queue more locations to continue."
                        self._stats["current_zip"] = None
                        await chrome_scraper.close_browser_if_idle(120)
                        await asyncio.sleep(1.0 if website_progress else 10.0)
                        continue

                    zip_code, city, state, lat, lng = claimed
                    mode = "Defined ZIP" if self._scraper_mode == "defined_zips" else "Radial Sweep"
                    self._stats["current_zip"] = zip_code
                    self._stats["current_action"] = f"Scraping ZIP {zip_code} ({city}, {state}) [{mode}]"
                    result = await self._scrape_maps(city, state, zip_code)
                    pending = _PendingBatch(zip_code, city, state, lat, lng, result)

                try:
                    if pending.quarantine is not None:
                        await self._quarantine(pending)
                    else:
                        await self._process_batch(pending)
                except DataLossSuspected as exc:
                    await self._pause_for_inventory_loss(exc)
                    continue
                except ZipQuarantined as exc:
                    pending.quarantine = exc
                    try:
                        await self._quarantine(pending)
                    except Exception as quarantine_exc:
                        if database.is_database_exception(quarantine_exc):
                            await self._database_retry(pending, quarantine_exc)
                            continue
                        self._stats["errors_encountered"] += 1
                        self._log(
                            f"Could not persist ZIP {pending.zip_code} quarantine: {_reason(quarantine_exc)}",
                            "ERROR",
                        )
                        await asyncio.sleep(5.0)
                        continue
                except Exception as exc:
                    if database.is_database_exception(exc):
                        await self._database_retry(pending, exc)
                        continue
                    if isinstance(exc, (OutboxError, sqlite3.Error)):
                        self._stats["errors_encountered"] += 1
                        self._stats["current_action"] = "Local outbox unavailable; holding validated batch"
                        self._log(
                            f"Could not persist/ack local outbox for ZIP {pending.zip_code}: {_reason(exc)}",
                            "ERROR",
                        )
                        await asyncio.sleep(5.0)
                        continue
                    # An internal processing error is safely treated as a Maps
                    # transport failure, never as an empty ZIP.
                    self._log(
                        f"Worker processing error for ZIP {pending.zip_code}: {_reason(exc)}",
                        "ERROR",
                    )
                    pending.result = ScrapeResult(
                        ScrapeStatus.TRANSPORT_FAILURE,
                        reason=f"worker processing error: {_reason(exc)}",
                    )
                    pending.records = None
                    try:
                        await self._handle_scrape_failure(pending)
                    except Exception as failure_exc:
                        if database.is_database_exception(failure_exc):
                            await self._database_retry(pending, failure_exc)
                            continue
                        self._stats["errors_encountered"] += 1
                        self._log(
                            f"Could not record worker failure for ZIP {pending.zip_code}: {_reason(failure_exc)}",
                            "ERROR",
                        )

                pending = None
                await asyncio.sleep(max(0.0, float(settings.SCRAPER_DELAY_SEC)))
        except asyncio.CancelledError:
            self._log("Background worker task cancellation received.")
        finally:
            self._is_running = False
            fetch_task.cancel()
            await asyncio.gather(fetch_task, return_exceptions=True)
            for task in self._website_fetches.values():
                task.cancel()
            await asyncio.gather(*self._website_fetches.values(), return_exceptions=True)
            self._website_fetches.clear()
            self._website_pipeline_enabled = False
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            try:
                await asyncio.to_thread(self._release_zip_claims)
            except Exception as exc:
                self._log(f"ZIP claim release deferred to stale-lease recovery: {_reason(exc)}", "WARNING")
            self._stats["current_action"] = "Idle"
            self._release_lock()
            worker_wake_lock.release()
            await asyncio.to_thread(
                self._finish_journal_run,
                "stopped" if self._stop_requested else "completed",
            )
            self._run_id = None
            self._log("Background worker loop exited.")


worker_instance = ScraperBackgroundWorker()
