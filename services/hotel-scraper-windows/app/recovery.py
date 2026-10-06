"""Read-only startup recovery inspection for durable local scraper state.

The worker keeps two local SQLite files: an immutable run journal and an
outbox of validated batches that have not yet been acknowledged after a Cloud
SQL commit.  A power loss can legitimately leave a journal run open and/or an
outbox batch pending.  This module lets a dashboard inspect that state before
the worker resumes, without opening the application database or mutating
either local file.

``inspect_startup_recovery`` deliberately uses SQLite's ``mode=ro`` URI and
``PRAGMA query_only`` rather than constructing :class:`RunJournal` or
:class:`LocalOutbox`.  Their constructors initialise schemas, which is useful
for normal operation but inappropriate for a diagnostic endpoint.  Therefore
calling this module never creates, repairs, acknowledges, quarantines, or
deletes local work -- and it has no Cloud SQL dependency at all.
"""

from __future__ import annotations

import copy
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

from app.outbox import default_outbox_path, require_matching_target, OutboxTargetMismatch
from app.run_journal import default_journal_path


PathLike = Union[str, Path]
DEFAULT_MAX_ITEMS = 50
MAX_ITEMS = 1_000

_JOURNAL_COLUMNS = frozenset(
    {"run_id", "started_at", "finished_at", "status", "metadata_json", "error"}
)
_OUTBOX_COLUMNS = frozenset(
    {
        "batch_id",
        "run_id",
        "zip_code",
        "created_at",
        "status",
        "record_count",
        "records_json",
        "metadata_json",
        "delivered_at",
        "quarantined_at",
    }
)
_OUTBOX_STATUSES = ("pending", "delivered", "quarantined")


class RecoveryInspectionError(RuntimeError):
    """Raised only for invalid arguments supplied to the inspection API."""


@dataclass(frozen=True)
class RecoveryReport:
    """JSON-ready view of local state that survived an abrupt shutdown.

    ``safe_to_resume`` is deliberately conservative.  It is false if either
    existing durable file cannot be read or has a malformed pending payload;
    a caller should hold remote writes until an operator reviews that state.
    A valid pending outbox is safe to resume: the worker's normal recovery
    path replays it before scraping anything new.
    """

    generated_at: str
    recovery_mode: str
    safe_to_resume: bool
    needs_operator_review: bool
    journal: Mapping[str, Any]
    outbox: Mapping[str, Any]
    recommended_actions: Sequence[Mapping[str, Any]]

    def as_dict(self) -> Dict[str, Any]:
        """Return a detached JSON-serialisable object for FastAPI/dashboard use."""
        return {
            "generated_at": self.generated_at,
            "recovery_mode": self.recovery_mode,
            "safe_to_resume": self.safe_to_resume,
            "needs_operator_review": self.needs_operator_review,
            "journal": copy.deepcopy(dict(self.journal)),
            "outbox": copy.deepcopy(dict(self.outbox)),
            "recommended_actions": [copy.deepcopy(dict(item)) for item in self.recommended_actions],
        }


