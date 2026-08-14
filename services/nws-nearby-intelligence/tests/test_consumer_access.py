from __future__ import annotations

import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import cast
from unittest.mock import patch

import pytest

from app.consumer_access import (
    AUDIT_SCHEMA_VERSION,
    REGISTRY_SCHEMA_VERSION,
    AccessPolicyError,
    AccessRequest,
    ApiKeyEnvironment,
    AuditOutcome,
    AuditRequestId,
    AuthenticatedConsumer,
    ConsentVerifierUnavailable,
    ConsumerAccessRegistry,
    ConsumerTier,
    CoordinateConsent,
    LocationMode,
    RateLimitResult,
    RegistryIntegrityError,
    RegistryValidationError,
    VerifiedCoordinateConsent,
    build_access_audit_event,
    build_denied_access_audit_event,
    derive_api_key_sha256,
    generate_api_key,
    generate_audit_request_id,
)

NOW = datetime(2026, 8, 14, 12, tzinfo=UTC)


def _test_api_key(label: bytes, *, environment: str) -> str:
    token = base64.urlsafe_b64encode(hashlib.sha256(label).digest()).decode().rstrip("=")
    return f"nws_{environment}_{token}"


PRIMARY_KEY = _test_api_key(b"one-production-test-key", environment="live")
SECONDARY_KEY = _test_api_key(b"research-uat-test-key", environment="test")
RECEIPT = "consent-receipt-0123456789abcdef"
REQUEST_ID = generate_audit_request_id()
ACTOR_REFERENCE = "actor_0123456789abcdef"


class RecordingRateLimiter:
    def __init__(self, result: RateLimitResult | None = None) -> None:
        self.result = result or RateLimitResult(
            allowed=True,
            remaining=29,
            reset_after_seconds=42,
        )
        self.calls: list[dict[str, object]] = []

    def consume(self, *, key: str, limit: int, window_seconds: int) -> RateLimitResult:
        self.calls.append({"key": key, "limit": limit, "window_seconds": window_seconds})
        return self.result


class RecordingConsentVerifier:
    def __init__(
        self,
        *,
        captured_at: datetime = NOW,
        bound_consumer_id: str | None = None,
        bound_project_id: str | None = None,
        bound_route: str | None = None,
        bound_purpose: str | None = None,
        bound_actor_reference: str | None = None,
        unavailable: bool = False,
    ) -> None:
        self.captured_at = captured_at
        self.bound_consumer_id = bound_consumer_id
        self.bound_project_id = bound_project_id
        self.bound_route = bound_route
        self.bound_purpose = bound_purpose
        self.bound_actor_reference = bound_actor_reference
        self.unavailable = unavailable
        self.calls: list[dict[str, object]] = []

    def verify_and_consume(
        self,
        *,
        receipt_id: str,
        consumer_id: str,
        project_id: str,
        route: str,
        purpose: str,
        actor_reference: str,
        scope: str,
        now: datetime,
        max_age_seconds: int,
    ) -> VerifiedCoordinateConsent | None:
        self.calls.append(
            {
                "receipt_id": receipt_id,
                "consumer_id": consumer_id,
                "project_id": project_id,
                "route": route,
                "purpose": purpose,
                "actor_reference": actor_reference,
                "scope": scope,
                "now": now,
                "max_age_seconds": max_age_seconds,
            }
        )
        if self.unavailable:
            raise ConsentVerifierUnavailable
        return VerifiedCoordinateConsent(
            receipt_sha256=hashlib.sha256(receipt_id.encode()).hexdigest(),
            captured_at=self.captured_at,
            consumer_id=self.bound_consumer_id or consumer_id,
            project_id=self.bound_project_id or project_id,
            route=self.bound_route or route,
            purpose=self.bound_purpose or purpose,
            actor_reference=self.bound_actor_reference or actor_reference,
            scope=scope,
            issuer="one-consent-v1",
        )


