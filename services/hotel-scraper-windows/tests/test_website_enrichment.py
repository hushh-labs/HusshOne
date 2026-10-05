import asyncio
import json
import socket
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import website_enrichment as web, worker as module
from app.config import database_target, settings
from app.models import Base, Hotel, ZipCode
from app.outbox import OutboxTargetMismatch
from app.website_queue import WebsiteQueue

RECORD = {"dedup_key": "cedar hotel|abc", "name": "Cedar Hotel", "website": "https://hotel.example/",
          "phone": "+1 206 555 1234", "formatted_address": "1 Main St, WA 98033", "lat": 47.68,
          "lng": -122.2, "sources": ["places"], "raw": {"scraped_at": "2026-10-06T01:00:00+00:00"}}
NODE = {"@type": "Hotel", "name": "Cedar Hotel", "telephone": "206-555-1234",
        "description": "Quiet independent hotel", "checkinTime": "15:00",
        "amenityFeature": [{"@type": "LocationFeatureSpecification", "name": "Wi-Fi", "value": True}]}


def html(node=NODE, links=""):
    return ('<html><script type="application/ld+json">' + json.dumps(node) + '</script><p>Cedar Hotel</p>' + links + '</html>').encode()


def fixture_fetch(pages):
    def fetch(url):
        if url.endswith("/robots.txt"):
            return 404, {}, b""
        value = pages[url]
        return value if isinstance(value, tuple) else (200, {"content-type": "text/html"}, value)
    return fetch


def test_collects_business_and_relevant_pages_with_provenance():
    pages = {RECORD["website"]: html(links='<a href="/contact">Contact</a><a href="https://evil.example/about">About</a>'),
             "https://hotel.example/contact": b"<html>Contact our hotel reception</html>"}
    result = web.crawl_website(RECORD, fixture_fetch(pages), sleep=lambda _: None)
    assert result["status"] == "collected"
    assert len(result["pages"]) == 2
    assert result["fields"]["checkinTime"]["value"] == "15:00"
    assert result["fields"]["telephone"]["source_url"] == RECORD["website"]
    assert result["identity"] == "corroborated_public_data"


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://localhost/", "http://hotel.example:8080/", "https://u:p@hotel.example/", "http://x.local/"])
def test_unsafe_urls_blocked(url):
    with pytest.raises(web.WebsiteBlocked):
        web.safe_url(url)


