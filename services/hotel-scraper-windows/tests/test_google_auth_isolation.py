"""Regression coverage for the scraper-only Google authentication boundary."""

import os
from types import SimpleNamespace

from app import cloud_proxy, config, database


def test_default_gcloud_config_is_beneath_app_local_data(monkeypatch, tmp_path):
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_CONFIG_DIR", None)
    monkeypatch.setattr(config, "user_data_dir", lambda: str(tmp_path / "HusshOne-Hotel-Scraper"))

    assert config.gcloud_config_dir() == str(
        (tmp_path / "HusshOne-Hotel-Scraper" / "gcloud").resolve()
    )


def test_google_auth_environment_cannot_inherit_personal_adc(monkeypatch, tmp_path):
    private_config = tmp_path / "private-gcloud"
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_CONFIG_DIR", str(private_config))
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_CONFIG_NAME", "husshone-scraper")
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_ACCOUNT", "husshpuppy5@gmail.com")

    env = config.google_auth_environment({
        "GOOGLE_APPLICATION_CREDENTIALS": "C:/Users/parth/AppData/Roaming/gcloud/personal.json",
        "CLOUDSDK_CONFIG": "C:/Users/parth/AppData/Roaming/gcloud",
        "CLOUDSDK_CORE_ACCOUNT": "personal@example.com",
        "CLOUDSDK_CORE_PROJECT": "personal-project",
        "CLOUDSDK_ACTIVE_CONFIG_NAME": "default",
        "CLOUDSDK_AUTH_ACCESS_TOKEN": "personal-token",
        "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE": "C:/personal-token.txt",
        "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE": "C:/personal-key.json",
        "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT": "personal@example.iam.gserviceaccount.com",
        "CLOUDSDK_AUTH_DISABLE_CREDENTIALS": "true",
        "PATH": "test-path",
    })

    assert env["CLOUDSDK_CONFIG"] == str(private_config.resolve())
    assert env["CLOUDSDK_ACTIVE_CONFIG_NAME"] == "husshone-scraper"
    assert env["CLOUDSDK_CORE_ACCOUNT"] == "husshpuppy5@gmail.com"
    assert env["CLOUDSDK_CORE_PROJECT"] == config.settings.GCP_PROJECT
    for override in (
        "GOOGLE_APPLICATION_CREDENTIALS",
        "CLOUDSDK_AUTH_ACCESS_TOKEN",
        "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
        "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
        "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
        "CLOUDSDK_AUTH_DISABLE_CREDENTIALS",
    ):
        assert override not in env
    assert env["PATH"] == "test-path"


def test_google_auth_environment_allows_no_account_override(monkeypatch, tmp_path):
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_CONFIG_DIR", str(tmp_path / "private-gcloud"))
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_CONFIG_NAME", "husshone-scraper")
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_ACCOUNT", "   ")

    env = config.google_auth_environment({"CLOUDSDK_CORE_ACCOUNT": "personal@example.com"})

    assert env["CLOUDSDK_ACTIVE_CONFIG_NAME"] == "husshone-scraper"
    assert "CLOUDSDK_CORE_ACCOUNT" not in env


def test_secret_lookup_passes_isolated_config_and_dedicated_account(monkeypatch, tmp_path):
    private_config = tmp_path / "private-gcloud"
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_CONFIG_DIR", str(private_config))
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_CONFIG_NAME", "husshone-scraper")
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_ACCOUNT", "husshpuppy5@gmail.com")
    monkeypatch.setattr(database.shutil, "which", lambda _name: "gcloud.exe")
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return SimpleNamespace(returncode=0, stdout="database-password\n", stderr="")

    monkeypatch.setattr(database.subprocess, "run", fake_run)

    assert database._fetch_password_from_secret_manager() == "database-password"
    assert captured["command"][:2] == ["gcloud.exe", "--account=husshpuppy5@gmail.com"]
    assert captured["kwargs"]["env"]["CLOUDSDK_CONFIG"] == str(private_config.resolve())
    assert captured["kwargs"]["env"]["CLOUDSDK_ACTIVE_CONFIG_NAME"] == "husshone-scraper"
    assert captured["kwargs"]["env"]["CLOUDSDK_CORE_ACCOUNT"] == "husshpuppy5@gmail.com"
    assert "GOOGLE_APPLICATION_CREDENTIALS" not in captured["kwargs"]["env"]


