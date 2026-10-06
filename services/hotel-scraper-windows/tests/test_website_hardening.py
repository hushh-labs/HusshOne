import json
import pytest
from app.website_enrichment import crawl_website, matched_business, WebsiteBlocked
from app.website_discovery import maps_identity_url
from app.website_queue import WebsiteQueue
from app.config import database_target


@pytest.fixture(autouse=True)
def legacy_review_mode(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "WEBSITE_AUTONOMOUS", False)

RECORD = {"name": "Cedar Hotel", "dedup_key": "cedar", "website": "https://hotel.example/",
          "phone": "2065551234", "formatted_address": "1 Main St WA 98033", "raw": {}}
NODE = {"@type": "Hotel", "name": "Cedar Hotel", "telephone": "2065551234"}


def test_branch_conflict_overrides_matching_chain_phone():
    assert not matched_business({**NODE, "address": {"postalCode": "90210"}}, RECORD)
    assert not matched_business({**NODE, "geo": {"latitude": 34, "longitude": -118}},
                                {**RECORD, "lat": 47, "lng": -122})


def test_alias_requires_two_independent_signals():
    alias = {**NODE, "name": "Cedar Downtown", "alternateName": "Cedar Hotel"}
    assert not matched_business(alias, RECORD)
    assert matched_business({**alias, "address": {"postalCode": "98033"}}, RECORD)


def test_js_fallback_and_rich_details_have_provenance():
    def fetch(url):
        if url.endswith("robots.txt"):
            return 404, {}, b""
        return 200, {"content-type": "text/html"}, b'<script src="/app.js"></script>'
    def render(url, request):
        node = {**NODE, "petsAllowed": True, "smokingAllowed": False}
        return ('<script type="application/ld+json">' + json.dumps(node) + '</script>').encode()
    result = crawl_website(RECORD, fetch, lambda _: None, render)
    assert result["status"] == "collected"
    assert result["render_method"] == "restricted_browser"
    assert result["fields"]["petsAllowed"]["value"] is True


def test_browser_callback_cannot_request_private_or_cross_domain():
    def fetch(url):
        if url.endswith("robots.txt"):
            return 404, {}, b""
        return 200, {"content-type": "text/html"}, b"<script></script>"
    def render(url, request):
        with pytest.raises(WebsiteBlocked):
            request("http://localhost/")
        with pytest.raises(WebsiteBlocked):
            request("https://other.example/")
        return b"<html>No identity</html>"
    result = crawl_website(RECORD, fetch, lambda _: None, render)
    assert result["status"] == "needs_review"
    assert result["pages"]


@pytest.mark.parametrize("url", ["https://evil.example/maps/place/X", "https://www.google.com/maps/search/hotels", "http://localhost/maps/place/X"])
def test_discovery_requires_existing_maps_identity(url):
    with pytest.raises(WebsiteBlocked):
        maps_identity_url({"google_maps_uri": url})


def test_discovery_canonical_cid():
    assert maps_identity_url({"raw": {"google_cid": "123"}}) == "https://www.google.com/maps?cid=123"


def test_review_decisions_survive_restart_and_repeated_evidence(tmp_path):
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    queue.enqueue(RECORD, "run", database_target())
    job = queue.next_job()
    result = {"status": "needs_review", "reason": "unconfirmed", "requested_url": RECORD["website"],
              "pages": [{"url": RECORD["website"], "sha256": "same"}], "fields": {}}
    queue.save_result(job, result)
    queue.hold_for_review({**job, "result": result})
    review = queue.reviews()[0]
    assert queue.decide_review(review["id"], "rejected")["production_changed"] is False
    queue = WebsiteQueue(queue.path)
    queue.enqueue({**RECORD, "raw": {"scraped_at": "new"}}, "run2", database_target())
    job = queue.next_job()
    queue.save_result(job, result)
    queue.hold_for_review({**job, "result": result})
    assert queue.reviews() == []
    assert queue.metrics()["review"]["rejected"] == 1
    assert queue.metrics()["filled_fields"] == 0
    assert queue.next_job() is None


