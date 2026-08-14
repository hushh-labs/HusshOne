from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.coordinate_consent import (
    GcsConsentReceiptConsumer,
    SignedCoordinateConsentVerifier,
    issue_coordinate_consent_receipt,
)
from app.snapshots.gcs_store import GcsObject, SnapshotStoreError

API_KEY = "nws_test_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"  # gitleaks:allow
NOW = datetime(2026, 8, 14, 12, tzinfo=UTC)


class _SingleUseConsumer:
    def __init__(self) -> None:
        self.used: set[str] = set()

    def consume(self, receipt_sha256: str, *, consumed_at: datetime) -> bool:
        assert consumed_at.tzinfo is not None
        if receipt_sha256 in self.used:
            return False
        self.used.add(receipt_sha256)
        return True


def _receipt(*, audit_actor: str = "service-account@nws") -> str:
    return issue_coordinate_consent_receipt(
        api_key=API_KEY,
        consumer_id="husshone-prod",
        project_id="hushone-app",
        route="/v4/net-worth/discover",
        purpose="NET_WORTH_LOOKUP",
        audit_actor=audit_actor,
        issued_at=NOW,
        expires_at=NOW + timedelta(minutes=15),
    )


def _verifier(
    *,
    audit_actor: str = "service-account@nws",
    consumer: _SingleUseConsumer | None = None,
) -> SignedCoordinateConsentVerifier:
    return SignedCoordinateConsentVerifier(
        api_key=API_KEY,
        expected_audit_actor=audit_actor,
        expected_issued_at=NOW,
        expected_expires_at=NOW + timedelta(minutes=15),
        receipt_consumer=consumer or _SingleUseConsumer(),
    )


def test_signed_receipt_is_location_free_and_bound_to_request() -> None:
    receipt = _receipt()

    assert "98033" not in receipt
    assert "47.67" not in receipt
    assert API_KEY not in receipt
    verifier = _verifier()
    verified = verifier.verify_and_consume(
        receipt_id=receipt,
        consumer_id="husshone-prod",
        project_id="hushone-app",
        route="/v4/net-worth/discover",
        purpose="NET_WORTH_LOOKUP",
        actor_reference="actor_c40c488ab56f2b55",
        scope="APPROXIMATE_LOCATION_QUERY",
        now=NOW + timedelta(minutes=1),
        max_age_seconds=900,
    )

    assert verified is not None
    assert verified.consumer_id == "husshone-prod"
    assert verified.project_id == "hushone-app"
    assert verified.issuer == "consumer-bff"
    assert len(verified.receipt_sha256) == 64
    assert (
        verifier.verify_and_consume(
            receipt_id=receipt,
            consumer_id="husshone-prod",
            project_id="hushone-app",
            route="/v4/net-worth/discover",
            purpose="NET_WORTH_LOOKUP",
            actor_reference="actor_c40c488ab56f2b55",
            scope="APPROXIMATE_LOCATION_QUERY",
            now=NOW + timedelta(minutes=1),
            max_age_seconds=900,
        )
        is None
    )


def test_receipt_supports_maximum_reviewed_policy_identifiers() -> None:
    receipt = issue_coordinate_consent_receipt(
        api_key=API_KEY,
        consumer_id="a" + ("b" * 63),
        project_id="a" + ("b" * 28) + "1",
        route="/v4/net-worth/discover",
        purpose="P" * 64,
        audit_actor="A" * 128,
        issued_at=NOW,
        expires_at=NOW + timedelta(minutes=15),
    )

    assert len(receipt.encode("ascii")) <= 512


def test_receipt_fails_closed_on_tamper_replay_or_expiry() -> None:
    receipt = _receipt()
    verifier = _verifier()
    common = {
        "receipt_id": receipt,
        "consumer_id": "husshone-prod",
        "project_id": "hushone-app",
        "route": "/v4/net-worth/discover",
        "purpose": "NET_WORTH_LOOKUP",
        "actor_reference": "actor_c40c488ab56f2b55",
        "scope": "APPROXIMATE_LOCATION_QUERY",
        "now": NOW + timedelta(minutes=1),
        "max_age_seconds": 900,
    }

    assert verifier.verify_and_consume(**{**common, "receipt_id": receipt[:-1] + "A"}) is None
    assert verifier.verify_and_consume(**{**common, "project_id": "another-project"}) is None
    assert verifier.verify_and_consume(**{**common, "purpose": "ANOTHER_PURPOSE"}) is None
    assert _verifier(audit_actor="other-actor").verify_and_consume(**common) is None
    assert verifier.verify_and_consume(**{**common, "now": NOW + timedelta(minutes=16)}) is None
    assert verifier.verify_and_consume(**{**common, "max_age_seconds": 60}) is None


def test_gcs_receipt_consumer_uses_an_atomic_create() -> None:
    class _Store:
        def __init__(self) -> None:
            self.calls: list[tuple[str, bytes, int]] = []
            self.replay = False

        def write(
            self,
            name: str,
            body: bytes,
            *,
            if_generation_match: int,
        ) -> GcsObject:
            self.calls.append((name, body, if_generation_match))
            if self.replay:
                raise SnapshotStoreError(
                    "already used",
                    code="GENERATION_PRECONDITION_FAILED",
                )
            return GcsObject(name=name, generation=1, body=body)

    store = _Store()
    consumer = GcsConsentReceiptConsumer(store=store)  # type: ignore[arg-type]
    digest = "a" * 64

    assert consumer.consume(digest, consumed_at=NOW) is True
    assert store.calls[0][0] == f"used/aa/{digest}.json"
    assert store.calls[0][2] == 0
    store.replay = True
    assert consumer.consume(digest, consumed_at=NOW) is False


def test_gcs_receipt_replay_key_does_not_change_at_midnight() -> None:
    class _Store:
        def __init__(self) -> None:
            self.names: set[str] = set()

        def write(
            self,
            name: str,
            body: bytes,
            *,
            if_generation_match: int,
        ) -> GcsObject:
            assert body
            assert if_generation_match == 0
            if name in self.names:
                raise SnapshotStoreError(
                    "already used",
                    code="GENERATION_PRECONDITION_FAILED",
                )
            self.names.add(name)
            return GcsObject(name=name, generation=1, body=body)

    store = _Store()
    consumer = GcsConsentReceiptConsumer(store=store)  # type: ignore[arg-type]
    digest = "b" * 64

    assert consumer.consume(
        digest,
        consumed_at=datetime(2026, 8, 14, 23, 59, 59, tzinfo=UTC),
    ) is True
    assert consumer.consume(
        digest,
        consumed_at=datetime(2026, 8, 15, 0, 0, 1, tzinfo=UTC),
    ) is False
    assert store.names == {f"used/bb/{digest}.json"}
