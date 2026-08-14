"""Privacy-reducing CMS Open Payments ownership CSV projector."""

from __future__ import annotations

import csv
import io
import re
import urllib.parse
from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import Field, model_validator

from app.source_plane.contracts import (
    ClaimProvenance,
    ImmutableSourceArtifact,
    ObservedBusinessInterestClaim,
    SourcePlaneContractError,
    _StrictFrozenModel,
    canonical_json_bytes,
    sha256_hex,
)

CMS_OPEN_PAYMENTS_SOURCE_ID = "cms_open_payments_ownership"
CMS_OPEN_PAYMENTS_PARSER_CONTRACT_VERSION = "cms-open-payments-ownership-csv-v1"
CMS_OPEN_PAYMENTS_PROJECTOR_VERSION: Literal[
    "cms-open-payments-ownership-projector-v1.0.0"
] = "cms-open-payments-ownership-projector-v1.0.0"
CMS_OPEN_PAYMENTS_PROJECTION_SCHEMA_VERSION: Literal[
    "nws-cms-open-payments-projection-v1"
] = "nws-cms-open-payments-projection-v1"

_MAX_CSV_BYTES = 64 * 1024 * 1024
_MAX_CELL_CHARACTERS = 32_768
_NPI = re.compile(r"^[0-9]{10}$")
_CURRENCY_CLEANUP = re.compile(r"[$,\s]")
_CENT = Decimal("0.01")
_MAX_USD = Decimal("1000000000000000.00")

_HOLDER = "interest_held_by_physician_or_an_immediate_family_member"
_NPI_COLUMN = "physician_npi"
_VALUE = "value_of_interest"
_INVESTED = "total_amount_invested_usdollars"
_REPORTING_ENTITY = "submitting_applicable_manufacturer_or_applicable_gpo_name"
_DISPUTED = "dispute_status_for_publication"
_REQUIRED_COLUMNS = frozenset(
    {_HOLDER, _NPI_COLUMN, _VALUE, _INVESTED, _REPORTING_ENTITY, _DISPUTED}
)
_ACCEPTED_MEDIA_TYPES = frozenset(
    {"text/csv", "application/csv", "application/vnd.ms-excel"}
)
_APPROVED_SOURCE_HOSTS = frozenset(
    {"openpaymentsdata.cms.gov", "download.cms.gov", "www.cms.gov"}
)


class CMSOwnershipProjectionError(SourcePlaneContractError):
    """The CMS artifact could not safely produce reduced ownership claims."""


class CMSOwnershipProjectionBatch(_StrictFrozenModel):
    """Auditable counts plus the privacy-reduced claims emitted from one artifact."""

    schema_version: Literal["nws-cms-open-payments-projection-v1"] = (
        CMS_OPEN_PAYMENTS_PROJECTION_SCHEMA_VERSION
    )
    projector_version: Literal["cms-open-payments-ownership-projector-v1.0.0"] = (
        CMS_OPEN_PAYMENTS_PROJECTOR_VERSION
    )
    source_artifact_id: str = Field(pattern=r"^artifact_[0-9a-f]{32}$")
    source_artifact_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    program_year: int = Field(ge=2013, le=2100)
    rows_seen: int = Field(ge=0, le=10_000_000)
    claims_emitted: int = Field(ge=0, le=10_000_000)
    family_rows_excluded: int = Field(ge=0, le=10_000_000)
    non_physician_rows_excluded: int = Field(ge=0, le=10_000_000)
    invalid_rows_rejected: int = Field(ge=0, le=10_000_000)
    duplicate_claims_dropped: int = Field(ge=0, le=10_000_000)
    claims: tuple[ObservedBusinessInterestClaim, ...]

    @model_validator(mode="after")
    def validate_counts(self) -> CMSOwnershipProjectionBatch:
        if self.claims_emitted != len(self.claims):
            raise ValueError("claims_emitted must match claims")
        accounted = (
            self.claims_emitted
            + self.family_rows_excluded
            + self.non_physician_rows_excluded
            + self.invalid_rows_rejected
            + self.duplicate_claims_dropped
        )
        if accounted != self.rows_seen:
            raise ValueError("projection counts must account for every source row")
        if self.source_artifact_id != f"artifact_{self.source_artifact_sha256[:32]}":
            raise ValueError("projection artifact identity is inconsistent")
        return self


