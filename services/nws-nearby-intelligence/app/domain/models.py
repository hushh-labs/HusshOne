from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from enum import StrEnum
from typing import Any, Iterable

import numpy as np


class SubjectType(StrEnum):
    PUBLIC_FIGURE = "PUBLIC_FIGURE"
    ANONYMOUS_ASSET_CLUSTER = "ANONYMOUS_ASSET_CLUSTER"
    PRIVATE_PERSON = "PRIVATE_PERSON"  # Explicitly blocked from named wealth output.


class PublicFigureStatus(StrEnum):
    VERIFIED = "VERIFIED"
    PENDING_REVIEW = "PENDING_REVIEW"
    REJECTED = "REJECTED"


class EvidenceUse(StrEnum):
    WEALTH = "WEALTH"
    AFFLUENCE = "AFFLUENCE"
    AFFILIATION = "AFFILIATION"
    DISAMBIGUATION = "DISAMBIGUATION"
    PHILANTHROPY_CONTEXT = "PHILANTHROPY_CONTEXT"


class EvidenceKind(StrEnum):
    SEC_OWNERSHIP = "SEC_OWNERSHIP"
    SEC_PROXY = "SEC_PROXY"
    SEC_MAJOR_HOLDER = "SEC_MAJOR_HOLDER"
    MARKET_PRICE = "MARKET_PRICE"
    PRIVATE_COMPANY_DISCLOSURE = "PRIVATE_COMPANY_DISCLOSURE"
    SELF_DISCLOSED_REAL_ESTATE = "SELF_DISCLOSED_REAL_ESTATE"
    DISCLOSED_LIABILITY = "DISCLOSED_LIABILITY"
    PROPERTY_ASSESSMENT = "PROPERTY_ASSESSMENT"
    PROPERTY_SALE = "PROPERTY_SALE"
    ACS_CONTEXT = "ACS_CONTEXT"
    IRS_990 = "IRS_990"
    OFFICIAL_BIO = "OFFICIAL_BIO"
    PUBLIC_WEB = "PUBLIC_WEB"
    PUBLIC_SOCIAL = "PUBLIC_SOCIAL"


class AssetCategory(StrEnum):
    PUBLIC_EQUITY = "PUBLIC_EQUITY"
    OPTIONS = "OPTIONS"
    PRIVATE_EQUITY = "PRIVATE_EQUITY"
    REAL_ESTATE = "REAL_ESTATE"
    CASH_OR_OTHER_DISCLOSED = "CASH_OR_OTHER_DISCLOSED"
    LIABILITY = "LIABILITY"


@dataclass(frozen=True)
class Subject:
    subject_id: str
    subject_type: SubjectType
    display_name: str | None = None
    public_figure_status: PublicFigureStatus | None = None

    def __post_init__(self) -> None:
        if self.subject_type is SubjectType.PUBLIC_FIGURE:
            if not self.display_name:
                raise ValueError("A public figure requires a display name.")
            if self.public_figure_status is None:
                raise ValueError("A public figure requires a verification status.")
        if self.subject_type is SubjectType.ANONYMOUS_ASSET_CLUSTER and self.display_name:
            raise ValueError("Anonymous asset clusters must not carry a personal display name.")


@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    subject_id: str
    subject_type: SubjectType
    kind: EvidenceKind
    allowed_uses: frozenset[EvidenceUse]
    source_authority: str
    source_uri: str
    source_date: date
    retrieved_at: datetime
    artifact_sha256: str
    reliability: float
    facts: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not 0.0 <= self.reliability <= 1.0:
            raise ValueError("reliability must be between 0 and 1")
        if self.retrieved_at.tzinfo is None:
            raise ValueError("retrieved_at must be timezone-aware")
        if len(self.artifact_sha256) != 64:
            raise ValueError("artifact_sha256 must be a 64-character SHA-256 hex digest")


@dataclass(frozen=True)
class TriangularDistribution:
    low: float
    mode: float
    high: float

    def __post_init__(self) -> None:
        if self.low < 0:
            raise ValueError("low cannot be negative")
        if not self.low <= self.mode <= self.high:
            raise ValueError("expected low <= mode <= high")

    def sample(self, rng: np.random.Generator, size: int) -> np.ndarray:
        if self.low == self.high:
            return np.full(size, self.low, dtype=float)
        return rng.triangular(self.low, self.mode, self.high, size=size)


@dataclass(frozen=True)
class EstimateComponent:
    component_id: str
    subject_id: str
    category: AssetCategory
    distribution: TriangularDistribution
    evidence_ids: tuple[str, ...]
    quality_score: float
    as_of_date: date
    double_count_group: str | None = None
    notes: str | None = None

    def __post_init__(self) -> None:
        if not 0.0 <= self.quality_score <= 1.0:
            raise ValueError("quality_score must be between 0 and 1")
        if not self.evidence_ids:
            raise ValueError("every estimate component must have evidence")


@dataclass(frozen=True)
class ValuationSummary:
    subject_id: str
    p05_usd: float
    median_usd: float
    p95_usd: float
    mean_usd: float
    probability_negative: float
    simulation_count: int
    model_version: str


@dataclass(frozen=True)
class RankSummary:
    subject_id: str
    median_rank: int
    rank_p05: int
    rank_p95: int
    probability_top_n: float
    target_n: int
    simulation_count: int


@dataclass(frozen=True)
class AnonymousAssetFeatures:
    anonymous_id: str
    assessed_value: float | None
    indexed_sale_value: float | None
    improvement_value: float | None
    lot_area_sqft: float | None
    building_area_sqft: float | None
    quality_index: float | None
    waterfront_flag: bool | None
    acs_income_context: float | None
    acs_home_value_context: float | None
    evidence_recency: float | None

    def __post_init__(self) -> None:
        if not self.anonymous_id.startswith("KIR-98033-"):
            raise ValueError("anonymous_id must use the KIR-98033-* namespace")
        for value in (
            self.assessed_value,
            self.indexed_sale_value,
            self.improvement_value,
            self.lot_area_sqft,
            self.building_area_sqft,
            self.quality_index,
            self.acs_income_context,
            self.acs_home_value_context,
            self.evidence_recency,
        ):
            if value is not None and value < 0:
                raise ValueError("numeric affluence features cannot be negative")


@dataclass(frozen=True)
class AnonymousAffluenceResult:
    anonymous_id: str
    score: float
    rank: int
    missing_feature_count: int
    confidence: str


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_same_subject(components: Iterable[EstimateComponent]) -> str:
    subject_ids = {component.subject_id for component in components}
    if len(subject_ids) != 1:
        raise ValueError("all estimate components must refer to the same subject")
    return next(iter(subject_ids))
