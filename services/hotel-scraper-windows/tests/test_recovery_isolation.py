import asyncio
from types import SimpleNamespace

import pytest

from app.config import database_target, settings
from app.outbox import OutboxTargetMismatch, default_outbox_path
from app.worker import ScraperBackgroundWorker


@pytest.mark.parametrize("target", [None, {"version": 1, "backend": "cloud", "fingerprint": "foreign"}])
def test_foreign_replay_never_claims_or_writes(target, monkeypatch):
    worker = ScraperBackgroundWorker()
    worker._outbox = object()
    def forbidden(*args):
        pytest.fail("Unsafe replay reached database")
    monkeypatch.setattr(worker, "_claim_outbox_zip", forbidden)
    monkeypatch.setattr(worker, "_save_results", forbidden)
    entry = SimpleNamespace(metadata={"database_target": target})
    with pytest.raises(OutboxTargetMismatch):
        asyncio.run(worker._flush_outbox_entry(entry))


def test_sqlite_state_separated_from_cloud(monkeypatch):
    monkeypatch.setattr(settings, "DB_BACKEND", "sqlite")
    local = default_outbox_path()
    monkeypatch.setattr(settings, "DB_BACKEND", "cloud")
    cloud = default_outbox_path()
    assert local != cloud
    assert "development" in local.parts


def test_tests_cannot_connect_to_cloud(monkeypatch):
    from app import database
    monkeypatch.setattr(settings, "DB_BACKEND", "cloud")
    with pytest.raises(database.DatabaseUnavailable, match="forbidden in tests"):
        database.init_db()


def test_missing_target_holds_startup_without_modifying_batch(tmp_path):
    from app.outbox import LocalOutbox
    from app.recovery import inspect_startup_recovery
    outbox = LocalOutbox(tmp_path / "outbox.sqlite3")
    batch = outbox.enqueue("legacy", "98033", [{"name": "Loop Hotel"}])
    report = inspect_startup_recovery(outbox_path=outbox.path, journal_path=tmp_path / "absent.sqlite3")
    assert not report.safe_to_resume
    assert outbox.get(batch.batch_id).status == "pending"


def test_approved_cleanup_checkpoint_preserves_newer_high_watermark():
    target = database_target()
    journal = SimpleNamespace(list_runs=lambda **kwargs: [
        {"run_id": "newer", "metadata": {"hotel_inventory_end": {"hotel_count": 105, "max_hotel_id": 205}}},
        {"run_id": "cleanup", "metadata": {"database_target": target,
            "operator_inventory_checkpoint": {"hotel_count": 100, "max_hotel_id": 200}}},
        {"run_id": "old", "metadata": {"hotel_inventory_end": {"hotel_count": 101, "max_hotel_id": 999}}},
    ])
    result = ScraperBackgroundWorker()._historical_inventory_watermark(journal)
    assert result["hotel_count"] == 105
    assert result["max_hotel_id"] == 205
