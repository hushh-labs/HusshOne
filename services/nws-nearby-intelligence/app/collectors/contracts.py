from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum


class AcquisitionMode(StrEnum):
    BULK_FILE = "BULK_FILE"
    PUBLIC_PAGE = "PUBLIC_PAGE"
    SNAPSHOT = "SNAPSHOT"
    INCREMENTAL_DUMP = "INCREMENTAL_DUMP"


class SourceTrustTier(StrEnum):
    AUTHORITATIVE = "AUTHORITATIVE"
    PRIMARY = "PRIMARY"
    CORROBORATIVE = "CORROBORATIVE"
    DISCOVERY_ONLY = "DISCOVERY_ONLY"


class CandidateProposalMode(StrEnum):
    """How observations from a source may enter the organization review plane.

    A source contract can never authorize a direct write into a public NWS
    release.  The only non-discovery option is a proposal that still requires
    a human reviewer and a separately versioned market release.
    """

    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    DISCOVERY_ONLY = "DISCOVERY_ONLY"


@dataclass(frozen=True)
class SourceContract:
    source_id: str
    authority: str
    acquisition_mode: AcquisitionMode
    trust_tier: SourceTrustTier
    base_reliability: float
    allowed_fact_types: frozenset[str]
    forbidden_fact_types: frozenset[str]
    requests_per_second: float = 1.0
    obey_robots_txt: bool = True
    user_agent: str = "NWSResearchBot/1.0 contact@example.invalid"
    source_family: str | None = None
    candidate_proposal_mode: CandidateProposalMode = CandidateProposalMode.REVIEW_REQUIRED
    metadata: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.source_id.strip():
            raise ValueError("source_id is required")
        if not 0 <= self.base_reliability <= 1:
            raise ValueError("base_reliability must be in [0, 1]")
        if self.requests_per_second <= 0:
            raise ValueError("requests_per_second must be positive")
        if self.source_family is not None and not self.source_family.strip():
            raise ValueError("source_family cannot be blank when supplied")
        overlap = self.allowed_fact_types & self.forbidden_fact_types
        if overlap:
            raise ValueError(f"fact types cannot be both allowed and forbidden: {sorted(overlap)}")


@dataclass(frozen=True)
class ArtifactManifest:
    source_id: str
    requested_uri: str
    final_uri: str
    retrieved_at: datetime
    status_code: int
    content_type: str | None
    content_length: int
    sha256: str
    etag: str | None = None
    last_modified: str | None = None
    fetcher_version: str = "fetch-v1"
    parser_hint: str | None = None

    def __post_init__(self) -> None:
        if self.retrieved_at.tzinfo is None:
            raise ValueError("retrieved_at must be timezone-aware")
        if len(self.sha256) != 64:
            raise ValueError("sha256 must be a 64-character digest")
        if self.content_length < 0:
            raise ValueError("content_length cannot be negative")

    @staticmethod
    def now() -> datetime:
        return datetime.now(UTC)


@dataclass(frozen=True)
class ParsedObservation:
    observation_id: str
    source_id: str
    artifact_sha256: str
    parser_version: str
    fact_type: str
    subject_external_id: str
    object_external_id: str | None
    confidence: float
    occurred_on: str | None
    attributes: Mapping[str, object]

    def __post_init__(self) -> None:
        if not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be in [0, 1]")
        if len(self.artifact_sha256) != 64:
            raise ValueError("artifact_sha256 must be a SHA-256 digest")