def _registry_document() -> dict[str, object]:
    return {
        "schema_version": REGISTRY_SCHEMA_VERSION,
        "registry_version": 7,
        "consumers": [
            {
                "consumer_id": "one-prod",
                "project_id": "hushone-app",
                "tier": "STANDARD",
                "api_key_sha256": derive_api_key_sha256(PRIMARY_KEY),
                "expires_at": "2027-08-14T12:00:00Z",
                "kill_switch": False,
                "grants": [
                    {
                        "route": "/v2/nearby-network/discover",
                        "purpose": "NEARBY_DISCOVERY",
                        "max_top_n": 100,
                        "max_radius_km": 150,
                        "requests_per_minute": 30,
                        "coordinate_consent_max_age_seconds": 900,
                    },
                    {
                        "route": "/v3/nearby-net-worth/discover",
                        "purpose": "NET_WORTH_LOOKUP",
                        "max_top_n": 50,
                        "max_radius_km": 100,
                        "requests_per_minute": 10,
                        "coordinate_consent_max_age_seconds": 300,
                    },
                ],
            },
            {
                "consumer_id": "research-uat",
                "project_id": "hushh-pda-uat",
                "tier": "SANDBOX",
                "api_key_sha256": derive_api_key_sha256(SECONDARY_KEY),
                "expires_at": "2026-12-31T23:59:59Z",
                "kill_switch": False,
                "grants": [
                    {
                        "route": "/v2/nearby-network/discover",
                        "purpose": "NEARBY_DISCOVERY",
                        "max_top_n": 10,
                        "max_radius_km": 25,
                        "requests_per_minute": 5,
                        "coordinate_consent_max_age_seconds": 300,
                    }
                ],
            },
        ],
    }


def _encode(document: dict[str, object]) -> bytes:
    return json.dumps(document, separators=(",", ":"), sort_keys=True).encode()


def _load(document: dict[str, object] | None = None) -> ConsumerAccessRegistry:
    payload = _encode(document or _registry_document())
    return ConsumerAccessRegistry.from_json_bytes(
        payload,
        expected_sha256=hashlib.sha256(payload).hexdigest(),
    )


def _postal_request(
    *,
    route: str = "/v2/nearby-network/discover",
    purpose: str = "NEARBY_DISCOVERY",
    top_n: int = 50,
    max_radius_km: float = 100,
) -> AccessRequest:
    return AccessRequest(
        route=route,
        purpose=purpose,
        top_n=top_n,
        max_radius_km=max_radius_km,
        location_mode=LocationMode.POSTAL_CODE,
        actor_reference=ACTOR_REFERENCE,
    )


def _coordinate_request(
    coordinate_consent: CoordinateConsent | None = None,
) -> AccessRequest:
    return AccessRequest(
        route="/v2/nearby-network/discover",
        purpose="NEARBY_DISCOVERY",
        top_n=50,
        max_radius_km=100,
        location_mode=LocationMode.COORDINATES,
        actor_reference=ACTOR_REFERENCE,
        coordinate_consent=coordinate_consent,
    )


def test_registry_is_exact_byte_pinned_and_never_exposes_key_digests_on_consumers() -> None:
    registry = _load()

    assert registry.registry_version == 7
    assert [consumer.consumer_id for consumer in registry.consumers] == [
        "one-prod",
        "research-uat",
    ]
    assert registry.consumers[0].project_id == "hushone-app"
    assert registry.consumers[0].tier is ConsumerTier.STANDARD
    assert not hasattr(registry.consumers[0], "api_key_sha256")
    assert PRIMARY_KEY not in repr(registry)
    assert derive_api_key_sha256(PRIMARY_KEY) not in repr(registry)

    payload = _encode(_registry_document())
    with pytest.raises(RegistryIntegrityError, match="pinned"):
        ConsumerAccessRegistry.from_json_bytes(payload, expected_sha256="0" * 64)


def test_api_key_generator_produces_canonical_tokens_even_when_body_contains_underscore() -> None:
    token = "X-zrZv_IbzjZUnhsbWlsecLbwjndTpG0ZynXOif7V-k"  # gitleaks:allow
    with patch("app.consumer_access.secrets.token_urlsafe", return_value=token):
        generated = generate_api_key(ApiKeyEnvironment.LIVE)

    assert generated == f"nws_live_{token}"
    assert len(derive_api_key_sha256(generated)) == 64


