from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Final, Protocol

from app.consumer_access import ConsentVerifierUnavailable, VerifiedCoordinateConsent
from app.snapshots.gcs_store import SnapshotGcsStore, SnapshotStoreError

_TOKEN_PREFIX: Final = "nwc1"
_SIGNING_CONTEXT: Final = b"nws-coordinate-consent-v1\x00"
_ISSUER: Final = "consumer-bff"
# The reviewed registry permits 64-character consumer and purpose identifiers.
# 512 bytes safely contains that full valid policy boundary while remaining a
# small request field.
_MAX_TOKEN_BYTES: Final = 512
_CONSENT_SCOPE: Final = "APPROXIMATE_LOCATION_QUERY"


def _utc(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("consent timestamps must be timezone-aware")
    return value.astimezone(UTC)


def _actor_reference(project_id: str, audit_actor: str) -> str:
    return hashlib.sha256(f"{project_id}\x00{audit_actor}".encode()).hexdigest()[:16]


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    if not value or any(
        character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        for character in value
    ):
        raise ValueError("invalid consent token encoding")
    padding = "=" * (-len(value) % 4)
    decoded = base64.urlsafe_b64decode(value + padding)
    if not hmac.compare_digest(_encode(decoded), value):
        raise ValueError("non-canonical consent token encoding")
    return decoded


def issue_coordinate_consent_receipt(
    *,
    api_key: str,
    consumer_id: str,
    project_id: str,
    route: str,
    purpose: str,
    audit_actor: str,
    issued_at: datetime,
    expires_at: datetime,
) -> str:
    """Create a short-lived, location-free receipt for a trusted consumer BFF.

    The caller invokes this only after the end user grants approximate-location
    access. The token contains no ZIP, coordinates, person data, or API key.
    """

    issued = _utc(issued_at)
    expires = _utc(expires_at)
    if expires <= issued:
        raise ValueError("consent expiry must be after issuance")
    if not isinstance(api_key, str) or len(api_key.encode("utf-8")) < 32:
        raise ValueError("a strong consumer API key is required")
    claims = [
        1,
        consumer_id,
        project_id,
        route,
        purpose,
        int(issued.timestamp()),
        int(expires.timestamp()),
        _actor_reference(project_id, audit_actor),
    ]
    payload = json.dumps(claims, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    encoded_payload = _encode(payload)
    signature = hmac.new(
        api_key.encode("utf-8"),
        _SIGNING_CONTEXT + encoded_payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    receipt = f"{_TOKEN_PREFIX}.{encoded_payload}.{_encode(signature)}"
    if len(receipt.encode("ascii")) > _MAX_TOKEN_BYTES:
        raise ValueError("consent receipt exceeds the supported size")
    return receipt


@dataclass(frozen=True, slots=True)
class SignedCoordinateConsentVerifier:
    """Verify a BFF receipt against the authenticated consumer request."""

    api_key: str = field(repr=False)
    expected_audit_actor: str = field(repr=False)
    expected_issued_at: datetime
    expected_expires_at: datetime
    receipt_consumer: ReceiptConsumer = field(repr=False)

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
        try:
            if (
                not isinstance(receipt_id, str)
                or len(receipt_id.encode("ascii")) > _MAX_TOKEN_BYTES
            ):
                return None
            prefix, encoded_payload, encoded_signature = receipt_id.split(".")
            if prefix != _TOKEN_PREFIX:
                return None
            signature = _decode(encoded_signature)
            expected_signature = hmac.new(
                self.api_key.encode("utf-8"),
                _SIGNING_CONTEXT + encoded_payload.encode("ascii"),
                hashlib.sha256,
            ).digest()
            if not hmac.compare_digest(signature, expected_signature):
                return None
            payload = json.loads(_decode(encoded_payload))
            if not isinstance(payload, list) or len(payload) != 8:
                return None
            (
                version,
                token_consumer,
                token_project,
                token_route,
                token_purpose,
                issued,
                expires,
                actor,
            ) = payload
            if version != 1 or type(issued) is not int or type(expires) is not int:
                return None
            expected_issued = _utc(self.expected_issued_at)
            expected_expires = _utc(self.expected_expires_at)
            checked_at = _utc(now)
            captured_at = datetime.fromtimestamp(issued, UTC)
            expires_at = datetime.fromtimestamp(expires, UTC)
            matches = all(
                (
                    hmac.compare_digest(str(token_consumer), consumer_id),
                    hmac.compare_digest(str(token_project), project_id),
                    hmac.compare_digest(str(token_route), route),
                    hmac.compare_digest(str(token_purpose), purpose),
                    hmac.compare_digest(
                        str(actor),
                        _actor_reference(project_id, self.expected_audit_actor),
                    ),
                    hmac.compare_digest(
                        actor_reference,
                        "actor_" + _actor_reference(project_id, self.expected_audit_actor),
                    ),
                    hmac.compare_digest(scope, _CONSENT_SCOPE),
                    int(expected_issued.timestamp()) == issued,
                    int(expected_expires.timestamp()) == expires,
                )
            )
            if not matches:
                return None
            if expires_at <= captured_at or checked_at >= expires_at:
                return None
            if (expires_at - captured_at).total_seconds() > max_age_seconds:
                return None
            receipt_sha256 = hashlib.sha256(receipt_id.encode("ascii")).hexdigest()
            if not self.receipt_consumer.consume(receipt_sha256, consumed_at=checked_at):
                return None
            return VerifiedCoordinateConsent(
                receipt_sha256=receipt_sha256,
                captured_at=captured_at,
                consumer_id=consumer_id,
                project_id=project_id,
                route=route,
                purpose=purpose,
                actor_reference=actor_reference,
                scope=scope,
                issuer=_ISSUER,
            )
        except (UnicodeEncodeError, ValueError, TypeError, json.JSONDecodeError):
            return None


class ReceiptConsumer(Protocol):
    """Atomically mark a consent receipt used across every service instance."""

    def consume(self, receipt_sha256: str, *, consumed_at: datetime) -> bool: ...


@dataclass(frozen=True, slots=True)
class GcsConsentReceiptConsumer:
    store: SnapshotGcsStore = field(repr=False)

    def consume(self, receipt_sha256: str, *, consumed_at: datetime) -> bool:
        if len(receipt_sha256) != 64 or any(
            character not in "0123456789abcdef" for character in receipt_sha256
        ):
            raise ConsentVerifierUnavailable("consent receipt digest was invalid")
        checked_at = _utc(consumed_at)
        # The object key is date-independent so one receipt cannot be accepted
        # twice across a UTC-day boundary while it is still valid.
        object_name = f"used/{receipt_sha256[:2]}/{receipt_sha256}.json"
        body = json.dumps(
            {
                "consumed_at": checked_at.isoformat().replace("+00:00", "Z"),
                "receipt_sha256": receipt_sha256,
                "schema_version": "nws-coordinate-consent-use-v1",
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
        try:
            self.store.write(object_name, body, if_generation_match=0)
        except SnapshotStoreError as exc:
            if exc.code == "GENERATION_PRECONDITION_FAILED":
                return False
            raise ConsentVerifierUnavailable("consent receipt store was unavailable") from exc
        return True
