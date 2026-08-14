import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.security import rate_limiter
from app.settings import Settings


def setup_function() -> None:
    rate_limiter._events.clear()  # noqa: SLF001 - test reset for the in-process limiter


def test_invalid_api_key_is_rejected() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers={"X-NWS-API-Key": "wrong"},
        json={"query": {"postal_code": "98033"}},
    )
    assert response.status_code == 401


@pytest.mark.parametrize("api_key", ["", "short", "local-development-only"])
def test_production_rejects_missing_or_weak_api_key(monkeypatch, api_key: str) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("NWS_ENVIRONMENT", "production")
    monkeypatch.setenv("NWS_REQUIRE_API_KEY", "true")
    monkeypatch.setenv("NWS_API_KEY", api_key)

    with pytest.raises(RuntimeError, match="at least 32 characters"):
        Settings.from_environment()


def test_production_form6_query_uses_snapshot_config_without_source_key(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("NWS_ENVIRONMENT", "production")
    monkeypatch.setenv("NWS_REQUIRE_API_KEY", "true")
    monkeypatch.setenv("NWS_API_KEY", "n" * 32)
    monkeypatch.setenv("NWS_NATIONAL_SOURCES_ENABLED", "false")
    monkeypatch.setenv("NWS_FORM6_SOURCE_ENABLED", "true")
    monkeypatch.delenv("NWS_FORM6_API_KEY", raising=False)
    monkeypatch.setenv("NWS_SNAPSHOT_BUCKET", "test-published-snapshots")
    monkeypatch.setenv("NWS_SNAPSHOT_PREFIX", "published/test-net-worth")
    monkeypatch.setenv("NWS_SNAPSHOT_MAX_AGE_HOURS", "12")
    monkeypatch.setenv("NWS_SNAPSHOT_MAX_SOURCE_AGE_HOURS", "240")
    monkeypatch.setenv("NWS_SOURCE_REGISTRY_PATH", "/app/config/test-sources.yaml")
    monkeypatch.setenv(
        "NWS_SOURCE_REGISTRY_MANIFEST_PATH",
        "/app/config/test-source-manifest.json",
    )
    monkeypatch.setenv("NWS_SOURCE_REGISTRY_SHA256", "a" * 64)
    monkeypatch.setenv("NWS_SOURCE_REGISTRY_VERSION", "9")

    settings = Settings.from_environment()

    assert settings.form6_source_enabled is True
    assert settings.snapshot_bucket == "test-published-snapshots"
    assert settings.snapshot_prefix == "published/test-net-worth"
    assert settings.snapshot_max_age_hours == 12
    assert settings.snapshot_max_source_age_hours == 240
    assert settings.source_registry_path == "/app/config/test-sources.yaml"
    assert (
        settings.source_registry_manifest_path
        == "/app/config/test-source-manifest.json"
    )
    assert settings.source_registry_sha256 == "a" * 64
    assert settings.source_registry_version == 9
    assert not hasattr(settings, "form6_api_key")


def test_production_form6_source_requires_snapshot_bucket(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("NWS_ENVIRONMENT", "production")
    monkeypatch.setenv("NWS_REQUIRE_API_KEY", "true")
    monkeypatch.setenv("NWS_API_KEY", "n" * 32)
    monkeypatch.setenv("NWS_NATIONAL_SOURCES_ENABLED", "false")
    monkeypatch.setenv("NWS_FORM6_SOURCE_ENABLED", "true")
    monkeypatch.delenv("NWS_SNAPSHOT_BUCKET", raising=False)
    monkeypatch.setenv("NWS_SOURCE_REGISTRY_SHA256", "a" * 64)

    with pytest.raises(RuntimeError, match="NWS_SNAPSHOT_BUCKET"):
        Settings.from_environment()


def test_security_headers_and_no_store_cache_policy_are_returned() -> None:
    client = TestClient(app)
    response = client.get("/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"


def test_oversized_payload_is_rejected_before_json_processing() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers={
            "X-NWS-API-Key": "local-development-only",
            "Content-Type": "application/json",
            "Content-Length": "40000",
        },
        content=b"{}",
    )
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "REQUEST_TOO_LARGE"


def test_headerless_oversized_payload_is_rejected_before_validation() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers={
            "X-NWS-API-Key": "local-development-only",
            "Content-Type": "application/json",
        },
        content=b'{"oversized":"' + (b"x" * 40_000) + b'"}',
    )

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "REQUEST_TOO_LARGE"
    assert "xxx" not in response.text


def test_validation_errors_do_not_reflect_submitted_values() -> None:
    client = TestClient(app)
    marker = "sensitive-user-supplied-value"
    response = client.post(
        "/v2/nearby-network/discover",
        headers={"X-NWS-API-Key": "local-development-only"},
        json={"query": {"postal_code": "98033", "unexpected": marker}},
    )

    assert response.status_code == 422
    assert marker not in response.text
    assert all("input" not in error for error in response.json()["detail"])