def inspect_startup_recovery(
    *,
    journal_path: Optional[PathLike] = None,
    outbox_path: Optional[PathLike] = None,
    max_items: int = DEFAULT_MAX_ITEMS,
    now: Optional[datetime] = None,
) -> RecoveryReport:
    """Inspect durable local recovery state without writing anywhere.

    Args:
        journal_path: Optional override for the local journal SQLite file.
        outbox_path: Optional override for the local outbox SQLite file.
        max_items: Maximum interrupted runs, pending batches, and diagnostics
            included in the response.  Aggregate counts always cover all rows.
        now: Optional UTC timestamp used only to make a deterministic report
            timestamp in tests.

    Missing files are reported as ``state: 'absent'`` rather than created,
    which represents a normal first run.  Existing unreadable, incomplete, or
    malformed files are reported as unsafe and are never changed by this
    function.
    """
    item_limit = _validate_limit(max_items)
    generated_at = _timestamp(now)
    resolved_journal = _path(journal_path, default_journal_path())
    resolved_outbox = _path(outbox_path, default_outbox_path())

    journal = _inspect_journal(resolved_journal, item_limit)
    outbox = _inspect_outbox(resolved_outbox, item_limit)

    safe_to_resume = journal["state"] in {"ready", "absent"} and outbox["state"] in {
        "ready",
        "absent",
    }
    actions = _recommended_actions(journal, outbox)
    needs_operator_review = any(
        action["severity"] in {"warning", "critical"} and not action["automatic"]
        for action in actions
    )
    if not safe_to_resume:
        recovery_mode = "hold_for_review"
    elif outbox["pending_batch_count"]:
        recovery_mode = "replay_pending_outbox"
    elif journal["unfinished_run_count"]:
        recovery_mode = "review_interrupted_run"
    else:
        recovery_mode = "ready"

    return RecoveryReport(
        generated_at=generated_at,
        recovery_mode=recovery_mode,
        safe_to_resume=safe_to_resume,
        needs_operator_review=needs_operator_review,
        journal=journal,
        outbox=outbox,
        recommended_actions=actions,
    )


def startup_recovery_status(**kwargs: Any) -> Dict[str, Any]:
    """Convenience JSON endpoint helper equivalent to ``inspect(...).as_dict()``."""
    return inspect_startup_recovery(**kwargs).as_dict()


def _validate_limit(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_ITEMS:
        raise RecoveryInspectionError(
            f"max_items must be an integer between 1 and {MAX_ITEMS}"
        )
    return value


def _path(value: Optional[PathLike], default: Path) -> Path:
    path = Path(default if value is None else value).expanduser()
    try:
        return path.resolve(strict=False)
    except OSError:
        # The path string is still useful in an error response; do not attempt
        # to create it simply because resolution was unavailable.
        return path.absolute()


def _timestamp(value: Optional[datetime]) -> str:
    current = datetime.now(timezone.utc) if value is None else value
    if not isinstance(current, datetime):
        raise RecoveryInspectionError("now must be a datetime or None")
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    else:
        current = current.astimezone(timezone.utc)
    return current.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _component_base(path: Path) -> Dict[str, Any]:
    return {
        "path": str(path),
        "state": "absent",
        "error": None,
        "integrity_errors": [],
    }


def _open_readonly(path: Path) -> sqlite3.Connection:
    # ``mode=ro`` causes SQLite to reject all writes even if a future change
    # accidentally adds one below. query_only is an independent second guard.
    uri = f"{path.as_uri()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def _ensure_table_columns(
    conn: sqlite3.Connection, table: str, required: frozenset[str]
) -> None:
    row = conn.execute(
        "SELECT type FROM sqlite_master WHERE name = ?", (table,)
    ).fetchone()
    if row is None or str(row["type"]).lower() != "table":
        raise sqlite3.DatabaseError(f"expected local table {table!r} is missing")
    columns = {
        str(column["name"])
        for column in conn.execute(f"PRAGMA table_info({table})").fetchall()
    }
    missing = sorted(required - columns)
    if missing:
        raise sqlite3.DatabaseError(
            f"local table {table!r} is missing columns: {', '.join(missing)}"
        )


def _safe_error(exc: BaseException) -> str:
    detail = " ".join(str(exc).split()) or exc.__class__.__name__
    return detail[:500]


def _append_limited(items: List[Dict[str, Any]], value: Dict[str, Any], limit: int) -> None:
    if len(items) < limit:
        items.append(value)


