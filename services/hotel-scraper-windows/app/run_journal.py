"""Durable, local audit journal for scraper runs.

This module deliberately has no dependency on the application database.  It is
an append-only SQLite journal kept beside the other per-user application data,
so a scrape can be accounted for even while Cloud SQL is unavailable.

Typical worker use::

    journal = RunJournal()
    run_id = journal.create_run({"scraped_via": "chrome_google_maps"})
    journal.record_hotel_insert(run_id, hotel_id=123, dedup_key="...", after=row)
    journal.record_zip_outcome(run_id, "98033", "success", hotels_seen=12)
    journal.finish_run(run_id)

``before`` and ``after`` snapshots are encoded immediately, rather than held
by reference, so they remain useful for an operator investigating or reverting
a run later.  Journal writes use short ``BEGIN IMMEDIATE`` transactions, WAL,
FULL synchronous mode, and parameterized SQL.  A connection is opened per
operation; this makes a single instance thread-safe and lets SQLite coordinate
separate application processes safely as well.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Union

from app.config import runtime_state_dir


DEFAULT_JOURNAL_FILENAME = "scrape_run_journal.sqlite3"
MAX_JSON_BYTES = 2_000_000
MAX_PAGE_SIZE = 1_000

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_ZIP_RE = re.compile(r"^\d{5}$")
_TOKEN_RE = re.compile(r"^[a-z][a-z0-9_:-]{0,63}$")


class RunJournalError(RuntimeError):
    """Base exception for local journal errors."""


class RunNotFoundError(RunJournalError):
    """Raised when a write refers to a run that does not exist."""


class RunExistsError(RunJournalError):
    """Raised when a caller attempts to create an existing run id."""


class RunClosedError(RunJournalError):
    """Raised when a mutable scrape record is added after a run is finished."""


class RunAlreadyFinishedError(RunJournalError):
    """Raised when a completed run is finished again with a different status."""


class JournalCorruptionError(RunJournalError):
    """Raised rather than silently hiding malformed JSON in an audit record."""


JsonMapping = Mapping[str, Any]
DateLike = Union[date, datetime, str]


def default_journal_path() -> Path:
    """Return the stable, user-local path used when no journal path is supplied."""
    return Path(runtime_state_dir()) / DEFAULT_JOURNAL_FILENAME


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: Optional[datetime] = None) -> str:
    """Serialize a timestamp in a lexically sortable, unambiguous UTC form."""
    value = value or _utc_now()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _report_day(value: Optional[DateLike] = None) -> str:
    if value is None:
        return _utc_now().date().isoformat()
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value).isoformat()
        except ValueError as exc:
            raise ValueError("day must be an ISO YYYY-MM-DD date") from exc
    raise TypeError("day must be a date, datetime, ISO date string, or None")


def _json_default(value: Any) -> str:
    if isinstance(value, (datetime, date)):
        if isinstance(value, datetime):
            return _timestamp(value)
        return value.isoformat()
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def _encode_json(value: Any, *, field: str) -> str:
    try:
        encoded = json.dumps(
            value,
            default=_json_default,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be JSON serializable") from exc
    if len(encoded.encode("utf-8")) > MAX_JSON_BYTES:
        raise ValueError(f"{field} exceeds the {MAX_JSON_BYTES:,}-byte journal limit")
    return encoded


def _decode_json(value: str, *, table: str, row_id: Any, field: str) -> Any:
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError) as exc:
        raise JournalCorruptionError(
            f"Malformed {field} in {table} record {row_id!r}; journal was not modified."
        ) from exc


def _require_mapping(value: Optional[JsonMapping], *, field: str, allow_none: bool = False) -> Optional[JsonMapping]:
    if value is None:
        if allow_none:
            return None
        raise ValueError(f"{field} is required")
    if not isinstance(value, Mapping):
        raise TypeError(f"{field} must be a mapping")
    return value


def _required_run_id(run_id: Union[str, uuid.UUID]) -> str:
    text = str(run_id).strip()
    if not _RUN_ID_RE.fullmatch(text):
        raise ValueError("run_id must be 1-128 safe identifier characters")
    return text


def _optional_text(value: Optional[Any], *, field: str, max_length: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if "\x00" in text or len(text) > max_length:
        raise ValueError(f"{field} must be at most {max_length} non-NUL characters")
    return text


def _token(value: str, *, field: str) -> str:
    token = str(value).strip().lower()
    if not _TOKEN_RE.fullmatch(token):
        raise ValueError(f"{field} must be a lowercase token (letters, digits, _, :, -)")
    return token


def _page_limit(limit: int) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PAGE_SIZE:
        raise ValueError(f"limit must be an integer between 1 and {MAX_PAGE_SIZE}")
    return limit


class RunJournal:
    """Small, durable local SQLite journal suitable for worker integration.

    Args:
        path: Optional database path.  Supplying a path is useful for tests.
            The default is ``user_data_dir()/scrape_run_journal.sqlite3``.

    The class does not keep a live connection.  That avoids sharing a SQLite
    connection across worker threads and allows an application restart to pick
    up exactly the same journal file.
    """

    def __init__(self, path: Optional[Union[str, Path]] = None):
        if path is not None and str(path) == ":memory:":
            raise ValueError("RunJournal requires a durable file path, not SQLite :memory:")
        self.path = Path(path) if path is not None else default_journal_path()
        self.path = self.path.expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._schema_ready = False
        self._ensure_schema()

    # ---- schema and connection handling ---------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self.path),
            timeout=30,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = FULL")
        return conn

    def _ensure_schema(self) -> None:
        with self._lock:
            if self._schema_ready:
                return
            conn = self._connect()
            try:
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS runs (
                        run_id TEXT PRIMARY KEY,
                        started_at TEXT NOT NULL,
                        finished_at TEXT,
                        status TEXT NOT NULL,
                        metadata_json TEXT NOT NULL,
                        error TEXT
                    );

                    CREATE TABLE IF NOT EXISTS hotel_changes (
                        change_id INTEGER PRIMARY KEY AUTOINCREMENT,
                        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
                        occurred_at TEXT NOT NULL,
                        operation TEXT NOT NULL CHECK (operation IN ('inserted', 'touched')),
                        hotel_id TEXT,
                        dedup_key TEXT,
                        cid TEXT,
                        before_json TEXT,
                        after_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_hotel_changes_run
                        ON hotel_changes(run_id, change_id);
                    CREATE INDEX IF NOT EXISTS idx_hotel_changes_hotel
                        ON hotel_changes(hotel_id, change_id);
                    CREATE INDEX IF NOT EXISTS idx_hotel_changes_cid
                        ON hotel_changes(cid, change_id);

                    CREATE TABLE IF NOT EXISTS zip_outcomes (
                        outcome_id INTEGER PRIMARY KEY AUTOINCREMENT,
                        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
                        zip_code TEXT NOT NULL,
                        outcome TEXT NOT NULL,
                        quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
                        reason TEXT,
                        evidence_json TEXT NOT NULL,
                        hotels_seen INTEGER,
                        hotels_new INTEGER,
                        occurred_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_zip_outcomes_run
                        ON zip_outcomes(run_id, outcome_id);
                    CREATE INDEX IF NOT EXISTS idx_zip_outcomes_zip
                        ON zip_outcomes(zip_code, outcome_id);

                    CREATE TABLE IF NOT EXISTS report_rows (
                        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
                        report_day TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_report_rows_run
                        ON report_rows(run_id, row_id);
                    CREATE INDEX IF NOT EXISTS idx_report_rows_day
                        ON report_rows(report_day, row_id);
                    """
                )
                self._schema_ready = True
            finally:
                conn.close()

    def _write(self, operation):
        """Run a short write transaction and always close its connection."""
        self._ensure_schema()
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                result = operation(conn)
                conn.commit()
                return result
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    def _read(self, operation):
        self._ensure_schema()
        with self._lock:
            conn = self._connect()
            try:
                return operation(conn)
            finally:
                conn.close()

    @staticmethod
    def _require_writable_run(conn: sqlite3.Connection, run_id: str) -> None:
        row = conn.execute(
            "SELECT status, finished_at FROM runs WHERE run_id = ?", (run_id,)
        ).fetchone()
        if row is None:
            raise RunNotFoundError(f"Run {run_id!r} does not exist")
        if row["finished_at"] is not None or row["status"] != "running":
            raise RunClosedError(f"Run {run_id!r} is already finished")

    @staticmethod
    def _require_run(conn: sqlite3.Connection, run_id: str) -> None:
        row = conn.execute("SELECT 1 FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            raise RunNotFoundError(f"Run {run_id!r} does not exist")

    # ---- run lifecycle ---------------------------------------------------

    def create_run(
        self,
        metadata: Optional[JsonMapping] = None,
        *,
        run_id: Optional[Union[str, uuid.UUID]] = None,
        started_at: Optional[datetime] = None,
    ) -> str:
        """Create a running scrape record and return its stable local run id."""
        metadata = _require_mapping({} if metadata is None else metadata, field="metadata")
        journal_run_id = _required_run_id(uuid.uuid4().hex if run_id is None else run_id)
        encoded_metadata = _encode_json(dict(metadata), field="metadata")
        began_at = _timestamp(started_at)

        def operation(conn: sqlite3.Connection) -> str:
            try:
                conn.execute(
                    """
                    INSERT INTO runs (run_id, started_at, finished_at, status, metadata_json, error)
                    VALUES (?, ?, NULL, 'running', ?, NULL)
                    """,
                    (journal_run_id, began_at, encoded_metadata),
                )
            except sqlite3.IntegrityError as exc:
                raise RunExistsError(f"Run {journal_run_id!r} already exists") from exc
            return journal_run_id

        return self._write(operation)

    # A clear alias for worker code that uses "start" terminology.
    start_run = create_run

    def finish_run(
        self,
        run_id: Union[str, uuid.UUID],
        *,
        status: str = "completed",
        error: Optional[str] = None,
        metadata_patch: Optional[JsonMapping] = None,
        finished_at: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Atomically close a run and return its final stored representation.

        Finishing the same run twice with the same status is idempotent.  A
        conflicting second status is rejected to preserve the audit trail.
        """
        journal_run_id = _required_run_id(run_id)
        final_status = _token(status, field="status")
        if final_status == "running":
            raise ValueError("finish_run status cannot be 'running'")
        safe_error = _optional_text(error, field="error", max_length=8_000)
        patch = _require_mapping(metadata_patch, field="metadata_patch", allow_none=True)
        closed_at = _timestamp(finished_at)

        def operation(conn: sqlite3.Connection) -> Dict[str, Any]:
            row = conn.execute("SELECT * FROM runs WHERE run_id = ?", (journal_run_id,)).fetchone()
            if row is None:
                raise RunNotFoundError(f"Run {journal_run_id!r} does not exist")
            if row["finished_at"] is not None:
                if row["status"] != final_status:
                    raise RunAlreadyFinishedError(
                        f"Run {journal_run_id!r} was already finished as {row['status']!r}"
                    )
                return self._run_from_row(row)

            metadata = _decode_json(
                row["metadata_json"], table="runs", row_id=journal_run_id, field="metadata_json"
            )
            if not isinstance(metadata, dict):
                raise JournalCorruptionError(
                    f"metadata_json in runs record {journal_run_id!r} is not a JSON object"
                )
            if patch:
                metadata.update(dict(patch))
            encoded_metadata = _encode_json(metadata, field="metadata_patch")
            conn.execute(
                """
                UPDATE runs
                   SET finished_at = ?, status = ?, metadata_json = ?, error = ?
                 WHERE run_id = ?
                """,
                (closed_at, final_status, encoded_metadata, safe_error, journal_run_id),
            )
            finished = conn.execute("SELECT * FROM runs WHERE run_id = ?", (journal_run_id,)).fetchone()
            return self._run_from_row(finished)

        return self._write(operation)

    def get_run(self, run_id: Union[str, uuid.UUID]) -> Optional[Dict[str, Any]]:
        """Return a freshly decoded run record, or ``None`` when it is absent."""
        journal_run_id = _required_run_id(run_id)

        def operation(conn: sqlite3.Connection) -> Optional[Dict[str, Any]]:
            row = conn.execute("SELECT * FROM runs WHERE run_id = ?", (journal_run_id,)).fetchone()
            return self._run_from_row(row) if row is not None else None

        return self._read(operation)

    def list_runs(self, *, limit: int = 100, status: Optional[str] = None) -> List[Dict[str, Any]]:
        """Return recent runs, optionally filtered by a validated status token."""
        page_size = _page_limit(limit)
        status_token = _token(status, field="status") if status is not None else None

        def operation(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
            if status_token is None:
                rows = conn.execute(
                    "SELECT * FROM runs ORDER BY started_at DESC, run_id DESC LIMIT ?", (page_size,)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC, run_id DESC LIMIT ?",
                    (status_token, page_size),
                ).fetchall()
            return [self._run_from_row(row) for row in rows]

        return self._read(operation)

    # ---- immutable hotel-change evidence --------------------------------

    def record_hotel_insert(
        self,
        run_id: Union[str, uuid.UUID],
        *,
        after: JsonMapping,
        hotel_id: Optional[Any] = None,
        dedup_key: Optional[str] = None,
        cid: Optional[str] = None,
        occurred_at: Optional[datetime] = None,
    ) -> int:
        """Record a hotel created by this run, with its post-write snapshot."""
        return self.record_hotel_change(
            run_id,
            operation="inserted",
            after=after,
            before=None,
            hotel_id=hotel_id,
            dedup_key=dedup_key,
            cid=cid,
            occurred_at=occurred_at,
        )

    # Alias names make the intent obvious at call sites.
    record_inserted_hotel = record_hotel_insert

    def record_hotel_touch(
        self,
        run_id: Union[str, uuid.UUID],
        *,
        before: JsonMapping,
        after: JsonMapping,
        hotel_id: Optional[Any] = None,
        dedup_key: Optional[str] = None,
        cid: Optional[str] = None,
        occurred_at: Optional[datetime] = None,
    ) -> int:
        """Record a pre-write and post-write snapshot for a touched hotel."""
        return self.record_hotel_change(
            run_id,
            operation="touched",
            before=before,
            after=after,
            hotel_id=hotel_id,
            dedup_key=dedup_key,
            cid=cid,
            occurred_at=occurred_at,
        )

    record_touched_hotel = record_hotel_touch

    def record_hotel_change(
        self,
        run_id: Union[str, uuid.UUID],
        *,
        operation: str,
        after: JsonMapping,
        before: Optional[JsonMapping] = None,
        hotel_id: Optional[Any] = None,
        dedup_key: Optional[str] = None,
        cid: Optional[str] = None,
        occurred_at: Optional[datetime] = None,
    ) -> int:
        """Append an immutable inserted/touched hotel change snapshot."""
        journal_run_id = _required_run_id(run_id)
        change_operation = _token(operation, field="operation")
        if change_operation not in {"inserted", "touched"}:
            raise ValueError("operation must be 'inserted' or 'touched'")
        after_map = _require_mapping(after, field="after")
        before_map = _require_mapping(before, field="before", allow_none=True)
        if change_operation == "inserted" and before_map is not None:
            raise ValueError("inserted changes must not include a before snapshot")
        if change_operation == "touched" and before_map is None:
            raise ValueError("touched changes require a before snapshot")

        after_json = _encode_json(dict(after_map), field="after")
        before_json = _encode_json(dict(before_map), field="before") if before_map is not None else None
        safe_hotel_id = _optional_text(hotel_id, field="hotel_id", max_length=256)
        safe_dedup_key = _optional_text(dedup_key, field="dedup_key", max_length=1_024)
        safe_cid = _optional_text(cid, field="cid", max_length=256)
        changed_at = _timestamp(occurred_at)

        def operation_fn(conn: sqlite3.Connection) -> int:
            self._require_writable_run(conn, journal_run_id)
            cursor = conn.execute(
                """
                INSERT INTO hotel_changes
                    (run_id, occurred_at, operation, hotel_id, dedup_key, cid, before_json, after_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    journal_run_id,
                    changed_at,
                    change_operation,
                    safe_hotel_id,
                    safe_dedup_key,
                    safe_cid,
                    before_json,
                    after_json,
                ),
            )
            return int(cursor.lastrowid)

        return self._write(operation_fn)

    def hotel_changes_for_run(
        self,
        run_id: Union[str, uuid.UUID],
        *,
        limit: int = 500,
        operation: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Safely retrieve decoded change snapshots in creation order."""
        journal_run_id = _required_run_id(run_id)
        page_size = _page_limit(limit)
        operation_token = _token(operation, field="operation") if operation is not None else None
        if operation_token is not None and operation_token not in {"inserted", "touched"}:
            raise ValueError("operation must be 'inserted' or 'touched'")

        def operation_fn(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
            self._require_run(conn, journal_run_id)
            if operation_token is None:
                rows = conn.execute(
                    """
                    SELECT * FROM hotel_changes
                     WHERE run_id = ?
                     ORDER BY change_id ASC
                     LIMIT ?
                    """,
                    (journal_run_id, page_size),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM hotel_changes
                     WHERE run_id = ? AND operation = ?
                     ORDER BY change_id ASC
                     LIMIT ?
                    """,
                    (journal_run_id, operation_token, page_size),
                ).fetchall()
            return [self._hotel_change_from_row(row) for row in rows]

        return self._read(operation_fn)

    # Friendly alternative used by report/integration code.
    changes_for_run = hotel_changes_for_run

    # ---- ZIP outcomes and quarantine evidence --------------------------

    def record_zip_outcome(
        self,
        run_id: Union[str, uuid.UUID],
        zip_code: Union[str, int],
        outcome: str,
        *,
        quarantined: bool = False,
        reason: Optional[str] = None,
        evidence: Optional[JsonMapping] = None,
        hotels_seen: Optional[int] = None,
        hotels_new: Optional[int] = None,
        occurred_at: Optional[datetime] = None,
    ) -> int:
        """Append a ZIP result; quarantines are retained as audit events, not updates."""
        journal_run_id = _required_run_id(run_id)
        zip_text = str(zip_code).strip()
        if not _ZIP_RE.fullmatch(zip_text):
            raise ValueError("zip_code must be a five-digit US ZIP")
        outcome_token = _token(outcome, field="outcome")
        is_quarantined = bool(quarantined) or outcome_token == "quarantined"
        safe_reason = _optional_text(reason, field="reason", max_length=4_000)
        evidence_map = _require_mapping({} if evidence is None else evidence, field="evidence")
        evidence_json = _encode_json(dict(evidence_map), field="evidence")
        seen = self._nonnegative_optional_int(hotels_seen, field="hotels_seen")
        new = self._nonnegative_optional_int(hotels_new, field="hotels_new")
        recorded_at = _timestamp(occurred_at)

        def operation_fn(conn: sqlite3.Connection) -> int:
            self._require_writable_run(conn, journal_run_id)
            cursor = conn.execute(
                """
                INSERT INTO zip_outcomes
                    (run_id, zip_code, outcome, quarantined, reason, evidence_json,
                     hotels_seen, hotels_new, occurred_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    journal_run_id,
                    zip_text,
                    outcome_token,
                    int(is_quarantined),
                    safe_reason,
                    evidence_json,
                    seen,
                    new,
                    recorded_at,
                ),
            )
            return int(cursor.lastrowid)

        return self._write(operation_fn)

    def quarantine_zip(
        self,
        run_id: Union[str, uuid.UUID],
        zip_code: Union[str, int],
        *,
        reason: str,
        evidence: Optional[JsonMapping] = None,
        outcome: str = "quarantined",
        hotels_seen: Optional[int] = None,
        hotels_new: Optional[int] = None,
        occurred_at: Optional[datetime] = None,
    ) -> int:
        """Convenience wrapper that records a durable, explicit ZIP quarantine."""
        if not _optional_text(reason, field="reason", max_length=4_000):
            raise ValueError("quarantined ZIPs require a reason")
        return self.record_zip_outcome(
            run_id,
            zip_code,
            outcome,
            quarantined=True,
            reason=reason,
            evidence=evidence,
            hotels_seen=hotels_seen,
            hotels_new=hotels_new,
            occurred_at=occurred_at,
        )

    def zip_outcomes_for_run(
        self,
        run_id: Union[str, uuid.UUID],
        *,
        limit: int = 500,
        quarantined: Optional[bool] = None,
    ) -> List[Dict[str, Any]]:
        """Return ZIP outcome events in append order for a run."""
        journal_run_id = _required_run_id(run_id)
        page_size = _page_limit(limit)
        if quarantined is not None and not isinstance(quarantined, bool):
            raise TypeError("quarantined must be True, False, or None")

        def operation_fn(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
            self._require_run(conn, journal_run_id)
            if quarantined is None:
                rows = conn.execute(
                    """
                    SELECT * FROM zip_outcomes
                     WHERE run_id = ?
                     ORDER BY outcome_id ASC
                     LIMIT ?
                    """,
                    (journal_run_id, page_size),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM zip_outcomes
                     WHERE run_id = ? AND quarantined = ?
                     ORDER BY outcome_id ASC
                     LIMIT ?
                    """,
                    (journal_run_id, int(quarantined), page_size),
                ).fetchall()
            return [self._zip_outcome_from_row(row) for row in rows]

        return self._read(operation_fn)

    get_zip_outcomes = zip_outcomes_for_run

    # ---- report payloads ------------------------------------------------

    def record_report_row(
        self,
        run_id: Union[str, uuid.UUID],
        payload: JsonMapping,
        *,
        day: Optional[DateLike] = None,
        kind: str = "summary",
        created_at: Optional[datetime] = None,
    ) -> int:
        """Store a caller-defined report payload for a run and reporting day.

        Unlike hotel/ZIP mutations, reports may be appended after a run closes
        so a daily reporter can write its final summary once the worker exits.
        """
        journal_run_id = _required_run_id(run_id)
        payload_map = _require_mapping(payload, field="payload")
        payload_json = _encode_json(dict(payload_map), field="payload")
        report_day = _report_day(day)
        kind_token = _token(kind, field="kind")
        inserted_at = _timestamp(created_at)

        def operation_fn(conn: sqlite3.Connection) -> int:
            self._require_run(conn, journal_run_id)
            cursor = conn.execute(
                """
                INSERT INTO report_rows (run_id, report_day, kind, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (journal_run_id, report_day, kind_token, payload_json, inserted_at),
            )
            return int(cursor.lastrowid)

        return self._write(operation_fn)

    def report_rows_for_run(
        self,
        run_id: Union[str, uuid.UUID],
        *,
        limit: int = 500,
        day: Optional[DateLike] = None,
    ) -> List[Dict[str, Any]]:
        """Safely retrieve report payloads belonging to one run."""
        journal_run_id = _required_run_id(run_id)
        page_size = _page_limit(limit)
        report_day = _report_day(day) if day is not None else None

        def operation_fn(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
            self._require_run(conn, journal_run_id)
            if report_day is None:
                rows = conn.execute(
                    """
                    SELECT * FROM report_rows
                     WHERE run_id = ?
                     ORDER BY row_id ASC
                     LIMIT ?
                    """,
                    (journal_run_id, page_size),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM report_rows
                     WHERE run_id = ? AND report_day = ?
                     ORDER BY row_id ASC
                     LIMIT ?
                    """,
                    (journal_run_id, report_day, page_size),
                ).fetchall()
            return [self._report_row_from_row(row) for row in rows]

        return self._read(operation_fn)

    def report_rows_for_day(self, day: DateLike, *, limit: int = 500) -> List[Dict[str, Any]]:
        """Return all report payloads explicitly assigned to one ISO date."""
        report_day = _report_day(day)
        page_size = _page_limit(limit)

        def operation(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
            rows = conn.execute(
                """
                SELECT * FROM report_rows
                 WHERE report_day = ?
                 ORDER BY row_id ASC
                 LIMIT ?
                """,
                (report_day, page_size),
            ).fetchall()
            return [self._report_row_from_row(row) for row in rows]

        return self._read(operation)

    # Aliases for naturally worded dashboard/report code.
    get_report_rows = report_rows_for_run
    get_report_rows_for_day = report_rows_for_day

    def run_report(self, run_id: Union[str, uuid.UUID]) -> Dict[str, Any]:
        """Build a read-only, complete per-run audit report from journal rows."""
        journal_run_id = _required_run_id(run_id)

        def operation(conn: sqlite3.Connection) -> Dict[str, Any]:
            run_row = conn.execute("SELECT * FROM runs WHERE run_id = ?", (journal_run_id,)).fetchone()
            if run_row is None:
                raise RunNotFoundError(f"Run {journal_run_id!r} does not exist")
            change_rows = conn.execute(
                "SELECT * FROM hotel_changes WHERE run_id = ? ORDER BY change_id ASC", (journal_run_id,)
            ).fetchall()
            outcome_rows = conn.execute(
                "SELECT * FROM zip_outcomes WHERE run_id = ? ORDER BY outcome_id ASC", (journal_run_id,)
            ).fetchall()
            report_rows = conn.execute(
                "SELECT * FROM report_rows WHERE run_id = ? ORDER BY row_id ASC", (journal_run_id,)
            ).fetchall()
            changes = [self._hotel_change_from_row(row) for row in change_rows]
            outcomes = [self._zip_outcome_from_row(row) for row in outcome_rows]
            reports = [self._report_row_from_row(row) for row in report_rows]
            return {
                "run": self._run_from_row(run_row),
                "changes": changes,
                "zip_outcomes": outcomes,
                "report_rows": reports,
                "counts": {
                    "hotels_inserted": sum(change["operation"] == "inserted" for change in changes),
                    "hotels_touched": sum(change["operation"] == "touched" for change in changes),
                    "zip_outcomes": len(outcomes),
                    "quarantined_zips": sum(outcome["quarantined"] for outcome in outcomes),
                    "report_rows": len(reports),
                },
            }

        return self._read(operation)

    def daily_report(self, day: DateLike, *, limit: int = 500) -> Dict[str, Any]:
        """Build a read-only daily view from rows explicitly tagged with ``day``.

        Run lifecycle records are included when either their start or finish
        timestamp falls on that UTC day.  ZIP/change rows remain available via
        their run report; the daily view intentionally does not infer a day
        from a potentially local caller timestamp.
        """
        report_day = _report_day(day)
        page_size = _page_limit(limit)

        def operation(conn: sqlite3.Connection) -> Dict[str, Any]:
            runs = conn.execute(
                """
                SELECT * FROM runs
                 WHERE substr(started_at, 1, 10) = ? OR substr(finished_at, 1, 10) = ?
                 ORDER BY started_at ASC, run_id ASC
                 LIMIT ?
                """,
                (report_day, report_day, page_size),
            ).fetchall()
            rows = conn.execute(
                """
                SELECT * FROM report_rows
                 WHERE report_day = ?
                 ORDER BY row_id ASC
                 LIMIT ?
                """,
                (report_day, page_size),
            ).fetchall()
            decoded_runs = [self._run_from_row(row) for row in runs]
            decoded_rows = [self._report_row_from_row(row) for row in rows]
            return {
                "day": report_day,
                "runs": decoded_runs,
                "report_rows": decoded_rows,
                "counts": {"runs": len(decoded_runs), "report_rows": len(decoded_rows)},
            }

        return self._read(operation)

    # ---- row decoding ----------------------------------------------------

    @staticmethod
    def _nonnegative_optional_int(value: Optional[int], *, field: str) -> Optional[int]:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{field} must be a non-negative integer or None")
        return value

    @staticmethod
    def _run_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "run_id": row["run_id"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "status": row["status"],
            "metadata": _decode_json(
                row["metadata_json"], table="runs", row_id=row["run_id"], field="metadata_json"
            ),
            "error": row["error"],
        }

    @staticmethod
    def _hotel_change_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "change_id": row["change_id"],
            "run_id": row["run_id"],
            "occurred_at": row["occurred_at"],
            "operation": row["operation"],
            "hotel_id": row["hotel_id"],
            "dedup_key": row["dedup_key"],
            "cid": row["cid"],
            "before": (
                _decode_json(
                    row["before_json"],
                    table="hotel_changes",
                    row_id=row["change_id"],
                    field="before_json",
                )
                if row["before_json"] is not None
                else None
            ),
            "after": _decode_json(
                row["after_json"],
                table="hotel_changes",
                row_id=row["change_id"],
                field="after_json",
            ),
        }

    @staticmethod
    def _zip_outcome_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "outcome_id": row["outcome_id"],
            "run_id": row["run_id"],
            "zip_code": row["zip_code"],
            "outcome": row["outcome"],
            "quarantined": bool(row["quarantined"]),
            "reason": row["reason"],
            "evidence": _decode_json(
                row["evidence_json"],
                table="zip_outcomes",
                row_id=row["outcome_id"],
                field="evidence_json",
            ),
            "hotels_seen": row["hotels_seen"],
            "hotels_new": row["hotels_new"],
            "occurred_at": row["occurred_at"],
        }

    @staticmethod
    def _report_row_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "row_id": row["row_id"],
            "run_id": row["run_id"],
            "day": row["report_day"],
            "kind": row["kind"],
            "payload": _decode_json(
                row["payload_json"],
                table="report_rows",
                row_id=row["row_id"],
                field="payload_json",
            ),
            "created_at": row["created_at"],
        }


__all__ = [
    "DEFAULT_JOURNAL_FILENAME",
    "JournalCorruptionError",
    "RunAlreadyFinishedError",
    "RunClosedError",
    "RunExistsError",
    "RunJournal",
    "RunJournalError",
    "RunNotFoundError",
    "default_journal_path",
]
