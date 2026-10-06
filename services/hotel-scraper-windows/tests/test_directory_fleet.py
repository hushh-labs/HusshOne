import asyncio
import json
from pathlib import Path
import shutil
import subprocess
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import business_lookup as lookup, directory_fleet as directories, worker_updates as updates
from app.models import Base, Hotel
from app.vm_runtime import _run_hotel_pipeline, bundled_source_root


def test_four_native_schema_contracts_include_raw_and_geography():
    for vertical in directories.SERVICES:
        contract = directories.expected_columns(vertical, bundled_source_root())
        assert set(contract) == set(directories.WRITE_TABLES[vertical])
        canonical = next(iter(contract)) if vertical == 'healthcare' else None
        for table in contract:
            if table not in ('zips', 'ingest_runs', 'state_progress'):
                assert contract[table]['raw'] == 'jsonb'
                assert contract[table]['geog'] == 'USER-DEFINED'


def test_hotel_pipeline_preserves_cid_sources_photos_and_custom_raw():
    if not shutil.which('node') or not (bundled_source_root() / 'node_modules/pg').exists():
        pytest.skip('Node dependencies required for imported mapping fixture')
    original = {'name': 'Hôtel Example', 'lat': 47.67, 'lng': -122.12, 'zip': '98033',
                'state': 'WA', 'cid': '123', 'sources': ['maps'], 'photo_refs': ['keep'],
                'raw': {'custom': 'retain'}, 'google_maps_uri': 'https://www.google.com/maps?cid=123'}
    result = _run_hotel_pipeline([original], 'Kirkland', 'WA', '98033')[0]
    assert result['place_id'] is None
    assert result['cid'] == '123'
    assert result['sources'] == ['maps']
    assert result['photo_refs'] == ['keep']
    assert result['raw']['custom'] == 'retain'
    assert result['query_zip'] == '98033'
    assert result['dedup_key'].startswith('hotel example|')


def test_lookup_literal_filters_and_readonly_projection(monkeypatch):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add_all([Hotel(dedup_key='one', name='100% Hotel', zip='98033', raw={'secret_metadata': 'hidden'}),
                    Hotel(dedup_key='two', name='100x Hotel', zip='98033')])
        db.commit()
    monkeypatch.setattr(lookup.database, 'get_readonly_db_session', lambda: Session(engine))
    result = lookup.search_stored_businesses(lookup.BusinessSearch(q='100%', vertical='hotel'))
    assert result['count'] == 1
    assert result['results'][0]['name'] == '100% Hotel'
    assert 'raw' not in result['results'][0]
    assert not result['results'][0]['ownership_verified']
    assert lookup.search_stored_businesses(lookup.BusinessSearch(q="' OR 1=1 --", vertical='hotel'))['count'] == 0


def test_lookup_partial_failure_and_canonical_registry_identity(monkeypatch):
    monkeypatch.setattr(lookup.database, 'get_readonly_db_session', lambda: MagicMock())
    monkeypatch.setattr(lookup, 'hotel_results', lambda *_: [])
    def offline(_):
        raise lookup.database.DatabaseUnavailable('password=do-not-expose')
    monkeypatch.setattr(directories, 'registry_session', offline)
    result = lookup.search_stored_businesses(lookup.BusinessSearch(q='Example'))
    assert result['available_directories'] == ['hotel']
    assert len(result['warnings']) == 3
    assert 'do-not-expose' not in str(result)


def test_lookup_validation_and_get_post_equivalence(monkeypatch):
    from app.main import app
    monkeypatch.setattr(lookup, 'search_stored_businesses', lambda req: req.model_dump())
    client = TestClient(app)
    assert client.get('/api/v1/businesses').status_code == 422
    assert client.get('/api/v1/businesses?q=a&limit=101').status_code == 422
    assert client.get('/api/v1/businesses?zip=123').status_code == 422
    assert client.get('/api/v1/businesses?q=a&vertical=restaurant').status_code == 422
    assert client.get('/api/v1/businesses?q=a&vertical=ria').json() == client.post(
        '/api/v1/businesses/search', json={'q': 'a', 'vertical': 'ria'}).json()


def test_lookup_blocking_io_is_off_event_loop(monkeypatch):
    import threading
    thread = threading.get_ident()
    monkeypatch.setattr(lookup, 'search_stored_businesses', lambda _: {'thread': threading.get_ident()})
    result = asyncio.run(lookup.execute_search(lookup.BusinessSearch(q='a')))
    assert result['thread'] != thread


def test_desired_registry_workers_survive_restart(monkeypatch, tmp_path):
    monkeypatch.setattr(directories, 'runtime_state_dir', lambda: str(tmp_path))
    first = directories.DirectoryFleet()
    first.persist('ria', True)
    second = directories.DirectoryFleet()
    with second._state_db() as db:
        assert db.execute('SELECT enabled FROM desired_workers WHERE vertical=?', ('ria',)).fetchone()[0] == 1
    first.persist('ria', False)
    with second._state_db() as db:
        assert db.execute('SELECT enabled FROM desired_workers WHERE vertical=?', ('ria',)).fetchone()[0] == 0


def test_update_staging_integrity_and_atomic_pointer(monkeypatch, tmp_path):
    monkeypatch.setattr(updates, 'runtime_state_dir', lambda: str(tmp_path))
    release = updates.stage(bundled_source_root())
    assert updates.pointer('pending') == release
    assert updates.pointer('active') is None
    updates.activate(release)
    assert updates.pointer('active') == release
    assert updates.pointer('pending') is None
    root = updates.verify_release(release)
    (root / 'local-worker.mjs').write_text('// changed', encoding='utf-8')
    with pytest.raises(RuntimeError, match='checksum'):
        updates.verify_release(release)
    with pytest.raises(RuntimeError):
        updates.verify_release('../escape')


def test_live_update_api_rejects_cross_origin(monkeypatch):
    from app.main import app
    client = TestClient(app)
    assert client.post('/api/worker-updates/apply', headers={'Origin': 'https://attacker.example'}).status_code == 403
    monkeypatch.setattr(updates, 'pointer', lambda _: None)
    assert client.post('/api/worker-updates/apply').status_code == 409


def test_update_drains_without_killing_or_stopping_hotel(monkeypatch, tmp_path):
    monkeypatch.setattr(updates, 'runtime_state_dir', lambda: str(tmp_path))
    release = updates.stage(bundled_source_root())
    supervisor = directories.DirectoryFleet()
    supervisor.desired = {'ria'}
    process = MagicMock()
    process.poll.side_effect = [None, 0]
    supervisor.processes = {'ria': process}
    monkeypatch.setattr(directories, 'fleet', supervisor)
    monkeypatch.setattr(directories, 'preflight', lambda *_: {'ready': True})
    asyncio.run(updates.apply_pending())
    process.stdin.write.assert_called_once_with('drain\n')
    process.kill.assert_not_called()
    assert updates.pointer('active') == release
    assert not supervisor.updating
    assert updates._state['state'] == 'applied'
