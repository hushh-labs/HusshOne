"""Immutable source artifacts and privacy-reduced financial claim contracts.

These contracts deliberately sit outside the public NWS snapshot contract.  A
financial claim is one observed asset fact; it is not a complete personal balance
sheet and cannot, by itself, produce a Net Worth Score.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SOURCE_ARTIFACT_MANIFEST_SCHEMA_VERSION: Literal[
    "nws-source-artifact-manifest-v1"
] = "nws-source-artifact-manifest-v1"
FINANCIAL_CLAIM_SCHEMA_VERSION: Literal[
    "nws-financial-claim-v1"
] = "nws-financial-claim-v1"

_SHA256_PATTERN = r"^[0-9a-f]{64}$"
_ARTIFACT_ID_PATTERN = r"^artifact_[0-9a-f]{32}$"
_CLAIM_ID_PATTERN = r"^claim_[0-9a-f]{32}$"
_ROW_FINGERPRINT_PATTERN = r"^row_[0-9a-f]{32}$"
_NPI_SUBJECT_PATTERN = r"^npi/[0-9]{10}$"
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
_CONTACT_OR_LOCATION_TEXT = re.compile(
    r"(?:https?://|www\.|\b[^\s@]+@[^\s@]+\b|"
    r"\b\+?1?[\s.(\-]*\d{3}[\s.)\-]+\d{3}[\s.\-]+\d{4}\b|"
    r"\b\d{1,7}\s+[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}\s+"
    r"(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|"
    r"boulevard|blvd\.?|highway|hwy\.?)\b)",
    re.IGNORECASE,
)
_CENT = Decimal("0.01")
_MAX_USD = Decimal("1000000000000000.00")


class SourcePlaneContractError(ValueError):
    """A source-plane artifact or financial claim failed closed."""


class _StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


def canonical_json_bytes(value: BaseModel | dict[str, object]) -> bytes:
    """Return the sole canonical JSON representation used for source-plane hashes."""

    payload = value.model_dump(mode="json") if isinstance(value, BaseModel) else value
    return (
        json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamps must be timezone-aware")
    return value


def _compact_text(value: str, *, field_name: str, maximum: int) -> str:
    compact = " ".join(value.split())
    if not compact or len(compact) > maximum or _CONTROL_CHARACTERS.search(value):
        raise ValueError(f"{field_name} is invalid")
    return compact


def _artifact_id(content_sha256: str) -> str:
    return f"artifact_{content_sha256[:32]}"


def _claim_identity_payload(
    *,
    subject_external_id: str,
    program_year: int,
    reporting_entity: str,
    value_of_interest_usd: Decimal | None,
    amount_invested_usd: Decimal | None,
    disputed: bool,
    provenance: ClaimProvenance,
) -> dict[str, object]:
    return {
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
        "provenance": provenance.model_dump(mode="json"),
    }


class SourceArtifactManifest(_StrictFrozenModel):
    """Versioned manifest for an immutable raw source artifact."""

    schema_version: Literal["nws-source-artifact-manifest-v1"] = (
        SOURCE_ARTIFACT_MANIFEST_SCHEMA_VERSION
    )
    artifact_id: str = Field(pattern=_ARTIFACT_ID_PATTERN)
    source_id: str = Field(pattern=r"^[a-z][a-z0-9_]{2,79}$")
    source_release: str = Field(min_length=1, max_length=160)
    source_uri: str = Field(min_length=9, max_length=2048)
    retrieved_at: datetime
    media_type: str = Field(min_length=3, max_length=100)
    content_length: int = Field(ge=0, le=1_000_000_000)
    content_sha256: str = Field(pattern=_SHA256_PATTERN)
    collector_version: str = Field(min_length=3, max_length=100)
    parser_contract_version: str = Field(min_length=3, max_length=100)

    @field_validator("source_release", "collector_version", "parser_contract_version")
    @classmethod
    def validate_compact_text(cls, value: str, info) -> str:  # type: ignore[no-untyped-def]
        return _compact_text(value, field_name=info.field_name, maximum=160)

    @field_validator("source_uri")
    @classmethod
    def validate_source_uri(cls, value: str) -> str:
        if not value.startswith("https://") or _CONTROL_CHARACTERS.search(value):
            raise ValueError("source_uri must be a safe HTTPS URL")
        return value

    @field_validator("retrieved_at")
    @classmethod
    def validate_retrieved_at(cls, value: datetime) -> datetime:
        return _aware(value)

    @field_validator("media_type")
    @classmethod
    def validate_media_type(cls, value: str) -> str:
        normalized = value.split(";", 1)[0].strip().casefold()
        if not re.fullmatch(r"[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*", normalized):
            raise ValueError("media_type is invalid")
        return normalized

    @model_validator(mode="after")
    def validate_derived_artifact_id(self) -> SourceArtifactManifest:
        if self.artifact_id != _artifact_id(self.content_sha256):
            raise ValueError("artifact_id must be derived from content_sha256")
        return self

    @classmethod
    def for_content(
        cls,
        *,
        content: bytes,
        source_id: str,
        source_release: str,
        source_uri: str,
        retrieved_at: datetime,
        media_type: str,
        collector_version: str,
        parser_contract_version: str,
    ) -> Self:
        digest = sha256_hex(content)
        return cls(
            artifact_id=_artifact_id(digest),
            source_id=source_id,
            source_release=source_release,
            source_uri=source_uri,
            retrieved_at=retrieved_at,
            media_type=media_type,
            content_length=len(content),
            content_sha256=digest,
            collector_version=collector_version,
            parser_contract_version=parser_contract_version,
        )

    def verify_content(self, content: bytes) -> None:
        if len(content) != self.content_length or sha256_hex(content) != self.content_sha256:
            raise SourcePlaneContractError("artifact bytes do not match the immutable manifest")

    @property
    def manifest_sha256(self) -> str:
        return sha256_hex(canonical_json_bytes(self))


@dataclass(frozen=True, slots=True)
class ImmutableSourceArtifact:
    """Raw immutable bytes bound to their content-addressed manifest."""

    manifest: SourceArtifactManifest
    content: bytes

    def __post_init__(self) -> None:
        if type(self.content) is not bytes:
            raise TypeError("immutable source artifact content must be bytes")
        self.manifest.verify_content(self.content)

    @classmethod
    def create(
        cls,
        *,
        content: bytes,
        source_id: str,
        source_release: str,
        source_uri: str,
        retrieved_at: datetime,
        media_type: str,
        collector_version: str,
        parser_contract_version: str,
    ) -> ImmutableSourceArtifact:
        manifest = SourceArtifactManifest.for_content(
            content=content,
            source_id=source_id,
            source_release=source_release,
            source_uri=source_uri,
            retrieved_at=retrieved_at,
            media_type=media_type,
            collector_version=collector_version,
            parser_contract_version=parser_contract_version,
        )
        return cls(manifest=manifest, content=content)


class ClaimProvenance(_StrictFrozenModel):
    """Non-personal provenance retained with one reduced financial claim."""

    source_id: str = Field(pattern=r"^[a-z][a-z0-9_]{2,79}$")
    source_release: str = Field(min_length=1, max_length=160)
    source_uri: str = Field(min_length=9, max_length=2048)
    source_artifact_id: str = Field(pattern=_ARTIFACT_ID_PATTERN)
    source_artifact_sha256: str = Field(pattern=_SHA256_PATTERN)
    source_row_fingerprint: str = Field(pattern=_ROW_FINGERPRINT_PATTERN)

    @field_validator("source_release")
    @classmethod
    def validate_release(cls, value: str) -> str:
        return _compact_text(value, field_name="source_release", maximum=160)

    @field_validator("source_uri")
    @classmethod
    def validate_source_uri(cls, value: str) -> str:
        if not value.startswith("https://") or _CONTROL_CHARACTERS.search(value):
            raise ValueError("source_uri must be a safe HTTPS URL")
        return value

    @model_validator(mode="after")
    def validate_artifact_identity(self) -> ClaimProvenance:
        if self.source_artifact_id != _artifact_id(self.source_artifact_sha256):
            raise ValueError("source artifact identity is inconsistent")
        return self


class ObservedBusinessInterestClaim(_StrictFrozenModel):
    """One CMS-reported business interest, never a total-net-worth estimate."""

    schema_version: Literal["nws-financial-claim-v1"] = FINANCIAL_CLAIM_SCHEMA_VERSION
    claim_id: str = Field(pattern=_CLAIM_ID_PATTERN)
    claim_type: Literal["observed_business_interest"] = "observed_business_interest"
    subject_external_id: str = Field(pattern=_NPI_SUBJECT_PATTERN)
    program_year: int = Field(ge=2013, le=2100)
    reporting_entity: str = Field(min_length=1, max_length=240)
    value_of_interest_usd: Decimal | None = None
    amount_invested_usd: Decimal | None = None
    disputed: bool
    asset_coverage: Literal["PARTIAL"] = "PARTIAL"
    liability_coverage: Literal["UNKNOWN"] = "UNKNOWN"
    nws_eligible: Literal[False] = False
    provenance: ClaimProvenance

    @field_validator("reporting_entity")
    @classmethod
    def validate_reporting_entity(cls, value: str) -> str:
        compact = _compact_text(value, field_name="reporting_entity", maximum=240)
        if _CONTACT_OR_LOCATION_TEXT.search(compact):
            raise ValueError("reporting_entity contains address or contact text")
        return compact

    @field_validator("value_of_interest_usd", "amount_invested_usd")
    @classmethod
    def validate_usd(cls, value: Decimal | None) -> Decimal | None:
        if value is None:
            return None
        if not value.is_finite() or value < 0 or value > _MAX_USD:
            raise ValueError("financial claim amount is outside the allowed range")
        quantized = value.quantize(_CENT)
        if quantized != value:
            raise ValueError("financial claim amount must use cent precision")
        return quantized

    @model_validator(mode="after")
    def validate_claim(self) -> ObservedBusinessInterestClaim:
        if self.value_of_interest_usd is None and self.amount_invested_usd is None:
            raise ValueError("an observed business interest needs a reported dollar amount")
        expected = self.derive_claim_id(
            subject_external_id=self.subject_external_id,
            program_year=self.program_year,
            reporting_entity=self.reporting_entity,
            value_of_interest_usd=self.value_of_interest_usd,
            amount_invested_usd=self.amount_invested_usd,
            disputed=self.disputed,
            provenance=self.provenance,
        )
        if self.claim_id != expected:
            raise ValueError("claim_id must be derived from the privacy-reduced claim")
        return self

    @staticmethod
    def derive_claim_id(
        *,
        subject_external_id: str,
        program_year: int,
        reporting_entity: str,
        value_of_interest_usd: Decimal | None,
        amount_invested_usd: Decimal | None,
        disputed: bool,
        provenance: ClaimProvenance,
    ) -> str:
        payload = _claim_identity_payload(
            subject_external_id=subject_external_id,
            program_year=program_year,
            reporting_entity=reporting_entity,
            value_of_interest_usd=value_of_interest_usd,
            amount_invested_usd=amount_invested_usd,
            disputed=disputed,
            provenance=provenance,
        )
        return "claim_" + sha256_hex(canonical_json_bytes(payload))[:32]

    @classmethod
    def create(
        cls,
        *,
        subject_external_id: str,
        program_year: int,
        reporting_entity: str,
        value_of_interest_usd: Decimal | None,
        amount_invested_usd: Decimal | None,
        disputed: bool,
        provenance: ClaimProvenance,
    ) -> Self:
        claim_id = cls.derive_claim_id(
            subject_external_id=subject_external_id,
            program_year=program_year,
            reporting_entity=reporting_entity,
            value_of_interest_usd=value_of_interest_usd,
            amount_invested_usd=amount_invested_usd,
            disputed=disputed,
            provenance=provenance,
        )
        return cls(
            claim_id=claim_id,
            subject_external_id=subject_external_id,
            program_year=program_year,
            reporting_entity=reporting_entity,
            value_of_interest_usd=value_of_interest_usd,
            amount_invested_usd=amount_invested_usd,
            disputed=disputed,
            provenance=provenance,
        )


__all__ = [
    "FINANCIAL_CLAIM_SCHEMA_VERSION",
    "SOURCE_ARTIFACT_MANIFEST_SCHEMA_VERSION",
    "ClaimProvenance",
    "ImmutableSourceArtifact",
    "ObservedBusinessInterestClaim",
    "SourceArtifactManifest",
    "SourcePlaneContractError",
    "canonical_json_bytes",
    "sha256_hex",
]
