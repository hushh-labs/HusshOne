import uuid
import sqlite3
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import worker as module
from app.config import database_target, settings
from app.models import Base, Hotel
from app.website_backfill import fill_candidates
from app.website_queue import WebsiteQueue


@pytest.fixture
def setup(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "hotels.sqlite3"))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(module, "get_db_session", sessions)
    monkeypatch.setattr(settings, "WEBSITE_FILL_MISSING_FIELDS", True)
    monkeypatch.setattr(settings, "WEBSITE_BACKFILL_BATCH_SIZE", 1)
    monkeypatch.setattr(settings, "WEBSITE_BACKFILL_MAX_PENDING", 2)
    worker = module.ScraperBackgroundWorker()
    worker._website_queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    monkeypatch.setattr(worker, "_assert_inventory_safe", lambda *a: None)
    monkeypatch.setattr(worker, "_assert_current_write_contract", lambda: None)
    yield worker, sessions
    engine.dispose()


def seed(sessions, **values):
    data = dict(dedup_key=uuid.uuid4().hex, name="Cedar Hotel", website="https://hotel.example/",
                sources=["places"], lat=47.68, lng=-122.2, rating=4.5,
                raw={"run_id": "original", "scraped_via": "chrome_google_maps"}, photos=[{"preserve": True}])
    data.update(values)
    with sessions() as db:
        row = Hotel(**data)
        db.add(row)
        db.commit()
        db.refresh(row)
        return row


def test_missing_website_queues_identity_discovery(setup):
    worker, sessions = setup
    row = seed(sessions, website=None, raw={"google_cid": "123"})
    worker._website_queue.start_backfill(row.id)
    worker._scan_website_backfill()
    queued = worker._website_queue.next_job()
    assert queued["payload"]["record"]["_discover_website"] is True
    assert queued["payload"]["fill_missing"] is True
    with sessions() as db:
        assert db.get(Hotel, row.id).website is None


def test_new_discovery_backlog_does_not_consume_historical_slots(setup):
    worker, sessions = setup
    queue = worker._website_queue
    for index in range(5):
        queue.enqueue({"dedup_key": str(index), "name": "New hotel", "website": "https://hotel.example/", "raw": {}},
                      "new-run", database_target())
    row = seed(sessions)
    queue.start_backfill(row.id)
    worker._scan_website_backfill()
    assert queue.backfill_status()["jobs"] == {"pending": 1}
    assert queue.backfill_status()["cursor"] == row.id


def test_discovered_website_requires_current_identity_and_preserves_replay(setup):
    worker, sessions = setup
    row = seed(sessions, website=None, phone="2065551234")
    result = evidence()
    result.update(requested_url="https://hotel.example/", discovery_source_url="https://www.google.com/maps?cid=123",
                  identity_node={"@type": "Hotel", "name": row.name, "telephone": row.phone})
    queued = job(row, result)
    queued["payload"]["record"]["_discover_website"] = True
    applied = worker._apply_website_evidence(queued)
    assert "website" in applied["filled_fields"]
    assert "website" in worker._apply_website_evidence(queued)["filled_fields"]
    with sessions() as db:
        stored = db.get(Hotel, row.id)
        assert stored.website == "https://hotel.example/"
        assert stored.phone == "2065551234"
        assert stored.raw["website_field_fills"]["website"]["previous"] is None
        assert stored.photos == [{"preserve": True}]


def test_discovered_website_does_not_override_concurrent_operator_change(setup):
    worker, sessions = setup
    row = seed(sessions, website=None, phone="2065551234")
    result = evidence()
    result.update(requested_url="https://hotel.example/", identity_node={"@type": "Hotel", "name": row.name, "telephone": row.phone})
    queued = job(row, result)
    queued["payload"]["record"]["_discover_website"] = True
    with sessions() as db:
        db.get(Hotel, row.id).website = "https://operator.example/"
        db.commit()
    assert worker._apply_website_evidence(queued) is False
    with sessions() as db:
        assert db.get(Hotel, row.id).website == "https://operator.example/"


def test_autonomous_backfill_starts_and_respects_pause(setup, monkeypatch):
    worker, sessions = setup
    monkeypatch.setattr(settings, "WEBSITE_AUTONOMOUS", True)
    monkeypatch.setattr(settings, "WEBSITE_BACKFILL_AUTO_START", True)
    row = seed(sessions)
    worker._scan_website_backfill()
    assert worker._website_queue.backfill_status()["ceiling"] == row.id
    worker._website_queue.pause_backfill()
    worker._scan_website_backfill()
    assert worker._website_queue.backfill_status()["state"] == "paused"


def test_autonomous_completed_pass_waits_for_refresh_interval(setup, monkeypatch):
    import time
    worker, sessions = setup
    monkeypatch.setattr(settings, "WEBSITE_AUTONOMOUS", True)
    monkeypatch.setattr(settings, "WEBSITE_BACKFILL_AUTO_START", True)
    seed(sessions)
    worker._scan_website_backfill()
    queue = worker._website_queue
    original = queue.backfill_status()["run_id"]
    queue.finish(queue.next_job()["id"], "skipped")
    worker._scan_website_backfill()
    worker._scan_website_backfill()
    assert queue.backfill_status()["state"] == "completed"
    assert queue.backfill_status()["run_id"] == original
    with queue.connect() as c:
        c.execute("UPDATE website_backfill_runs SET updated_at=?", (time.time() - settings.WEBSITE_BACKFILL_REFRESH_SEC - 1,))
    worker._scan_website_backfill()
    assert queue.backfill_status()["run_id"] != original


