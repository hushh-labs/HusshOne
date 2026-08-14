from __future__ import annotations

import hashlib
import re
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Self
from urllib.parse import urlsplit

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from app.net_worth import NWS_SCALE_VERSION, net_worth_to_nws

FinancialMode = Literal["verified", "estimated", "observed-only"]
GeographyMode = Literal["nearest-count", "strict-radius"]
ConfidenceFilter = Literal["A", "B", "C"]
AssetFamily = Literal[
    "cash_and_near_cash",
    "public_securities",
    "private_business_equity",
    "real_estate_equity",
    "other_assets",
]
ComponentStatus = Literal[
    "SUPPORTED",
    "MODELED_RANGE",
    "INCLUDED_IN_DECLARED_TOTAL",
    "UNKNOWN",
    "NOT_PROVIDED",
    "NOT_APPLICABLE",
]

V4_CONTRACT_VERSION: Literal["nws-nearby-net-worth-v4-preview-1"] = (
    "nws-nearby-net-worth-v4-preview-1"
)
V4_COVERAGE_CONTRACT: Literal["BEST_EFFORT_VERIFIED_PUBLIC_FINANCIAL_PROFILES"] = (
    "BEST_EFFORT_VERIFIED_PUBLIC_FINANCIAL_PROFILES"
)
QUALIFIED_C_MINIMUM_COVERAGE = 0.55
VERIFIED_MINIMUM_COVERAGE = 0.70
_KM_PER_MILE = 1.609344
_GRADE_ORDER = {"A": 3, "B": 2, "C": 1, "D": 0, "E": -1}
_SAFE_IDENTIFIER = r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,127}$"
_CONSENT_RECEIPT = r"^[A-Za-z0-9][A-Za-z0-9._~:-]{15,511}$"
_PROJECT_ID = r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$"
_PURPOSE_ID = r"^[A-Z][A-Z0-9_]{2,63}$"
_MAX_RADIUS_MILES = 310.685596
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_STREET_ADDRESS = re.compile(
    r"\b\d{1,6}\s+[A-Za-z0-9 .'-]{1,80}\s"
    r"(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way)\b",
    re.IGNORECASE,
)
_PHONE_NUMBER = re.compile(
    r"(?<!\d)(?:\+?1[-.\s]?)?(?:\([0-9]{3}\)|[0-9]{3})"
    r"[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}(?!\d)"
)


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class NetWorthV4ProjectionError(ValueError):
    """The legacy response cannot be truthfully represented by the v4 public contract."""


class NetWorthV4Query(_StrictModel):
    postal_code: str | None = Field(
        default=None,
        pattern=r"^[0-9]{5}(?:-[0-9]{4})?$",
    )
    latitude: float | None = Field(
        default=None,
        ge=-90,
        le=90,
        strict=True,
        allow_inf_nan=False,
    )
    longitude: float | None = Field(
        default=None,
        ge=-180,
        le=180,
        strict=True,
        allow_inf_nan=False,
    )
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")

    @model_validator(mode="after")
    def one_location_mode(self) -> Self:
        has_postal = self.postal_code is not None
        has_coordinate = self.latitude is not None or self.longitude is not None
        if has_postal == has_coordinate:
            raise ValueError("provide either postal_code or latitude and longitude")
        if has_coordinate and (self.latitude is None or self.longitude is None):
            raise ValueError("latitude and longitude must be provided together")
        if has_postal and self.country_code not in {None, "US"}:
            raise ValueError("postal-code queries are limited to US ZIP/ZCTA geography")
        return self

    @property
    def uses_coordinates(self) -> bool:
        return self.latitude is not None


class NetWorthV4Selection(_StrictModel):
    count: Literal[100, 150, 200] = 100
    financial_mode: FinancialMode = "estimated"
    geography_mode: GeographyMode = "nearest-count"
    maximum_radius_miles: float | None = Field(
        default=None,
        gt=0,
        le=_MAX_RADIUS_MILES,
        strict=True,
        allow_inf_nan=False,
    )

    @model_validator(mode="after")
    def strict_radius_has_boundary(self) -> Self:
        if self.geography_mode == "strict-radius" and self.maximum_radius_miles is None:
            raise ValueError("strict-radius requires maximum_radius_miles")
        return self


class NetWorthV4Filters(_StrictModel):
    minimum_confidence: ConfidenceFilter = "C"
    minimum_coverage: float = Field(
        default=QUALIFIED_C_MINIMUM_COVERAGE,
        ge=0,
        le=1,
        strict=True,
        allow_inf_nan=False,
    )
    asset_families: list[AssetFamily] = Field(default_factory=list, max_length=5)

    @model_validator(mode="after")
    def asset_filters_are_unique(self) -> Self:
        if len(self.asset_families) != len(set(self.asset_families)):
            raise ValueError("asset_families must be unique")
        return self


