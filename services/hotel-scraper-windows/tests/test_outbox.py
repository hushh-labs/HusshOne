from datetime import datetime, timezone
import sqlite3

import pytest

from app.outbox import (
    DELIVERED,
    PENDING,
    QUARANTINED,
    LocalOutbox,
    OutboxConflictError,
    OutboxStateError,
)


@pytest.fixture
def outbox(tmp_path):
    return LocalOutbox(tmp_path / "scrape_outbox.sqlite3")


def test_enqueue_is_durable_idempotent_and_snapshots_records(outbox):
    records = [
        {
            "name": "North Star Hotel",
            "lat": 47.61,
            "lng": -122.2,
            "sources": ["places"],
            "raw": {"google_cid": "123"},
        }
    ]
    metadata = {"scraped_via": "chrome_google_maps"}
    created_at = datetime(2026, 10, 5, 8, 30, tzinfo=timezone.utc)

    queued = outbox.enqueue(
        "run-20261005",
        "98033",
        records,
        metadata=metadata,
        batch_id="run-20261005:98033",
        created_at=created_at,
    )
    records[0]["name"] = "changed only in worker memory"
    metadata["scraped_via"] = "changed only in worker memory"

    # A restart must see the original on-disk snapshot, not caller-owned data.
    reopened = LocalOutbox(outbox.path)
    assert reopened.pending() == [
        queued.__class__(
            batch_id="run-20261005:98033",
            run_id="run-20261005",
            zip_code="98033",
            records=[
                {
                    "name": "North Star Hotel",
                    "lat": 47.61,
                    "lng": -122.2,
                    "sources": ["places"],
                    "raw": {"google_cid": "123"},
                }
            ],
            metadata={"scraped_via": "chrome_google_maps"},
            status=PENDING,
            created_at="2026-10-05T08:30:00.000000Z",
            delivered_at=None,
            quarantined_at=None,
            delivery_metadata=None,
            quarantine_reason=None,
            quarantine_evidence=None,
        )
    ]
    # Retrying the same durable enqueue does not create a second batch.
    retried = reopened.enqueue(
        "run-20261005",
        "98033",
        [
            {
                "name": "North Star Hotel",
                "lat": 47.61,
                "lng": -122.2,
                "sources": ["places"],
                "raw": {"google_cid": "123"},
            }
        ],
        metadata={"scraped_via": "chrome_google_maps"},
        batch_id="run-20261005:98033",
    )
    assert retried == reopened.get("run-20261005:98033")
    assert reopened.count() == 1
    assert reopened.count(PENDING) == 1


def test_delivered_and_quarantined_are_durable_terminal_lifecycles(outbox):
    outbox.enqueue("run-a", "98033", [{"name": "A"}], batch_id="run-a:98033")
    outbox.enqueue("run-a", "98034", [{"name": "B"}], batch_id="run-a:98034")

    delivered = outbox.mark_delivered(
        "run-a:98033",
        delivery_metadata={"cloud_sql_attempt": "transaction-42", "inserted": 1},
        delivered_at=datetime(2026, 10, 5, 9, tzinfo=timezone.utc),
    )
    quarantined = outbox.mark_quarantined(
        "run-a:98034",
        "ZIP had an implausible number of new hotels",
        evidence={"new_hotels": 41, "limit": 40},
        quarantined_at=datetime(2026, 10, 5, 9, 1, tzinfo=timezone.utc),
    )

    assert delivered.status == DELIVERED
    assert delivered.delivered_at == "2026-10-05T09:00:00.000000Z"
    assert quarantined.status == QUARANTINED
    assert quarantined.quarantine_evidence == {"new_hotels": 41, "limit": 40}
    assert outbox.pending() == []
    assert outbox.count(DELIVERED) == 1
    assert outbox.count(QUARANTINED) == 1

    # The matching acknowledgement is idempotent; conflicting terminal state is not.
    assert outbox.mark_delivered(
        "run-a:98033", delivery_metadata={"cloud_sql_attempt": "transaction-42", "inserted": 1}
    ).status == DELIVERED
    with pytest.raises(OutboxStateError):
        outbox.mark_delivered("run-a:98034")
    with pytest.raises(OutboxStateError):
        outbox.mark_quarantined("run-a:98033", "unexpected follow-up")


def test_payload_conflicts_invalid_json_and_connection_durability_are_guarded(outbox):
    outbox.enqueue("run-b", "98033", [{"name": "A"}], batch_id="run-b:98033")
    with pytest.raises(OutboxConflictError):
        outbox.enqueue("run-b", "98033", [{"name": "different"}], batch_id="run-b:98033")
    with pytest.raises(ValueError, match="JSON serializable"):
        outbox.enqueue("run-b", "98034", [{"rating": float("nan")}])
    with pytest.raises(ValueError, match="at least one"):
        outbox.enqueue("run-b", "98034", [])
    assert outbox.count() == 1

    # WAL is persistent, and every connection opened by the outbox requests FULL sync.
    with sqlite3.connect(outbox.path) as raw:
        assert raw.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    conn = outbox._connect()
    try:
        assert conn.execute("PRAGMA synchronous").fetchone()[0] == 2  # SQLITE_SYNC_FULL
    finally:
        conn.close()


def test_prune_terminal_never_removes_pending_batches(outbox):
    outbox.enqueue("run-c", "98033", [{"name": "pending"}], batch_id="run-c:pending")
    outbox.enqueue("run-c", "98034", [{"name": "old"}], batch_id="run-c:old")
    outbox.mark_delivered(
        "run-c:old",
        delivered_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
    )

    removed = outbox.prune_terminal(datetime(2026, 10, 5, tzinfo=timezone.utc))

    assert removed == 1
    assert outbox.count(PENDING) == 1
    assert outbox.count() == 1