def evidence():
    def field(value):
        return {"value": value, "source_url": "https://hotel.example/", "extraction": "json_ld", "collected_at": "2026-10-06T02:00:00+00:00"}
    return {"status": "collected", "identity": "corroborated_public_data", "business_name": "Cedar Hotel",
            "collected_at": "2026-10-06T02:00:00+00:00", "fields": {
                "telephone": field("+1 206 555 1234"), "address": field({"streetAddress": "1 Main Street",
                "addressLocality": "Kirkland", "addressRegion": "WA", "postalCode": "98033", "addressCountry": "US"})}}


def job(row, result=None, fill_missing=True):
    return {"id": "backfill-job", "payload": {"record": {"dedup_key": row.dedup_key, "name": row.name,
            "website": row.website}, "database_target": database_target(), "run_id": "backfill-run", "fill_missing": fill_missing},
            "result": result or evidence()}


@pytest.mark.parametrize("empty", [None, "", "   "])
def test_fills_blanks_only_with_reversible_field_evidence(setup, empty):
    worker, sessions = setup
    row = seed(sessions, phone=empty, formatted_address=empty, zip=empty, state=empty)
    first_seen, last_seen = row.first_seen, row.last_seen
    result = worker._apply_website_evidence(job(row))
    assert set(result["filled_fields"]) == {"phone", "formatted_address", "zip", "state"}
    with sessions() as db:
        changed = db.get(Hotel, row.id)
        assert changed.phone == "+1 206 555 1234"
        assert changed.formatted_address == "1 Main Street, Kirkland, WA 98033"
        assert changed.zip == "98033" and changed.state == "WA"
        assert changed.raw["website_field_fills"]["phone"]["previous"] == empty
        assert changed.raw["website_field_fills"]["phone"]["job_id"] == "backfill-job"
        assert changed.raw["run_id"] == "original"
        assert changed.rating == 4.5 and changed.lat == 47.68
        assert changed.sources == ["places"] and changed.photos == [{"preserve": True}]
        assert changed.first_seen == first_seen and changed.last_seen == last_seen
    # Repeat after a commit/acknowledgement crash: preserve historical fill count.
    assert set(worker._apply_website_evidence(job(row))["filled_fields"]) == {"phone", "formatted_address", "zip", "state"}


def test_value_populated_after_enqueue_is_preserved(setup):
    worker, sessions = setup
    row = seed(sessions)
    queued = job(row)
    with sessions() as db:
        db.get(Hotel, row.id).phone = "operator verified phone"
        db.commit()
    worker._apply_website_evidence(queued)
    with sessions() as db:
        assert db.get(Hotel, row.id).phone == "operator verified phone"
        assert "phone" not in db.get(Hotel, row.id).raw.get("website_field_fills", {})


@pytest.mark.parametrize("change", ["identity", "name", "domain", "country", "region", "postal", "type"])
def test_uncertain_or_invalid_evidence_does_not_fill_address(change):
    row = SimpleNamespace(name="Cedar Hotel", website="https://hotel.example/", phone=None, formatted_address=None, zip=None, state=None)
    result = evidence()
    if change == "identity": result["identity"] = "unconfirmed"
    if change == "name": result["business_name"] = "Different Hotel"
    if change == "domain": result["fields"]["address"]["source_url"] = "https://other.example/"
    if change == "country": result["fields"]["address"]["value"]["addressCountry"] = "GB"
    if change == "region": result["fields"]["address"]["value"]["addressRegion"] = "invalid"
    if change == "postal": result["fields"]["address"]["value"]["postalCode"] = "not a ZIP"
    if change == "type": result["fields"]["address"]["extraction"] = "inferred"
    assert "formatted_address" not in fill_candidates(row, result)


def test_existing_location_conflict_rejects_address():
    row = SimpleNamespace(name="Cedar Hotel", website="https://hotel.example/", phone=None, formatted_address=None, zip="90001", state="CA")
    assert set(fill_candidates(row, evidence())) == {"phone"}


def test_postal_in_existing_address_is_not_contradicted():
    row = SimpleNamespace(name="Cedar Hotel", website="https://hotel.example/", phone=None,
                          formatted_address="2 Main Street, Seattle WA 98101", zip=None, state=None)
    assert set(fill_candidates(row, evidence())) == {"phone"}


def test_evidence_only_job_cannot_fill_columns(setup):
    worker, sessions = setup
    row = seed(sessions)
    worker._apply_website_evidence(job(row, fill_missing=False))
    with sessions() as db:
        changed = db.get(Hotel, row.id)
        assert changed.phone is None and changed.formatted_address is None


