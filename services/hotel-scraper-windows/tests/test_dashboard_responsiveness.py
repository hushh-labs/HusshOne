from types import SimpleNamespace
from fastapi.testclient import TestClient
from app import main


def test_fast_worker_poll_does_not_connect_to_database(monkeypatch):
    monkeypatch.setattr(main, "worker_instance", SimpleNamespace(get_status=lambda: {"is_running": True, "stats": {}}))
    monkeypatch.setattr(main, "_live_session", lambda: (_ for _ in ()).throw(AssertionError("No database access")))
    monkeypatch.setattr(main, "_cache", {"snapshot": (0, {"zips_total": 10, "done": 5, "error": 1, "pending": 4})})
    response = TestClient(main.app).get("/api/worker/live")
    assert response.status_code == 200
    data = response.json()
    assert data["database_status_is_cached"] is True
    assert data["status"]["queue"]["places_done"] == 5
    assert data["status"]["inventory_snapshot_age_seconds"] >= 0


def test_compact_outcomes_do_not_send_raw_history_or_large_excerpts(monkeypatch):
    item = {"id": "id", "decision": "automatically_deferred", "updated_at": 1,
            "record": {"name": "Hotel", "raw": {"large": "x" * 100000}},
            "result": {"fields": {"address": {"value": "x" * 10000}},
                       "pages": [{"url": "https://hotel.example/", "excerpt": "x" * 5000}]}}
    queue = SimpleNamespace(reviews=lambda **kwargs: [item] * 50, metrics=lambda: {})
    monkeypatch.setattr(main, "_website_backfill_queue", lambda: queue)
    response = TestClient(main.app).get("/api/website-reviews?compact=true")
    assert response.status_code == 200
    assert len(response.content) < 10000
    data = response.json()
    assert len(data["items"]) == 10
    assert "raw" not in data["items"][0]["record"]
    assert len(data["items"][0]["result"]["pages"][0]["excerpt"]) == 400