@pytest.mark.parametrize(
    "mutate",
    [
        lambda document: cast(
            dict[str, object], cast(list[object], document["consumers"])[0]
        ).update(  # noqa: E501
            {"api_key": PRIMARY_KEY}
        ),
        lambda document: cast(
            dict[str, object], cast(list[object], document["consumers"])[0]
        ).update(  # noqa: E501
            {"kill_switch": "false"}
        ),
        lambda document: cast(
            dict[str, object],
            cast(
                list[object],
                cast(dict[str, object], cast(list[object], document["consumers"])[0])["grants"],
            )[0],
        ).update({"max_top_n": 10.0}),
    ],
)
def test_registry_rejects_unknown_fields_and_non_strict_types(mutate) -> None:  # type: ignore[no-untyped-def]
    document = _registry_document()
    mutate(document)

    with pytest.raises(RegistryValidationError):
        _load(document)


def test_registry_rejects_duplicate_json_keys_and_reused_credentials() -> None:
    duplicate_key_payload = (
        b'{"schema_version":"nws-consumer-access-registry-v1",'
        b'"schema_version":"nws-consumer-access-registry-v1",'
        b'"registry_version":1,"consumers":[]}'
    )
    with pytest.raises(RegistryValidationError, match="duplicate JSON key"):
        ConsumerAccessRegistry.from_json_bytes(
            duplicate_key_payload,
            expected_sha256=hashlib.sha256(duplicate_key_payload).hexdigest(),
        )

    document = _registry_document()
    consumers = cast(list[dict[str, object]], document["consumers"])
    consumers[1]["api_key_sha256"] = consumers[0]["api_key_sha256"]
    with pytest.raises(RegistryValidationError, match="reused"):
        _load(document)

    oversized_integer_payload = (
        '{"schema_version":"nws-consumer-access-registry-v1",'
        f'"registry_version":{("9" * 5_000)},"consumers":[]}}'
    ).encode()
    with pytest.raises(RegistryValidationError, match="valid JSON"):
        ConsumerAccessRegistry.from_json_bytes(
            oversized_integer_payload,
            expected_sha256=hashlib.sha256(oversized_integer_payload).hexdigest(),
        )


def test_authentication_compares_every_digest_and_returns_no_key_material() -> None:
    registry = _load()

    with patch(
        "app.consumer_access.hmac.compare_digest", wraps=__import__("hmac").compare_digest
    ) as compare:  # noqa: E501
        principal = registry.authenticate(PRIMARY_KEY, now=NOW)

    # One canonical-token comparison plus one digest comparison per consumer.
    assert compare.call_count == len(registry.consumers) + 1
    assert principal.consumer_id == "one-prod"
    assert principal.project_id == "hushone-app"
    assert not hasattr(principal, "api_key_sha256")
    assert PRIMARY_KEY not in repr(principal)

    with patch(
        "app.consumer_access.hmac.compare_digest", wraps=__import__("hmac").compare_digest
    ) as invalid_compare:
        with pytest.raises(AccessPolicyError) as exc_info:
            registry.authenticate("invalid-key-format", now=NOW)
    assert invalid_compare.call_count == 2
    assert exc_info.value.code == "INVALID_CREDENTIALS"
    assert exc_info.value.http_status == 401
    assert "wrong" not in str(exc_info.value)


@pytest.mark.parametrize(
    ("kill_switch", "expires_at", "expected_code"),
    [
        (True, "2027-08-14T12:00:00Z", "CONSUMER_DISABLED"),
        (False, "2026-08-14T12:00:00Z", "CONSUMER_EXPIRED"),
    ],
)
def test_kill_switch_and_expiry_fail_closed(
    kill_switch: bool,
    expires_at: str,
    expected_code: str,
) -> None:
    document = _registry_document()
    consumer = cast(dict[str, object], cast(list[object], document["consumers"])[0])
    consumer["kill_switch"] = kill_switch
    consumer["expires_at"] = expires_at

    with pytest.raises(AccessPolicyError) as exc_info:
        _load(document).authenticate(PRIMARY_KEY, now=NOW)
    assert exc_info.value.code == expected_code