def test_bounded_scan_resumes_and_excludes_new_inventory(setup):
    worker, sessions = setup
    first = seed(sessions)
    second = seed(sessions, website=None)
    run = worker._website_queue.start_backfill(second.id)
    added_later = seed(sessions)
    worker._scan_website_backfill()
    assert worker._website_queue.backfill_status()["cursor"] == first.id
    # Re-open local state as if the app restarted; no second job for first row.
    worker._website_queue = WebsiteQueue(worker._website_queue.path)
    worker._scan_website_backfill()
    worker._scan_website_backfill()
    status = worker._website_queue.backfill_status()
    assert status["state"] == "draining" and status["cursor"] == second.id
    assert status["scanned"] == 2 and status["missing_website"] == 1
    assert status["jobs"] == {"pending": 1}
    queued = worker._website_queue.next_job()
    assert queued["payload"]["record"]["id"] == first.id
    worker._website_queue.finish(queued["id"], filled_fields=["phone"])
    assert worker._website_queue.backfill_status()["state"] == "completed"
    assert worker._website_queue.backfill_status()["filled_fields"] == 1


def test_enqueue_checkpoint_crash_does_not_duplicate_job(setup, monkeypatch):
    worker, sessions = setup
    row = seed(sessions)
    queue = worker._website_queue
    queue.start_backfill(row.id)
    original = queue.checkpoint_backfill
    def crash(*args):
        raise OSError("shutdown after enqueue")
    monkeypatch.setattr(queue, "checkpoint_backfill", crash)
    with pytest.raises(OSError): worker._scan_website_backfill()
    assert queue.backfill_status()["cursor"] == 0
    monkeypatch.setattr(queue, "checkpoint_backfill", original)
    worker._scan_website_backfill()
    assert queue.counts() == {"pending": 1}
    assert queue.backfill_status()["cursor"] == row.id


def test_pause_holds_backfill_jobs_and_resume_keeps_snapshot(setup):
    worker, sessions = setup
    row = seed(sessions)
    queue = worker._website_queue
    started = queue.start_backfill(row.id)
    worker._scan_website_backfill()
    queue.pause_backfill()
    assert queue.next_job() is None
    resumed = queue.start_backfill(row.id + 100)
    assert resumed["run_id"] == started["run_id"] and resumed["ceiling"] == row.id
    assert resumed["cursor"] == row.id
    assert queue.next_job() is not None


def test_queue_pressure_prevents_unbounded_scan(setup, monkeypatch):
    worker, sessions = setup
    first = seed(sessions)
    last = seed(sessions)
    monkeypatch.setattr(settings, "WEBSITE_BACKFILL_MAX_PENDING", 1)
    queue = worker._website_queue
    queue.start_backfill(last.id)
    worker._scan_website_backfill()
    worker._scan_website_backfill()
    assert queue.backfill_status()["cursor"] == first.id
    assert queue.counts() == {"pending": 1}


def test_disabled_fills_hold_existing_backfill_jobs(setup, monkeypatch):
    worker, sessions = setup
    row = seed(sessions)
    worker._website_queue.start_backfill(row.id)
    worker._scan_website_backfill()
    monkeypatch.setattr(settings, "WEBSITE_FILL_MISSING_FIELDS", False)
    assert worker._website_queue.next_job() is None
    assert worker._website_queue.counts() == {"pending": 1}


def test_dashboard_start_pause_resume_only_changes_local_queue(setup, monkeypatch):
    from fastapi.testclient import TestClient
    from app import main
    worker, sessions = setup
    monkeypatch.setattr(settings, "WEBSITE_ENRICHMENT_ENABLED", True)
    monkeypatch.setattr(main, "worker_instance", worker)
    row = seed(sessions)
    before = row.to_dict()
    def dependency():
        with sessions() as db:
            yield db
    main.app.dependency_overrides[main.get_db] = dependency
    try:
        with TestClient(main.app) as client:
            response = client.post("/api/website-backfill/start")
            assert response.status_code == 200
            started = response.json()
            assert started["ceiling"] == row.id
            assert client.post("/api/website-backfill/pause").json()["state"] == "paused"
            assert client.post("/api/website-backfill/start").json()["run_id"] == started["run_id"]
            assert client.get("/api/website-backfill").json()["state"] == "running"
        with sessions() as db:
            assert db.get(Hotel, row.id).to_dict() == before
    finally:
        main.app.dependency_overrides.pop(main.get_db, None)


def test_additive_local_queue_upgrade_preserves_pending_work(tmp_path):
    path = tmp_path / "v1.sqlite3"
    payload = {"record": {"name": "Cedar Hotel"}, "database_target": database_target()}
    with sqlite3.connect(path) as c:
        c.execute("CREATE TABLE website_jobs (id TEXT PRIMARY KEY, payload TEXT, state TEXT, result TEXT, attempts INTEGER, next_attempt REAL, updated_at REAL)")
        c.execute("INSERT INTO website_jobs VALUES ('old-job',?,'pending',NULL,0,0,0)", (json.dumps(payload),))
    queue = WebsiteQueue(path)
    assert queue.next_job()["id"] == "old-job"
    assert queue.next_job()["payload"] == payload
    assert queue.counts() == {"pending": 1}
