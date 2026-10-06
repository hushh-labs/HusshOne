"""Durable local outbox for validated scraper batches.

The outbox is intentionally independent of SQLAlchemy and Cloud SQL.  A
worker enqueues a *validated* ZIP batch locally before attempting a remote
write; after a successful idempotent Cloud SQL flush it marks the batch
delivered.  If a batch is unsafe to send, it can instead be quarantined with
operator-readable evidence.  No row is deleted automatically.

Each operation opens its own SQLite connection and commits with ``WAL`` plus
``synchronous=FULL``.  This keeps the queue durable across application and
machine restarts without sharing SQLite connections between worker threads or
processes.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Union

from app.config import runtime_state_dir, database_target


DEFAULT_OUTBOX_FILENAME = "scrape_outbox.sqlite3"
MAX_JSON_BYTES = 5_000_000
MAX_PAGE_SIZE = 1_000

PENDING = "pending"
DELIVERED = "delivered"
QUARANTINED = "quarantined"
_STATUSES = frozenset((PENDING, DELIVERED, QUARANTINED))

_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_ZIP_RE = re.compile(r"^\d{5}$")


class OutboxError(RuntimeError):
    """Base exception for local outbox failures."""


class OutboxTargetMismatch(OutboxError):
    """A legacy or foreign batch must never mutate the current database."""


def require_matching_target(metadata: Mapping[str, Any]) -> None:
    if metadata.get("database_target") != database_target():
        raise OutboxTargetMismatch(
            "Outbox database target is missing or different; hold for operator review."
        )


class OutboxNotFoundError(OutboxError):
    """Raised when a requested outbox batch does not exist."""


class OutboxConflictError(OutboxError):
    """Raised when a caller reuses a batch id for a different payload."""


class OutboxStateError(OutboxError):
    """Raised when a terminal batch is asked to take another terminal state."""


class OutboxCorruptionError(OutboxError):
    """Raised rather than silently ignoring malformed JSON on disk."""


JsonMapping = Mapping[str, Any]
PathLike = Union[str, Path]


@dataclass(frozen=True)
class OutboxBatch:
    """An immutable view of one durable scrape batch.

    ``records`` and metadata values are decoded afresh on every read, so
    mutating a returned object cannot mutate the durable payload.
    """

    batch_id: str
    run_id: str
    zip_code: str
    records: List[Dict[str, Any]]
    metadata: Dict[str, Any]
    status: str
    created_at: str
    delivered_at: Optional[str]
    quarantined_at: Optional[str]
    delivery_metadata: Optional[Dict[str, Any]]
    quarantine_reason: Optional[str]
    quarantine_evidence: Optional[Dict[str, Any]]

    @property
    def record_count(self) -> int:
        return len(self.records)


def default_outbox_path() -> Path:
    """Return the stable user-local path used when no path is supplied."""
    return Path(runtime_state_dir()) / DEFAULT_OUTBOX_FILENAME


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: Optional[datetime] = None) -> str:
    """Serialize a timestamp as a lexically sortable UTC value."""
    value = value or _utc_now()
    if not isinstance(value, datetime):
        raise TypeError("timestamp must be a datetime or None")
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return _timestamp(value)
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def _encode_json(value: Any, *, field: str) -> str:
    """Encode a bounded, standards-compliant JSON snapshot immediately."""
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
        raise ValueError(f"{field} exceeds the {MAX_JSON_BYTES:,}-byte outbox limit")
    return encoded


def _decode_json(value: Optional[str], *, field: str, batch_id: str) -> Any:
    if value is None:
        return None
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError) as exc:
        raise OutboxCorruptionError(
            f"Malformed {field} in outbox batch {batch_id!r}; outbox was not modified."
        ) from exc


def _identifier(value: Any, *, field: str) -> str:
    if value is None:
        raise ValueError(f"{field} is required")
    text = str(value).strip()
    if not _IDENTIFIER_RE.fullmatch(text):
        raise ValueError(f"{field} must be 1-128 safe identifier characters")
    return text


def _zip_code(value: Any) -> str:
    text = str(value).strip()
    if not _ZIP_RE.fullmatch(text):
        raise ValueError("zip_code must be a five-digit ZIP")
    return text


def _reason(value: Any) -> str:
    if value is None:
        raise ValueError("reason is required")
    text = str(value).strip()
    if not text or "\x00" in text or len(text) > 2_000:
        raise ValueError("reason must be 1-2,000 non-NUL characters")
    return text


def _mapping(value: Optional[JsonMapping], *, field: str) -> Dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise TypeError(f"{field} must be a mapping")
    # JSON encoding below is the deep-copy boundary.  This shallow conversion
    # also avoids retaining a caller-owned custom Mapping object.
    return dict(value)


def _records(value: Iterable[JsonMapping]) -> List[Dict[str, Any]]:
    if isinstance(value, (str, bytes, Mapping)):
        raise TypeError("records must be a non-empty iterable of mappings")
    try:
        rows = list(value)
    except TypeError as exc:
        raise TypeError("records must be a non-empty iterable of mappings") from exc
    if not rows:
        raise ValueError("records must contain at least one validated record")
    normalized: List[Dict[str, Any]] = []
    for index, row in enumerate(rows):
        if not isinstance(row, Mapping):
            raise TypeError(f"records[{index}] must be a mapping")
        normalized.append(dict(row))
    return normalized


def _page_limit(limit: int) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PAGE_SIZE:
        raise ValueError(f"limit must be an integer between 1 and {MAX_PAGE_SIZE}")
    return limit


class LocalOutbox:
    """A durable, file-backed queue for validated batches awaiting Cloud SQL.

    Args:
        path: Optional SQLite path.  The default is
            ``user_data_dir()/scrape_outbox.sqlite3``.  ``:memory:`` is
            rejected because an outbox must survive a restart.

    ``enqueue`` is idempotent when the caller supplies a stable ``batch_id``:
    resubmitting the same run, ZIP, records and metadata returns the original
    batch; a differing payload raises :class:`OutboxConflictError`.
    """

    def __init__(self, path: Optional[PathLike] = None):
        if path is not None and str(path) == ":memory:":
            raise ValueError("LocalOutbox requires a durable file path, not SQLite :memory:")
        self.path = Path(path) if path is not None else default_outbox_path()
        self.path = self.path.expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._schema_ready = False
        self._ensure_schema()

    # ---- SQLite lifecycle -------------------------------------------------

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
                    CREATE TABLE IF NOT EXISTS outbox_batches (
                        batch_id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL,
                        zip_code TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'quarantined')),
                        record_count INTEGER NOT NULL CHECK (record_count > 0),
                        records_json TEXT NOT NULL,
                        metadata_json TEXT NOT NULL,
                        delivered_at TEXT,
                        delivery_metadata_json TEXT,
                        quarantined_at TEXT,
                        quarantine_reason TEXT,
                        quarantine_evidence_json TEXT,
                        CHECK (
                            (status = 'pending'
                                AND delivered_at IS NULL
                                AND delivery_metadata_json IS NULL
                                AND quarantined_at IS NULL
                                AND quarantine_reason IS NULL
                                AND quarantine_evidence_json IS NULL)
                            OR
                            (status = 'delivered'
                                AND delivered_at IS NOT NULL
                                AND quarantined_at IS NULL
                                AND quarantine_reason IS NULL
                                AND quarantine_evidence_json IS NULL)
                            OR
                            (status = 'quarantined'
                                AND delivered_at IS NULL
                                AND delivery_metadata_json IS NULL
                                AND quarantined_at IS NOT NULL
                                AND quarantine_reason IS NOT NULL)
                        )
                    );

                    CREATE INDEX IF NOT EXISTS idx_outbox_pending_created
                        ON outbox_batches(status, created_at, batch_id);
                    """
                )
            finally:
                conn.close()
            self._schema_ready = True

    # ---- public queue API -------------------------------------------------

    def enqueue(
        self,
        run_id: Any,
        zip_code: Any,
        records: Iterable[JsonMapping],
        *,
        metadata: Optional[JsonMapping] = None,
        batch_id: Optional[Any] = None,
        created_at: Optional[datetime] = None,
    ) -> OutboxBatch:
        """Durably enqueue one already-validated, non-empty ZIP batch.

        The payload is serialized before the SQLite transaction begins, which
        prevents later caller-side mutations from changing queued data.
        ``batch_id`` may be a deterministic value such as ``<run>:<zip>`` to
        make retrying an enqueue safe.
        """
        normalized_run_id = _identifier(run_id, field="run_id")
        normalized_zip = _zip_code(zip_code)
        normalized_records = _records(records)
        normalized_metadata = _mapping(metadata, field="metadata")
        normalized_batch_id = (
            _identifier(batch_id, field="batch_id")
            if batch_id is not None
            else f"outbox-{uuid.uuid4().hex}"
        )
        records_json = _encode_json(normalized_records, field="records")
        metadata_json = _encode_json(normalized_metadata, field="metadata")
        timestamp = _timestamp(created_at)

        with self._lock:
            conn = self._connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                existing = conn.execute(
                    "SELECT * FROM outbox_batches WHERE batch_id = ?", (normalized_batch_id,)
                ).fetchone()
                if existing is not None:
                    result = self._row_to_batch(existing)
                    if (
                        result.run_id == normalized_run_id
                        and result.zip_code == normalized_zip
                        and result.records == normalized_records
                        and result.metadata == normalized_metadata
                    ):
                        conn.commit()
                        return result
                    raise OutboxConflictError(
                        f"batch_id {normalized_batch_id!r} already belongs to a different payload"
                    )
                conn.execute(
                    """
                    INSERT INTO outbox_batches (
                        batch_id, run_id, zip_code, created_at, status, record_count,
                        records_json, metadata_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        normalized_batch_id,
                        normalized_run_id,
                        normalized_zip,
                        timestamp,
                        PENDING,
                        len(normalized_records),
                        records_json,
                        metadata_json,
                    ),
                )
                row = conn.execute(
                    "SELECT * FROM outbox_batches WHERE batch_id = ?", (normalized_batch_id,)
                ).fetchone()
                conn.commit()
                return self._row_to_batch(row)
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    def get(self, batch_id: Any) -> OutboxBatch:
        """Return a batch, including terminal batches retained for audit."""
        normalized_batch_id = _identifier(batch_id, field="batch_id")
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM outbox_batches WHERE batch_id = ?", (normalized_batch_id,)
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            raise OutboxNotFoundError(f"Outbox batch {normalized_batch_id!r} was not found")
        return self._row_to_batch(row)

    def pending(self, *, limit: int = 100) -> List[OutboxBatch]:
        """Return pending batches in durable FIFO order without changing state."""
        limit = _page_limit(limit)
        conn = self._connect()
        try:
            rows = conn.execute(
                """
                SELECT * FROM outbox_batches
                WHERE status = ?
                ORDER BY created_at ASC, batch_id ASC
                LIMIT ?
                """,
                (PENDING, limit),
            ).fetchall()
        finally:
            conn.close()
        return [self._row_to_batch(row) for row in rows]

    def mark_delivered(
        self,
        batch_id: Any,
        *,
        delivery_metadata: Optional[JsonMapping] = None,
        delivered_at: Optional[datetime] = None,
    ) -> OutboxBatch:
        """Mark a successfully flushed batch terminally delivered.

        Repeating the same acknowledgement is safe.  A batch that was
        quarantined cannot silently become delivered, and vice versa.
        """
        normalized_batch_id = _identifier(batch_id, field="batch_id")
        normalized_metadata = _mapping(delivery_metadata, field="delivery_metadata")
        metadata_json = _encode_json(normalized_metadata, field="delivery_metadata")
        timestamp = _timestamp(delivered_at)
        return self._transition(
            normalized_batch_id,
            target=DELIVERED,
            timestamp=timestamp,
            delivery_metadata=normalized_metadata,
            delivery_metadata_json=metadata_json,
        )

    def mark_quarantined(
        self,
        batch_id: Any,
        reason: Any,
        *,
        evidence: Optional[JsonMapping] = None,
        quarantined_at: Optional[datetime] = None,
    ) -> OutboxBatch:
        """Mark an unsafe batch terminally quarantined with durable evidence."""
        normalized_batch_id = _identifier(batch_id, field="batch_id")
        normalized_reason = _reason(reason)
        normalized_evidence = _mapping(evidence, field="evidence")
        evidence_json = _encode_json(normalized_evidence, field="evidence")
        timestamp = _timestamp(quarantined_at)
        return self._transition(
            normalized_batch_id,
            target=QUARANTINED,
            timestamp=timestamp,
            reason=normalized_reason,
            evidence=normalized_evidence,
            evidence_json=evidence_json,
        )

    def count(self, status: Optional[str] = None) -> int:
        """Return the total batch count, or only batches in one valid state."""
        if status is not None and status not in _STATUSES:
            raise ValueError(f"status must be one of: {', '.join(sorted(_STATUSES))}")
        conn = self._connect()
        try:
            if status is None:
                row = conn.execute("SELECT COUNT(*) AS count FROM outbox_batches").fetchone()
            else:
                row = conn.execute(
                    "SELECT COUNT(*) AS count FROM outbox_batches WHERE status = ?", (status,)
                ).fetchone()
        finally:
            conn.close()
        return int(row["count"])

    def prune_terminal(self, older_than: datetime) -> int:
        """Remove only old terminal transport records and return their count.

        Pending batches are never eligible. The run journal remains the
        long-lived audit source; this method merely bounds the size of the
        replay spool after a caller-selected retention period.
        """
        cutoff = _timestamp(older_than)
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                cursor = conn.execute(
                    """
                    DELETE FROM outbox_batches
                    WHERE status IN (?, ?)
                      AND COALESCE(delivered_at, quarantined_at) < ?
                    """,
                    (DELIVERED, QUARANTINED, cutoff),
                )
                conn.commit()
                return int(cursor.rowcount)
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    # ---- state transition plumbing ---------------------------------------

    def _transition(
        self,
        batch_id: str,
        *,
        target: str,
        timestamp: str,
        delivery_metadata: Optional[Dict[str, Any]] = None,
        delivery_metadata_json: Optional[str] = None,
        reason: Optional[str] = None,
        evidence: Optional[Dict[str, Any]] = None,
        evidence_json: Optional[str] = None,
    ) -> OutboxBatch:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                row = conn.execute(
                    "SELECT * FROM outbox_batches WHERE batch_id = ?", (batch_id,)
                ).fetchone()
                if row is None:
                    raise OutboxNotFoundError(f"Outbox batch {batch_id!r} was not found")
                existing = self._row_to_batch(row)
                if existing.status == target:
                    self._assert_same_terminal_ack(
                        existing,
                        target=target,
                        delivery_metadata=delivery_metadata,
                        reason=reason,
                        evidence=evidence,
                    )
                    conn.commit()
                    return existing
                if existing.status != PENDING:
                    raise OutboxStateError(
                        f"Outbox batch {batch_id!r} is {existing.status!r}, not pending"
                    )
                if target == DELIVERED:
                    conn.execute(
                        """
                        UPDATE outbox_batches
                        SET status = ?, delivered_at = ?, delivery_metadata_json = ?
                        WHERE batch_id = ? AND status = ?
                        """,
                        (DELIVERED, timestamp, delivery_metadata_json, batch_id, PENDING),
                    )
                else:
                    conn.execute(
                        """
                        UPDATE outbox_batches
                        SET status = ?, quarantined_at = ?, quarantine_reason = ?,
                            quarantine_evidence_json = ?
                        WHERE batch_id = ? AND status = ?
                        """,
                        (QUARANTINED, timestamp, reason, evidence_json, batch_id, PENDING),
                    )
                updated = conn.execute(
                    "SELECT * FROM outbox_batches WHERE batch_id = ?", (batch_id,)
                ).fetchone()
                conn.commit()
                return self._row_to_batch(updated)
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    @staticmethod
    def _assert_same_terminal_ack(
        existing: OutboxBatch,
        *,
        target: str,
        delivery_metadata: Optional[Dict[str, Any]],
        reason: Optional[str],
        evidence: Optional[Dict[str, Any]],
    ) -> None:
        if target == DELIVERED:
            if existing.delivery_metadata != delivery_metadata:
                raise OutboxConflictError(
                    f"Outbox batch {existing.batch_id!r} was already delivered with different metadata"
                )
            return
        if existing.quarantine_reason != reason or existing.quarantine_evidence != evidence:
            raise OutboxConflictError(
                f"Outbox batch {existing.batch_id!r} was already quarantined differently"
            )

    @staticmethod
    def _row_to_batch(row: sqlite3.Row) -> OutboxBatch:
        batch_id = str(row["batch_id"])
        records = _decode_json(row["records_json"], field="records_json", batch_id=batch_id)
        metadata = _decode_json(row["metadata_json"], field="metadata_json", batch_id=batch_id)
        delivery_metadata = _decode_json(
            row["delivery_metadata_json"], field="delivery_metadata_json", batch_id=batch_id
        )
        quarantine_evidence = _decode_json(
            row["quarantine_evidence_json"], field="quarantine_evidence_json", batch_id=batch_id
        )
        if not isinstance(records, list) or not records or any(not isinstance(record, dict) for record in records):
            raise OutboxCorruptionError(
                f"Malformed records_json in outbox batch {batch_id!r}; outbox was not modified."
            )
        if int(row["record_count"]) != len(records):
            raise OutboxCorruptionError(
                f"Mismatched record_count in outbox batch {batch_id!r}; outbox was not modified."
            )
        if not isinstance(metadata, dict):
            raise OutboxCorruptionError(
                f"Malformed metadata_json in outbox batch {batch_id!r}; outbox was not modified."
            )
        if delivery_metadata is not None and not isinstance(delivery_metadata, dict):
            raise OutboxCorruptionError(
                f"Malformed delivery_metadata_json in outbox batch {batch_id!r}; outbox was not modified."
            )
        if quarantine_evidence is not None and not isinstance(quarantine_evidence, dict):
            raise OutboxCorruptionError(
                f"Malformed quarantine_evidence_json in outbox batch {batch_id!r}; outbox was not modified."
            )
        if row["status"] not in _STATUSES:
            raise OutboxCorruptionError(
                f"Malformed status in outbox batch {batch_id!r}; outbox was not modified."
            )
        return OutboxBatch(
            batch_id=batch_id,
            run_id=str(row["run_id"]),
            zip_code=str(row["zip_code"]),
            records=records,
            metadata=metadata,
            status=str(row["status"]),
            created_at=str(row["created_at"]),
            delivered_at=row["delivered_at"],
            quarantined_at=row["quarantined_at"],
            delivery_metadata=delivery_metadata,
            quarantine_reason=row["quarantine_reason"],
            quarantine_evidence=quarantine_evidence,
        )


# A descriptive alias for integrations that prefer the pipeline-oriented name.
ScrapeOutbox = LocalOutbox
