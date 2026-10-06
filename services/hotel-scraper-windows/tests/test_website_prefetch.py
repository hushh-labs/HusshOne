import asyncio
import pytest
from app import worker as module
from app.config import settings, database_target
from app.website_queue import WebsiteQueue


@pytest.fixture
def worker(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "WEBSITE_ENRICHMENT_ENABLED", True)
    monkeypatch.setattr(settings, "WEBSITE_FETCH_CONCURRENCY", 2)
    worker = module.ScraperBackgroundWorker()
    worker._is_running = True
    worker._website_queue = WebsiteQueue(tmp_path / "jobs.sqlite3")
    monkeypatch.setattr(worker, "_has_website_headroom", lambda: True)
    return worker


def add(worker, name, host, discovery=False):
    worker._website_queue.enqueue({"dedup_key": name, "name": name, "website": "https://" + host + "/",
        "_discover_website": discovery, "raw": {}}, "run", database_target())


def test_two_hosts_overlap_and_persist_without_remote_write(worker, monkeypatch):
    add(worker, "one", "one.example")
    add(worker, "two", "two.example")
    active, peak = 0, 0
    async def collect(record):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(.01)
        active -= 1
        return {"status": "collected", "fields": {}}
    monkeypatch.setattr(module, "collect_website", collect)
    monkeypatch.setattr(worker, "_apply_website_evidence", lambda job: pytest.fail("Prefetch cannot write production"))
    assert asyncio.run(worker._prefetch_website_pair())
    assert peak == 2
    assert worker._website_queue.counts() == {"fetched": 2}


@pytest.mark.parametrize("case", ["same_host", "serial", "maps", "paused"])
def test_prefetch_respects_training_and_site_limits(worker, monkeypatch, case):
    add(worker, "one", "one.example", discovery=case == "maps")
    add(worker, "two", "one.example" if case == "same_host" else "two.example")
    if case == "serial": monkeypatch.setattr(settings, "WEBSITE_FETCH_CONCURRENCY", 1)
    if case == "paused": worker._is_paused = True
    async def forbidden(record):
        pytest.fail("Should fall back to serial scheduling")
    monkeypatch.setattr(module, "collect_website", forbidden)
    assert asyncio.run(worker._prefetch_website_pair()) is False
    assert worker._website_queue.counts() == {"pending": 2}


def test_success_survives_other_collector_failure(worker, monkeypatch):
    add(worker, "one", "one.example")
    add(worker, "two", "two.example")
    async def collect(record):
        if record["name"] == "one": raise RuntimeError("collector failure")
        return {"status": "collected", "fields": {}}
    monkeypatch.setattr(module, "collect_website", collect)
    with pytest.raises(RuntimeError): asyncio.run(worker._prefetch_website_pair())
    assert worker._website_queue.counts() == {"pending": 1, "fetched": 1}


def test_fetched_replay_precedes_parallel_network(worker, monkeypatch):
    for name in ("one", "two", "three"): add(worker, name, name + ".example")
    queue = worker._website_queue
    queue.save_result(queue.next_job(), {"status": "collected", "fields": {}})
    assert asyncio.run(worker._prefetch_website_pair()) is False


def test_low_ram_reverts_to_serial(worker, monkeypatch):
    add(worker, "one", "one.example")
    add(worker, "two", "two.example")
    monkeypatch.setattr(worker, "_has_website_headroom", lambda: False)
    assert asyncio.run(worker._prefetch_website_pair()) is False
    assert worker._website_queue.counts() == {"pending": 2}