class NetWorthV4CallerContext(_StrictModel):
    project_id: str = Field(min_length=6, max_length=30, pattern=_PROJECT_ID)
    purpose_id: str = Field(min_length=3, max_length=64, pattern=_PURPOSE_ID)
    authorization_scope: Literal["PUBLIC_SAFE", "RESTRICTED_ANALYTICAL"]
    requested_data_tier: Literal["PUBLIC_SAFE", "RESTRICTED_ANALYTICAL"]
    audit_actor: str = Field(min_length=2, max_length=128, pattern=_SAFE_IDENTIFIER)
    model_version: str = Field(min_length=3, max_length=128, pattern=_SAFE_IDENTIFIER)

    @model_validator(mode="after")
    def tier_is_authorized(self) -> Self:
        if (
            self.requested_data_tier == "RESTRICTED_ANALYTICAL"
            and self.authorization_scope != "RESTRICTED_ANALYTICAL"
        ):
            raise ValueError("restricted data requires restricted analytical authorization")
        return self


class CoordinateConsentReceipt(_StrictModel):
    receipt_id: str = Field(min_length=16, max_length=512, pattern=_CONSENT_RECEIPT)
    purpose_id: str = Field(min_length=3, max_length=64, pattern=_PURPOSE_ID)
    audit_actor: str = Field(min_length=2, max_length=128, pattern=_SAFE_IDENTIFIER)
    scope: Literal["APPROXIMATE_LOCATION_QUERY"]
    # ISO-8601 is the only interoperable JSON representation for a datetime.
    # Keep all other request fields strict while allowing Pydantic to parse these two strings.
    issued_at: AwareDatetime = Field(strict=False)
    expires_at: AwareDatetime = Field(strict=False)

    @model_validator(mode="after")
    def chronological(self) -> Self:
        if self.expires_at <= self.issued_at:
            raise ValueError("coordinate consent must expire after it is issued")
        return self


class CoordinateConsentIssueRequest(_StrictModel):
    project_id: str = Field(min_length=6, max_length=30, pattern=_PROJECT_ID)
    purpose_id: str = Field(min_length=3, max_length=64, pattern=_PURPOSE_ID)
    audit_actor: str = Field(min_length=2, max_length=128, pattern=_SAFE_IDENTIFIER)
    scope: Literal["APPROXIMATE_LOCATION_QUERY"]
    consent_granted: Literal[True]


class NetWorthV4Request(_StrictModel):
    query: NetWorthV4Query
    selection: NetWorthV4Selection
    filters: NetWorthV4Filters = Field(default_factory=NetWorthV4Filters)
    caller_context: NetWorthV4CallerContext
    coordinate_consent: CoordinateConsentReceipt | None = None

    @model_validator(mode="after")
    def coordinate_consent_matches_context(self) -> Self:
        receipt = self.coordinate_consent
        if self.query.uses_coordinates:
            if receipt is None:
                raise ValueError("coordinate queries require a consent receipt")
            if receipt.purpose_id != self.caller_context.purpose_id:
                raise ValueError("coordinate consent purpose does not match caller purpose")
            if receipt.audit_actor != self.caller_context.audit_actor:
                raise ValueError("coordinate consent actor does not match audit actor")
        elif receipt is not None:
            raise ValueError("postal-code queries must not attach a coordinate consent receipt")
        return self


class NetWorthV4QuerySummary(_StrictModel):
    label: str
    mode: Literal["POSTAL_CODE", "COARSE_COORDINATE"]
    postal_code: str | None = None
    country_code: str | None = None
    approximate: bool


class NetWorthV4Coverage(_StrictModel):
    status: Literal["COVERED", "NOT_COVERED", "LOCATION_UNRESOLVED"]
    reason_code: str
    market_label: str | None = None
    country_code: str | None = None


class NetWorthV4Snapshot(_StrictModel):
    model_version: str
    scale_version: str
    as_of: str
    upstream_complete: bool


class NetWorthV4FinancialCoverage(_StrictModel):
    upstream_status: Literal[
        "AVAILABLE",
        "PARTIAL",
        "FINANCIAL_COVERAGE_INSUFFICIENT",
        "NOT_SEARCHED",
    ]
    discovered_count: int = Field(ge=0)
    evaluated_count: int = Field(ge=0)
    upstream_scored_count: int = Field(ge=0)
    v4_eligible_count: int = Field(ge=0)


