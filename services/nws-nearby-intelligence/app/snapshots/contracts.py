"""Strict public-safe contracts for precomputed financial NWS releases."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.net_worth import net_worth_to_nws

SNAPSHOT_SCHEMA_VERSION: Literal["nws-net-worth-snapshot-v1"] = "nws-net-worth-snapshot-v1"
ACTIVE_POINTER_SCHEMA_VERSION: Literal["nws-net-worth-active-pointer-v1"] = (
    "nws-net-worth-active-pointer-v1"
)
FLORIDA_SOURCE_CONTRACT_ID: Literal["florida_form_6"] = "florida_form_6"
FLORIDA_PUBLIC_SOURCE_URL: Literal["https://disclosure.floridaethics.gov/PublicSearch/Filings"] = (
    "https://disclosure.floridaethics.gov/PublicSearch/Filings"
)

_SHA256_PATTERN = r"^[0-9a-f]{64}$"
_SNAPSHOT_ID_PATTERN = r"^nwsnw_[0-9a-f]{24}$"
_JURISDICTION_ID_PATTERN = r"^US-FL-COUNTY-[0-9]{5}$"
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
_STREET_ADDRESS = re.compile(
    r"^\s*\d{1,7}\s+.+\b(?:street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|"
    r"lane|ln\.?|boulevard|blvd\.?|highway|hwy\.?)\b",
    re.IGNORECASE,
)
_FORBIDDEN_JSON_KEYS = frozenset(
    {
        "address",
        "street_address",
        "residence",
        "latitude",
        "longitude",
        "phone",
        "email",
        "family",
        "children",
        "account_number",
        "parcel_id",
        "filing_url",
        "pdf_url",
        "raw_payload",
    }
)


class SnapshotContractError(ValueError):
    """A stored release violated its versioned public-safe schema."""


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


def canonical_json_bytes(value: BaseModel | dict[str, object]) -> bytes:
    """Return the one byte representation used for object digests."""

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


def reject_private_json_keys(value: object) -> None:
    """Fail before model parsing if a prohibited field is present anywhere."""

    if isinstance(value, dict):
        for key, nested in value.items():
            if str(key).strip().casefold() in _FORBIDDEN_JSON_KEYS:
                raise SnapshotContractError(f"snapshot contains prohibited field {key!r}")
            reject_private_json_keys(nested)
    elif isinstance(value, list):
        for item in value:
            reject_private_json_keys(item)


def parse_public_snapshot(content: bytes) -> PublishedNetWorthSnapshot:
    try:
        raw = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SnapshotContractError("snapshot is not valid JSON") from exc
    reject_private_json_keys(raw)
    try:
        # Strict models intentionally reject Python string-to-datetime coercion. JSON
        # parsing is the one trusted boundary where RFC 3339 strings are permitted.
        return PublishedNetWorthSnapshot.model_validate_json(content, strict=True)
    except ValueError as exc:
        raise SnapshotContractError("snapshot schema validation failed") from exc


def parse_active_pointer(content: bytes) -> ActiveSnapshotPointer:
    try:
        json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SnapshotContractError("active pointer is not valid JSON") from exc
    try:
        return ActiveSnapshotPointer.model_validate_json(content, strict=True)
    except ValueError as exc:
        raise SnapshotContractError("active pointer schema validation failed") from exc


def _safe_text(value: str, *, field: str, maximum: int) -> str:
    compact = " ".join(value.split())
    if not compact or len(compact) > maximum or _CONTROL_CHARACTERS.search(value):
        raise ValueError(f"{field} is invalid")
    return compact


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamps must be timezone-aware")
    return value


class SnapshotConfidence(_StrictModel):
    score: float = Field(ge=0, le=1)
    grade: Literal["A", "B", "C", "D", "E"]
    coverage: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def grade_matches_score(self) -> SnapshotConfidence:
        expected = (
            "A"
            if self.score >= 0.85
            else "B"
            if self.score >= 0.70
            else "C"
            if self.score >= 0.55
            else "D"
            if self.score >= 0.40
            else "E"
        )
        if self.grade != expected:
            raise ValueError("confidence grade does not match confidence score")
        return self


class PublishedJurisdiction(_StrictModel):
    jurisdiction_id: str = Field(pattern=_JURISDICTION_ID_PATTERN)
    county_geoid: str = Field(pattern=r"^12[0-9]{3}$")
    county_name: str = Field(min_length=2, max_length=120)
    public_label: str = Field(min_length=2, max_length=160)

    @field_validator("county_name", "public_label")
    @classmethod
    def validate_text(cls, value: str, info) -> str:  # type: ignore[no-untyped-def]
        return _safe_text(value, field=info.field_name, maximum=160)

    @model_validator(mode="after")
    def id_matches_county(self) -> PublishedJurisdiction:
        if self.jurisdiction_id != f"US-FL-COUNTY-{self.county_geoid}":
            raise ValueError("jurisdiction_id must be derived from county_geoid")
        return self


class PublishedNetWorthProfile(_StrictModel):
    subject_id: str = Field(pattern=r"^florida-form6:[1-9][0-9]*$", max_length=80)
    name: str = Field(min_length=1, max_length=200)
    headline: str = Field(min_length=1, max_length=200)
    public_offices: tuple[str, ...] = Field(min_length=1, max_length=20)
    jurisdiction_ids: tuple[str, ...] = Field(min_length=1, max_length=67)
    form_year: int = Field(ge=2000, le=2100)
    declared_net_worth_usd: int = Field(ge=-1_000_000_000_000_000, le=1_000_000_000_000_000)
    p10_usd: int = Field(ge=-1_000_000_000_000_000, le=1_000_000_000_000_000)
    median_usd: int = Field(ge=-1_000_000_000_000_000, le=1_000_000_000_000_000)
    p90_usd: int = Field(ge=-1_000_000_000_000_000, le=1_000_000_000_000_000)
    nws: int = Field(ge=0, le=100)
    confidence: SnapshotConfidence
    method: Literal["DECLARED_TOTAL_SIMULATION"] = "DECLARED_TOTAL_SIMULATION"
    financial_update_precision: Literal["YEAR"] = "YEAR"
    components_included_in_declared_total: Literal[True] = True
    source_url: Literal["https://disclosure.floridaethics.gov/PublicSearch/Filings"] = (
        FLORIDA_PUBLIC_SOURCE_URL
    )

    @field_validator("name", "headline")
    @classmethod
    def validate_public_text(cls, value: str, info) -> str:  # type: ignore[no-untyped-def]
        compact = _safe_text(value, field=info.field_name, maximum=200)
        if "@" in compact or _STREET_ADDRESS.search(compact):
            raise ValueError(f"{info.field_name} contains non-public text")
        return compact

    @field_validator("public_offices")
    @classmethod
    def validate_public_offices(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        result: list[str] = []
        for value in values:
            compact = _safe_text(value, field="public_office", maximum=200)
            if "@" in compact or _STREET_ADDRESS.search(compact):
                raise ValueError("public_office contains contact or street information")
            if compact not in result:
                result.append(compact)
        return tuple(result)

    @field_validator("jurisdiction_ids")
    @classmethod
    def validate_jurisdiction_ids(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(values) != len(set(values)):
            raise ValueError("jurisdiction_ids must be unique")
        if any(re.fullmatch(_JURISDICTION_ID_PATTERN, value) is None for value in values):
            raise ValueError("jurisdiction_id is invalid")
        return tuple(sorted(values))

    @model_validator(mode="after")
    def validate_declared_total(self) -> PublishedNetWorthProfile:
        if self.headline != self.public_offices[0]:
            raise ValueError("headline must be the first public office")
        if not self.p10_usd <= self.median_usd <= self.p90_usd:
            raise ValueError("net-worth distribution is not ordered")
        if self.declared_net_worth_usd != self.median_usd:
            raise ValueError("declared total must equal the published median")
        if self.nws != net_worth_to_nws(self.median_usd):
            raise ValueError("NWS does not match the fixed national scale")
        if self.confidence.coverage != 1.0:
            raise ValueError("whole declared totals must have full declared-total coverage")
        return self


class SnapshotSourceStatus(_StrictModel):
    source_contract_id: Literal["florida_form_6"] = FLORIDA_SOURCE_CONTRACT_ID
    source_snapshot_id: str = Field(min_length=3, max_length=200)
    source_artifact_sha256: str = Field(pattern=_SHA256_PATTERN)
    authority: Literal["Florida Commission on Ethics"] = "Florida Commission on Ethics"
    public_source_url: Literal["https://disclosure.floridaethics.gov/PublicSearch/Filings"] = (
        FLORIDA_PUBLIC_SOURCE_URL
    )
    retrieved_at: datetime
    index_built_at: datetime
    form_year: int = Field(ge=2000, le=2100)
    partial: bool
    total_count: int = Field(ge=0, le=1_000_000)
    evaluated_count: int = Field(ge=0, le=1_000_000)
    published_profile_count: int = Field(ge=0, le=1_000_000)
    truncated: bool

    @field_validator("retrieved_at", "index_built_at")
    @classmethod
    def timestamps_are_aware(cls, value: datetime) -> datetime:
        return _aware(value)

    @model_validator(mode="after")
    def validate_counts_and_time(self) -> SnapshotSourceStatus:
        if self.index_built_at > self.retrieved_at:
            raise ValueError("source index cannot be built after it was retrieved")
        if self.published_profile_count > self.evaluated_count:
            raise ValueError("published profile count cannot exceed evaluated count")
        if self.evaluated_count > self.total_count:
            raise ValueError("evaluated count cannot exceed source index total")
        return self


class PublishedNetWorthSnapshot(_StrictModel):
    schema_version: Literal["nws-net-worth-snapshot-v1"] = SNAPSHOT_SCHEMA_VERSION
    snapshot_id: str = Field(pattern=_SNAPSHOT_ID_PATTERN)
    generated_at: datetime
    source_registry_sha256: str = Field(pattern=_SHA256_PATTERN)
    source_registry_id: str = Field(min_length=3, max_length=200)
    source_registry_version: int = Field(ge=1)
    model_version: str = Field(min_length=3, max_length=100)
    scale_version: str = Field(min_length=3, max_length=100)
    source: SnapshotSourceStatus
    jurisdictions: tuple[PublishedJurisdiction, ...] = Field(min_length=1, max_length=100)
    profiles: tuple[PublishedNetWorthProfile, ...] = Field(max_length=10_000)

    @field_validator("generated_at")
    @classmethod
    def generated_at_is_aware(cls, value: datetime) -> datetime:
        return _aware(value)

    @model_validator(mode="after")
    def validate_release(self) -> PublishedNetWorthSnapshot:
        if self.source.retrieved_at > self.generated_at:
            raise ValueError("source retrieval cannot be after snapshot generation")
        if self.source.form_year > self.generated_at.year:
            raise ValueError("source form year cannot be in the future")
        jurisdiction_ids = [item.jurisdiction_id for item in self.jurisdictions]
        if len(jurisdiction_ids) != len(set(jurisdiction_ids)):
            raise ValueError("jurisdictions must be unique")
        allowed = set(jurisdiction_ids)
        subject_ids = [profile.subject_id for profile in self.profiles]
        if len(subject_ids) != len(set(subject_ids)):
            raise ValueError("profiles must be unique by subject_id")
        if any(not set(profile.jurisdiction_ids).issubset(allowed) for profile in self.profiles):
            raise ValueError("profile references an unknown jurisdiction")
        if any(profile.form_year != self.source.form_year for profile in self.profiles):
            raise ValueError("profile form year does not match source index")
        if self.source.published_profile_count != len(self.profiles):
            raise ValueError("published profile count does not match profiles")
        return self

    def profiles_for_jurisdiction(
        self, jurisdiction_id: str
    ) -> tuple[PublishedNetWorthProfile, ...]:
        return tuple(
            sorted(
                (item for item in self.profiles if jurisdiction_id in item.jurisdiction_ids),
                key=lambda item: (-item.median_usd, item.subject_id),
            )
        )


class ActiveSnapshotPointer(_StrictModel):
    schema_version: Literal["nws-net-worth-active-pointer-v1"] = ACTIVE_POINTER_SCHEMA_VERSION
    snapshot_id: str = Field(pattern=_SNAPSHOT_ID_PATTERN)
    snapshot_object: str = Field(min_length=10, max_length=1024)
    snapshot_generation: str = Field(pattern=r"^[1-9][0-9]*$")
    snapshot_sha256: str = Field(pattern=_SHA256_PATTERN)
    snapshot_schema_version: Literal["nws-net-worth-snapshot-v1"] = SNAPSHOT_SCHEMA_VERSION
    source_registry_sha256: str = Field(pattern=_SHA256_PATTERN)
    generated_at: datetime
    published_at: datetime

    @field_validator("generated_at", "published_at")
    @classmethod
    def pointer_times_are_aware(cls, value: datetime) -> datetime:
        return _aware(value)

    @field_validator("snapshot_object")
    @classmethod
    def validate_object_name(cls, value: str) -> str:
        if value.startswith("/") or ".." in value.split("/") or not value.endswith(".json"):
            raise ValueError("snapshot_object is not a safe JSON object name")
        return value

    @model_validator(mode="after")
    def publication_follows_generation(self) -> ActiveSnapshotPointer:
        if self.published_at < self.generated_at:
            raise ValueError("published_at cannot precede generated_at")
        return self


class SnapshotRepositoryStatus(_StrictModel):
    snapshot_id: str = Field(pattern=_SNAPSHOT_ID_PATTERN)
    snapshot_sha256: str = Field(pattern=_SHA256_PATTERN)
    generated_at: datetime
    source_retrieved_at: datetime
    source_index_built_at: datetime
    source_form_year: int = Field(ge=2000, le=2100)
    source_partial: bool
    source_total_count: int = Field(ge=0)
    evaluated_count: int = Field(ge=0)
    profile_count: int = Field(ge=0)
    jurisdiction_count: int = Field(ge=0)
    truncated: bool

    @field_validator("generated_at", "source_retrieved_at", "source_index_built_at")
    @classmethod
    def status_times_are_aware(cls, value: datetime) -> datetime:
        return _aware(value)