def test_proxy_uses_private_gcloud_auth_not_a_credentials_file(monkeypatch, tmp_path):
    private_config = tmp_path / "private-gcloud"
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_CONFIG_DIR", str(private_config))
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_CONFIG_NAME", "husshone-scraper")
    monkeypatch.setattr(config.settings, "GCP_GCLOUD_ACCOUNT", "husshpuppy5@gmail.com")
    monkeypatch.setattr(config.settings, "DB_BACKEND", "cloud")
    monkeypatch.setattr(config.settings, "DATABASE_URL", None)
    monkeypatch.setattr(config.settings, "AUTO_START_PROXY", True)
    monkeypatch.setattr(config.settings, "DB_HOST", "127.0.0.1")
    monkeypatch.setattr(cloud_proxy, "_proc", None)
    monkeypatch.setattr(cloud_proxy, "_port_open", lambda: False)
    monkeypatch.setattr(cloud_proxy, "_find_binary", lambda: "cloud-sql-proxy.exe")
    captured = {}

    class FakeProcess:
        stdout = None

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return FakeProcess()

    class FakeThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            pass

    monkeypatch.setattr(cloud_proxy.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(cloud_proxy.threading, "Thread", FakeThread)

    assert cloud_proxy.ensure_proxy() is False
    assert "--gcloud-auth" in captured["command"]
    assert "--credentials-file" not in captured["command"]
    assert captured["kwargs"]["env"]["CLOUDSDK_CONFIG"] == str(private_config.resolve())
    assert captured["kwargs"]["env"]["CLOUDSDK_ACTIVE_CONFIG_NAME"] == "husshone-scraper"
    assert captured["kwargs"]["env"]["CLOUDSDK_CORE_ACCOUNT"] == "husshpuppy5@gmail.com"
    assert "GOOGLE_APPLICATION_CREDENTIALS" not in captured["kwargs"]["env"]


def test_proxy_refuses_an_unowned_listener_in_managed_mode(monkeypatch):
    monkeypatch.setattr(config.settings, "DB_BACKEND", "cloud")
    monkeypatch.setattr(config.settings, "DATABASE_URL", None)
    monkeypatch.setattr(config.settings, "AUTO_START_PROXY", True)
    monkeypatch.setattr(config.settings, "DB_HOST", "127.0.0.1")
    monkeypatch.setattr(cloud_proxy, "_proc", None)
    monkeypatch.setattr(cloud_proxy, "_port_open", lambda: True)

    assert cloud_proxy.ensure_proxy() is False


def test_proxy_still_refuses_unowned_listener_when_auto_start_is_disabled(monkeypatch):
    """Turning off automatic launch must not silently allow a personal proxy."""
    monkeypatch.setattr(config.settings, "DB_BACKEND", "cloud")
    monkeypatch.setattr(config.settings, "DATABASE_URL", None)
    monkeypatch.setattr(config.settings, "AUTO_START_PROXY", False)
    monkeypatch.setattr(config.settings, "ALLOW_UNMANAGED_CLOUD_SQL_CONNECTION", False)
    monkeypatch.setattr(config.settings, "DB_HOST", "127.0.0.1")
    monkeypatch.setattr(cloud_proxy, "_proc", None)
    monkeypatch.setattr(cloud_proxy, "_port_open", lambda: True)

    assert cloud_proxy.requires_owned_proxy() is True
    assert cloud_proxy.ensure_proxy() is False


def test_managed_cloud_database_url_requires_explicit_opt_in(monkeypatch):
    monkeypatch.setattr(config.settings, "DB_BACKEND", "cloud")
    monkeypatch.setattr(config.settings, "DATABASE_URL", "postgresql://unmanaged.example/hotels")
    monkeypatch.setattr(config.settings, "ALLOW_UNMANAGED_CLOUD_SQL_CONNECTION", False)

    try:
        database._build_url()
    except database.DatabaseUnavailable as exc:
        assert "DATABASE_URL is disabled" in str(exc)
    else:
        raise AssertionError("managed Cloud SQL mode accepted an unverified DATABASE_URL")


def test_sqlite_backend_rejects_postgresql_database_url(monkeypatch):
    monkeypatch.setattr(config.settings, "DB_BACKEND", "sqlite")
    monkeypatch.setattr(config.settings, "DATABASE_URL", "postgresql://unmanaged.example/hotels")

    try:
        database._build_url()
    except database.DatabaseUnavailable as exc:
        assert "DB_BACKEND=sqlite" in str(exc)
    else:
        raise AssertionError("SQLite mode accepted a PostgreSQL DATABASE_URL")


def test_connection_guard_rejects_unready_owned_proxy(monkeypatch):
    monkeypatch.setattr(cloud_proxy, "requires_owned_proxy", lambda: True)
    monkeypatch.setattr(cloud_proxy, "ensure_proxy", lambda: False)

    try:
        database._require_owned_cloud_sql_proxy()
    except database.DatabaseUnavailable as exc:
        assert "app-owned Cloud SQL proxy" in str(exc)
    else:
        raise AssertionError("database connection guard accepted an unready proxy")


def _recorded_proxy_marker():
    connection_name = (
        f"{config.settings.GCP_PROJECT}:{config.settings.GCP_REGION}:"
        f"{config.settings.CLOUD_SQL_INSTANCE}"
    )
    executable = os.path.normcase(os.path.abspath("C:/tools/cloud-sql-proxy.exe"))
    return {
        "version": 1,
        "pid": 1234,
        "creation_date": "20261005120000.000000+000",
        "parent_pid": 4321,
        "parent_creation_date": "20261005110000.000000+000",
        "executable": executable,
        "connection_name": connection_name,
        "host": config.settings.DB_HOST,
        "port": config.settings.DB_PORT,
    }


def _matching_process_details(marker):
    return {
        "creation_date": marker["creation_date"],
        "executable_path": marker["executable"],
        "command_line": (
            f"{marker['executable']} {marker['connection_name']} --address "
            f"{marker['host']} --port {marker['port']} --gcloud-auth"
        ),
    }


def test_verified_orphan_is_reclaimed_after_its_parent_is_gone(monkeypatch):
    marker = _recorded_proxy_marker()
    child = _matching_process_details(marker)
    calls = []
    cleared = []

    monkeypatch.setattr(cloud_proxy, "_read_owner_marker", lambda: marker)
    monkeypatch.setattr(
        cloud_proxy,
        "_windows_process_details",
        lambda pid: child if pid == marker["pid"] else None,
    )
    monkeypatch.setattr(cloud_proxy, "_process_exists", lambda _pid: False)
    monkeypatch.setattr(cloud_proxy, "_port_open", lambda: False)
    monkeypatch.setattr(cloud_proxy, "_clear_owner_marker", lambda: cleared.append(True))

    def fake_run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(cloud_proxy.subprocess, "run", fake_run)

    assert cloud_proxy._recover_recorded_orphan() is True
    assert calls == [["taskkill.exe", "/PID", str(marker["pid"]), "/T", "/F"]]
    assert cleared == [True]


def test_mismatched_orphan_marker_never_kills_the_listener(monkeypatch):
    marker = _recorded_proxy_marker()
    child = _matching_process_details(marker)
    child["executable_path"] = os.path.abspath("C:/other/process.exe")
    calls = []

    monkeypatch.setattr(cloud_proxy, "_read_owner_marker", lambda: marker)
    monkeypatch.setattr(
        cloud_proxy,
        "_windows_process_details",
        lambda pid: child if pid == marker["pid"] else None,
    )
    monkeypatch.setattr(cloud_proxy, "_process_exists", lambda _pid: False)
    monkeypatch.setattr(cloud_proxy, "_clear_owner_marker", lambda: None)
    monkeypatch.setattr(cloud_proxy.subprocess, "run", lambda *args, **kwargs: calls.append(args))

    assert cloud_proxy._recover_recorded_orphan() is False
    assert calls == []


def test_live_parent_prevents_orphan_cleanup(monkeypatch):
    marker = _recorded_proxy_marker()
    parent = {"creation_date": marker["parent_creation_date"], "executable_path": "app.exe", "command_line": "app"}
    calls = []

    monkeypatch.setattr(cloud_proxy, "_read_owner_marker", lambda: marker)
    monkeypatch.setattr(
        cloud_proxy,
        "_windows_process_details",
        lambda pid: parent if pid == marker["parent_pid"] else None,
    )
    monkeypatch.setattr(cloud_proxy.subprocess, "run", lambda *args, **kwargs: calls.append(args))

    assert cloud_proxy._recover_recorded_orphan() is False
    assert calls == []