class NetWorthV4ExpansionStep(_StrictModel):
    order: int = Field(ge=1)
    stage: Literal["LEGACY_RADIUS", "PUBLIC_JURISDICTION"]
    radius_miles: float | None = Field(default=None, ge=0)
    count_status: Literal["AVAILABLE", "UPSTREAM_NOT_REPORTED"]
    discovered_count: int | None = Field(default=None, ge=0)
    evaluated_count: int | None = Field(default=None, ge=0)
    financially_eligible_count: int | None = Field(default=None, ge=0)
    cumulative_returned_count: int | None = Field(default=None, ge=0)


class NetWorthV4ExpansionAccountability(_StrictModel):
    requested_strategy: GeographyMode
    upstream_strategy: Literal["LEGACY_RADIUS", "PUBLIC_JURISDICTION", "NOT_SEARCHED"]
    status: Literal["PARTIAL", "NOT_SEARCHED"]
    steps: list[NetWorthV4ExpansionStep]
    effective_radius_miles: float | None = Field(default=None, ge=0)
    maximum_radius_reached: bool
    disclosure_code: Literal[
        "UPSTREAM_PER_STEP_COUNTS_UNAVAILABLE",
        "UPSTREAM_JURISDICTION_WITHOUT_DISTANCE",
        "LOCATION_NOT_SEARCHED",
    ]


class NetWorthV4ResultSet(_StrictModel):
    requested_count: Literal[100, 150, 200]
    upstream_result_count: int = Field(ge=0)
    eligible_count: int = Field(ge=0)
    returned_count: int = Field(ge=0)
    shortfall_count: int = Field(ge=0)
    target_satisfied: bool
    reasons: list[str]

    @model_validator(mode="after")
    def counts_are_consistent(self) -> Self:
        if self.shortfall_count != max(0, self.requested_count - self.returned_count):
            raise ValueError("shortfall_count is inconsistent")
        if self.target_satisfied != (self.returned_count >= self.requested_count):
            raise ValueError("target_satisfied is inconsistent")
        if self.target_satisfied and self.reasons:
            raise ValueError("a satisfied target cannot have shortfall reasons")
        return self


class NetWorthV4Person(_StrictModel):
    id: str
    name: str
    headline: str
    organization: str | None = None


class NetWorthV4Distribution(_StrictModel):
    status: Literal["AVAILABLE", "PARTIAL_ESTIMATE"]
    currency: Literal["USD"]
    p10_usd: int
    median_usd: int
    p90_usd: int
    method: Literal["MONTE_CARLO", "DECLARED_TOTAL_SIMULATION"]
    as_of: str


class NetWorthV4ScoreInterval(_StrictModel):
    low: int = Field(ge=0, le=100)
    median: int = Field(ge=0, le=100)
    high: int = Field(ge=0, le=100)
    basis: Literal["P10_MEDIAN_P90_FIXED_SCALE"]

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if not self.low <= self.median <= self.high:
            raise ValueError("NWS uncertainty interval is not ordered")
        return self


class NetWorthV4Nws(_StrictModel):
    value: int = Field(ge=0, le=100)
    scale_version: str
    uncertainty: NetWorthV4ScoreInterval


class NetWorthV4Confidence(_StrictModel):
    score: float = Field(ge=0, le=1)
    grade: Literal["A", "B", "C"]
    coverage: float = Field(ge=0, le=1)


class NetWorthV4Component(_StrictModel):
    status: ComponentStatus
    low_usd: int | None = None
    most_likely_usd: int | None = None
    high_usd: int | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)


class NetWorthV4Components(_StrictModel):
    cash_and_near_cash: NetWorthV4Component
    public_securities: NetWorthV4Component
    private_business_equity: NetWorthV4Component
    real_estate_equity: NetWorthV4Component
    other_assets: NetWorthV4Component
    liabilities: NetWorthV4Component


class NetWorthV4ObservedFloor(_StrictModel):
    status: Literal["AVAILABLE", "UNAVAILABLE"]
    amount_usd: int | None = None
    method: Literal[
        "DIRECT_DECLARED_TOTAL_P10",
        "SUPPORTED_ASSET_LOWS_LESS_SUPPORTED_LIABILITY_HIGH",
        "UNAVAILABLE",
    ]
    supporting_asset_families: list[AssetFamily]

    @model_validator(mode="after")
    def availability_is_consistent(self) -> Self:
        if self.status == "AVAILABLE" and self.amount_usd is None:
            raise ValueError("an available observed floor requires amount_usd")
        if self.status == "UNAVAILABLE" and (
            self.amount_usd is not None or self.method != "UNAVAILABLE"
        ):
            raise ValueError("an unavailable observed floor cannot contain a value")
        return self


class NetWorthV4RankInterval(_StrictModel):
    low: int = Field(ge=1)
    high: int = Field(ge=1)
    basis: Literal["P10_P90_OVERLAP_AVAILABLE_SET", "OBSERVED_FLOOR_AVAILABLE_SET"]
    population_complete: Literal[False] = False

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if self.low > self.high:
            raise ValueError("rank interval is not ordered")
        return self


