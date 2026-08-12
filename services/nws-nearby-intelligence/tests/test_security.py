from fastapi.testclient import TestClient

from app.main import app
from app.security import rate_limiter


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
