from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

import app.main as main
from app.consumer_access import ConsumerAccessRegistry, derive_api_key_sha256
from app.coordinate_consent import issue_coordinate_consent_receipt
from app.main import app
from app.net_worth import NET_WORTH_MODEL_VERSION
from app.security import rate_limiter

API_KEY = "nws_test_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"  # gitleaks:allow


def setup_function() -> None:
    rate_limiter._events.clear()  # noqa: SLF001 - in-process test reset


def _registry() -> ConsumerAccessRegistry:
    document = {
        "schema_version": "nws-consumer-access-registry-v1",
        "registry_version": 1,
        "consumers": [
            {
                "consumer_id": "husshone-prod",
                "project_id": "hushone-app",
                "tier": "STANDARD",
                "api_key_sha256": derive_api_key_sha256(API_KEY),
                "expires_at": "2027-08-14T23:59:59Z",
                "kill_switch": False,
                "grants": [
                    {
                        "route": "/v4/net-worth/discover",
                        "purpose": "NET_WORTH_LOOKUP",
                        "max_top_n": 200,
                        "max_radius_km": 500.0,
                        "requests_per_minute": 30,
                        "coordinate_consent_max_age_seconds": 900,
                    }
                ],
            }
        ],
    }
    payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    return ConsumerAccessRegistry.from_json_bytes(
        payload,
        expected_sha256=hashlib.sha256(payload).hexdigest(),
    )


def _enable_v4(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    settings = replace(
        main.get_settings(),
        v4_enabled=True,
        consent_receipt_bucket="test-consent-bucket",
    )
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "_consumer_access_registry", _registry)


def _payload(*, project_id: str = "hushone-app") -> dict[str, object]:
    return {
        "query": {"postal_code": "98033", "country_code": "US"},
        "selection": {
            "count": 100,
            "financial_mode": "estimated",
            "geography_mode": "nearest-count",
        },
        "filters": {
            "minimum_confidence": "C",
            "minimum_coverage": 0.55,
            "asset_families": [],
        },
        "caller_context": {
            "project_id": project_id,
            "purpose_id": "NET_WORTH_LOOKUP",
            "authorization_scope": "PUBLIC_SAFE",
            "requested_data_tier": "PUBLIC_SAFE",
            "audit_actor": "service-account:nws-client",
            "model_version": NET_WORTH_MODEL_VERSION,
        },
    }