class NetWorthV4LocationRelationship(_StrictModel):
    label: str
    association_kind: str
    granularity: str
    approximate_distance_band: str
    notice: Literal[
        "Public professional or opt-in association; not residence or physical presence."
    ] = "Public professional or opt-in association; not residence or physical presence."


class NetWorthV4Result(_StrictModel):
    rank: int = Field(ge=1)
    rank_interval: NetWorthV4RankInterval
    person: NetWorthV4Person
    estimated_net_worth: NetWorthV4Distribution
    observed_net_worth_floor: NetWorthV4ObservedFloor
    nws: NetWorthV4Nws
    confidence: NetWorthV4Confidence
    components: NetWorthV4Components
    location_relationship: NetWorthV4LocationRelationship
    last_financial_update: str
    financial_update_precision: Literal["DAY", "YEAR"]
    why_ranked: list[str] = Field(min_length=1, max_length=5)
    source_families: list[str] = Field(min_length=1, max_length=20)


class NetWorthV4RequestPolicy(_StrictModel):
    project_id: str
    purpose_id: str
    authorization_scope: Literal["PUBLIC_SAFE"]
    requested_data_tier: Literal["PUBLIC_SAFE"]
    audit_actor_reference: str = Field(pattern=r"^actor_[0-9a-f]{16}$")
    financial_mode: FinancialMode
    geography_mode: GeographyMode
    minimum_confidence: ConfidenceFilter
    minimum_coverage: float = Field(ge=0, le=1)
    asset_families: list[AssetFamily]


class NetWorthV4Response(_StrictModel):
    contract_version: Literal["nws-nearby-net-worth-v4-preview-1"] = V4_CONTRACT_VERSION
    coverage_contract: Literal["BEST_EFFORT_VERIFIED_PUBLIC_FINANCIAL_PROFILES"] = (
        V4_COVERAGE_CONTRACT
    )
    data_tier: Literal["PUBLIC_SAFE"] = "PUBLIC_SAFE"
    request_policy: NetWorthV4RequestPolicy
    query: NetWorthV4QuerySummary
    coverage: NetWorthV4Coverage
    snapshot: NetWorthV4Snapshot
    financial_coverage: NetWorthV4FinancialCoverage
    expansion: NetWorthV4ExpansionAccountability
    result_set: NetWorthV4ResultSet
    generated_at: AwareDatetime
    disclosures: list[str]
    results: list[NetWorthV4Result]


@dataclass(frozen=True)
class _EligibleRecord:
    raw: dict[str, Any]
    observed_floor: NetWorthV4ObservedFloor
    source_families: tuple[str, ...]


def _is_public_text(value: object) -> bool:
    if value is None:
        return True
    if not isinstance(value, str) or not value.strip():
        return False
    return not (
        "@" in value
        or _CONTROL_CHARACTERS.search(value)
        or _STREET_ADDRESS.search(value)
        or _PHONE_NUMBER.search(value)
    )


def _privacy_safe(raw: Mapping[str, Any]) -> bool:
    person = raw["person"]
    location = raw["location_relationship"]
    return (
        all(
            _is_public_text(value)
            for value in (
                person["name"],
                person["headline"],
                person.get("organization"),
                location["label"],
            )
        )
        and location["association_kind"] != "EVENT_ONLY"
    )


def _source_families(raw: Mapping[str, Any]) -> tuple[str, ...]:
    families: set[str] = set()
    for citation in raw["sources"]:
        hostname = (urlsplit(citation["url"]).hostname or "").casefold().removeprefix("www.")
        if hostname and re.fullmatch(r"[a-z0-9.-]+", hostname):
            families.add(hostname)
    return tuple(sorted(families))


def _has_direct_financial_evidence(raw: Mapping[str, Any]) -> bool:
    if raw["estimated_net_worth"]["method"] == "DECLARED_TOTAL_SIMULATION":
        return True
    return any(
        family != "liabilities" and component["status"] == "SUPPORTED"
        for family, component in raw["components"].items()
    )