def _inspect_journal(path: Path, limit: int) -> Dict[str, Any]:
    result = _component_base(path)
    result.update(
        {
            "run_count": 0,
            "unfinished_run_count": 0,
            "unfinished_runs": [],
            "anomalies": [],
        }
    )
    if not path.exists():
        return result
    if not path.is_file():
        result.update({"state": "unavailable", "error": "journal path is not a file"})
        return result

    conn: Optional[sqlite3.Connection] = None
    try:
        conn = _open_readonly(path)
        _ensure_table_columns(conn, "runs", _JOURNAL_COLUMNS)
        result["run_count"] = int(conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0])
        unfinished_rows = conn.execute(
            """
            SELECT run_id, started_at, metadata_json
              FROM runs
             WHERE status = 'running' AND finished_at IS NULL
             ORDER BY started_at ASC, run_id ASC
            """
        ).fetchall()
        result["unfinished_run_count"] = len(unfinished_rows)
        for row in unfinished_rows:
            run_id = str(row["run_id"])
            _append_limited(
                result["unfinished_runs"],
                {"run_id": run_id, "started_at": row["started_at"]},
                limit,
            )
            try:
                metadata = json.loads(row["metadata_json"])
                if not isinstance(metadata, dict):
                    raise ValueError("metadata is not an object")
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                _append_limited(
                    result["integrity_errors"],
                    {
                        "code": "malformed_run_metadata",
                        "run_id": run_id,
                        "message": _safe_error(exc),
                    },
                    limit,
                )

        # A normal finish has a terminal status *and* a finished timestamp.
        # Treat contradictory combinations as audit evidence to review, never
        # as a reason to rewrite historical run state automatically.
        anomaly_rows = conn.execute(
            """
            SELECT run_id, status, finished_at
              FROM runs
             WHERE (status = 'running' AND finished_at IS NOT NULL)
                OR (status <> 'running' AND finished_at IS NULL)
             ORDER BY started_at ASC, run_id ASC
            """
        ).fetchall()
        for row in anomaly_rows:
            code = (
                "running_run_has_finished_at"
                if row["status"] == "running"
                else "terminal_run_missing_finished_at"
            )
            _append_limited(
                result["anomalies"],
                {
                    "code": code,
                    "run_id": str(row["run_id"]),
                    "status": row["status"],
                    "finished_at": row["finished_at"],
                },
                limit,
            )
        if result["integrity_errors"] or result["anomalies"]:
            result["state"] = "corrupt"
            result["error"] = "journal contains malformed or contradictory lifecycle evidence"
        else:
            result["state"] = "ready"
    except (OSError, sqlite3.Error, ValueError) as exc:
        result.update({"state": "unavailable", "error": _safe_error(exc)})
    finally:
        if conn is not None:
            conn.close()
    return result


def _inspect_outbox(path: Path, limit: int) -> Dict[str, Any]:
    result = _component_base(path)
    result.update(
        {
            "total_batch_count": 0,
            "pending_batch_count": 0,
            "pending_record_count": 0,
            "oldest_pending_at": None,
            "pending_batches": [],
            "status_counts": {
                status: {"batches": 0, "records": 0} for status in _OUTBOX_STATUSES
            },
        }
    )
    if not path.exists():
        return result
    if not path.is_file():
        result.update({"state": "unavailable", "error": "outbox path is not a file"})
        return result

    conn: Optional[sqlite3.Connection] = None
    try:
        conn = _open_readonly(path)
        _ensure_table_columns(conn, "outbox_batches", _OUTBOX_COLUMNS)
        status_rows = conn.execute(
            """
            SELECT status, COUNT(*) AS batches, COALESCE(SUM(record_count), 0) AS records
              FROM outbox_batches
             GROUP BY status
            """
        ).fetchall()
        for row in status_rows:
            status = str(row["status"])
            details = {"batches": int(row["batches"]), "records": int(row["records"])}
            if status in result["status_counts"]:
                result["status_counts"][status] = details
            else:
                _append_limited(
                    result["integrity_errors"],
                    {"code": "unknown_outbox_status", "status": status},
                    limit,
                )
        result["total_batch_count"] = sum(
            item["batches"] for item in result["status_counts"].values()
        )
        result["pending_batch_count"] = result["status_counts"]["pending"]["batches"]
        result["pending_record_count"] = result["status_counts"]["pending"]["records"]

        pending_rows = conn.execute(
            """
            SELECT batch_id, run_id, zip_code, created_at, record_count, records_json, metadata_json
              FROM outbox_batches
             WHERE status = 'pending'
             ORDER BY created_at ASC, batch_id ASC
            """
        ).fetchall()
        if pending_rows:
            result["oldest_pending_at"] = pending_rows[0]["created_at"]
        for row in pending_rows:
            batch_id = str(row["batch_id"])
            _append_limited(
                result["pending_batches"],
                {
                    "batch_id": batch_id,
                    "run_id": str(row["run_id"]),
                    "zip_code": str(row["zip_code"]),
                    "created_at": row["created_at"],
                    "record_count": int(row["record_count"]),
                },
                limit,
            )
            _validate_pending_payload(row, result["integrity_errors"], limit)

        if result["integrity_errors"]:
            result["state"] = "corrupt"
            result["error"] = "outbox contains an unsafe pending batch (payload or database target); remote writes should remain paused"
        else:
            result["state"] = "ready"
    except (OSError, sqlite3.Error, ValueError) as exc:
        result.update({"state": "unavailable", "error": _safe_error(exc)})
    finally:
        if conn is not None:
            conn.close()
    return result


