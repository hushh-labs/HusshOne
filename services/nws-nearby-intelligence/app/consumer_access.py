from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import re
import secrets
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Final, Never, Protocol, cast

REGISTRY_SCHEMA_VERSION: Final = "nws-consumer-access-registry-v1"
AUDIT_SCHEMA_VERSION: Final = "nws-consumer-access-audit-v1"
RATE_LIMIT_WINDOW_SECONDS: Final = 60
COORDINATE_CONSENT_SCOPE: Final = "APPROXIMATE_LOCATION_QUERY"

_MAX_REGISTRY_BYTES: Final = 1_048_576
_MAX_CONSUMERS: Final = 1_000
_MAX_GRANTS_PER_CONSUMER: Final = 100
_MAX_FUTURE_CONSENT_SKEW_SECONDS: Final = 60

_LOWER_SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])?$")
_PROJECT_ID = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_POLICY_TOKEN = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
_UTC_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
_OPAQUE_RECEIPT = re.compile(r"^[A-Za-z0-9._~:-]{16,512}$")
_AUDIT_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$")
_SNAPSHOT_ID = re.compile(r"^nwsnw_[0-9a-f]{24}$")
_NET_WORTH_MODEL_VERSION = re.compile(r"^net-worth-v[0-9]+\.[0-9]+\.[0-9]+$")
_AUDIT_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
_ACTOR_REFERENCE = re.compile(r"^actor_[0-9a-f]{16,64}$")
_HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_API_KEY = re.compile(r"^nws_(?:live|test)_[A-Za-z0-9_-]{43}$")
_AUDIT_REQUEST_ID_SECRET = secrets.token_bytes(32)
_AUTHORIZED_REQUEST_SECRET = secrets.token_bytes(32)
_AUDIT_ROUTES: Final = frozenset(
    {
        "/v2/nearby-network/discover",
        "/v3/nearby-net-worth/discover",
        "/v4/location-consent/receipt",
        "/v4/net-worth/discover",
    }
)


class ConsumerTier(StrEnum):
    SANDBOX = "SANDBOX"
    STANDARD = "STANDARD"
    PRIVILEGED = "PRIVILEGED"


class ApiKeyEnvironment(StrEnum):
    LIVE = "live"
    TEST = "test"


class LocationMode(StrEnum):
    POSTAL_CODE = "POSTAL_CODE"
    COORDINATES = "COORDINATES"


class AuditOutcome(StrEnum):
    SUCCESS = "SUCCESS"
    EMPTY = "EMPTY"
    DENIED = "DENIED"
    RATE_LIMITED = "RATE_LIMITED"
    ERROR = "ERROR"


@dataclass(frozen=True, slots=True)
class AuditRequestId:
    value: str
    _proof: bytes = field(repr=False, compare=False)


class RegistryValidationError(ValueError):
    """The registry is malformed and must not be used."""


class RegistryIntegrityError(RegistryValidationError):
    """The exact registry bytes do not match the caller-pinned digest."""


class AccessPolicyError(RuntimeError):
    """A safe, structured denial that never includes credentials or request locations."""

    def __init__(
        self,
        *,
        code: str,
        message: str,
        http_status: int,
        retry_after_seconds: int | None = None,
    ) -> None:
        if not _POLICY_TOKEN.fullmatch(code):
            raise ValueError("access-policy error code must be a canonical token")
        if (
            not isinstance(message, str)
            or not 1 <= len(message) <= 256
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in message)
        ):
            raise ValueError("access-policy error message must be safe single-line text")
        if type(http_status) is not int or not 400 <= http_status <= 599:
            raise ValueError("access-policy HTTP status must be between 400 and 599")
        if retry_after_seconds is not None and (
            http_status != 429
            or type(retry_after_seconds) is not int
            or not 1 <= retry_after_seconds <= 3_600
        ):
            raise ValueError("retry_after_seconds is only valid for a 429 denial")
        if (code == "RATE_LIMITED") != (http_status == 429 and retry_after_seconds is not None):
            raise ValueError("RATE_LIMITED requires HTTP 429 and a positive Retry-After")
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.http_status = http_status
        self.retry_after_seconds = retry_after_seconds

    def http_detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.safe_message}


@dataclass(frozen=True, slots=True)
class ConsumerGrant:
    route: str
    purpose: str
    max_top_n: int
    max_radius_km: float
    requests_per_minute: int
    coordinate_consent_max_age_seconds: int


@dataclass(frozen=True, slots=True)
class ConsumerPolicy:
    consumer_id: str
    project_id: str
    tier: ConsumerTier
    expires_at: datetime
    kill_switch: bool
    grants: tuple[ConsumerGrant, ...]


