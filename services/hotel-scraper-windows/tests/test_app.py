import os
import sys
import tempfile
from datetime import datetime, timezone

# Must be configured before the app modules are imported: tests never touch Cloud SQL.
_tmp = tempfile.mkdtemp(prefix="hotel_scraper_test_")
os.environ["DB_BACKEND"] = "sqlite"
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db".replace("\\", "/")
os.environ["AUTO_START_PROXY"] = "false"

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import database, chrome_scraper, worker as worker_module
import app.main as main_module
from app.main import app, invalidate_cache
from app.models import Hotel, ZipCode
from app.worker import worker_instance
from app.free_scraper import generate_dedup_key, normalize_name
from app.scrape_contract import ScrapeResult, ScrapeStatus
from app.outbox import DELIVERED, LocalOutbox
from app.run_journal import RunJournal
from app import geohash


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def _seed_zip(zip_code="98033", status="pending"):
    db = database.get_db_session()
    try:
        db.merge(ZipCode(zip=zip_code, city="Kirkland", state="WA", lat=47.68, lng=-122.2,
                         dist_km_from_kirkland=1.0, places_status=status, osm_status="pending"))
        db.commit()
    finally:
        db.close()
    invalidate_cache()


# ---- pure helpers ------------------------------------------------------

def test_geohash_known_value():
    assert geohash.encode(47.6757411, -122.2039442, 6) == "c23p5p"


def test_dedup_key_matches_production_format():
    assert generate_dedup_key("Hampton Inn & Suites Atlanta/Duluth", 33.99, -84.14).startswith(
        "hampton inn and suites atlanta duluth|")
    assert normalize_name("Dexter’s Inn") == "dexter s inn"
    assert normalize_name("Rincón Plaza") == "rincon plaza"


# ---- API ---------------------------------------------------------------