def test_forged_authentication_context_is_rejected() -> None:
    registry = _load()
    forged = AuthenticatedConsumer(
        consumer_id="one-prod",
        project_id="hushone-app",
        tier=ConsumerTier.STANDARD,
        expires_at=datetime(2027, 8, 14, 12, tzinfo=UTC),
        registry_sha256=registry.registry_sha256,
        registry_version=registry.registry_version,
        authenticated_at=NOW,
        _proof=b"\x00" * 32,
    )

    with pytest.raises(AccessPolicyError) as exc_info:
        registry.authorize(
            forged,
            _postal_request(),
            rate_limiter=RecordingRateLimiter(),
            now=NOW,
        )
    assert exc_info.value.code == "INVALID_AUTHENTICATION_CONTEXT"


@pytest.mark.parametrize(
    ("access_request", "expected_code"),
    [
        (
            _postal_request(purpose="NET_WORTH_LOOKUP"),
            "ROUTE_PURPOSE_NOT_ALLOWED",
        ),
        (_postal_request(top_n=101), "TOP_N_LIMIT_EXCEEDED"),
        (_postal_request(max_radius_km=151), "RADIUS_LIMIT_EXCEEDED"),
    ],
)
def test_route_purpose_and_query_limits_are_enforced(
    access_request: AccessRequest,
    expected_code: str,
) -> None:
    registry = _load()
    principal = registry.authenticate(PRIMARY_KEY, now=NOW)
    limiter = RecordingRateLimiter()

    with pytest.raises(AccessPolicyError) as exc_info:
        registry.authorize(principal, access_request, rate_limiter=limiter, now=NOW)

    assert exc_info.value.code == expected_code
    assert limiter.calls == []


def test_coordinate_access_requires_fresh_purpose_bound_consent() -> None:
    registry = _load()
    principal = registry.authenticate(PRIMARY_KEY, now=NOW)

    with pytest.raises(AccessPolicyError) as missing:
        registry.authorize(
            principal,
            _coordinate_request(),
            rate_limiter=RecordingRateLimiter(),
            now=NOW,
        )
    assert missing.value.code == "COORDINATE_CONSENT_REQUIRED"

    with pytest.raises(AccessPolicyError) as unavailable:
        registry.authorize(
            principal,
            _coordinate_request(CoordinateConsent(receipt_id=RECEIPT)),
            rate_limiter=RecordingRateLimiter(),
            now=NOW,
        )
    assert unavailable.value.code == "CONSENT_VERIFIER_UNAVAILABLE"

    with pytest.raises(AccessPolicyError) as stale:
        registry.authorize(
            principal,
            _coordinate_request(CoordinateConsent(receipt_id=RECEIPT)),
            rate_limiter=RecordingRateLimiter(),
            consent_verifier=RecordingConsentVerifier(captured_at=NOW - timedelta(seconds=901)),
            now=NOW,
        )
    assert stale.value.code == "COORDINATE_CONSENT_EXPIRED"

    with pytest.raises(AccessPolicyError) as binding:
        registry.authorize(
            principal,
            _coordinate_request(CoordinateConsent(receipt_id=RECEIPT)),
            rate_limiter=RecordingRateLimiter(),
            consent_verifier=RecordingConsentVerifier(bound_project_id="hushh-pda-uat"),
            now=NOW,
        )
    assert binding.value.code == "CONSENT_BINDING_MISMATCH"

    with pytest.raises(AccessPolicyError) as future:
        registry.authorize(
            principal,
            _coordinate_request(CoordinateConsent(receipt_id=RECEIPT)),
            rate_limiter=RecordingRateLimiter(),
            consent_verifier=RecordingConsentVerifier(captured_at=NOW + timedelta(seconds=61)),
            now=NOW,
        )
    assert future.value.code == "COORDINATE_CONSENT_EXPIRED"

    class BrokenVerifier:
        def verify_and_consume(self, **_: object) -> VerifiedCoordinateConsent | None:
            raise RuntimeError("private backend detail")

    with pytest.raises(AccessPolicyError) as broken:
        registry.authorize(
            principal,
            _coordinate_request(CoordinateConsent(receipt_id=RECEIPT)),
            rate_limiter=RecordingRateLimiter(),
            consent_verifier=BrokenVerifier(),
            now=NOW,
        )
    assert broken.value.code == "CONSENT_VERIFIER_UNAVAILABLE"
    assert broken.value.http_status == 503
    assert "private backend detail" not in str(broken.value)