@dataclass(frozen=True, slots=True)
class _ConsumerRecord:
    policy: ConsumerPolicy
    api_key_digest: bytes = field(repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class AuthenticatedConsumer:
    consumer_id: str
    project_id: str
    tier: ConsumerTier
    expires_at: datetime
    registry_sha256: str
    registry_version: int
    authenticated_at: datetime
    _proof: bytes = field(repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class CoordinateConsent:
    receipt_id: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class VerifiedCoordinateConsent:
    """Safe fields returned only after a trusted receipt signature/store lookup."""

    receipt_sha256: str
    captured_at: datetime
    consumer_id: str
    project_id: str
    route: str
    purpose: str
    actor_reference: str
    scope: str
    issuer: str


class ConsentVerifierUnavailable(RuntimeError):
    """A trusted consent verifier could not make a definitive decision."""


class CoordinateConsentVerifier(Protocol):
    """Validate and atomically consume a receipt using a trusted signature/store."""

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
    ) -> VerifiedCoordinateConsent | None: ...


@dataclass(frozen=True, slots=True)
class AccessRequest:
    route: str
    purpose: str
    top_n: int
    max_radius_km: float
    location_mode: LocationMode
    actor_reference: str
    coordinate_consent: CoordinateConsent | None = field(default=None, repr=False)


@dataclass(frozen=True, slots=True)
class RateLimitResult:
    allowed: bool
    remaining: int
    reset_after_seconds: int


class RateLimitEnforcer(Protocol):
    """Production implementations must atomically consume from a shared backend."""

    def consume(
        self,
        *,
        key: str,
        limit: int,
        window_seconds: int,
    ) -> RateLimitResult: ...


@dataclass(frozen=True, slots=True)
class AuthorizedRequest:
    consumer_id: str
    project_id: str
    tier: ConsumerTier
    route: str
    purpose: str
    top_n: int
    max_radius_km: float
    location_mode: LocationMode
    actor_reference: str
    requests_per_minute: int
    rate_limit_remaining: int
    rate_limit_reset_after_seconds: int
    registry_sha256: str
    registry_version: int
    authorized_at: datetime
    consent_captured_at: datetime | None
    consent_issuer: str | None
    _proof: bytes = field(repr=False, compare=False)


def derive_api_key_sha256(api_key: str) -> str:
    """Derive the only credential representation allowed in a registry."""

    encoded = _validated_api_key_bytes(api_key)
    return hashlib.sha256(encoded).hexdigest()


def generate_api_key(environment: ApiKeyEnvironment) -> str:
    """Generate a 256-bit key for one-time delivery into a managed secret store."""

    if not isinstance(environment, ApiKeyEnvironment):
        raise ValueError("environment must be an ApiKeyEnvironment")
    return f"nws_{environment.value}_{secrets.token_urlsafe(32)}"


def generate_audit_request_id() -> AuditRequestId:
    """Mint a server-owned ID; caller-provided request IDs cannot enter access audits."""

    value = f"req-{secrets.token_hex(16)}"
    proof = hmac.new(_AUDIT_REQUEST_ID_SECRET, value.encode(), hashlib.sha256).digest()
    return AuditRequestId(value=value, _proof=proof)


class ConsumerAccessRegistry:
    """Immutable, integrity-pinned multi-consumer API access policy."""

    __slots__ = ("_context_secret", "_records", "_registry_sha256", "_registry_version")

    def __init__(
        self,
        *,
        records: tuple[_ConsumerRecord, ...],
        registry_sha256: str,
        registry_version: int,
    ) -> None:
        self._records = records
        self._registry_sha256 = registry_sha256
        self._registry_version = registry_version
        self._context_secret = secrets.token_bytes(32)

    @property
    def registry_sha256(self) -> str:
        return self._registry_sha256

    @property
    def registry_version(self) -> int:
        return self._registry_version

    def __repr__(self) -> str:
        return (
            "ConsumerAccessRegistry("
            f"registry_sha256={self.registry_sha256!r}, "
            f"registry_version={self.registry_version!r}, "
            f"consumer_count={len(self._records)!r})"
        )

    @property
    def consumers(self) -> tuple[ConsumerPolicy, ...]:
        return tuple(record.policy for record in self._records)

    @classmethod
    def from_json_file(
        cls,
        path: str | Path,
        *,
        expected_sha256: str,
    ) -> ConsumerAccessRegistry:
        return cls.from_json_bytes(Path(path).read_bytes(), expected_sha256=expected_sha256)

    @classmethod
    def from_json_bytes(
        cls,
        payload: bytes,
        *,
        expected_sha256: str,
    ) -> ConsumerAccessRegistry:
        if not isinstance(payload, bytes):
            raise RegistryValidationError("registry payload must be bytes")
        if not payload or len(payload) > _MAX_REGISTRY_BYTES:
            raise RegistryValidationError("registry size is outside the supported range")
        _require_sha256(expected_sha256, path="expected_sha256")

        actual_sha256 = hashlib.sha256(payload).hexdigest()
        if not hmac.compare_digest(actual_sha256, expected_sha256):
            raise RegistryIntegrityError("registry SHA-256 does not match the pinned value")

        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RegistryValidationError("registry must be UTF-8 JSON") from exc
        if text.startswith("\ufeff"):
            raise RegistryValidationError("registry must not contain a UTF-8 BOM")

        try:
            decoded: object = json.loads(
                text,
                object_pairs_hook=_reject_duplicate_keys,
                parse_constant=_reject_non_finite_json,
            )
        except RegistryValidationError:
            raise
        except (ValueError, RecursionError) as exc:
            raise RegistryValidationError("registry is not valid JSON") from exc

        root = _expect_object(decoded, path="registry")
        _require_exact_keys(
            root,
            expected={"schema_version", "registry_version", "consumers"},
            path="registry",
        )
        schema_version = _expect_string(root["schema_version"], path="schema_version")
        if schema_version != REGISTRY_SCHEMA_VERSION:
            raise RegistryValidationError("unsupported registry schema_version")
        registry_version = _expect_int(
            root["registry_version"], path="registry_version", minimum=1, maximum=1_000_000
        )
        raw_consumers = _expect_list(root["consumers"], path="consumers")
        if not raw_consumers or len(raw_consumers) > _MAX_CONSUMERS:
            raise RegistryValidationError("consumers must contain between 1 and 1000 entries")

        records = tuple(
            _parse_consumer(value, index=index) for index, value in enumerate(raw_consumers)
        )
        _validate_registry_uniqueness(records)
        return cls(
            records=records,
            registry_sha256=actual_sha256,
            registry_version=registry_version,
        )

    def authenticate(
        self,
        api_key: str,
        *,
        now: datetime | None = None,
    ) -> AuthenticatedConsumer:
        checked_at = _utc_now(now)
        supplied_is_valid = _is_valid_api_key(api_key)
        encoded = api_key.encode("ascii") if supplied_is_valid else b""
        supplied_digest = hashlib.sha256(encoded).digest()

        matched: _ConsumerRecord | None = None
        for record in self._records:
            # Always scan the complete registry. Individual digest equality is constant-time.
            if hmac.compare_digest(supplied_digest, record.api_key_digest):
                matched = record

        if not supplied_is_valid or matched is None:
            raise AccessPolicyError(
                code="INVALID_CREDENTIALS",
                message="Valid service credentials are required.",
                http_status=401,
            )
        _require_active_consumer(matched.policy, now=checked_at)
        proof = self._authentication_context_proof(
            consumer_id=matched.policy.consumer_id,
            project_id=matched.policy.project_id,
            tier=matched.policy.tier,
            expires_at=matched.policy.expires_at,
            authenticated_at=checked_at,
        )
        return AuthenticatedConsumer(
            consumer_id=matched.policy.consumer_id,
            project_id=matched.policy.project_id,
            tier=matched.policy.tier,
            expires_at=matched.policy.expires_at,
            registry_sha256=self.registry_sha256,
            registry_version=self.registry_version,
            authenticated_at=checked_at,
            _proof=proof,
        )

    def authorize(
        self,
        principal: AuthenticatedConsumer,
        request: AccessRequest,
        *,
        rate_limiter: RateLimitEnforcer,
        consent_verifier: CoordinateConsentVerifier | None = None,
        now: datetime | None = None,
    ) -> AuthorizedRequest:
        checked_at = _utc_now(now)
        record = self._record_for_principal(principal)
        _require_active_consumer(record.policy, now=checked_at)
        _validate_access_request(request)

        grant = next(
            (
                candidate
                for candidate in record.policy.grants
                if candidate.route == request.route and candidate.purpose == request.purpose
            ),
            None,
        )
        if grant is None:
            raise AccessPolicyError(
                code="ROUTE_PURPOSE_NOT_ALLOWED",
                message="This consumer is not approved for the requested operation.",
                http_status=403,
            )
        if request.top_n > grant.max_top_n:
            raise AccessPolicyError(
                code="TOP_N_LIMIT_EXCEEDED",
                message="The requested result count exceeds this consumer's limit.",
                http_status=403,
            )
        if request.max_radius_km > grant.max_radius_km:
            raise AccessPolicyError(
                code="RADIUS_LIMIT_EXCEEDED",
                message="The requested radius exceeds this consumer's limit.",
                http_status=403,
            )

        limit_key = _rate_limit_key(
            consumer_id=record.policy.consumer_id,
            route=request.route,
            purpose=request.purpose,
        )
        try:
            rate_result = rate_limiter.consume(
                key=limit_key,
                limit=grant.requests_per_minute,
                window_seconds=RATE_LIMIT_WINDOW_SECONDS,
            )
        except Exception as exc:
            raise AccessPolicyError(
                code="RATE_LIMIT_BACKEND_UNAVAILABLE",
                message="Consumer quota verification is temporarily unavailable.",
                http_status=503,
            ) from exc
        _validate_rate_limit_result(rate_result, limit=grant.requests_per_minute)
        if not rate_result.allowed:
            raise AccessPolicyError(
                code="RATE_LIMITED",
                message="The consumer request limit has been reached.",
                http_status=429,
                retry_after_seconds=rate_result.reset_after_seconds,
            )

        consent_captured_at: datetime | None = None
        consent_issuer: str | None = None
        if request.location_mode is LocationMode.COORDINATES:
            consent = request.coordinate_consent
            if consent is None:
                raise AccessPolicyError(
                    code="COORDINATE_CONSENT_REQUIRED",
                    message="A valid location-consent receipt is required for coordinates.",
                    http_status=403,
                )
            (
                consent_captured_at,
                consent_issuer,
            ) = _validate_coordinate_consent(
                consent,
                verifier=consent_verifier,
                consumer_id=record.policy.consumer_id,
                project_id=record.policy.project_id,
                route=request.route,
                request_purpose=request.purpose,
                actor_reference=request.actor_reference,
                max_age_seconds=grant.coordinate_consent_max_age_seconds,
                now=checked_at,
            )
        elif request.coordinate_consent is not None:
            raise AccessPolicyError(
                code="COORDINATE_CONSENT_NOT_APPLICABLE",
                message="A location-consent receipt is only accepted with coordinates.",
                http_status=400,
            )

        authorization = AuthorizedRequest(
            consumer_id=record.policy.consumer_id,
            project_id=record.policy.project_id,
            tier=record.policy.tier,
            route=request.route,
            purpose=request.purpose,
            top_n=request.top_n,
            max_radius_km=float(request.max_radius_km),
            location_mode=request.location_mode,
            actor_reference=request.actor_reference,
            requests_per_minute=grant.requests_per_minute,
            rate_limit_remaining=rate_result.remaining,
            rate_limit_reset_after_seconds=rate_result.reset_after_seconds,
            registry_sha256=self.registry_sha256,
            registry_version=self.registry_version,
            authorized_at=checked_at,
            consent_captured_at=consent_captured_at,
            consent_issuer=consent_issuer,
            _proof=b"",
        )
        return replace(authorization, _proof=_authorized_request_proof(authorization))

    def _record_for_principal(self, principal: AuthenticatedConsumer) -> _ConsumerRecord:
        if not isinstance(principal, AuthenticatedConsumer):
            _raise_invalid_authentication_context()
        if (
            not isinstance(principal.consumer_id, str)
            or not _LOWER_SLUG.fullmatch(principal.consumer_id)
            or not isinstance(principal.project_id, str)
            or not _PROJECT_ID.fullmatch(principal.project_id)
            or not isinstance(principal.tier, ConsumerTier)
            or not isinstance(principal.registry_sha256, str)
            or not _HEX_SHA256.fullmatch(principal.registry_sha256)
            or type(principal.registry_version) is not int
            or type(principal._proof) is not bytes
            or len(principal._proof) != hashlib.sha256().digest_size
        ):
            _raise_invalid_authentication_context()
        try:
            expires_at = _utc_now(principal.expires_at)
            authenticated_at = _utc_now(principal.authenticated_at)
        except ValueError:
            _raise_invalid_authentication_context()
        expected_proof = self._authentication_context_proof(
            consumer_id=principal.consumer_id,
            project_id=principal.project_id,
            tier=principal.tier,
            expires_at=expires_at,
            authenticated_at=authenticated_at,
        )
        if not hmac.compare_digest(principal._proof, expected_proof):
            _raise_invalid_authentication_context()
        if not hmac.compare_digest(principal.registry_sha256, self.registry_sha256) or (
            principal.registry_version != self.registry_version
        ):
            raise AccessPolicyError(
                code="STALE_AUTHENTICATION_CONTEXT",
                message="Service credentials must be authenticated against the active policy.",
                http_status=401,
            )
        record = next(
            (
                candidate
                for candidate in self._records
                if candidate.policy.consumer_id == principal.consumer_id
            ),
            None,
        )
        if (
            record is None
            or record.policy.project_id != principal.project_id
            or record.policy.tier is not principal.tier
        ):
            _raise_invalid_authentication_context()
        return record

    def _authentication_context_proof(
        self,
        *,
        consumer_id: str,
        project_id: str,
        tier: ConsumerTier,
        expires_at: datetime,
        authenticated_at: datetime,
    ) -> bytes:
        payload = json.dumps(
            {
                "authenticated_at": _format_utc(authenticated_at),
                "consumer_id": consumer_id,
                "expires_at": _format_utc(expires_at),
                "project_id": project_id,
                "registry_sha256": self.registry_sha256,
                "registry_version": self.registry_version,
                "tier": tier.value,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        return hmac.new(self._context_secret, payload, hashlib.sha256).digest()


def _authorized_request_proof(access: AuthorizedRequest) -> bytes:
    payload = json.dumps(
        {
            "actor_reference": access.actor_reference,
            "authorized_at": _format_utc(access.authorized_at),
            "consent_captured_at": (
                _format_utc(access.consent_captured_at)
                if access.consent_captured_at is not None
                else None
            ),
            "consent_issuer": access.consent_issuer,
            "consumer_id": access.consumer_id,
            "location_mode": access.location_mode.value,
            "max_radius_km": access.max_radius_km,
            "project_id": access.project_id,
            "purpose": access.purpose,
            "rate_limit_remaining": access.rate_limit_remaining,
            "rate_limit_reset_after_seconds": access.rate_limit_reset_after_seconds,
            "registry_sha256": access.registry_sha256,
            "registry_version": access.registry_version,
            "requests_per_minute": access.requests_per_minute,
            "route": access.route,
            "tier": access.tier.value,
            "top_n": access.top_n,
        },
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hmac.new(_AUTHORIZED_REQUEST_SECRET, payload, hashlib.sha256).digest()


def _validate_authorized_request_proof(access: AuthorizedRequest) -> None:
    try:
        expected = _authorized_request_proof(access)
    except (AttributeError, TypeError, ValueError, OverflowError) as exc:
        raise ValueError("access must be minted by ConsumerAccessRegistry.authorize") from exc
    if (
        type(access._proof) is not bytes
        or len(access._proof) != hashlib.sha256().digest_size
        or not hmac.compare_digest(access._proof, expected)
    ):
        raise ValueError("access must be minted by ConsumerAccessRegistry.authorize")


def build_access_audit_event(
    access: AuthorizedRequest,
    *,
    request_id: AuditRequestId,
    outcome: AuditOutcome,
    status_code: int,
    result_count: int | None,
    occurred_at: datetime | None = None,
    snapshot_id: str | None = None,
    snapshot_sha256: str | None = None,
    model_version: str | None = None,
) -> dict[str, object]:
    """Build an allowlisted event with no key, IP, person, postal code, or coordinates."""

    if not isinstance(access, AuthorizedRequest):
        raise ValueError("access must be an AuthorizedRequest")
    _validate_authorized_request_proof(access)
    audit_request_id = _validated_audit_request_id(request_id)
    if not isinstance(outcome, AuditOutcome):
        raise ValueError("outcome must be an AuditOutcome")
    if type(status_code) is not int or not 100 <= status_code <= 599:
        raise ValueError("status_code must be an integer between 100 and 599")
    if result_count is not None and (
        type(result_count) is not int or not 0 <= result_count <= 1_000_000
    ):
        raise ValueError("result_count must be null or an integer between 0 and 1000000")
    if snapshot_id is not None and not _SNAPSHOT_ID.fullmatch(snapshot_id):
        raise ValueError("snapshot_id must be a server-owned net-worth snapshot ID")
    if snapshot_sha256 is not None:
        _require_sha256(snapshot_sha256, path="snapshot_sha256")
    if model_version is not None and not _NET_WORTH_MODEL_VERSION.fullmatch(model_version):
        raise ValueError("model_version must be a server-owned net-worth model version")
    occurred = _utc_now(occurred_at)
    if occurred < access.authorized_at:
        raise ValueError("occurred_at cannot be earlier than authorized_at")
    if outcome is AuditOutcome.SUCCESS and not (
        200 <= status_code <= 299 and result_count is not None and result_count > 0
    ):
        raise ValueError("SUCCESS requires a 2xx status and a positive result_count")
    if outcome is AuditOutcome.EMPTY and not (200 <= status_code <= 299 and result_count == 0):
        raise ValueError("EMPTY requires a 2xx status and result_count=0")
    if outcome is AuditOutcome.ERROR and not (status_code >= 400 and result_count is None):
        raise ValueError("ERROR requires a non-2xx status and no result_count")
    if outcome in {AuditOutcome.DENIED, AuditOutcome.RATE_LIMITED}:
        raise ValueError("denials must use build_denied_access_audit_event")

    event: dict[str, object] = {
        "schema_version": AUDIT_SCHEMA_VERSION,
        "event_type": "NWS_CONSUMER_ACCESS",
        "occurred_at": _format_utc(occurred),
        "request_id": audit_request_id,
        "consumer": {
            "consumer_id": access.consumer_id,
            "project_id": access.project_id,
            "tier": access.tier.value,
            "actor_reference": access.actor_reference,
        },
        "operation": {
            "route": access.route,
            "purpose": access.purpose,
            "location_mode": access.location_mode.value,
            "top_n": access.top_n,
            "max_radius_km": access.max_radius_km,
        },
        "decision": {
            "outcome": outcome.value,
            "status_code": status_code,
            "result_count": result_count,
        },
        "rate_limit": {
            "requests_per_minute": access.requests_per_minute,
            "remaining": access.rate_limit_remaining,
            "reset_after_seconds": access.rate_limit_reset_after_seconds,
        },
        "policy": {
            "registry_sha256": access.registry_sha256,
            "registry_version": access.registry_version,
        },
        "data_version": {
            "snapshot_id": snapshot_id,
            "snapshot_sha256": snapshot_sha256,
            "model_version": model_version,
        },
    }
    if access.location_mode is LocationMode.COORDINATES:
        if access.consent_captured_at is None or access.consent_issuer is None:
            raise ValueError("coordinate access is missing validated consent evidence")
        event["coordinate_consent"] = {
            "verified": True,
            "captured_at": _format_utc(access.consent_captured_at),
            "issuer": access.consent_issuer,
        }
    return event


def build_denied_access_audit_event(
    *,
    registry: ConsumerAccessRegistry,
    request_id: AuditRequestId,
    error: AccessPolicyError,
    route: str,
    occurred_at: datetime | None = None,
    principal: AuthenticatedConsumer | None = None,
    purpose: str | None = None,
    location_mode: LocationMode | None = None,
) -> dict[str, object]:
    """Build a minimal denial event without logging credentials or request location data."""

    audit_request_id = _validated_audit_request_id(request_id)
    if not isinstance(registry, ConsumerAccessRegistry):
        raise ValueError("registry must be a ConsumerAccessRegistry")
    if not isinstance(error, AccessPolicyError):
        raise ValueError("error must be an AccessPolicyError")
    try:
        _require_route(route, path="route")
        if route not in _AUDIT_ROUTES:
            raise RegistryValidationError("route is not an audited product route")
        if purpose is not None:
            _require_policy_token(purpose, path="purpose")
    except RegistryValidationError as exc:
        raise ValueError("route and purpose must be safe policy values") from exc
    if location_mode is not None and not isinstance(location_mode, LocationMode):
        raise ValueError("location_mode must be a LocationMode")
    if principal is not None and not isinstance(principal, AuthenticatedConsumer):
        raise ValueError("principal must be an AuthenticatedConsumer")
    if principal is not None:
        try:
            registry._record_for_principal(principal)
        except AccessPolicyError as exc:
            raise ValueError("principal was not minted by the active registry") from exc

    outcome = (
        AuditOutcome.RATE_LIMITED
        if error.code == "RATE_LIMITED"
        else AuditOutcome.DENIED
        if 400 <= error.http_status <= 499
        else AuditOutcome.ERROR
    )
    event: dict[str, object] = {
        "schema_version": AUDIT_SCHEMA_VERSION,
        "event_type": "NWS_CONSUMER_ACCESS_DENIED",
        "occurred_at": _format_utc(_utc_now(occurred_at)),
        "request_id": audit_request_id,
        "operation": {
            "route": route,
            "purpose": purpose,
            "location_mode": location_mode.value if location_mode is not None else None,
        },
        "decision": {
            "outcome": outcome.value,
            "status_code": error.http_status,
            "denial_code": error.code,
            "retry_after_seconds": error.retry_after_seconds,
        },
        "policy": {
            "registry_sha256": registry.registry_sha256,
            "registry_version": registry.registry_version,
        },
    }
    if principal is not None:
        event["consumer"] = {
            "consumer_id": principal.consumer_id,
            "project_id": principal.project_id,
            "tier": principal.tier.value,
        }
    return event


def _parse_consumer(value: object, *, index: int) -> _ConsumerRecord:
    path = f"consumers[{index}]"
    item = _expect_object(value, path=path)
    _require_exact_keys(
        item,
        expected={
            "consumer_id",
            "project_id",
            "tier",
            "api_key_sha256",
            "expires_at",
            "kill_switch",
            "grants",
        },
        path=path,
    )
    consumer_id = _expect_string(item["consumer_id"], path=f"{path}.consumer_id")
    if not _LOWER_SLUG.fullmatch(consumer_id):
        raise RegistryValidationError(f"{path}.consumer_id is not a canonical lowercase slug")
    project_id = _expect_string(item["project_id"], path=f"{path}.project_id")
    if not _PROJECT_ID.fullmatch(project_id):
        raise RegistryValidationError(f"{path}.project_id is not a valid Google project ID")
    tier_value = _expect_string(item["tier"], path=f"{path}.tier")
    try:
        tier = ConsumerTier(tier_value)
    except ValueError as exc:
        raise RegistryValidationError(f"{path}.tier is not supported") from exc
    digest = _expect_string(item["api_key_sha256"], path=f"{path}.api_key_sha256")
    _require_sha256(digest, path=f"{path}.api_key_sha256")
    expires_at = _parse_utc_timestamp(
        _expect_string(item["expires_at"], path=f"{path}.expires_at"),
        path=f"{path}.expires_at",
    )
    kill_switch = _expect_bool(item["kill_switch"], path=f"{path}.kill_switch")
    raw_grants = _expect_list(item["grants"], path=f"{path}.grants")
    if not raw_grants or len(raw_grants) > _MAX_GRANTS_PER_CONSUMER:
        raise RegistryValidationError(f"{path}.grants must contain between 1 and 100 entries")
    grants = tuple(
        _parse_grant(grant, path=f"{path}.grants[{grant_index}]")
        for grant_index, grant in enumerate(raw_grants)
    )
    if len({(grant.route, grant.purpose) for grant in grants}) != len(grants):
        raise RegistryValidationError(f"{path}.grants contains a duplicate route-purpose grant")
    return _ConsumerRecord(
        policy=ConsumerPolicy(
            consumer_id=consumer_id,
            project_id=project_id,
            tier=tier,
            expires_at=expires_at,
            kill_switch=kill_switch,
            grants=grants,
        ),
        api_key_digest=bytes.fromhex(digest),
    )


def _parse_grant(value: object, *, path: str) -> ConsumerGrant:
    item = _expect_object(value, path=path)
    _require_exact_keys(
        item,
        expected={
            "route",
            "purpose",
            "max_top_n",
            "max_radius_km",
            "requests_per_minute",
            "coordinate_consent_max_age_seconds",
        },
        path=path,
    )
    route = _expect_string(item["route"], path=f"{path}.route")
    _require_route(route, path=f"{path}.route")
    purpose = _expect_string(item["purpose"], path=f"{path}.purpose")
    _require_policy_token(purpose, path=f"{path}.purpose")
    return ConsumerGrant(
        route=route,
        purpose=purpose,
        max_top_n=_expect_int(item["max_top_n"], path=f"{path}.max_top_n", minimum=1, maximum=400),
        max_radius_km=_expect_number(
            item["max_radius_km"],
            path=f"{path}.max_radius_km",
            minimum=0.1,
            maximum=500.0,
        ),
        requests_per_minute=_expect_int(
            item["requests_per_minute"],
            path=f"{path}.requests_per_minute",
            minimum=1,
            maximum=10_000,
        ),
        coordinate_consent_max_age_seconds=_expect_int(
            item["coordinate_consent_max_age_seconds"],
            path=f"{path}.coordinate_consent_max_age_seconds",
            minimum=60,
            maximum=86_400,
        ),
    )


def _validate_registry_uniqueness(records: tuple[_ConsumerRecord, ...]) -> None:
    consumer_ids = [record.policy.consumer_id for record in records]
    if len(set(consumer_ids)) != len(consumer_ids):
        raise RegistryValidationError("registry contains a duplicate consumer_id")
    digests = [record.api_key_digest for record in records]
    if len(set(digests)) != len(digests):
        raise RegistryValidationError("registry contains a reused api_key_sha256")


def _validate_access_request(request: AccessRequest) -> None:
    if not isinstance(request, AccessRequest):
        raise AccessPolicyError(
            code="INVALID_ACCESS_REQUEST",
            message="The access-policy request is invalid.",
            http_status=400,
        )
    try:
        _require_route(request.route, path="route")
        _require_policy_token(request.purpose, path="purpose")
        if not isinstance(request.actor_reference, str) or not _ACTOR_REFERENCE.fullmatch(
            request.actor_reference
        ):
            raise RegistryValidationError("actor_reference must be a privacy-safe opaque token")
    except RegistryValidationError as exc:
        raise AccessPolicyError(
            code="INVALID_ACCESS_REQUEST",
            message="The access-policy request is invalid.",
            http_status=400,
        ) from exc
    if type(request.top_n) is not int or not 1 <= request.top_n <= 400:
        raise AccessPolicyError(
            code="INVALID_ACCESS_REQUEST",
            message="The access-policy request is invalid.",
            http_status=400,
        )
    try:
        radius = float(request.max_radius_km)
    except (TypeError, ValueError, OverflowError):
        radius = math.inf
    if (
        type(request.max_radius_km) not in {int, float}
        or not math.isfinite(radius)
        or not 0 < radius <= 500
    ):
        raise AccessPolicyError(
            code="INVALID_ACCESS_REQUEST",
            message="The access-policy request is invalid.",
            http_status=400,
        )
    if not isinstance(request.location_mode, LocationMode):
        raise AccessPolicyError(
            code="INVALID_ACCESS_REQUEST",
            message="The access-policy request is invalid.",
            http_status=400,
        )


def _validate_coordinate_consent(
    consent: CoordinateConsent,
    *,
    verifier: CoordinateConsentVerifier | None,
    consumer_id: str,
    project_id: str,
    route: str,
    request_purpose: str,
    actor_reference: str,
    max_age_seconds: int,
    now: datetime,
) -> tuple[datetime, str]:
    if not isinstance(consent, CoordinateConsent):
        raise AccessPolicyError(
            code="INVALID_COORDINATE_CONSENT",
            message="The location-consent receipt is invalid.",
            http_status=403,
        )
    if not isinstance(consent.receipt_id, str) or not _OPAQUE_RECEIPT.fullmatch(consent.receipt_id):
        raise AccessPolicyError(
            code="INVALID_COORDINATE_CONSENT",
            message="The location-consent receipt is invalid.",
            http_status=403,
        )
    if verifier is None:
        raise AccessPolicyError(
            code="CONSENT_VERIFIER_UNAVAILABLE",
            message="Coordinate access is unavailable because consent cannot be verified.",
            http_status=503,
        )
    try:
        verified = verifier.verify_and_consume(
            receipt_id=consent.receipt_id,
            consumer_id=consumer_id,
            project_id=project_id,
            route=route,
            purpose=request_purpose,
            actor_reference=actor_reference,
            scope=COORDINATE_CONSENT_SCOPE,
            now=now,
            max_age_seconds=max_age_seconds,
        )
    except ConsentVerifierUnavailable as exc:
        raise AccessPolicyError(
            code="CONSENT_VERIFIER_UNAVAILABLE",
            message="Coordinate access is unavailable because consent cannot be verified.",
            http_status=503,
        ) from exc
    except Exception as exc:
        raise AccessPolicyError(
            code="CONSENT_VERIFIER_UNAVAILABLE",
            message="Coordinate access is unavailable because consent cannot be verified.",
            http_status=503,
        ) from exc
    if not isinstance(verified, VerifiedCoordinateConsent):
        raise AccessPolicyError(
            code="INVALID_COORDINATE_CONSENT",
            message="The location-consent receipt is invalid.",
            http_status=403,
        )
    try:
        _require_sha256(verified.receipt_sha256, path="verified_consent.receipt_sha256")
        _require_route(verified.route, path="verified_consent.route")
        _require_policy_token(verified.purpose, path="verified_consent.purpose")
        _require_policy_token(verified.scope, path="verified_consent.scope")
        if not isinstance(verified.consumer_id, str) or not _LOWER_SLUG.fullmatch(
            verified.consumer_id
        ):
            raise RegistryValidationError("verified_consent.consumer_id is not canonical")
        if not isinstance(verified.project_id, str) or not _PROJECT_ID.fullmatch(
            verified.project_id
        ):
            raise RegistryValidationError("verified_consent.project_id is not canonical")
        if not isinstance(verified.issuer, str) or not _LOWER_SLUG.fullmatch(verified.issuer):
            raise RegistryValidationError("verified_consent.issuer is not canonical")
        if not isinstance(verified.actor_reference, str) or not _ACTOR_REFERENCE.fullmatch(
            verified.actor_reference
        ):
            raise RegistryValidationError("verified_consent.actor_reference is not canonical")
        captured_at = _utc_now(verified.captured_at)
    except (RegistryValidationError, ValueError, TypeError) as exc:
        raise AccessPolicyError(
            code="INVALID_COORDINATE_CONSENT",
            message="The location-consent receipt is invalid.",
            http_status=403,
        ) from exc

    expected_receipt_sha256 = hashlib.sha256(consent.receipt_id.encode("ascii")).hexdigest()
    bindings_match = all(
        (
            hmac.compare_digest(verified.receipt_sha256, expected_receipt_sha256),
            hmac.compare_digest(verified.consumer_id, consumer_id),
            hmac.compare_digest(verified.project_id, project_id),
            hmac.compare_digest(verified.route, route),
            hmac.compare_digest(verified.purpose, request_purpose),
            hmac.compare_digest(verified.actor_reference, actor_reference),
            hmac.compare_digest(verified.scope, COORDINATE_CONSENT_SCOPE),
        )
    )
    if not bindings_match:
        raise AccessPolicyError(
            code="CONSENT_BINDING_MISMATCH",
            message="The location-consent receipt does not cover this consumer operation.",
            http_status=403,
        )
    age_seconds = (now - captured_at).total_seconds()
    if age_seconds < -_MAX_FUTURE_CONSENT_SKEW_SECONDS or age_seconds > max_age_seconds:
        raise AccessPolicyError(
            code="COORDINATE_CONSENT_EXPIRED",
            message="A fresh location-consent receipt is required.",
            http_status=403,
        )
    return captured_at, verified.issuer


def _require_active_consumer(policy: ConsumerPolicy, *, now: datetime) -> None:
    if policy.kill_switch:
        raise AccessPolicyError(
            code="CONSUMER_DISABLED",
            message="This consumer's access is disabled.",
            http_status=403,
        )
    if now >= policy.expires_at:
        raise AccessPolicyError(
            code="CONSUMER_EXPIRED",
            message="This consumer's access has expired.",
            http_status=403,
        )


def _raise_invalid_authentication_context() -> Never:
    raise AccessPolicyError(
        code="INVALID_AUTHENTICATION_CONTEXT",
        message="A valid authentication context is required.",
        http_status=401,
    )


def _validate_rate_limit_result(result: RateLimitResult, *, limit: int) -> None:
    if not isinstance(result, RateLimitResult):
        raise RuntimeError("rate limiter returned an invalid result")
    if type(result.allowed) is not bool:
        raise RuntimeError("rate limiter returned an invalid allowed flag")
    if type(result.remaining) is not int or not 0 <= result.remaining <= limit:
        raise RuntimeError("rate limiter returned an invalid remaining count")
    if type(result.reset_after_seconds) is not int or not 1 <= result.reset_after_seconds <= 3_600:
        raise RuntimeError("rate limiter returned an invalid reset interval")


def _rate_limit_key(*, consumer_id: str, route: str, purpose: str) -> str:
    dimensions = f"{consumer_id}\x00{route}\x00{purpose}".encode()
    return f"nws-consumer-access:v1:{hashlib.sha256(dimensions).hexdigest()}"


def _validated_api_key_bytes(api_key: str) -> bytes:
    if not _is_valid_api_key(api_key):
        raise ValueError("API key must be a generated 32-byte nws_live_ or nws_test_ token")
    return api_key.encode("ascii")


def _is_valid_api_key(api_key: object) -> bool:
    if not isinstance(api_key, str) or not _API_KEY.fullmatch(api_key):
        return False
    token = api_key[9:]
    try:
        decoded = base64.urlsafe_b64decode(f"{token}=")
    except (ValueError, UnicodeEncodeError):
        return False
    canonical = base64.urlsafe_b64encode(decoded).decode().rstrip("=")
    return len(decoded) == 32 and len(set(decoded)) >= 16 and hmac.compare_digest(canonical, token)


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise RegistryValidationError(f"registry contains duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_non_finite_json(value: str) -> Never:
    raise RegistryValidationError(f"registry contains unsupported JSON constant: {value}")


def _expect_object(value: object, *, path: str) -> dict[str, object]:
    if type(value) is not dict:
        raise RegistryValidationError(f"{path} must be an object")
    return cast(dict[str, object], value)


def _expect_list(value: object, *, path: str) -> list[object]:
    if type(value) is not list:
        raise RegistryValidationError(f"{path} must be an array")
    return cast(list[object], value)


def _expect_string(value: object, *, path: str) -> str:
    if type(value) is not str:
        raise RegistryValidationError(f"{path} must be a string")
    return cast(str, value)


def _expect_bool(value: object, *, path: str) -> bool:
    if type(value) is not bool:
        raise RegistryValidationError(f"{path} must be a boolean")
    return cast(bool, value)


def _expect_int(value: object, *, path: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= cast(int, value) <= maximum:
        raise RegistryValidationError(f"{path} must be an integer between {minimum} and {maximum}")
    return cast(int, value)


def _expect_number(value: object, *, path: str, minimum: float, maximum: float) -> float:
    if type(value) not in {int, float}:
        raise RegistryValidationError(f"{path} must be a finite number")
    try:
        number = float(cast(int | float, value))
    except OverflowError as exc:
        raise RegistryValidationError(f"{path} must be a finite number") from exc
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise RegistryValidationError(f"{path} must be between {minimum} and {maximum}")
    return number


def _require_exact_keys(
    value: dict[str, object],
    *,
    expected: set[str],
    path: str,
) -> None:
    keys = set(value)
    missing = sorted(expected - keys)
    unknown = sorted(keys - expected)
    if missing:
        raise RegistryValidationError(f"{path} is missing fields: {', '.join(missing)}")
    if unknown:
        raise RegistryValidationError(f"{path} has unknown fields: {', '.join(unknown)}")


def _require_route(value: str, *, path: str) -> None:
    if (
        not isinstance(value, str)
        or not 1 < len(value) <= 160
        or not value.startswith("/")
        or value.endswith("/")
        or "//" in value
        or any(not 0x21 <= ord(character) <= 0x7E for character in value)
        or any(character.isspace() for character in value)
        or any(character in value for character in {"?", "#", "\\"})
    ):
        raise RegistryValidationError(f"{path} must be a canonical absolute route path")


def _require_policy_token(value: str, *, path: str) -> None:
    if not isinstance(value, str) or not _POLICY_TOKEN.fullmatch(value):
        raise RegistryValidationError(f"{path} must be a canonical policy token")


def _require_sha256(value: str, *, path: str) -> None:
    if not isinstance(value, str) or not _HEX_SHA256.fullmatch(value):
        raise RegistryValidationError(f"{path} must be a lowercase SHA-256 hex digest")


def _require_audit_token(value: str, *, path: str) -> None:
    if not isinstance(value, str) or not _AUDIT_TOKEN.fullmatch(value):
        raise ValueError(f"{path} must be a safe audit token")


def _validated_audit_request_id(request_id: AuditRequestId) -> str:
    if not isinstance(request_id, AuditRequestId):
        raise ValueError("request_id must be a server-generated opaque identifier")
    if (
        not isinstance(request_id.value, str)
        or not _AUDIT_REQUEST_ID.fullmatch(request_id.value)
        or type(request_id._proof) is not bytes
    ):
        raise ValueError("request_id must be a server-generated opaque identifier")
    expected = hmac.new(
        _AUDIT_REQUEST_ID_SECRET,
        request_id.value.encode(),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(request_id._proof, expected):
        raise ValueError("request_id must be a server-generated opaque identifier")
    return request_id.value


def _parse_utc_timestamp(value: str, *, path: str) -> datetime:
    if not _UTC_TIMESTAMP.fullmatch(value):
        raise RegistryValidationError(f"{path} must be a canonical RFC 3339 UTC timestamp")
    try:
        parsed = datetime.fromisoformat(f"{value[:-1]}+00:00")
    except ValueError as exc:
        raise RegistryValidationError(f"{path} is not a valid timestamp") from exc
    return parsed.astimezone(UTC)


def _utc_now(value: datetime | None) -> datetime:
    result = datetime.now(UTC) if value is None else value
    if not isinstance(result, datetime) or result.tzinfo is None:
        raise ValueError("datetime values must be timezone-aware")
    if result.utcoffset() is None:
        raise ValueError("datetime values must have a valid UTC offset")
    return result.astimezone(UTC)


def _format_utc(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