def test_v4_requires_integrity_pinned_consumer_credentials(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _enable_v4(monkeypatch)
    response = TestClient(app).post("/v4/net-worth/discover", json=_payload())

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "INVALID_CREDENTIALS"


def test_v4_project_context_must_match_authenticated_consumer(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _enable_v4(monkeypatch)
    response = TestClient(app).post(
        "/v4/net-worth/discover",
        headers={"X-NWS-API-Key": API_KEY},
        json=_payload(project_id="another-project"),
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "PROJECT_CONTEXT_MISMATCH"


def test_v4_truthfully_returns_scored_shortfall_and_redacted_audit(
    monkeypatch,
    caplog,
) -> None:  # type: ignore[no-untyped-def]
    _enable_v4(monkeypatch)
    caplog.set_level(logging.INFO, logger="nws_nearby_intelligence")
    response = TestClient(app).post(
        "/v4/net-worth/discover",
        headers={
            "X-NWS-API-Key": API_KEY,
            "X-Request-ID": "client-request-01234567",
        },
        json=_payload(),
    )

    assert response.status_code == 200
    assert response.headers["X-Request-ID"].startswith("req-")
    assert response.headers["X-Request-ID"] != "client-request-01234567"
    body = response.json()
    assert body["contract_version"] == "nws-nearby-net-worth-v4-preview-1"
    assert body["coverage_contract"] == ("BEST_EFFORT_VERIFIED_PUBLIC_FINANCIAL_PROFILES")
    assert body["request_policy"]["project_id"] == "hushone-app"
    assert body["request_policy"]["purpose_id"] == "NET_WORTH_LOOKUP"
    assert body["request_policy"]["audit_actor_reference"].startswith("actor_")
    assert body["financial_coverage"]["v4_eligible_count"] == 0
    assert body["result_set"]["requested_count"] == 100
    assert body["result_set"]["returned_count"] == 0
    assert body["result_set"]["shortfall_count"] == 100
    assert body["result_set"]["target_satisfied"] is False
    assert body["results"] == []

    audit_lines = [
        record.message for record in caplog.records if "consumer_access_audit" in record.message
    ]
    assert len(audit_lines) == 1
    audit = audit_lines[0]
    assert "actor_" in audit
    audit_event = json.loads(audit.removeprefix("consumer_access_audit "))
    assert audit_event["request_id"] == response.headers["X-Request-ID"]
    assert audit_event["data_version"]["snapshot_id"] is None
    assert audit_event["data_version"]["snapshot_sha256"] is None
    for forbidden in (
        API_KEY,
        "service-account:nws-client",
        "98033",
        "postal_code",
        "latitude",
        "longitude",
    ):
        assert forbidden not in audit


def test_v4_coordinate_query_requires_fresh_purpose_bound_consent(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _enable_v4(monkeypatch)
    payload = _payload()
    payload["query"] = {
        "latitude": 47.6715,
        "longitude": -122.2133,
        "country_code": "US",
    }
    response = TestClient(app).post(
        "/v4/net-worth/discover",
        headers={"X-NWS-API-Key": API_KEY},
        json=payload,
    )

    assert response.status_code == 422
    assert "47.6715" not in response.text
    assert "-122.2133" not in response.text


def test_v4_coordinate_query_consumes_a_signed_receipt_once(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _enable_v4(monkeypatch)

    class _SingleUse:
        def __init__(self) -> None:
            self.used: set[str] = set()

        def consume(self, digest: str, *, consumed_at: datetime) -> bool:
            assert consumed_at.tzinfo is not None
            if digest in self.used:
                return False
            self.used.add(digest)
            return True

    single_use = _SingleUse()
    monkeypatch.setattr(main, "_consent_receipt_consumer", lambda: single_use)
    issued_at = datetime.now(UTC) - timedelta(seconds=1)
    expires_at = issued_at + timedelta(minutes=15)
    receipt_id = issue_coordinate_consent_receipt(
        api_key=API_KEY,
        consumer_id="husshone-prod",
        project_id="hushone-app",
        route="/v4/net-worth/discover",
        purpose="NET_WORTH_LOOKUP",
        audit_actor="service-account:nws-client",
        issued_at=issued_at,
        expires_at=expires_at,
    )
    payload = _payload()
    payload["query"] = {
        "latitude": 47.6715,
        "longitude": -122.2133,
        "country_code": "US",
    }
    payload["coordinate_consent"] = {
        "receipt_id": receipt_id,
        "purpose_id": "NET_WORTH_LOOKUP",
        "audit_actor": "service-account:nws-client",
        "scope": "APPROXIMATE_LOCATION_QUERY",
        "issued_at": issued_at.isoformat(),
        "expires_at": expires_at.isoformat(),
    }
    client = TestClient(app)

    first = client.post(
        "/v4/net-worth/discover",
        headers={"X-NWS-API-Key": API_KEY},
        json=payload,
    )
    second = client.post(
        "/v4/net-worth/discover",
        headers={"X-NWS-API-Key": API_KEY},
        json=payload,
    )

    assert first.status_code == 200
    assert "47.6715" not in first.text
    assert "-122.2133" not in first.text
    assert second.status_code == 403
    assert second.json()["detail"]["code"] == "INVALID_COORDINATE_CONSENT"


def test_v4_bff_can_issue_a_location_free_consent_receipt(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _enable_v4(monkeypatch)
    response = TestClient(app).post(
        "/v4/location-consent/receipt",
        headers={"X-NWS-API-Key": API_KEY},
        json={
            "project_id": "hushone-app",
            "purpose_id": "NET_WORTH_LOOKUP",
            "audit_actor": "service-account:nws-client",
            "scope": "APPROXIMATE_LOCATION_QUERY",
            "consent_granted": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["receipt_id"].startswith("nwc1.")
    assert body["purpose_id"] == "NET_WORTH_LOOKUP"
    assert body["scope"] == "APPROXIMATE_LOCATION_QUERY"
    assert "latitude" not in response.text
    assert "longitude" not in response.text
    assert API_KEY not in response.text


def test_v4_replaces_unsafe_caller_request_id(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _enable_v4(monkeypatch)
    response = TestClient(app).post(
        "/v4/net-worth/discover",
        headers={
            "X-NWS-API-Key": API_KEY,
            "X-Request-ID": "bad request id with spaces",
        },
        json=_payload(),
    )

    assert response.status_code == 200
    assert response.headers["X-Request-ID"].startswith("req-")
    assert " " not in response.headers["X-Request-ID"]


def test_v4_never_echoes_or_logs_api_key_shaped_request_id(
    monkeypatch,
    caplog,
) -> None:  # type: ignore[no-untyped-def]
    _enable_v4(monkeypatch)
    caplog.set_level(logging.INFO, logger="nws_nearby_intelligence")
    secret_shaped_request_id = (
        "nws_live_"
        "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    )

    response = TestClient(app).post(
        "/v4/net-worth/discover",
        headers={
            "X-NWS-API-Key": API_KEY,
            "X-Request-ID": secret_shaped_request_id,
        },
        json=_payload(),
    )

    assert response.status_code == 200
    assert response.headers["X-Request-ID"].startswith("req-")
    assert secret_shaped_request_id not in caplog.text


def test_v4_unexpected_failure_is_audited_with_response_request_id(
    monkeypatch,
    caplog,
) -> None:  # type: ignore[no-untyped-def]
    _enable_v4(monkeypatch)
    caplog.set_level(logging.INFO, logger="nws_nearby_intelligence")

    def fail_discovery(*_: object, **__: object) -> object:
        raise RuntimeError("private upstream failure")

    monkeypatch.setattr(main, "_discover_net_worth", fail_discovery)
    response = TestClient(app, raise_server_exceptions=False).post(
        "/v4/net-worth/discover",
        headers={"X-NWS-API-Key": API_KEY},
        json=_payload(),
    )

    assert response.status_code == 500
    assert response.headers["X-Request-ID"].startswith("req-")
    audits = [
        json.loads(record.message.removeprefix("consumer_access_audit "))
        for record in caplog.records
        if "consumer_access_audit" in record.message
    ]
    assert len(audits) == 1
    assert audits[0]["request_id"] == response.headers["X-Request-ID"]
    assert audits[0]["decision"]["outcome"] == "ERROR"
    assert audits[0]["decision"]["status_code"] == 500
    assert "private upstream failure" not in caplog.text
