import asyncio
import pytest
from app.config import settings, database_target
from app.website_queue import WebsiteQueue
from app.worker import ScraperBackgroundWorker


def enqueue(queue, name, backfill=None):
    queue.enqueue({"name": name, "dedup_key": name, "website": "https://hotel.example/", "raw": {}},
                  "run", database_target(), backfill_id=backfill)


@pytest.fixture
def queue(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "WEBSITE_FILL_MISSING_FIELDS", True)
    return WebsiteQueue(tmp_path / "jobs.sqlite3")


def test_fair_lane_selection_with_fallback(queue):
    enqueue(queue, "new")
    enqueue(queue, "old", "historic")
    assert queue.next_job(prefer_backfill=False)["payload"]["record"]["name"] == "new"
    old = queue.next_job(prefer_backfill=True)
    assert old["payload"]["record"]["name"] == "old"
    queue.finish(old["id"], "skipped")
    assert queue.next_job(prefer_backfill=True)["payload"]["record"]["name"] == "new"


def test_fetched_evidence_replayed_before_other_lane(queue):
    enqueue(queue, "old", "historic")
    job = queue.next_job()
    queue.save_result(job, {"status": "collected", "fields": {}})
    enqueue(queue, "new")
    assert queue.next_job(prefer_backfill=False)["id"] == job["id"]


def test_paused_backfill_not_eligible_and_does_not_throttle(queue, monkeypatch):
    run = queue.start_backfill(10)
    enqueue(queue, "old", run["run_id"])
    enqueue(queue, "new")
    queue.pause_backfill()
    assert queue.scheduler_status()["queued"] == 1
    assert queue.next_job(prefer_backfill=True)["payload"]["record"]["name"] == "new"
    worker = ScraperBackgroundWorker()
    worker._website_queue = queue
    monkeypatch.setattr(settings, "WEBSITE_ENRICHMENT_ENABLED", True)
    monkeypatch.setattr(settings, "WEBSITE_BACKLOG_HIGH", 2)
    assert worker._website_backpressure() is False


def test_scheduled_retries_are_not_ready(queue):
    enqueue(queue, "new")
    queue.defer(queue.next_job(), 300)
    status = queue.scheduler_status()
    assert status["queued"] == status["waiting_retry"] == 1
    assert status["ready"] == 0
    assert status["next_retry_at"]
    assert queue.next_job() is None


def test_hysteresis_preserves_all_jobs(queue, monkeypatch):
    worker = ScraperBackgroundWorker()
    worker._website_queue = queue
    monkeypatch.setattr(settings, "WEBSITE_ENRICHMENT_ENABLED", True)
    monkeypatch.setattr(settings, "WEBSITE_BACKLOG_HIGH", 3)
    monkeypatch.setattr(settings, "WEBSITE_BACKLOG_LOW", 1)
    for name in ("a", "b", "c"):
        enqueue(queue, name)
    assert worker._website_backpressure() is True
    queue.finish(queue.next_job()["id"], "skipped")
    assert worker._website_backpressure() is True
    queue.finish(queue.next_job()["id"], "skipped")
    assert worker._website_backpressure() is False
    assert sum(queue.counts().values()) == 3


def test_bounded_drain_clears_activity_and_respects_pause(monkeypatch):
    worker = ScraperBackgroundWorker()
    worker._is_running = True
    monkeypatch.setattr(settings, "WEBSITE_JOBS_PER_CYCLE", 3)
    calls = []
    async def flush():
        calls.append(1)
        worker._website_activity = {"state": "processing", "hotel": "Test"}
        return True
    monkeypatch.setattr(worker, "_flush_one_website_job", flush)
    assert asyncio.run(worker._drain_website_cycle()) is True
    assert len(calls) == 3 and worker._website_activity["state"] == "idle"
    worker._is_paused = True
    assert asyncio.run(worker._drain_website_cycle()) is False
    assert len(calls) == 3


def test_drain_exception_preserves_error_and_clears_activity(monkeypatch):
    worker = ScraperBackgroundWorker()
    worker._is_running = True
    async def fail():
        worker._website_activity = {"state": "processing", "hotel": "Test"}
        raise RuntimeError("database unavailable")
    monkeypatch.setattr(worker, "_flush_one_website_job", fail)
    with pytest.raises(RuntimeError):
        asyncio.run(worker._drain_website_cycle())
    assert worker._website_activity["state"] == "idle"


def test_worker_cycle_actually_alternates_lanes(queue, monkeypatch):
    from app import worker as module
    worker = ScraperBackgroundWorker()
    worker._website_queue = queue
    worker._is_running = True
    monkeypatch.setattr(settings, "WEBSITE_ENRICHMENT_ENABLED", True)
    monkeypatch.setattr(settings, "WEBSITE_JOBS_PER_CYCLE", 4)
    monkeypatch.setattr(worker, "_scan_website_backfill", lambda: None)
    monkeypatch.setattr(worker, "_apply_website_evidence", lambda job: True)
    calls = []
    async def collect(record):
        calls.append(record["name"])
        return {"status": "collected", "fields": {}}
    monkeypatch.setattr(module, "collect_website", collect)
    for name, lane in [("new1", None), ("new2", None), ("old1", "historic"), ("old2", "historic")]:
        enqueue(queue, name, lane)
    assert asyncio.run(worker._drain_website_cycle()) is True
    assert calls == ["new1", "old1", "new2", "old2"]
    assert queue.counts() == {"applied": 4}


def test_cycle_time_budget_checked_between_jobs(monkeypatch):
    from app import worker as module
    worker = ScraperBackgroundWorker()
    worker._is_running = True
    monkeypatch.setattr(settings, "WEBSITE_JOBS_PER_CYCLE", 8)
    monkeypatch.setattr(settings, "WEBSITE_CYCLE_BUDGET_SEC", 1)
    clock = iter([0, 2])
    monkeypatch.setattr(module.time, "monotonic", lambda: next(clock))
    calls = []
    async def flush():
        calls.append(1)
        return True
    monkeypatch.setattr(worker, "_flush_one_website_job", flush)
    # Run on an existing loop; asyncio itself also reads the monotonic clock.
    # Use a direct coroutine driver since this stub never suspends.
    coro = worker._drain_website_cycle()
    with pytest.raises(StopIteration) as completed:
        coro.send(None)
    assert completed.value.value is True
    assert calls == [1]