def _observed_floor(raw: Mapping[str, Any]) -> NetWorthV4ObservedFloor:
    estimate = raw["estimated_net_worth"]
    if estimate["method"] == "DECLARED_TOTAL_SIMULATION":
        return NetWorthV4ObservedFloor(
            status="AVAILABLE",
            amount_usd=estimate["p10_usd"],
            method="DIRECT_DECLARED_TOTAL_P10",
            supporting_asset_families=[],
        )

    components = raw["components"]
    supported: list[AssetFamily] = []
    asset_low = 0
    for family in (
        "cash_and_near_cash",
        "public_securities",
        "private_business_equity",
        "real_estate_equity",
        "other_assets",
    ):
        component = components[family]
        if component["status"] == "SUPPORTED" and component["low_usd"] is not None:
            asset_low += int(component["low_usd"])
            supported.append(family)

    liability = components["liabilities"]
    if not supported or liability["status"] not in {"SUPPORTED", "NOT_APPLICABLE"}:
        return NetWorthV4ObservedFloor(
            status="UNAVAILABLE",
            amount_usd=None,
            method="UNAVAILABLE",
            supporting_asset_families=supported,
        )
    liability_high = int(liability["high_usd"] or 0)
    return NetWorthV4ObservedFloor(
        status="AVAILABLE",
        amount_usd=asset_low - liability_high,
        method="SUPPORTED_ASSET_LOWS_LESS_SUPPORTED_LIABILITY_HIGH",
        supporting_asset_families=supported,
    )


def _asset_filters_match(raw: Mapping[str, Any], request: NetWorthV4Request) -> bool:
    allowed_statuses = (
        {"SUPPORTED"}
        if request.selection.financial_mode == "observed-only"
        else {"SUPPORTED", "MODELED_RANGE"}
    )
    return all(
        raw["components"][family]["status"] in allowed_statuses
        for family in request.filters.asset_families
    )


def _eligibility_reason(
    raw: Mapping[str, Any],
    *,
    request: NetWorthV4Request,
    observed_floor: NetWorthV4ObservedFloor,
    source_families: tuple[str, ...],
) -> str | None:
    if not _privacy_safe(raw):
        return "PRIVACY_PROJECTION_EXCLUDED_PROFILES"
    grade = raw["confidence"]["grade"]
    if grade in {"D", "E"}:
        return "CONFIDENCE_FILTER_EXCLUDED_PROFILES"
    if _GRADE_ORDER[grade] < _GRADE_ORDER[request.filters.minimum_confidence]:
        return "CONFIDENCE_FILTER_EXCLUDED_PROFILES"
    coverage = float(raw["confidence"]["coverage"])
    if coverage < request.filters.minimum_coverage:
        return "COVERAGE_FILTER_EXCLUDED_PROFILES"
    if not source_families:
        return "PROVENANCE_FILTER_EXCLUDED_PROFILES"

    direct_evidence = _has_direct_financial_evidence(raw)
    if request.selection.financial_mode == "verified":
        if grade not in {"A", "B"} or coverage < VERIFIED_MINIMUM_COVERAGE or not direct_evidence:
            return "VERIFIED_MODE_EXCLUDED_PROFILES"
    elif grade == "C" and (coverage < QUALIFIED_C_MINIMUM_COVERAGE or not direct_evidence):
        return "UNQUALIFIED_C_EXCLUDED_PROFILES"

    if not _asset_filters_match(raw, request):
        return "ASSET_FILTER_EXCLUDED_PROFILES"
    if request.selection.financial_mode == "observed-only" and observed_floor.status != "AVAILABLE":
        return "OBSERVED_FLOOR_UNAVAILABLE"
    return None


def _sort_key(record: _EligibleRecord, mode: FinancialMode) -> tuple[float, ...] | tuple[Any, ...]:
    raw = record.raw
    if mode == "observed-only":
        assert record.observed_floor.amount_usd is not None
        return (-record.observed_floor.amount_usd, raw["person"]["id"])
    return (
        -raw["estimated_net_worth"]["median_usd"],
        -raw["estimated_net_worth"]["p10_usd"],
        -raw["confidence"]["coverage"],
        raw["person"]["id"],
    )


def _rank_interval(
    current: _EligibleRecord,
    records: list[_EligibleRecord],
    *,
    rank: int,
    mode: FinancialMode,
) -> NetWorthV4RankInterval:
    if mode == "observed-only":
        return NetWorthV4RankInterval(
            low=rank,
            high=rank,
            basis="OBSERVED_FLOOR_AVAILABLE_SET",
            population_complete=False,
        )
    current_low = current.raw["estimated_net_worth"]["p10_usd"]
    current_high = current.raw["estimated_net_worth"]["p90_usd"]
    certainly_above = sum(
        other.raw["estimated_net_worth"]["p10_usd"] > current_high
        for other in records
        if other is not current
    )
    possibly_above = sum(
        other.raw["estimated_net_worth"]["p90_usd"] >= current_low
        for other in records
        if other is not current
    )
    return NetWorthV4RankInterval(
        low=min(rank, certainly_above + 1),
        high=max(rank, possibly_above + 1),
        basis="P10_P90_OVERLAP_AVAILABLE_SET",
        population_complete=False,
    )