def test_authorization_passes_exact_rpm_to_shared_limiter_and_enforces_denial() -> None:
    registry = _load()
    principal = registry.authenticate(PRIMARY_KEY, now=NOW)
    limiter = RecordingRateLimiter()

    access = registry.authorize(
        principal,
        _postal_request(),
        rate_limiter=limiter,
        now=NOW,
    )

    assert limiter.calls == [
        {
            "key": limiter.calls[0]["key"],
            "limit": 30,
            "window_seconds": 60,
        }
    ]
    assert str(limiter.calls[0]["key"]).startswith("nws-consumer-access:v1:")
    assert "one-prod" not in str(limiter.calls[0]["key"])
    assert access.requests_per_minute == 30
    assert access.rate_limit_remaining == 29

    denied_limiter = RecordingRateLimiter(
        RateLimitResult(allowed=False, remaining=0, reset_after_seconds=17)
    )
    with pytest.raises(AccessPolicyError) as denied:
        registry.authorize(
            principal,
            _postal_request(),
            rate_limiter=denied_limiter,
            now=NOW,
        )
    assert denied.value.code == "RATE_LIMITED"
    assert denied.value.http_status == 429
    assert denied.value.retry_after_seconds == 17

    class BrokenRateLimiter:
        def consume(self, *, key: str, limit: int, window_seconds: int) -> RateLimitResult:
            raise RuntimeError("backend unavailable")

    with pytest.raises(AccessPolicyError) as backend_unavailable:
        registry.authorize(
            principal,
            _postal_request(),
            rate_limiter=BrokenRateLimiter(),
            now=NOW,
        )
    assert backend_unavailable.value.code == "RATE_LIMIT_BACKEND_UNAVAILABLE"
    assert backend_unavailable.value.http_status == 503
    assert "backend unavailable" not in str(backend_unavailable.value)

    invalid_limiter = RecordingRateLimiter(
        RateLimitResult(allowed=True, remaining=31, reset_after_seconds=10)
    )
    with pytest.raises(RuntimeError, match="remaining"):
        registry.authorize(
            principal,
            _postal_request(),
            rate_limiter=invalid_limiter,
            now=NOW,
        )


def test_authorization_accepts_full_supported_consent_receipt_size() -> None:
    registry = _load()
    principal = registry.authenticate(PRIMARY_KEY, now=NOW)
    receipt = "nwc1." + ("a" * 360)

    access = registry.authorize(
        principal,
        _coordinate_request(CoordinateConsent(receipt_id=receipt)),
        rate_limiter=RecordingRateLimiter(),
        consent_verifier=RecordingConsentVerifier(),
        now=NOW,
    )

    assert access.consent_captured_at == NOW

def test_audit_event_is_allowlisted_and_never_contains_raw_location_key_or_receipt() -> None:
    registry = _load()
    principal = registry.authenticate(PRIMARY_KEY, now=NOW)
    access = registry.authorize(
        principal,
        AccessRequest(
            route="/v2/nearby-network/discover",
            purpose="NEARBY_DISCOVERY",
            top_n=25,
            max_radius_km=40,
            location_mode=LocationMode.COORDINATES,
            actor_reference=ACTOR_REFERENCE,
            coordinate_consent=CoordinateConsent(receipt_id=RECEIPT),
        ),
        rate_limiter=RecordingRateLimiter(),
        consent_verifier=RecordingConsentVerifier(captured_at=NOW - timedelta(seconds=30)),
        now=NOW,
    )

    event = build_access_audit_event(
        access,
        request_id=REQUEST_ID,
        outcome=AuditOutcome.SUCCESS,
        status_code=200,
        result_count=25,
        occurred_at=NOW,
        snapshot_id="nwsnw_0123456789abcdef01234567",
        snapshot_sha256="a" * 64,
        model_version="net-worth-v1.0.0",
    )
    serialized = json.dumps(event, sort_keys=True)

    assert event["schema_version"] == AUDIT_SCHEMA_VERSION
    assert cast(dict[str, object], event["coordinate_consent"]) == {
        "verified": True,
        "captured_at": "2026-08-14T11:59:30Z",
        "issuer": "one-consent-v1",
    }
    for forbidden in (
        PRIMARY_KEY,
        RECEIPT,
        "47.6715",
        "-122.2133",
        "98033",
        "latitude",
        "longitude",
        "postal_code",
        "client_ip",
        "person_name",
    ):
        assert forbidden not in serialized