def test_accept_evidence_never_requeues_unsafe_fill(tmp_path):
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    queue.enqueue(RECORD, "run", database_target(), fill_missing=True)
    job = queue.next_job()
    result = {"status": "needs_review", "pages": [], "fields": {}}
    queue.save_result(job, result)
    queue.hold_for_review({**job, "result": result})
    queue.decide_review(queue.reviews()[0]["id"], "accepted_evidence")
    assert queue.next_job() is None
    assert queue.metrics()["review"] == {"accepted_evidence": 1}


def test_actual_browser_executes_js_without_direct_network():
    from pathlib import Path
    from app.website_browser import render_page
    import os
    if os.name != "nt" or not any(Path(path).exists() for path in (
            "C:/Program Files/Google/Chrome/Application/chrome.exe",
            "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe")):
        pytest.skip("Installed Windows Chrome required")
    requests = []
    script = "const s=document.createElement('script');s.type='application/ld+json';s.textContent=" + json.dumps(json.dumps(NODE)) + ";document.head.append(s);"
    def request(url):
        requests.append(url)
        assert url == RECORD["website"]
        return 200, {"content-type": "text/html"}, ("<html><head></head><body><script>" + script + "</script></body></html>").encode(), url
    body = render_page(RECORD["website"], request)
    from app.website_enrichment import Page
    assert any(matched_business(node, RECORD) for node in Page(body.decode()).nodes)
    assert requests == [RECORD["website"]]


@pytest.mark.parametrize("discovery,status", [(False, "needs_review"), (True, "blocked"), (True, "needs_review")])
def test_review_and_discovery_paths_never_apply_remote(discovery, status, tmp_path, monkeypatch):
    import asyncio
    from app import worker as module
    from app.config import settings
    monkeypatch.setattr(settings, "WEBSITE_ENRICHMENT_ENABLED", True)
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    record = {**RECORD, "_discover_website": discovery}
    queue.enqueue(record, "run", database_target())
    worker = module.ScraperBackgroundWorker()
    worker._website_queue = queue
    async def collect(record):
        return {"status": status, "fields": {}, "pages": []}
    monkeypatch.setattr(module, "collect_website", collect)
    def forbidden(job):
        pytest.fail("Unconfirmed evidence must never enter remote write path")
    monkeypatch.setattr(worker, "_apply_website_evidence", forbidden)
    assert asyncio.run(worker._flush_one_website_job())
    assert queue.next_job() is None