def _why_ranked(record: _EligibleRecord, mode: FinancialMode) -> list[str]:
    raw = record.raw
    coverage_percent = round(raw["confidence"]["coverage"] * 100)
    if mode == "observed-only":
        assert record.observed_floor.amount_usd is not None
        first = f"Observed floor: ${record.observed_floor.amount_usd:,}"
    else:
        first = f"Median estimate: ${raw['estimated_net_worth']['median_usd']:,}"
    reasons = [
        first,
        f"Confidence {raw['confidence']['grade']}; {coverage_percent}% coverage",
    ]
    if record.observed_floor.supporting_asset_families:
        labels = ", ".join(
            family.replace("_", " ")
            for family in record.observed_floor.supporting_asset_families[:3]
        )
        reasons.append(f"Direct evidence: {labels}")
    elif raw["estimated_net_worth"]["method"] == "DECLARED_TOTAL_SIMULATION":
        reasons.append("Direct whole-net-worth disclosure")
    reasons.append(f"Sources: {', '.join(record.source_families[:3])}")
    return reasons[:5]


def _project_result(
    record: _EligibleRecord,
    *,
    rank: int,
    all_eligible: list[_EligibleRecord],
    mode: FinancialMode,
) -> dict[str, Any]:
    raw = record.raw
    estimate = raw["estimated_net_worth"]
    if not estimate["p10_usd"] <= estimate["median_usd"] <= estimate["p90_usd"]:
        raise NetWorthV4ProjectionError("upstream net-worth interval is not ordered")
    if raw["nws"]["scale_version"] != NWS_SCALE_VERSION:
        raise NetWorthV4ProjectionError("upstream NWS scale is unsupported by v4")
    expected_nws = net_worth_to_nws(estimate["median_usd"])
    if raw["nws"]["value"] != expected_nws:
        raise NetWorthV4ProjectionError("upstream NWS value does not match the fixed scale")
    location = raw["location_relationship"]
    return {
        "rank": rank,
        "rank_interval": _rank_interval(record, all_eligible, rank=rank, mode=mode),
        "person": raw["person"],
        "estimated_net_worth": estimate,
        "observed_net_worth_floor": record.observed_floor,
        "nws": {
            "value": expected_nws,
            "scale_version": raw["nws"]["scale_version"],
            "uncertainty": {
                "low": net_worth_to_nws(estimate["p10_usd"]),
                "median": expected_nws,
                "high": net_worth_to_nws(estimate["p90_usd"]),
                "basis": "P10_MEDIAN_P90_FIXED_SCALE",
            },
        },
        "confidence": raw["confidence"],
        "components": raw["components"],
        "location_relationship": {
            "label": location["label"],
            "association_kind": location["association_kind"],
            "granularity": location["granularity"],
            "approximate_distance_band": location["approximate_distance_band"],
            "notice": (
                "Public professional or opt-in association; not residence or physical presence."
            ),
        },
        "last_financial_update": raw["last_financial_update"],
        "financial_update_precision": raw["financial_update_precision"],
        "why_ranked": _why_ranked(record, mode),
        "source_families": list(record.source_families),
    }


def _expansion_accountability(
    upstream: Mapping[str, Any],
    *,
    request: NetWorthV4Request,
    eligible_count: int,
    returned_count: int,
) -> dict[str, Any]:
    search = upstream["search"]
    financial = upstream["financial_coverage"]
    if not search["performed"]:
        return {
            "requested_strategy": request.selection.geography_mode,
            "upstream_strategy": "NOT_SEARCHED",
            "status": "NOT_SEARCHED",
            "steps": [],
            "effective_radius_miles": None,
            "maximum_radius_reached": False,
            "disclosure_code": "LOCATION_NOT_SEARCHED",
        }

    if search["scope"] == "PUBLIC_JURISDICTION":
        return {
            "requested_strategy": request.selection.geography_mode,
            "upstream_strategy": "PUBLIC_JURISDICTION",
            "status": "PARTIAL",
            "steps": [
                {
                    "order": 1,
                    "stage": "PUBLIC_JURISDICTION",
                    "radius_miles": None,
                    "count_status": "AVAILABLE",
                    "discovered_count": financial["discovered_count"],
                    "evaluated_count": financial["evaluated_count"],
                    "financially_eligible_count": eligible_count,
                    "cumulative_returned_count": returned_count,
                }
            ],
            "effective_radius_miles": None,
            "maximum_radius_reached": search["maximum_radius_reached"],
            "disclosure_code": "UPSTREAM_JURISDICTION_WITHOUT_DISTANCE",
        }

    radii = list(search["expansion_steps_km"])
    if not radii:
        radii = [search["effective_radius_km"]]
    steps: list[dict[str, Any]] = []
    for index, radius_km in enumerate(radii):
        final = index == len(radii) - 1
        steps.append(
            {
                "order": index + 1,
                "stage": "LEGACY_RADIUS",
                "radius_miles": round(radius_km / _KM_PER_MILE, 2),
                "count_status": "AVAILABLE" if final else "UPSTREAM_NOT_REPORTED",
                "discovered_count": financial["discovered_count"] if final else None,
                "evaluated_count": financial["evaluated_count"] if final else None,
                "financially_eligible_count": eligible_count if final else None,
                "cumulative_returned_count": returned_count if final else None,
            }
        )
    return {
        "requested_strategy": request.selection.geography_mode,
        "upstream_strategy": "LEGACY_RADIUS",
        "status": "PARTIAL",
        "steps": steps,
        "effective_radius_miles": round(search["effective_radius_km"] / _KM_PER_MILE, 2),
        "maximum_radius_reached": search["maximum_radius_reached"],
        "disclosure_code": "UPSTREAM_PER_STEP_COUNTS_UNAVAILABLE",
    }


