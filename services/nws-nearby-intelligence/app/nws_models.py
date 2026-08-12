from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import StrEnum
from typing import Mapping


class ProfileClass(StrEnum):
    """Which profiles may be shown in a named nearby result."""

    PUBLIC_FIGURE = "PUBLIC_FIGURE"
    PUBLIC_PROFESSIONAL = "PUBLIC_PROFESSIONAL"
    OPTED_IN = "OPTED_IN"
    PRIVATE_PERSON = "PRIVATE_PERSON"


class VerificationStatus(StrEnum):
    VERIFIED = "VERIFIED"
    PENDING_REVIEW = "PENDING_REVIEW"
    REJECTED = "REJECTED"


class ProfessionalLane(StrEnum):
    BUILDER = "BUILDER"
    CAPITAL = "CAPITAL"
    KNOWLEDGE = "KNOWLEDGE"
    CIVIC = "CIVIC"
    CONNECTOR = "CONNECTOR"
    GENERAL = "GENERAL"


class LocationAssociationKind(StrEnum):
    """Public professional association only; not a private residential assertion."""

    SELF_PUBLISHED_PROFESSIONAL = "SELF_PUBLISHED_PROFESSIONAL"
    OFFICIAL_BIO = "OFFICIAL_BIO"
    CURRENT_ORGANIZATION_OFFICE = "CURRENT_ORGANIZATION_OFFICE"
    PUBLIC_SERVICE_JURISDICTION = "PUBLIC_SERVICE_JURISDICTION"
    OPT_IN_LOCATION = "OPT_IN_LOCATION"
    EVENT_ONLY = "EVENT_ONLY"


class LocationGranularity(StrEnum):
    CITY = "CITY"
    POSTAL_AREA = "POSTAL_AREA"
    METRO = "METRO"
    REGION = "REGION"
    EXACT_PUBLIC_VENUE = "EXACT_PUBLIC_VENUE"


@dataclass(frozen=True)
class GeoPoint:
    latitude: float
    longitude: float

    def __post_init__(self) -> None:
        if not -90 <= self.latitude <= 90:
            raise ValueError("latitude must be in [-90, 90]")
        if not -180 <= self.longitude <= 180:
            raise ValueError("longitude must be in [-180, 180]")


@dataclass(frozen=True)
class PublicLocationAssociation:
    label: str
    point: GeoPoint
    kind: LocationAssociationKind
    granularity: LocationGranularity
    confidence: float
    source_count: int
    as_of_date: date

    def __post_init__(self) -> None:
        if not self.label.strip():
            raise ValueError("location label is required")
        if not 0 <= self.confidence <= 1:
            raise ValueError("location confidence must be in [0, 1]")
        if self.source_count < 1:
            raise ValueError("source_count must be at least one")


@dataclass(frozen=True)
class NwsFeatureVector:
    """Normalized, quality-reviewed inputs in the [0, 1] interval.

    These are not direct raw counts. Raw counts are log-scaled, winsorized and converted
    to peer-cohort percentiles before being assembled into this feature vector.
    """

    pagerank_percentile: float
    kcore_percentile: float
    bridging_percentile: float
    cross_sector_percentile: float

    role_authority_percentile: float
    institution_strength_percentile: float
    founder_board_percentile: float

    outcome_track_record_percentile: float
    knowledge_creation_percentile: float
    civic_leadership_percentile: float

    capital_access_percentile: float
    trusted_reach_percentile: float
    verified_social_reach_percentile: float

    freshness: float
    source_quality: float
    source_diversity: float
    identity_confidence: float

    evidence_count: int
    suspicious_pattern_ratio: float = 0.0
    self_published_source_ratio: float = 0.0
    dominant_source_ratio: float = 0.0

    def __post_init__(self) -> None:
        for field_name, value in self.__dict__.items():
            if field_name == "evidence_count":
                if value < 0:
                    raise ValueError("evidence_count cannot be negative")
                continue
            if not 0 <= float(value) <= 1:
                raise ValueError(f"{field_name} must be in [0, 1]")


@dataclass(frozen=True)
class NearbyCandidate:
    person_id: str
    display_name: str
    headline: str
    profile_class: ProfileClass
    verification_status: VerificationStatus
    primary_lane: ProfessionalLane
    organization_id: str | None
    organization_name: str | None
    graph_community_id: str | None
    location: PublicLocationAssociation
    features: NwsFeatureVector
    public_profile_url: str | None = None
    tags: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if not self.person_id.strip():
            raise ValueError("person_id is required")
        if not self.display_name.strip():
            raise ValueError("display_name is required")
        if not self.headline.strip():
            raise ValueError("headline is required")


@dataclass(frozen=True)
class NwsComponents:
    graph_authority: float
    institutional_influence: float
    verified_track_record: float
    capital_access: float
    trusted_reach: float
    freshness: float
    evidence_confidence: float

    def as_dict(self) -> Mapping[str, float]:
        return {
            "graph_authority": self.graph_authority,
            "institutional_influence": self.institutional_influence,
            "verified_track_record": self.verified_track_record,
            "capital_access": self.capital_access,
            "trusted_reach": self.trusted_reach,
            "freshness": self.freshness,
            "evidence_confidence": self.evidence_confidence,
        }


@dataclass(frozen=True)
class NwsScore:
    person_id: str
    global_nws: float
    nearby_rank_score: float
    local_relevance: float
    distance_km: float
    confidence: float
    confidence_grade: str
    components: NwsComponents
    reasons: tuple[str, ...]
    warnings: tuple[str, ...]
    model_version: str


@dataclass(frozen=True)
class NearbyRankedPerson:
    rank: int
    candidate: NearbyCandidate
    score: NwsScore


@dataclass(frozen=True)
class NearbyDiscoverySummary:
    query_radius_km: float
    effective_radius_km: float
    candidate_pool_size: int
    eligible_candidate_count: int
    confidence_eligible_candidate_count: int
    returned_count: int
    expansion_steps: tuple[float, ...]
    diversity_applied: bool