def test_audit_outcomes_are_consistent_and_denials_are_representable() -> None:
    registry = _load()
    principal = registry.authenticate(PRIMARY_KEY, now=NOW)
    access = registry.authorize(
        principal,
        _postal_request(),
        rate_limiter=RecordingRateLimiter(),
        now=NOW,
    )

    with pytest.raises(ValueError, match="SUCCESS"):
        build_access_audit_event(
            access,
            request_id=REQUEST_ID,
            outcome=AuditOutcome.SUCCESS,
            status_code=200,
            result_count=0,
            occurred_at=NOW,
        )
    with pytest.raises(ValueError, match="server-generated"):
        build_access_audit_event(
            access,
            request_id=AuditRequestId(value="person@example.com", _proof=b"\x00" * 32),
            outcome=AuditOutcome.SUCCESS,
            status_code=200,
            result_count=1,
            occurred_at=NOW,
        )

    error = AccessPolicyError(
        code="RATE_LIMITED",
        message="The consumer request limit has been reached.",
        http_status=429,
        retry_after_seconds=17,
    )
    denial = build_denied_access_audit_event(
        registry=registry,
        request_id=REQUEST_ID,
        error=error,
        route="/v2/nearby-network/discover",
        occurred_at=NOW,
        principal=principal,
        purpose="NEARBY_DISCOVERY",
        location_mode=LocationMode.COORDINATES,
    )

    assert cast(dict[str, object], denial["decision"]) == {
        "outcome": "RATE_LIMITED",
        "status_code": 429,
        "denial_code": "RATE_LIMITED",
        "retry_after_seconds": 17,
    }
    serialized = json.dumps(denial, sort_keys=True)
    assert PRIMARY_KEY not in serialized
    assert RECEIPT not in serialized
    assert "latitude" not in serialized
    assert "longitude" not in serialized


def test_policy_errors_and_audit_metadata_reject_contradictory_or_private_values() -> None:
    with pytest.raises(ValueError, match="RATE_LIMITED"):
        AccessPolicyError(
            code="RATE_LIMITED",
            message="Unavailable.",
            http_status=500,
        )
    with pytest.raises(ValueError, match="RATE_LIMITED"):
        AccessPolicyError(
            code="OTHER_ERROR",
            message="Unavailable.",
            http_status=429,
            retry_after_seconds=17,
        )

    registry = _load()
    principal = registry.authenticate(PRIMARY_KEY, now=NOW)
    access = registry.authorize(
        principal,
        _postal_request(),
        rate_limiter=RecordingRateLimiter(),
        now=NOW,
    )
    with pytest.raises(ValueError, match="snapshot_id"):
        build_access_audit_event(
            access,
            request_id=REQUEST_ID,
            outcome=AuditOutcome.SUCCESS,
            status_code=200,
            result_count=1,
            occurred_at=NOW,
            snapshot_id="98033",
        )
    with pytest.raises(ValueError, match="model_version"):
        build_access_audit_event(
            access,
            request_id=REQUEST_ID,
            outcome=AuditOutcome.SUCCESS,
            status_code=200,
            result_count=1,
            occurred_at=NOW,
            model_version="person@example.com",
        )
    with pytest.raises(ValueError, match="route and purpose"):
        build_denied_access_audit_event(
            registry=registry,
            request_id=REQUEST_ID,
            error=AccessPolicyError(
                code="OTHER_ERROR",
                message="Denied.",
                http_status=403,
            ),
            route="/discover/98033",
            occurred_at=NOW,
        )