def _generated_at(upstream: Mapping[str, Any]) -> datetime:
    try:
        generated_at = datetime.fromisoformat(upstream["generated_at"].replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError) as exc:
        raise NetWorthV4ProjectionError("upstream generated_at is invalid") from exc
    if generated_at.tzinfo is None or generated_at.utcoffset() is None:
        raise NetWorthV4ProjectionError("upstream generated_at must be timezone-aware")
    return generated_at


def _validate_projection_boundary(upstream: Mapping[str, Any], request: NetWorthV4Request) -> None:
    if request.caller_context.requested_data_tier != "PUBLIC_SAFE":
        raise NetWorthV4ProjectionError(
            "the v4 projector accepts only the existing public-safe response tier"
        )
    if upstream["snapshot"]["model_version"] != request.caller_context.model_version:
        raise NetWorthV4ProjectionError("requested model_version does not match the snapshot")
    expected_mode = "COARSE_COORDINATE" if request.query.uses_coordinates else "POSTAL_CODE"
    if upstream["query"]["mode"] != expected_mode:
        raise NetWorthV4ProjectionError(
            "request location mode does not match the upstream response"
        )
    if request.query.uses_coordinates:
        receipt = request.coordinate_consent
        assert receipt is not None
        generated_at = _generated_at(upstream)
        if not receipt.issued_at <= generated_at < receipt.expires_at:
            raise NetWorthV4ProjectionError(
                "coordinate consent is not valid at response generation time"
            )

    if request.selection.geography_mode == "strict-radius":
        search = upstream["search"]
        if search["performed"] and search["scope"] != "ASSOCIATION_RADIUS":
            raise NetWorthV4ProjectionError(
                "strict-radius cannot project a jurisdiction-wide upstream result"
            )
        maximum_miles = request.selection.maximum_radius_miles
        assert maximum_miles is not None
        maximum_km = maximum_miles * _KM_PER_MILE
        if search["performed"] and search["effective_radius_km"] > maximum_km + 0.01:
            raise NetWorthV4ProjectionError("upstream results exceed the strict radius")


def _shortfall_reasons(
    upstream: Mapping[str, Any],
    *,
    request: NetWorthV4Request,
    exclusions: Counter[str],
    returned_count: int,
) -> list[str]:
    if returned_count >= request.selection.count:
        return []
    reasons: list[str] = []
    financial_status = upstream["financial_coverage"]["status"]
    if financial_status in {"FINANCIAL_COVERAGE_INSUFFICIENT", "NOT_SEARCHED"}:
        reasons.append(financial_status)
    if not upstream["results"]:
        reasons.append("NO_UPSTREAM_FINANCIAL_RESULTS")
    reasons.extend(reason for reason, count in exclusions.items() if count)
    if request.selection.geography_mode == "nearest-count":
        reasons.append("UPSTREAM_NEAREST_COUNT_EXPANSION_INCOMPLETE")
    else:
        reasons.append("STRICT_RADIUS_LIMIT")
    reasons.append("INSUFFICIENT_ELIGIBLE_PROFILES")
    return list(dict.fromkeys(reasons))


