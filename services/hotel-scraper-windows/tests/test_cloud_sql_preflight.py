"""Read-only preflight behavior without contacting a real Cloud SQL instance."""

import json

import preflight_cloud_sql as preflight
from app import cloud_proxy, config, database


def test_preflight_refuses_non_cloud_backend(monkeypatch, capsys):
    monkeypatch.setattr(config.settings, "DB_BACKEND", "sqlite")
    monkeypatch.setattr(preflight.sys, "argv", ["preflight_cloud_sql.py"])

    assert preflight.main() == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["read_only"] is True
    assert payload["database_connected"] is False
    assert "DB_BACKEND" in payload["error"]


def test_preflight_reports_compatible_connection_without_writes(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(config.settings, "DB_BACKEND", "cloud")
    monkeypatch.setattr(config.settings, "ALLOW_UNMANAGED_CLOUD_SQL_CONNECTION", False)
    monkeypatch.setattr(preflight.sys, "argv", ["preflight_cloud_sql.py", "--timeout", "5"])
    monkeypatch.setattr(cloud_proxy, "start_watchdog", lambda: calls.append("watchdog"))
    monkeypatch.setattr(cloud_proxy, "ensure_proxy", lambda: calls.append("proxy") or True)
    monkeypatch.setattr(cloud_proxy, "stop_proxy", lambda: calls.append("stop"))
    monkeypatch.setattr(database, "ensure_engine", lambda: object())
    monkeypatch.setattr(database, "check_connection", lambda: True)
    monkeypatch.setattr(database, "check_schema_compatible", lambda **kwargs: True)

    assert preflight.main() == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["read_only"] is True
    assert payload["database_connected"] is True
    assert payload["schema_compatible"] is True
    assert calls == ["watchdog", "proxy", "stop"]
