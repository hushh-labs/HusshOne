import asyncio
import pytest
from app import worker as module, performance
from app.config import settings, database_target
from app.website_queue import WebsiteQueue


@pytest.fixture
def worker(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'WEBSITE_ENRICHMENT_ENABLED', True)
    monkeypatch.setattr(settings, 'WEBSITE_JOBS_PER_CYCLE', 4)
    monkeypatch.setattr(performance, 'collector_limit', lambda active=0: 4)
    worker = module.ScraperBackgroundWorker()
    worker._is_running = True
    worker._website_queue = WebsiteQueue(tmp_path / 'jobs.sqlite3')
    worker._website_pipeline_enabled = True
    worker._website_fetches = {}
    worker._website_hosts = set()
    worker._website_fetch_stats = {'completed':0, 'retries':0}
    return worker


def add(worker, name, host):
    worker._website_queue.enqueue({'dedup_key':name, 'name':name, 'website':'https://' + host,
                                  'raw':{}}, 'run', database_target())


def test_slow_site_does_not_block_fast_evidence_or_main_loop(worker, monkeypatch):
    add(worker, 'slow', 'slow.example')
    add(worker, 'fast', 'fast.example')
    async def scenario():
        release = asyncio.Event()
        async def collect(record, timeout):
            if record['name'] == 'slow':
                await release.wait()
            return {'status':'collected','fields':{}}
        monkeypatch.setattr(module, 'collect_website', collect)
        monkeypatch.setattr(worker, '_apply_website_evidence', lambda job: {'filled_fields':['phone']})
        await worker._fill_website_fetch_pool()
        for _ in range(100):
            if worker._website_queue.counts().get('fetched'):
                break
            await asyncio.sleep(.01)
        assert await worker._flush_one_website_job()
        assert worker._stats['website_records_written'] == 1
        assert worker._stats['blank_fields_filled'] == 1
        assert worker._website_queue.counts().get('pending') == 1
        # The application loop returns immediately rather than awaiting slow.
        assert await asyncio.wait_for(worker._flush_one_website_job(), .1) is False
        release.set()
        await asyncio.gather(*worker._website_fetches.values())
        assert worker._website_fetch_stats['completed'] == 2
    asyncio.run(scenario())


def test_pool_bounded_unique_hosts_and_single_selection(worker, monkeypatch):
    for index in range(10):
        add(worker, str(index), f'host{index // 2}.example')
    async def scenario():
        gate = asyncio.Event()
        started = []
        async def collect(record, timeout):
            started.append(record['website'])
            await gate.wait()
            return {'status':'collected','fields':{}}
        monkeypatch.setattr(module, 'collect_website', collect)
        await asyncio.gather(worker._fill_website_fetch_pool(), worker._fill_website_fetch_pool())
        await asyncio.sleep(.01)
        assert len(started) == 4 and len(set(started)) == 4
        gate.set()
        await asyncio.gather(*worker._website_fetches.values())
    asyncio.run(scenario())


def test_cancelled_fetch_survives_for_restart(worker, monkeypatch):
    add(worker, 'one', 'one.example')
    async def collect(record, timeout):
        await asyncio.sleep(100)
    monkeypatch.setattr(module, 'collect_website', collect)
    async def scenario():
        await worker._fill_website_fetch_pool()
        for task in worker._website_fetches.values(): task.cancel()
        await asyncio.gather(*worker._website_fetches.values(), return_exceptions=True)
    asyncio.run(scenario())
    assert worker._website_queue.counts() == {'pending':1}


def test_resource_profiles_preserve_headroom_and_are_live(monkeypatch, tmp_path):
    monkeypatch.setattr(performance, 'runtime_state_dir', lambda: str(tmp_path))
    monkeypatch.setattr(performance.os, 'cpu_count', lambda: 32)
    monkeypatch.setattr(performance, 'available_memory_bytes', lambda: 28 * 1024**3)
    monkeypatch.setattr(settings, 'SCRAPER_PERFORMANCE_MODE', 'balanced')
    monkeypatch.setattr(settings, 'WEBSITE_FULL_CONCURRENCY', 32)
    performance.set_mode('throughput')
    assert performance.collector_limit() == 24  # 28 GiB free minus 4 GiB reserve
    assert performance.collector_limit(active=8) == 32
    monkeypatch.setattr(settings, 'WEBSITE_FULL_CONCURRENCY', 6)
    assert performance.collector_limit(active=8) == 6
    performance.set_mode('training')
    assert performance.collector_limit(active=8) == 1
    monkeypatch.setattr(performance, 'available_memory_bytes', lambda: 3 * 1024**3)
    assert performance.collector_limit() == 0
    performance.restore_mode()
    assert settings.SCRAPER_PERFORMANCE_MODE == 'training'


def test_maps_claim_is_reached_even_under_website_pressure(worker, monkeypatch):
    calls = []
    async def noop(*args): return False
    async def canary(): return True
    async def idle(): await asyncio.sleep(100)
    for name in ('_maybe_prune_outbox','_maybe_run_data_quality_audit','_flush_one_outbox_batch','_drain_website_cycle'):
        monkeypatch.setattr(worker, name, noop)
    monkeypatch.setattr(worker, '_website_fetch_loop', idle)
    monkeypatch.setattr(worker, '_website_backpressure', lambda: True)
    monkeypatch.setattr(worker, '_maps_cap_reached', lambda: False)
    monkeypatch.setattr(worker, '_maybe_run_canary', canary)
    def claim():
        calls.append('maps')
        raise asyncio.CancelledError()
    monkeypatch.setattr(worker, '_next_zip_sync', claim)
    monkeypatch.setattr(worker, '_release_zip_claims', lambda: None)
    monkeypatch.setattr(worker, '_finish_journal_run', lambda *args: None)
    asyncio.run(worker._run_loop())
    assert calls == ['maps']
