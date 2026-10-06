from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from app.main import app
from app.directory_fleet import fleet
from app.worker import worker_instance


def test_hotel_card_reports_paused_and_desired_state(monkeypatch):
    monkeypatch.setattr(worker_instance, 'get_status', lambda: {
        'is_running': True, 'is_paused': True, 'stats': {}})
    hotel = fleet.status()['hotel']
    assert hotel['state'] == 'paused'
    assert hotel['desired_running'] is True


def test_card_start_reports_hotel_failure_instead_of_false_success(monkeypatch):
    monkeypatch.setattr(fleet, 'updating', False)
    monkeypatch.setattr(worker_instance, 'start', AsyncMock(return_value={
        'status': 'error', 'message': 'Schema guard blocked writes'}))
    response = TestClient(app).post('/api/directory-fleet/hotel/start')
    assert response.status_code == 409
    assert 'Schema guard' in response.json()['detail']


def test_starts_do_not_claim_success_while_updater_blocks_workers(monkeypatch):
    monkeypatch.setattr(fleet, 'updating', True)
    start = AsyncMock()
    monkeypatch.setattr(fleet, 'start', start)
    response = TestClient(app).post('/api/directory-fleet/insurance/start')
    assert response.status_code == 409
    start.assert_not_awaited()


def test_registry_buttons_dispatch_to_selected_directory(monkeypatch):
    monkeypatch.setattr(fleet, 'updating', False)
    start = AsyncMock()
    monkeypatch.setattr(fleet, 'start', start)
    client = TestClient(app)
    for vertical in ('healthcare', 'ria', 'insurance'):
        assert client.post(f'/api/directory-fleet/{vertical}/start').status_code == 200
    assert [call.args[0] for call in start.await_args_list] == ['healthcare', 'ria', 'insurance']