def _normalize_header(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", value.lstrip("\ufeff").strip().casefold())
    return normalized.strip("_")


def _compact(value: object) -> str:
    return " ".join(str(value or "").split())


def _parse_usd(value: object) -> Decimal | None:
    raw = _CURRENCY_CLEANUP.sub("", str(value or ""))
    if not raw:
        return None
    try:
        parsed = Decimal(raw)
    except InvalidOperation as exc:
        raise ValueError("reported dollar amount is invalid") from exc
    if not parsed.is_finite() or parsed < 0 or parsed > _MAX_USD:
        raise ValueError("reported dollar amount is outside the allowed range")
    quantized = parsed.quantize(_CENT)
    if quantized != parsed:
        raise ValueError("reported dollar amount exceeds cent precision")
    return quantized


def _parse_disputed(value: object) -> bool:
    normalized = _compact(value).casefold()
    if normalized == "yes":
        return True
    if normalized == "no":
        return False
    raise ValueError("dispute status must be Yes or No")


def _row_fingerprint(
    *,
    subject_external_id: str,
    program_year: int,
    reporting_entity: str,
    value_of_interest_usd: Decimal | None,
    amount_invested_usd: Decimal | None,
    disputed: bool,
) -> str:
    # Only fields allowed in the reduced claim contribute to this fingerprint.  Raw
    # names, addresses, contacts, specialties, and free text never enter it.
    payload: dict[str, object] = {
        "subject_external_id": subject_external_id,
        "program_year": program_year,
        "reporting_entity": reporting_entity,
        "value_of_interest_usd": (
            format(value_of_interest_usd, "f") if value_of_interest_usd is not None else None
        ),
        "amount_invested_usd": (
            format(amount_invested_usd, "f") if amount_invested_usd is not None else None
        ),
        "disputed": disputed,
    }
    return "row_" + sha256_hex(canonical_json_bytes(payload))[:32]


class CMSOpenPaymentsOwnershipProjector:
    """Project official ownership CSV bytes into asset-observation claims.

    The projector is intentionally offline and whitelist-based.  It never emits the
    physician's name, address, ZIP, phone, email, specialty, or free-text terms.  A row
    without a stable NPI is rejected rather than falling back to name matching.
    """

    source_id = CMS_OPEN_PAYMENTS_SOURCE_ID
    parser_contract_version = CMS_OPEN_PAYMENTS_PARSER_CONTRACT_VERSION
    projector_version = CMS_OPEN_PAYMENTS_PROJECTOR_VERSION

    def project(
        self,
        artifact: ImmutableSourceArtifact,
        *,
        program_year: int,
    ) -> CMSOwnershipProjectionBatch:
        manifest = artifact.manifest
        if manifest.source_id != self.source_id:
            raise CMSOwnershipProjectionError("artifact source is not CMS Open Payments ownership")
        if manifest.parser_contract_version != self.parser_contract_version:
            raise CMSOwnershipProjectionError("artifact parser contract is not approved")
        source_uri = urllib.parse.urlsplit(manifest.source_uri)
        if (
            (source_uri.hostname or "").casefold() not in _APPROVED_SOURCE_HOSTS
            or source_uri.username is not None
            or source_uri.password is not None
            or source_uri.query
            or source_uri.fragment
        ):
            raise CMSOwnershipProjectionError("artifact URI is not an approved public CMS origin")
        if manifest.media_type not in _ACCEPTED_MEDIA_TYPES:
            raise CMSOwnershipProjectionError("artifact media type is not an approved CSV type")
        if manifest.content_length > _MAX_CSV_BYTES:
            raise CMSOwnershipProjectionError("CMS CSV exceeds the approved parser size")
        if not 2013 <= program_year <= 2100:
            raise CMSOwnershipProjectionError("program_year is outside the supported range")

        try:
            text = artifact.content.decode("utf-8-sig", errors="strict")
        except UnicodeDecodeError as exc:
            raise CMSOwnershipProjectionError("CMS CSV is not valid UTF-8") from exc

        reader = csv.DictReader(io.StringIO(text, newline=""))
        if reader.fieldnames is None:
            raise CMSOwnershipProjectionError("CMS CSV has no header")
        normalized_headers = [_normalize_header(item) for item in reader.fieldnames]
        if len(normalized_headers) != len(set(normalized_headers)):
            raise CMSOwnershipProjectionError("CMS CSV contains duplicate normalized columns")
        missing = sorted(_REQUIRED_COLUMNS - set(normalized_headers))
        if missing:
            raise CMSOwnershipProjectionError(
                "CMS CSV schema is missing required columns: " + ", ".join(missing)
            )
        header_map = dict(zip(reader.fieldnames, normalized_headers, strict=True))

        rows_seen = 0
        family_rows_excluded = 0
        non_physician_rows_excluded = 0
        invalid_rows_rejected = 0
        duplicate_claims_dropped = 0
        claims_by_id: dict[str, ObservedBusinessInterestClaim] = {}

        for raw_row in reader:
            rows_seen += 1
            if raw_row.get(None):
                invalid_rows_rejected += 1
                continue
            row = {
                header_map[key]: value
                for key, value in raw_row.items()
                if key is not None and value is not None
            }
            if any(len(str(value)) > _MAX_CELL_CHARACTERS for value in row.values()):
                invalid_rows_rejected += 1
                continue

            holder = _compact(row.get(_HOLDER)).casefold()
            if "immediate family member" in holder:
                family_rows_excluded += 1
                continue
            if holder != "physician covered recipient":
                non_physician_rows_excluded += 1
                continue

            try:
                npi = _compact(row.get(_NPI_COLUMN))
                if _NPI.fullmatch(npi) is None:
                    raise ValueError("a valid NPI is required")
                subject_external_id = f"npi/{npi}"
                value_of_interest_usd = _parse_usd(row.get(_VALUE))
                amount_invested_usd = _parse_usd(row.get(_INVESTED))
                if value_of_interest_usd is None and amount_invested_usd is None:
                    raise ValueError("ownership row has no reported dollar amount")
                reporting_entity = _compact(row.get(_REPORTING_ENTITY))
                if not reporting_entity:
                    raise ValueError("reporting entity is required")
                disputed = _parse_disputed(row.get(_DISPUTED))
                row_fingerprint = _row_fingerprint(
                    subject_external_id=subject_external_id,
                    program_year=program_year,
                    reporting_entity=reporting_entity,
                    value_of_interest_usd=value_of_interest_usd,
                    amount_invested_usd=amount_invested_usd,
                    disputed=disputed,
                )
                provenance = ClaimProvenance(
                    source_id=manifest.source_id,
                    source_release=manifest.source_release,
                    source_uri=manifest.source_uri,
                    source_artifact_id=manifest.artifact_id,
                    source_artifact_sha256=manifest.content_sha256,
                    source_row_fingerprint=row_fingerprint,
                )
                claim = ObservedBusinessInterestClaim.create(
                    subject_external_id=subject_external_id,
                    program_year=program_year,
                    reporting_entity=reporting_entity,
                    value_of_interest_usd=value_of_interest_usd,
                    amount_invested_usd=amount_invested_usd,
                    disputed=disputed,
                    provenance=provenance,
                )
            except (ValueError, ArithmeticError):
                # Reject the row without echoing third-party content into logs or errors.
                invalid_rows_rejected += 1
                continue

            if claim.claim_id in claims_by_id:
                duplicate_claims_dropped += 1
                continue
            claims_by_id[claim.claim_id] = claim

        claims = tuple(sorted(claims_by_id.values(), key=lambda item: item.claim_id))
        return CMSOwnershipProjectionBatch(
            source_artifact_id=manifest.artifact_id,
            source_artifact_sha256=manifest.content_sha256,
            program_year=program_year,
            rows_seen=rows_seen,
            claims_emitted=len(claims),
            family_rows_excluded=family_rows_excluded,
            non_physician_rows_excluded=non_physician_rows_excluded,
            invalid_rows_rejected=invalid_rows_rejected,
            duplicate_claims_dropped=duplicate_claims_dropped,
            claims=claims,
        )


__all__ = [
    "CMS_OPEN_PAYMENTS_PARSER_CONTRACT_VERSION",
    "CMS_OPEN_PAYMENTS_PROJECTION_SCHEMA_VERSION",
    "CMS_OPEN_PAYMENTS_PROJECTOR_VERSION",
    "CMS_OPEN_PAYMENTS_SOURCE_ID",
    "CMSOpenPaymentsOwnershipProjector",
    "CMSOwnershipProjectionBatch",
    "CMSOwnershipProjectionError",
]