def test_index_page(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "HusshOne Hotel Scraper" in r.text


def test_live_endpoint_shape(client):
    _seed_zip()
    r = client.get("/api/live")
    assert r.status_code == 200
    data = r.json()
    assert data["status"]["queue"]["total_zips"] >= 1
    assert data["overview"]["hotels"]["total"] == 0
    assert data["overview"]["db"]["connected"] is True


def test_data_quality_endpoint_is_read_only_and_paged(client):
    _seed_zip("98033")
    r = client.get("/api/audits/data-quality?finding_limit=5&shape_scan_limit=5")
    assert r.status_code == 200
    data = r.json()
    assert {"summary", "duplicate_google_cids", "coordinate_issues", "shape_issues"} <= data.keys()


def test_requeue_all_requires_confirmation(client):
    assert client.post("/api/zips/requeue-all").status_code == 400


def test_queue_unknown_zip_is_404(client):
    assert client.post("/api/zips/add?query=00000").status_code == 404


def test_queue_known_zip(client):
    _seed_zip("98033", status="done")
    r = client.post("/api/zips/add?query=98033")
    assert r.status_code == 200
    assert r.json()["queued_count"] == 1
    client.post("/api/control/stop")


def test_queue_write_is_blocked_when_schema_guard_fails(client, monkeypatch):
    _seed_zip("98033", status="done")

    def reject_write():
        raise database.SchemaIncompatible("hotels.rating does not match the approved contract")

    monkeypatch.setattr(database, "assert_write_safe", reject_write)
    r = client.post("/api/zips/add?query=98033")
    assert r.status_code == 409
    assert "Schema guard blocked writes" in r.json()["detail"]

    db = database.get_db_session()
    try:
        assert db.get(ZipCode, "98033").places_status == "done"
    finally:
        db.close()


def test_worker_rechecks_schema_before_each_write(monkeypatch):
    guarded_worker = worker_module.ScraperBackgroundWorker()
    monkeypatch.setattr(database, "is_sqlite", lambda: False)
    monkeypatch.setattr(database, "check_schema_compatible", lambda: False)
    database.schema_state.update(diagnostics=[{"message": "hotels schema drift"}])

    with pytest.raises(database.SchemaIncompatible, match="hotels schema drift"):
        guarded_worker._save_results(
            "98033",
            "WA",
            47.68,
            -122.2,
            [{"name": "Blocked Inn", "lat": 47.67, "lng": -122.2, "sources": ["places"]}],
        )


def test_worker_treats_guard_catalog_outage_as_database_outage(monkeypatch):
    guarded_worker = worker_module.ScraperBackgroundWorker()
    monkeypatch.setattr(database, "is_sqlite", lambda: False)
    monkeypatch.setattr(database, "check_schema_compatible", lambda: False)
    database.schema_state.update(diagnostics=[{"code": "inspection_error", "message": "catalog connection failed"}])

    with pytest.raises(database.DatabaseUnavailable, match="catalog connection failed"):
        guarded_worker._save_results(
            "98033",
            "WA",
            47.68,
            -122.2,
            [{"name": "Retry Inn", "lat": 47.67, "lng": -122.2, "sources": ["places"]}],
        )


def test_inventory_guard_refuses_a_result_write_before_any_hotel_mutation():
    _seed_zip("98099", status="pending")
    guarded_worker = worker_module.ScraperBackgroundWorker()
    current = guarded_worker._read_hotel_inventory()
    guarded_worker._inventory_watermark = {
        "hotel_count": current["hotel_count"] + 1,
        "max_hotel_id": current["max_hotel_id"],
    }

    with pytest.raises(worker_module.DataLossSuspected, match="before_result_save"):
        guarded_worker._save_results(
            "98099",
            "WA",
            47.68,
            -122.2,
            [{"name": "Must Not Be Written Inn", "lat": 47.681, "lng": -122.201, "sources": ["places"]}],
        )

    db = database.get_db_session()
    try:
        assert db.query(Hotel).filter(Hotel.name == "Must Not Be Written Inn").count() == 0
    finally:
        db.close()


def test_inventory_guard_detects_a_lower_watermark_after_commit(monkeypatch):
    _seed_zip("98100", status="pending")
    guarded_worker = worker_module.ScraperBackgroundWorker()
    current = guarded_worker._read_hotel_inventory()
    # Simulate another writer adding then unexpectedly deleting a hotel while
    # this transaction is in flight.  The actual test transaction only marks
    # ZIP progress, avoiding pollution of the following directory tests.
    guarded_worker._inventory_watermark = {
        "hotel_count": current["hotel_count"],
        "max_hotel_id": current["max_hotel_id"],
    }
    observations = iter((
        {"hotel_count": current["hotel_count"] + 1, "max_hotel_id": current["max_hotel_id"]},
        {"hotel_count": current["hotel_count"], "max_hotel_id": current["max_hotel_id"]},
    ))
    monkeypatch.setattr(guarded_worker, "_read_hotel_inventory", lambda: next(observations))

    with pytest.raises(worker_module.DataLossSuspected, match="after_result_commit"):
        guarded_worker._save_results(
            "98100",
            "WA",
            47.68,
            -122.2,
            [],
        )

    # The safety check is intentionally after the durable transaction.  Later
    # writes stay paused for review rather than becoming a Maps failure.
    db = database.get_db_session()
    try:
        assert db.get(ZipCode, "98100").places_status == "done"
    finally:
        db.close()


def test_worker_start_refuses_unsafe_recovery_evidence(monkeypatch):
    import asyncio

    unsafe = {
        "safe_to_resume": False,
        "recovery_mode": "hold_for_review",
        "recommended_actions": [{"message": "local outbox is corrupt"}],
    }
    monkeypatch.setattr(worker_module, "inspect_startup_recovery", lambda **_kwargs: unsafe)
    guarded_worker = worker_module.ScraperBackgroundWorker()

    result = asyncio.run(guarded_worker.start())

    assert result["status"] == "error"
    assert "Startup recovery blocked writes" in result["message"]
    assert guarded_worker.is_running is False
    assert guarded_worker.get_status()["startup_recovery"]["recovery_mode"] == "hold_for_review"


def test_worker_start_refuses_prior_cloud_inventory_watermark(monkeypatch, tmp_path):
    import asyncio
    from app.outbox import LocalOutbox
    from app.run_journal import RunJournal

    journal = RunJournal(tmp_path / "journal.sqlite3")
    current = worker_module.ScraperBackgroundWorker()._read_hotel_inventory()
    prior = journal.start_run({
        "hotel_inventory_end": {
            "hotel_count": current["hotel_count"] + 1,
            "max_hotel_id": current["max_hotel_id"],
        },
    })
    journal.finish_run(prior)
    outbox = LocalOutbox(tmp_path / "outbox.sqlite3")
    safe = {"safe_to_resume": True, "recovery_mode": "ready", "recommended_actions": []}
    guarded_worker = worker_module.ScraperBackgroundWorker()

    monkeypatch.setattr(worker_module, "inspect_startup_recovery", lambda **_kwargs: safe)
    monkeypatch.setattr(guarded_worker, "_open_durable_state", lambda: (journal, outbox))
    monkeypatch.setattr(guarded_worker, "_acquire_lock", lambda: True)
    monkeypatch.setattr(worker_module.database, "is_sqlite", lambda: False)
    monkeypatch.setattr(worker_module.worker_wake_lock, "acquire", lambda: True)
    monkeypatch.setattr(worker_module.worker_wake_lock, "release", lambda: None)

    result = asyncio.run(guarded_worker.start())

    assert result["status"] == "error"
    assert "DataLossSuspected during startup" in result["message"]
    assert guarded_worker.is_running is False
    blocked = journal.list_runs(limit=5, status="blocked")
    assert len(blocked) == 1
    assert blocked[0]["metadata"]["hotel_inventory_start"]["hotel_count"] == current["hotel_count"]


def test_scraper_mode_toggle(client):
    assert client.post("/api/control/mode?mode=radial").json()["mode"] == "radial"
    assert client.post("/api/control/mode?mode=defined_zips").json()["mode"] == "defined_zips"
    assert client.post("/api/control/mode?mode=bogus").status_code == 400


# ---- worker write path --------------------------------------------------

def test_save_results_dedups_and_merges(client):
    _seed_zip("98033", status="pending")
    scraped = [
        {"name": "Test Inn & Suites", "lat": 47.6757, "lng": -122.2039, "rating": 4.1, "sources": ["places"]},
        {"name": "Test Inn & Suites", "lat": 47.6757, "lng": -122.2039, "rating": 4.1, "sources": ["places"]},
        {"name": "Other Motel", "lat": 47.70, "lng": -122.25, "sources": ["osm"], "osm_id": "node/1"},
    ]
    merged, added = worker_instance._save_results("98033", "WA", 47.68, -122.2, scraped)
    assert (merged, added) == (0, 2)

    # Same hotel again from OSM: merges sources instead of inserting a duplicate.
    again = [{"name": "Test Inn & Suites", "lat": 47.6757, "lng": -122.2039, "sources": ["osm"]}]
    merged, added = worker_instance._save_results("98033", "WA", 47.68, -122.2, again)
    assert (merged, added) == (1, 0)

    db = database.get_db_session()
    try:
        assert db.query(Hotel).count() == 2
        row = db.query(Hotel).filter(Hotel.name == "Test Inn & Suites").one()
        assert sorted(row.sources) == ["osm", "places"]
        assert row.query_zip == "98033" and row.state == "WA"
        assert db.get(ZipCode, "98033").places_status == "done"
    finally:
        db.close()

    r = client.get("/api/hotels?source=merged")
    assert r.json()["total"] == 1
    assert client.get("/api/hotels?source=osm").json()["total"] == 2
    assert client.get("/api/hotels?source=places").json()["total"] == 1


def test_prepared_maps_record_has_trace_and_secondary_cid_identity():
    records, rejected = worker_instance._prepare_records(
        "98033",
        47.68,
        -122.2,
        [{
            "name": "Traceable Inn",
            "lat": 47.6757,
            "lng": -122.2039,
            "sources": ["places"],
            "raw": {"google_cid": "123456789"},
        }],
        run_id="test-run-id",
    )

    assert rejected == []
    raw = records[0]["raw"]
    assert raw["scraped_via"] == "chrome_google_maps"
    assert raw["google_cid"] == "123456789"
    assert raw["run_id"] == raw["scrape_run_id"] == "test-run-id"
    assert raw["scraped_at"]


def test_canary_failure_pauses_worker_before_normal_writes(monkeypatch):
    import asyncio

    _seed_zip("98033", status="pending")

    async def sparse_maps_result(city, state, zip_code):
        return ScrapeResult(
            ScrapeStatus.SUCCESS,
            records=[
                {"name": "One", "lat": 47.67, "lng": -122.2, "sources": ["places"]},
                {"name": "Two", "lat": 47.68, "lng": -122.2, "sources": ["places"]},
            ],
        )

    monkeypatch.setattr(worker_module.settings, "CANARY_ZIP", "98033")
    monkeypatch.setattr(worker_module.settings, "CANARY_MIN_RESULTS", 3)
    monkeypatch.setattr(worker_instance, "_scrape_maps", sparse_maps_result)
    worker_instance._last_canary_at = None
    worker_instance._canary_failed = False
    worker_instance._is_paused = False

    assert asyncio.run(worker_instance._maybe_run_canary()) is False
    assert worker_instance.is_paused is True
    assert worker_instance._canary_failed is True

    # This singleton is shared by the API tests; leave it neutral for later
    # worker-loop assertions after monkeypatch restores the configuration.
    worker_instance._is_paused = False
    worker_instance._canary_failed = False
    worker_instance._last_canary_at = None


def test_durable_outbox_replays_a_prior_run_before_new_scraping(client, tmp_path):
    import asyncio

    _seed_zip("98123", status="pending")
    replay_worker = worker_module.ScraperBackgroundWorker()
    records, rejected = replay_worker._prepare_records(
        "98123",
        47.68,
        -122.2,
        [{
            "name": "Outbox Replay Hotel",
            "lat": 47.681,
            "lng": -122.201,
            "sources": ["places"],
            "raw": {"google_cid": "outbox-cid"},
        }],
        run_id="prior-run",
    )
    assert rejected == []

    outbox = LocalOutbox(tmp_path / "scrape_outbox.sqlite3")
    outbox.enqueue(
        "prior-run",
        "98123",
        records,
        metadata={"state": "WA", "zip_lat": 47.68, "zip_lng": -122.2},
        batch_id="prior-run:98123",
    )
    replay_worker._outbox = outbox
    replay_worker._run_id = "current-run"

    assert asyncio.run(replay_worker._flush_one_outbox_batch()) is True
    assert outbox.get("prior-run:98123").status == DELIVERED
    assert asyncio.run(replay_worker._flush_one_outbox_batch()) is False

    db = database.get_db_session()
    try:
        row = db.query(Hotel).filter(Hotel.name == "Outbox Replay Hotel").one()
        assert row.raw["run_id"] == "prior-run"
        assert db.get(ZipCode, "98123").places_status == "done"
    finally:
        db.close()


def test_worker_loop_end_to_end(monkeypatch):
    import asyncio
    _seed_zip("98052", status="pending")

    async def fake_scrape(city, state, zip_code, max_results=15):
        return [{"name": "Loop Hotel", "lat": 47.67, "lng": -122.12, "rating": 4.4, "sources": ["places"]}]

    monkeypatch.setattr(chrome_scraper, "scrape_google_maps_hotels", fake_scrape)
    monkeypatch.setattr(worker_module.settings, "SCRAPER_DELAY_SEC", 0.01)

    async def run():
        result = await worker_instance.start()
        assert result["status"] == "started"
        for _ in range(100):
            if worker_instance.get_status()["stats"]["zips_processed"] >= 1:
                break
            await asyncio.sleep(0.05)
        await worker_instance.stop()

    asyncio.run(run())

    db = database.get_db_session()
    try:
        assert db.query(Hotel).filter(Hotel.name == "Loop Hotel").count() == 1
        assert db.get(ZipCode, "98052").places_status == "done"
    finally:
        db.close()


# ---- read-only data review ---------------------------------------------

def _seed_review_hotels():
    _seed_zip("98040")
    db = database.get_db_session()
    seen_at = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
    try:
        traced = db.query(Hotel).filter(Hotel.dedup_key == "review-traced-key").one_or_none()
        if traced is None:
            traced = Hotel(
                dedup_key="review-traced-key",
                name="Review Traced Hotel",
                formatted_address="100 Review Way, Kirkland, WA",
                zip="98040",
                query_zip="98040",
                state="WA",
                lat=47.68,
                lng=-122.2,
                rating=4.6,
                sources=["places"],
                raw={
                    "scraped_via": "chrome_google_maps",
                    "scrape_run_id": "review-run-20261005",
                    "run_id": "review-run-20261005",
                    "scraped_at": "2026-10-05T12:00:00+00:00",
                    "google_cid": "review-cid-1",
                    "source_url": "https://www.google.com/maps?cid=review-cid-1",
                },
                first_seen=seen_at,
                last_seen=seen_at,
            )
            db.add(traced)
        legacy = db.query(Hotel).filter(Hotel.dedup_key == "review-legacy-key").one_or_none()
        if legacy is None:
            legacy = Hotel(
                dedup_key="review-legacy-key",
                name="Review Legacy Hotel",
                formatted_address="200 Existing Way, Kirkland, WA",
                zip="98040",
                query_zip="98040",
                state="WA",
                lat=47.681,
                lng=-122.201,
                sources=["places"],
                raw=None,
                first_seen=seen_at,
                last_seen=seen_at,
            )
            db.add(legacy)
        db.commit()
        return traced.id, legacy.id
    finally:
        db.close()
        invalidate_cache()


def test_review_endpoints_filter_traced_and_legacy_rows(client):
    _seed_review_hotels()

    traced_response = client.get(
        "/api/review/hotels?scope=scraper_traced&provenance=chrome_google_maps"
        "&run_id=review-run-20261005&date_from=2026-10-05&date_to=2026-10-05"
        "&date_field=scraped_at&include_raw=true"
    )
    assert traced_response.status_code == 200
    traced_data = traced_response.json()
    traced = next(item for item in traced_data["items"] if item["name"] == "Review Traced Hotel")
    assert traced["trace"]["run_id"] == "review-run-20261005"
    assert traced["trace"]["google_cid"] == "review-cid-1"
    assert traced["raw"]["scraped_via"] == "chrome_google_maps"

    legacy_response = client.get("/api/review/hotels?scope=legacy_or_untraced&q=Review%20Legacy")
    assert legacy_response.status_code == 200
    legacy_items = legacy_response.json()["items"]
    assert any(item["name"] == "Review Legacy Hotel" for item in legacy_items)
    assert all(not item["trace"]["scraper_traced"] for item in legacy_items)

    summary = client.get("/api/review/summary").json()
    assert summary["all"]["total"] >= 2
    assert summary["scraper_traced"]["total"] >= 1
    assert summary["scraper_traced"]["by_scraped_via"]["chrome_google_maps"] >= 1
    assert summary["legacy_or_untraced"]["total"] >= 1
    assert summary["inventory"]["zips_total"] >= 1


def test_review_run_detail_reconciles_journal_evidence_without_writes(client, tmp_path, monkeypatch):
    traced_id, _ = _seed_review_hotels()
    journal = RunJournal(tmp_path / "review-journal.sqlite3")
    run_id = "review-evidence-run"
    journal.create_run({"scraped_via": "chrome_google_maps"}, run_id=run_id)
    journal.record_hotel_insert(
        run_id,
        hotel_id=traced_id,
        dedup_key="review-traced-key",
        cid="review-cid-1",
        after={
            "id": traced_id,
            "dedup_key": "review-traced-key",
            "name": "Review Traced Hotel",
            "sources": ["places"],
            "raw": {"google_cid": "review-cid-1"},
        },
    )
    journal.record_zip_outcome(
        run_id,
        "98040",
        "success",
        evidence={"review": True},
        hotels_seen=1,
        hotels_new=1,
    )
    journal.finish_run(run_id)
    monkeypatch.setattr(main_module, "RunJournal", lambda: journal)

    listed = client.get("/api/review/runs")
    assert listed.status_code == 200
    assert any(item["run_id"] == run_id for item in listed.json()["items"])

    response = client.get(f"/api/review/runs/{run_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["run"]["run_id"] == run_id
    assert data["counts"]["records_inserted_returned"] == 1
    assert data["records"][0]["verification"]["status"] == "present"
    assert data["records"][0]["current_record"]["name"] == "Review Traced Hotel"
    assert data["zip_outcomes"][0]["zip_code"] == "98040"


def test_recovery_endpoint_exposes_a_read_only_contract(client):
    response = client.get("/api/recovery")
    assert response.status_code == 200
    data = response.json()
    assert {
        "generated_at", "recovery_mode", "safe_to_resume", "needs_operator_review",
        "journal", "outbox", "recommended_actions",
    } <= data.keys()
    assert isinstance(data["recommended_actions"], list)
    assert data["recommended_actions"]
    assert {"code", "severity", "automatic", "message", "details"} <= data["recommended_actions"][0].keys()