def _validate_pending_payload(
    row: sqlite3.Row, integrity_errors: List[Dict[str, Any]], limit: int
) -> None:
    """Verify enough of a replay payload to fail closed before a dashboard says resume is safe."""
    batch_id = str(row["batch_id"])
    try:
        records = json.loads(row["records_json"])
        if not isinstance(records, list) or not records:
            raise ValueError("records must be a non-empty JSON array")
        if any(not isinstance(record, dict) for record in records):
            raise ValueError("records must contain only JSON objects")
        if int(row["record_count"]) != len(records):
            raise ValueError("record_count does not match records payload")
        metadata = json.loads(row["metadata_json"])
        if not isinstance(metadata, dict):
            raise ValueError("metadata must be a JSON object")
        require_matching_target(metadata)
    except (TypeError, ValueError, json.JSONDecodeError, OutboxTargetMismatch) as exc:
        _append_limited(
            integrity_errors,
            {
                "code": "malformed_pending_batch",
                "batch_id": batch_id,
                "message": _safe_error(exc),
            },
            limit,
        )


def _recommended_actions(
    journal: Mapping[str, Any], outbox: Mapping[str, Any]
) -> List[Dict[str, Any]]:
    actions: List[Dict[str, Any]] = []
    for component in (journal, outbox):
        state = component["state"]
        if state in {"unavailable", "corrupt"}:
            actions.append(
                {
                    "code": f"hold_{'journal' if component is journal else 'outbox'}_writes",
                    "severity": "critical",
                    "automatic": False,
                    "message": (
                        "Do not resume Cloud SQL writes until the local "
                        f"{'journal' if component is journal else 'outbox'} is inspected; "
                        "this report did not alter it."
                    ),
                    "details": {"path": component["path"], "error": component["error"]},
                }
            )
    pending_count = int(outbox["pending_batch_count"])
    if pending_count and outbox["state"] == "ready":
        actions.append(
            {
                "code": "replay_pending_outbox",
                "severity": "warning",
                "automatic": True,
                "message": (
                    f"Replay {pending_count} durable outbox batch(es) before scraping new ZIPs. "
                    "The worker's normal startup loop already does this idempotently."
                ),
                "details": {
                    "pending_batches": pending_count,
                    "pending_records": int(outbox["pending_record_count"]),
                    "oldest_pending_at": outbox["oldest_pending_at"],
                },
            }
        )
    unfinished_count = int(journal["unfinished_run_count"])
    if unfinished_count and journal["state"] == "ready":
        actions.append(
            {
                "code": "review_interrupted_runs",
                "severity": "warning",
                "automatic": False,
                "message": (
                    f"{unfinished_count} journal run(s) were left open by an abrupt stop. "
                    "Keep their evidence immutable; inspect their run report rather than "
                    "marking them complete automatically."
                ),
                "details": {
                    "run_count": unfinished_count,
                    "runs": list(journal["unfinished_runs"]),
                },
            }
        )
    if not actions:
        actions.append(
            {
                "code": "start_clean",
                "severity": "info",
                "automatic": True,
                "message": "No interrupted local work was found; a normal worker start is safe.",
                "details": {},
            }
        )
    return actions