@pytest.mark.parametrize("ip", ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "fe80::1"])
def test_private_dns_never_connects(ip, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", (ip, 80))])
    with pytest.raises(web.WebsiteBlocked):
        web._public_addresses("hotel.example", 80)


def test_mixed_public_private_dns_blocked(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", (ip, 80)) for ip in ("8.8.8.8", "127.0.0.1")])
    with pytest.raises(web.WebsiteBlocked):
        web._public_addresses("hotel.example", 80)


def test_name_only_is_not_enough():
    node = {"@type": "Hotel", "name": RECORD["name"], "telephone": "123"}
    result = web.crawl_website(RECORD, fixture_fetch({RECORD["website"]: html(node)}), sleep=lambda _: None)
    assert result["status"] == "needs_review"
    assert not result["fields"]


def test_robots_denial_stops_before_business_page():
    calls = []
    def fetch(url):
        calls.append(url)
        return 200, {}, b"User-agent: *\nDisallow: /\n"
    result = web.crawl_website(RECORD, fetch, sleep=lambda _: None)
    assert result["status"] == "blocked"
    assert calls == ["https://hotel.example/robots.txt"]


def test_cross_domain_redirect_never_requested():
    result = web.crawl_website(RECORD, fixture_fetch({RECORD["website"]:
        (302, {"location": "http://169.254.169.254/latest/meta-data"}, b"")}), sleep=lambda _: None)
    assert result["status"] == "blocked"


@pytest.mark.parametrize("code,status", [(403, "blocked"), (429, "blocked"), (503, "retry")])
def test_restricted_and_unavailable_sites(code, status):
    result = web.crawl_website(RECORD, fixture_fetch({RECORD["website"]: (code, {}, b"")}), sleep=lambda _: None)
    assert result["status"] == status


def test_queue_survives_restart_and_does_not_refetch_saved_evidence(tmp_path):
    path = tmp_path / "jobs.sqlite3"
    queue = WebsiteQueue(path)
    queue.enqueue(RECORD, "run", database_target())
    queue.enqueue(RECORD, "run", database_target())
    assert queue.counts() == {"pending": 1}
    job = queue.next_job()
    queue.save_result(job, {"status": "collected", "fields": {}})
    restarted = WebsiteQueue(path)
    assert restarted.next_job()["state"] == "fetched"
    restarted.finish(job["id"])
    assert restarted.next_job() is None


def test_failed_attempt_schedules_retry(tmp_path):
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    queue.enqueue(RECORD, "run", database_target())
    assert not queue.save_result(queue.next_job(), {"status": "retry"})
    assert queue.next_job() is None
    assert queue.counts() == {"retry": 1}


def test_foreign_queue_target_rejected(tmp_path):
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    with pytest.raises(OutboxTargetMismatch):
        queue.enqueue(RECORD, "run", {"backend": "cloud", "fingerprint": "foreign"})


def test_enrichment_preserves_production_columns_and_maps_trace(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "db.sqlite3"))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(module, "get_db_session", sessions)
    worker = module.ScraperBackgroundWorker()
    monkeypatch.setattr(worker, "_assert_current_write_contract", lambda: None)
    monkeypatch.setattr(worker, "_assert_inventory_safe", lambda *args: None)
    with sessions() as db:
        row = Hotel(dedup_key=RECORD["dedup_key"], name=RECORD["name"], website=RECORD["website"],
                    phone="keep original", rating=4.7, sources=["places"], photos=[{"keep": True}],
                    raw={"run_id": "maps-original", "scraped_via": "chrome_google_maps"})
        db.add(row)
        db.commit()
        db.refresh(row)
        before = row.to_dict()
    job = {"id": "job", "payload": {"record": RECORD, "database_target": database_target(), "run_id": "website-run"},
           "result": {"status": "collected", "collected_at": "2026-10-06T01:00:00+00:00", "fields": {"telephone": {"value": "new phone"}}}}
    worker._apply_website_evidence(job)
    with sessions() as db:
        row = db.query(Hotel).one()
        assert row.to_dict() == before
        assert row.photos == [{"keep": True}]
        assert row.raw["run_id"] == "maps-original"
        assert row.raw["website_enrichment"]["job_id"] == "job"
    failed = {**job, "id": "failed-job", "result": {"status": "failed", "collected_at": "2026-10-07T01:00:00+00:00"}}
    assert worker._apply_website_evidence(failed) is False
    with sessions() as db:
        assert db.query(Hotel).one().raw["website_enrichment"]["job_id"] == "job"
    engine.dispose()


def test_fetch_pins_validated_ip_and_bounds_response(monkeypatch):
    calls = []
    sock = SimpleNamespace(close=lambda: None)
    monkeypatch.setattr(web, "_public_addresses", lambda *a: ["8.8.8.8"])
    monkeypatch.setattr(socket, "create_connection", lambda address, **kw: calls.append(address) or sock)
    class Connection:
        def __init__(self, host, port, **kw):
            assert host == "hotel.example"
        def request(self, method, path, **kw):
            assert method == "GET" and path == "/about"
        def getresponse(self):
            return SimpleNamespace(status=200, getheaders=lambda: [("Content-Type", "text/html")],
                read=lambda size: b"a" * size)
        def close(self):
            pass
    monkeypatch.setattr(web.http.client, "HTTPConnection", Connection)
    with pytest.raises(web.WebsiteBlocked, match="size limit"):
        web.fetch_page("http://hotel.example/about")
    assert calls == [("8.8.8.8", 80)]


def test_process_watchdog_terminates_owned_child(monkeypatch):
    calls = []
    pipe = SimpleNamespace(close=lambda: None, poll=lambda: False)
    class Process:
        pid = 123
        alive = True
        def start(self):
            pass
        def is_alive(self):
            return self.alive
        def terminate(self):
            calls.append("terminate")
            self.alive = False
        def join(self, **kw):
            pass
    context = SimpleNamespace(Pipe=lambda **kw: (pipe, pipe), Process=lambda **kw: Process())
    monkeypatch.setattr(web.multiprocessing, "get_context", lambda _: context)
    result = asyncio.run(web.collect_website(RECORD, timeout=0))
    assert result["status"] == "retry"
    assert calls == ["terminate"]


def test_real_spawn_returns_blocked_without_network():
    result = asyncio.run(web.collect_website({**RECORD, "website": "http://localhost/"}, timeout=20))
    assert result["status"] == "blocked"
    assert result["reason"] == "Local website blocked"


def test_worker_reuses_fetched_result_after_database_outage(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "WEBSITE_ENRICHMENT_ENABLED", True)
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    queue.enqueue(RECORD, "run", database_target())
    worker = module.ScraperBackgroundWorker()
    worker._website_queue = queue
    calls = []
    async def collect(record):
        calls.append("fetch")
        return {"status": "collected", "fields": {}}
    monkeypatch.setattr(module, "collect_website", collect)
    def outage(job):
        raise module.database.DatabaseUnavailable("offline")
    monkeypatch.setattr(worker, "_apply_website_evidence", outage)
    with pytest.raises(module.database.DatabaseUnavailable):
        asyncio.run(worker._flush_one_website_job())
    assert queue.next_job()["state"] == "fetched"
    monkeypatch.setattr(worker, "_apply_website_evidence", lambda job: True)
    asyncio.run(worker._flush_one_website_job())
    assert calls == ["fetch"]
    assert queue.counts() == {"applied": 1}


def test_detail_api_and_manual_queue_do_not_change_hotel(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app, get_db
    from app import website_queue as queue_module
    engine = create_engine("sqlite:///" + str(tmp_path / "api.sqlite3"))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    monkeypatch.setattr(settings, "WEBSITE_ENRICHMENT_ENABLED", True)
    monkeypatch.setattr(queue_module, "WebsiteQueue", lambda: queue)
    with sessions() as db:
        row = Hotel(dedup_key="api|a", name=RECORD["name"], website=RECORD["website"],
                    sources=["places"], raw={"run_id": "original"})
        db.add(row)
        db.commit()
        hotel_id = row.id
    def dependency():
        with sessions() as db:
            yield db
    app.dependency_overrides[get_db] = dependency
    try:
        with TestClient(app) as client:
            detail = client.get(f"/api/hotels/{hotel_id}").json()
            assert "website_enrichment" in detail
            assert client.post(f"/api/hotels/{hotel_id}/website-enrichment").status_code == 200
            assert queue.counts() == {"pending": 1}
        with sessions() as db:
            assert db.get(Hotel, hotel_id).raw == {"run_id": "original"}
    finally:
        app.dependency_overrides.pop(get_db, None)
        engine.dispose()
