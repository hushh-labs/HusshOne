from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.source_plane import (
    CMS_OPEN_PAYMENTS_PARSER_CONTRACT_VERSION,
    CMS_OPEN_PAYMENTS_SOURCE_ID,
    CMSOpenPaymentsOwnershipProjector,
    CMSOwnershipProjectionError,
    ImmutableSourceArtifact,
    ObservedBusinessInterestClaim,
    SourceArtifactManifest,
    SourcePlaneContractError,
)

_HEADERS = (
    "physician_profile_id",
    "physician_npi",
    "physician_first_name",
    "physician_last_name",
    "recipient_primary_business_street_address_line1",
    "recipient_city",
    "recipient_state",
    "recipient_zip_code",
    "recipient_phone_number",
    "recipient_email_address",
    "total_amount_invested_usdollars",
    "value_of_interest",
    "terms_of_interest",
    "submitting_applicable_manufacturer_or_applicable_gpo_name",
    "dispute_status_for_publication",
    "interest_held_by_physician_or_an_immediate_family_member",
)


def _row(**overrides: str) -> dict[str, str]:
    value = {
        "physician_profile_id": "752056",
        "physician_npi": "1649393182",
        "physician_first_name": "PERSON-NAME-CANARY",
        "physician_last_name": "PRIVATE-NAME-CANARY",
        "recipient_primary_business_street_address_line1": "89 LEUNING STREET",
        "recipient_city": "CITY-CANARY",
        "recipient_state": "NJ",
        "recipient_zip_code": "07606",
        "recipient_phone_number": "201-555-0112",
        "recipient_email_address": "private@example.test",
        "total_amount_invested_usdollars": "1246788.00",
        "value_of_interest": "2493577.00",
        "terms_of_interest": "TERMS-CANARY at 12 Oak Ave",
        "submitting_applicable_manufacturer_or_applicable_gpo_name": (
            "ESSENTIAL DENTAL SYSTEMS INCORPORATED"
        ),
        "dispute_status_for_publication": "No",
        "interest_held_by_physician_or_an_immediate_family_member": (
            "Physician Covered Recipient"
        ),
    }
    value.update(overrides)
    return value


def _csv(*rows: dict[str, str], headers: tuple[str, ...] = _HEADERS) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=headers, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8")


def _artifact(content: bytes) -> ImmutableSourceArtifact:
    return ImmutableSourceArtifact.create(
        content=content,
        source_id=CMS_OPEN_PAYMENTS_SOURCE_ID,
        source_release="cms-open-payments-py2025",
        source_uri="https://openpaymentsdata.cms.gov/datasets/ownership/2025",
        retrieved_at=datetime(2026, 8, 14, tzinfo=UTC),
        media_type="text/csv; charset=utf-8",
        collector_version="cms-public-bulk-v1.0.0",
        parser_contract_version=CMS_OPEN_PAYMENTS_PARSER_CONTRACT_VERSION,
    )


def test_artifact_manifest_is_versioned_content_addressed_and_verified() -> None:
    artifact = _artifact(_csv(_row()))

    assert artifact.manifest.schema_version == "nws-source-artifact-manifest-v1"
    assert artifact.manifest.artifact_id == (
        f"artifact_{artifact.manifest.content_sha256[:32]}"
    )
    assert len(artifact.manifest.manifest_sha256) == 64
    assert artifact.manifest.media_type == "text/csv"

    with pytest.raises(SourcePlaneContractError, match="immutable manifest"):
        ImmutableSourceArtifact(manifest=artifact.manifest, content=b"tampered")
    with pytest.raises(ValidationError, match="frozen"):
        setattr(artifact.manifest, "source_release", "mutated")


def test_projector_emits_only_an_observed_business_interest_claim() -> None:
    batch = CMSOpenPaymentsOwnershipProjector().project(
        _artifact(_csv(_row())),
        program_year=2025,
    )

    assert batch.rows_seen == batch.claims_emitted == 1
    assert batch.family_rows_excluded == batch.invalid_rows_rejected == 0
    claim = batch.claims[0]
    assert claim.schema_version == "nws-financial-claim-v1"
    assert claim.claim_type == "observed_business_interest"
    assert claim.subject_external_id == "npi/1649393182"
    assert claim.value_of_interest_usd == Decimal("2493577.00")
    assert claim.amount_invested_usd == Decimal("1246788.00")
    assert claim.asset_coverage == "PARTIAL"
    assert claim.liability_coverage == "UNKNOWN"
    assert claim.nws_eligible is False
    assert not hasattr(claim, "net_worth")
    assert not hasattr(claim, "nws")


def test_immediate_family_rows_are_excluded_even_when_they_have_large_values() -> None:
    family = _row(
        physician_npi="1999999999",
        value_of_interest="999999999999.00",
        interest_held_by_physician_or_an_immediate_family_member="Immediate Family Member",
    )
    batch = CMSOpenPaymentsOwnershipProjector().project(
        _artifact(_csv(_row(), family)),
        program_year=2025,
    )

    assert batch.rows_seen == 2
    assert batch.claims_emitted == 1
    assert batch.family_rows_excluded == 1
    assert all(claim.subject_external_id != "npi/1999999999" for claim in batch.claims)