def test_review_api_persists_only_local_decision(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app import main
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    queue.enqueue(RECORD, "run", database_target())
    job = queue.next_job()
    result = {"status": "needs_review", "pages": [], "fields": {}}
    queue.save_result(job, result)
    queue.hold_for_review({**job, "result": result})
    monkeypatch.setattr(main, "_website_backfill_queue", lambda: queue)
    client = TestClient(main.app)
    item = client.get("/api/website-reviews").json()["items"][0]
    response = client.post(f"/api/website-reviews/{item['id']}/accepted_evidence")
    assert response.json()["production_changed"] is False
    assert client.get("/api/website-reviews").json()["items"] == []
    assert client.post(f"/api/website-reviews/{item['id']}/unsafe_override").status_code == 400


def test_changed_website_candidate_requires_new_review(tmp_path):
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    for observation, url in enumerate(("https://first.example/", "https://second.example/")):
        record = {**RECORD, "raw": {"scraped_at": str(observation)}}
        queue.enqueue(record, "run", database_target())
        job = queue.next_job()
        result = {"status": "needs_review", "pages": [], "fields": {"website": {"value": url}}}
        queue.save_result(job, result)
        queue.hold_for_review({**job, "result": result})
        items = queue.reviews()
        assert len(items) == 1
        queue.decide_review(items[0]["id"], "rejected")
    assert queue.metrics()["review"] == {"rejected": 2}


def test_autonomous_unverified_job_is_terminal_without_human(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "WEBSITE_AUTONOMOUS", True)
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    queue.enqueue(RECORD, "run", database_target())
    job = queue.next_job()
    result = {"status": "needs_review", "pages": [], "fields": {}}
    queue.save_result(job, result)
    queue.hold_for_review({**job, "result": result})
    assert queue.next_job() is None
    assert queue.counts() == {"skipped": 1}
    assert queue.reviews() == []
    assert queue.reviews(include_deferred=True)[0]["decision"] == "automatically_deferred"


def test_autonomous_upgrade_preserves_evidence_and_releases_legacy_review(tmp_path, monkeypatch):
    from app.config import settings
    queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    queue.enqueue(RECORD, "run", database_target())
    job = queue.next_job()
    result = {"status": "needs_review", "pages": [{"url": RECORD["website"], "excerpt": "Unverified"}], "fields": {}}
    queue.save_result(job, result)
    queue.hold_for_review({**job, "result": result})
    assert queue.counts() == {"review": 1}
    monkeypatch.setattr(settings, "WEBSITE_AUTONOMOUS", True)
    queue = WebsiteQueue(queue.path)
    assert queue.counts() == {"skipped": 1}
    assert queue.reviews(include_deferred=True)[0]["result"] == result


def test_unmatched_landing_page_follows_contact_before_giving_up():
    def fetch(url):
        if url.endswith("robots.txt"):
            return 404, {}, b""
        body = b'<a href="/contact">Contact</a>' if url == RECORD["website"] else ('<script type="application/ld+json">' + json.dumps(NODE) + '</script>').encode()
        return 200, {"content-type": "text/html"}, body
    result = crawl_website(RECORD, fetch, lambda _: None)
    assert result["status"] == "collected"
    assert result["fields"]["telephone"]["source_url"] == RECORD["website"] + "contact"
    assert len(result["pages"]) == 2


def test_audit_report_uses_keyword_kind_and_is_persisted(tmp_path, monkeypatch):
    import asyncio
    import uuid
    from types import SimpleNamespace
    from app import worker as module
    from app.run_journal import RunJournal
    from app.config import settings
    worker = module.ScraperBackgroundWorker()
    journal = RunJournal(tmp_path / "journal.sqlite3")
    run_id = str(uuid.uuid4())
    journal.start_run(run_id=run_id)
    worker._journal = journal
    worker._run_id = run_id
    monkeypatch.setattr(settings, "DATA_QUALITY_AUDIT_INTERVAL_SEC", 3600)
    report = SimpleNamespace(next_shape_cursor=5, is_clean=True, as_dict=lambda: {"test": "audit"},
        summary=lambda: {"duplicate_google_cids": 0, "coordinate_issues": 0, "shape_issues": 0, "shape_rows_scanned": 5})
    monkeypatch.setattr(worker, "_run_data_quality_audit_sync", lambda: report)
    asyncio.run(worker._maybe_run_data_quality_audit())
    assert not any("Could not journal" in item["message"] for item in worker.get_status()["logs"])
    rows = journal.report_rows_for_run(run_id)
    assert len(rows) == 1
    assert rows[0]["kind"] == "data_quality"


def test_new_maps_observation_without_website_queues_discovery_without_mutating_batch(tmp_path):
    from types import SimpleNamespace
    from app import worker as module
    record = {**RECORD, "website": None, "raw": {"google_cid": "123"}}
    worker = module.ScraperBackgroundWorker()
    worker._website_queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    worker._queue_websites(SimpleNamespace(records=[record], run_id="run", metadata={"database_target": database_target()}))
    assert worker._website_queue.next_job()["payload"]["record"]["_discover_website"] is True
    assert "_discover_website" not in record