def project_nearby_net_worth_v4(
    upstream_response: Mapping[str, object],
    request: NetWorthV4Request,
) -> NetWorthV4Response:
    """Project a validated v3 public response into a stricter, deterministic v4 view.

    This function performs no network, storage, authentication, or clock access. It cannot create
    financial evidence or geographic coverage that the upstream snapshot did not provide.
    """

    # Import lazily so this projection module can later be imported by app.main without a cycle.
    from app.main import NearbyNetWorthResponse

    try:
        validated = NearbyNetWorthResponse.model_validate(dict(upstream_response))
    except ValueError as exc:
        raise NetWorthV4ProjectionError("upstream response failed its existing contract") from exc
    upstream: dict[str, Any] = validated.model_dump(mode="json")
    _validate_projection_boundary(upstream, request)

    eligible: list[_EligibleRecord] = []
    exclusions: Counter[str] = Counter()
    for raw_result in upstream["results"]:
        observed_floor = _observed_floor(raw_result)
        source_families = _source_families(raw_result)
        reason = _eligibility_reason(
            raw_result,
            request=request,
            observed_floor=observed_floor,
            source_families=source_families,
        )
        if reason is not None:
            exclusions[reason] += 1
            continue
        eligible.append(
            _EligibleRecord(
                raw=raw_result,
                observed_floor=observed_floor,
                source_families=source_families,
            )
        )

    eligible.sort(key=lambda record: _sort_key(record, request.selection.financial_mode))
    selected = eligible[: request.selection.count]
    projected_results = [
        _project_result(
            record,
            rank=index + 1,
            all_eligible=eligible,
            mode=request.selection.financial_mode,
        )
        for index, record in enumerate(selected)
    ]
    returned_count = len(projected_results)
    reasons = _shortfall_reasons(
        upstream,
        request=request,
        exclusions=exclusions,
        returned_count=returned_count,
    )
    upstream_reasons = [
        reason
        for reason in upstream["result_set"]["reasons"]
        if isinstance(reason, str) and re.fullmatch(r"[A-Z0-9_]+", reason)
    ]
    disclosures = list(
        dict.fromkeys(
            [
                "UPSTREAM_SNAPSHOT_DECLARED_INCOMPLETE",
                "RANK_INTERVAL_AVAILABLE_SET_ONLY",
                "PUBLIC_ASSOCIATION_NOT_PHYSICAL_PRESENCE",
                "SOURCE_FAMILIES_REPLACE_RAW_CITATIONS",
                "QUOTA_ENFORCEMENT_PROCESS_LOCAL",
                "GEOGRAPHIC_HIERARCHY_NOT_YET_MATERIALIZED",
                "FINANCIAL_COVERAGE_NOT_NATIONWIDE",
                *upstream_reasons,
            ]
        )
    )
    financial = upstream["financial_coverage"]
    generated_at = _generated_at(upstream)
    return NetWorthV4Response.model_validate(
        {
            "contract_version": V4_CONTRACT_VERSION,
            "coverage_contract": V4_COVERAGE_CONTRACT,
            "data_tier": "PUBLIC_SAFE",
            "request_policy": {
                "project_id": request.caller_context.project_id,
                "purpose_id": request.caller_context.purpose_id,
                "authorization_scope": "PUBLIC_SAFE",
                "requested_data_tier": "PUBLIC_SAFE",
                "audit_actor_reference": "actor_"
                + hashlib.sha256(
                    (
                        request.caller_context.project_id
                        + "\x00"
                        + request.caller_context.audit_actor
                    ).encode("utf-8")
                ).hexdigest()[:16],
                "financial_mode": request.selection.financial_mode,
                "geography_mode": request.selection.geography_mode,
                "minimum_confidence": request.filters.minimum_confidence,
                "minimum_coverage": request.filters.minimum_coverage,
                "asset_families": request.filters.asset_families,
            },
            "query": upstream["query"],
            "coverage": {
                "status": upstream["coverage"]["status"],
                "reason_code": upstream["coverage"]["reason_code"],
                "market_label": upstream["coverage"]["market_label"],
                "country_code": upstream["coverage"]["country_code"],
            },
            "snapshot": {
                "model_version": upstream["snapshot"]["model_version"],
                "scale_version": upstream["snapshot"]["scale_version"],
                "as_of": upstream["snapshot"]["as_of"],
                "upstream_complete": upstream["snapshot"]["complete"],
            },
            "financial_coverage": {
                "upstream_status": financial["status"],
                "discovered_count": financial["discovered_count"],
                "evaluated_count": financial["evaluated_count"],
                "upstream_scored_count": financial["scored_count"],
                "v4_eligible_count": len(eligible),
            },
            "expansion": _expansion_accountability(
                upstream,
                request=request,
                eligible_count=len(eligible),
                returned_count=returned_count,
            ),
            "result_set": {
                "requested_count": request.selection.count,
                "upstream_result_count": len(upstream["results"]),
                "eligible_count": len(eligible),
                "returned_count": returned_count,
                "shortfall_count": max(0, request.selection.count - returned_count),
                "target_satisfied": returned_count >= request.selection.count,
                "reasons": reasons,
            },
            "generated_at": generated_at,
            "disclosures": disclosures,
            "results": projected_results,
        }
    )