def test_output_never_contains_person_name_address_contact_or_free_text() -> None:
    batch = CMSOpenPaymentsOwnershipProjector().project(
        _artifact(_csv(_row())),
        program_year=2025,
    )
    serialized = batch.model_dump_json()

    for forbidden_value in (
        "PERSON-NAME-CANARY",
        "PRIVATE-NAME-CANARY",
        "89 LEUNING STREET",
        "CITY-CANARY",
        "07606",
        "201-555-0112",
        "private@example.test",
        "TERMS-CANARY",
        "12 Oak Ave",
    ):
        assert forbidden_value not in serialized

    forbidden_keys = {
        "name",
        "address",
        "street_address",
        "city",
        "state",
        "zip",
        "postal_code",
        "phone",
        "email",
        "terms_of_interest",
        "raw_row",
        "net_worth",
        "nws",
    }
    payload = json.loads(serialized)

    def keys(value: object) -> set[str]:
        if isinstance(value, dict):
            return set(value) | {key for nested in value.values() for key in keys(nested)}
        if isinstance(value, list):
            return {key for nested in value for key in keys(nested)}
        return set()

    assert keys(payload).isdisjoint(forbidden_keys)


def test_claim_contract_forbids_appended_private_or_net_worth_fields() -> None:
    claim = CMSOpenPaymentsOwnershipProjector().project(
        _artifact(_csv(_row())),
        program_year=2025,
    ).claims[0]
    payload = claim.model_dump(mode="python")

    for forbidden_key in ("street_address", "email", "net_worth_usd", "nws"):
        mutated = {**payload, forbidden_key: "should-not-survive"}
        with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
            ObservedBusinessInterestClaim.model_validate(mutated)


def test_missing_npi_or_money_is_rejected_without_name_fallback_or_zero_fill() -> None:
    no_npi = _row(physician_npi="", value_of_interest="50.00")
    no_money = _row(
        physician_npi="1111111111",
        value_of_interest="",
        total_amount_invested_usdollars="",
    )
    one_amount = _row(
        physician_npi="1222222222",
        value_of_interest="",
        total_amount_invested_usdollars="25.50",
    )
    batch = CMSOpenPaymentsOwnershipProjector().project(
        _artifact(_csv(no_npi, no_money, one_amount)),
        program_year=2025,
    )

    assert batch.rows_seen == 3
    assert batch.invalid_rows_rejected == 2
    assert batch.claims_emitted == 1
    assert batch.claims[0].value_of_interest_usd is None
    assert batch.claims[0].amount_invested_usd == Decimal("25.50")


def test_projection_is_deterministic_and_deduplicates_identical_reduced_claims() -> None:
    artifact = _artifact(_csv(_row(), _row()))
    projector = CMSOpenPaymentsOwnershipProjector()

    first = projector.project(artifact, program_year=2025)
    second = projector.project(artifact, program_year=2025)

    assert first == second
    assert first.claims_emitted == 1
    assert first.duplicate_claims_dropped == 1
    assert first.claims[0].claim_id == second.claims[0].claim_id


def test_schema_drift_or_wrong_source_contract_fails_closed() -> None:
    missing_holder = tuple(header for header in _HEADERS if header != _HOLDER_HEADER)
    with pytest.raises(CMSOwnershipProjectionError, match="missing required columns"):
        CMSOpenPaymentsOwnershipProjector().project(
            _artifact(_csv(_row(), headers=missing_holder)),
            program_year=2025,
        )

    content = _csv(_row())
    wrong_manifest = SourceArtifactManifest.for_content(
        content=content,
        source_id="different_source",
        source_release="2025",
        source_uri="https://example.gov/source.csv",
        retrieved_at=datetime(2026, 8, 14, tzinfo=UTC),
        media_type="text/csv",
        collector_version="collector-v1",
        parser_contract_version=CMS_OPEN_PAYMENTS_PARSER_CONTRACT_VERSION,
    )
    with pytest.raises(CMSOwnershipProjectionError, match="not CMS Open Payments"):
        CMSOpenPaymentsOwnershipProjector().project(
            ImmutableSourceArtifact(manifest=wrong_manifest, content=content),
            program_year=2025,
        )


def test_unapproved_or_parameterized_source_uri_fails_closed() -> None:
    content = _csv(_row())
    manifest = SourceArtifactManifest.for_content(
        content=content,
        source_id=CMS_OPEN_PAYMENTS_SOURCE_ID,
        source_release="cms-open-payments-py2025",
        source_uri="https://example.gov/source.csv?email=private@example.test",
        retrieved_at=datetime(2026, 8, 14, tzinfo=UTC),
        media_type="text/csv",
        collector_version="collector-v1",
        parser_contract_version=CMS_OPEN_PAYMENTS_PARSER_CONTRACT_VERSION,
    )

    with pytest.raises(CMSOwnershipProjectionError, match="approved public CMS origin"):
        CMSOpenPaymentsOwnershipProjector().project(
            ImmutableSourceArtifact(manifest=manifest, content=content),
            program_year=2025,
        )


_HOLDER_HEADER = "interest_held_by_physician_or_an_immediate_family_member"
