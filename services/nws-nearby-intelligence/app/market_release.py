"""Load the reviewed, public-association market release used by the live API.

This module is deliberately a small, deterministic release loader rather than a
collector.  A person enters this release only after a reviewer has confirmed a
public professional role and a public organization, campus, civic, or office
association.  It is not a live people-search or device-location data source.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit

from app.nws_models import (
    GeoPoint,
    LocationAssociationKind,
    LocationGranularity,
    NearbyCandidate,
    NwsFeatureVector,
    ProfessionalLane,
    ProfileClass,
    PublicLocationAssociation,
    VerificationStatus,
)

_RELEASE_PATH = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "markets"
    / "us-wa-kirkland"
    / "2026-08-13"
    / "release.json"
)
_REQUIRED_FACT_TYPES = {
    "identity",
    "current_role",
    "organization_identity",
    "public_association",
}


@dataclass(frozen=True)
class SourceCitation:
    publisher: str
    title: str
    url: str
    fact_types: tuple[str, ...]
    retrieved_at: str


@dataclass(frozen=True)
class BootstrapMetadata:
    """Public metadata retained under the old name for route compatibility.

    ``source_family_count`` is intentionally separate from ``citation_count``:
    two pages on the same organization domain do not become independent
    corroboration merely by appearing twice in a record.
    """

    score_status: str
    revalidation_required: bool
    citations: tuple[SourceCitation, ...]
    source_family_count: int
    evidence_fact_count: int
    review_flags: tuple[str, ...]


@dataclass(frozen=True)
class MarketRelease:
    release_id: str
    market_id: str
    market_label: str
    reviewed_at: str
    source_retrieved_at: str
    source_policy_version: str
    model_version: str
    candidates: tuple[NearbyCandidate, ...]
    metadata: dict[str, BootstrapMetadata]
    candidate_set_sha256: str
    source_registry_sha256: str
    manifest_sha256: str


@dataclass(frozen=True)
class _RoleSignals:
    graph: float
    institution: float
    founder_or_board: float
    outcome: float
    knowledge: float
    civic: float
    capital: float
    reach: float


# These are conservative, role-taxonomy priors for the provisional NWS model.
# They are not claims of a measured social graph, wealth, private network, or
# physical presence.  Source quality and concentration are calculated from the
# release evidence below rather than supplied as per-person "strength" values.
_ROLE_SIGNALS: dict[str, _RoleSignals] = {
    "CORPORATE_EXECUTIVE": _RoleSignals(0.68, 0.82, 0.52, 0.72, 0.34, 0.18, 0.58, 0.56),
    "FOUNDER_EXECUTIVE": _RoleSignals(0.72, 0.80, 0.82, 0.75, 0.36, 0.18, 0.64, 0.60),
    "CIVIC_ELECTED": _RoleSignals(0.62, 0.76, 0.22, 0.56, 0.32, 0.86, 0.36, 0.57),
    "CIVIC_EXECUTIVE": _RoleSignals(0.64, 0.79, 0.24, 0.64, 0.34, 0.80, 0.40, 0.55),
    "EDUCATION_EXECUTIVE": _RoleSignals(0.61, 0.78, 0.30, 0.64, 0.76, 0.42, 0.38, 0.52),
    "INSTITUTION_EXECUTIVE": _RoleSignals(0.66, 0.80, 0.36, 0.70, 0.56, 0.34, 0.46, 0.54),
    "COMMERCIAL_LEADER": _RoleSignals(0.58, 0.68, 0.36, 0.60, 0.32, 0.20, 0.48, 0.48),
    "COMMUNITY_LEADER": _RoleSignals(0.56, 0.64, 0.50, 0.56, 0.36, 0.48, 0.42, 0.62),
}


def _canonical_json(payload: object) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def _source_family(url: str) -> str:
    host = urlsplit(url).hostname
    if not host:
        raise ValueError(f"Citation URL has no hostname: {url}")
    return host.removeprefix("www.").casefold()


def _feature_vector(
    *,
    role_profile: str,
    lane: ProfessionalLane,
    source_family_count: int,
    evidence_fact_count: int,
    review_flags: tuple[str, ...],
) -> NwsFeatureVector:
    try:
        signals = _ROLE_SIGNALS[role_profile]
    except KeyError as exc:
        raise ValueError(f"Unsupported role profile: {role_profile}") from exc

    source_diversity = 0.90 if source_family_count >= 2 else 0.58
    source_quality = 0.92
    identity_confidence = 0.93
    if "ROLE_REFRESH_REQUIRED" in review_flags:
        source_quality = 0.87
        identity_confidence = 0.90

    civic_bonus = 0.05 if lane is ProfessionalLane.CIVIC else 0.0
    knowledge_bonus = 0.05 if lane is ProfessionalLane.KNOWLEDGE else 0.0
    builder_bonus = 0.04 if lane is ProfessionalLane.BUILDER else 0.0
    return NwsFeatureVector(
        pagerank_percentile=signals.graph,
        kcore_percentile=max(0.0, signals.graph - 0.04),
        bridging_percentile=max(0.0, signals.graph - 0.08),
        cross_sector_percentile=max(0.0, signals.graph - 0.12),
        role_authority_percentile=signals.institution,
        institution_strength_percentile=max(0.0, signals.institution - 0.04),
        founder_board_percentile=min(1.0, signals.founder_or_board + builder_bonus),
        outcome_track_record_percentile=signals.outcome,
        knowledge_creation_percentile=min(1.0, signals.knowledge + knowledge_bonus),
        civic_leadership_percentile=min(1.0, signals.civic + civic_bonus),
        capital_access_percentile=signals.capital,
        trusted_reach_percentile=signals.reach,
        verified_social_reach_percentile=min(0.30, signals.reach * 0.35),
        freshness=0.92,
        source_quality=source_quality,
        source_diversity=source_diversity,
        identity_confidence=identity_confidence,
        evidence_count=evidence_fact_count,
        suspicious_pattern_ratio=0.0,
        self_published_source_ratio=0.0,
        dominant_source_ratio=round(1.0 / source_family_count, 4),
    )


def _read_citations(
    raw_sources: list[dict[str, object]], *, source_retrieved_at: str
) -> tuple[SourceCitation, ...]:
    citations: list[SourceCitation] = []
    seen_facts: set[tuple[str, str]] = set()
    for item in raw_sources:
        publisher = str(item["publisher"]).strip()
        title = str(item["title"]).strip()
        url = str(item["url"]).strip()
        facts = tuple(str(fact).strip() for fact in item["fact_types"])
        if not publisher or not title or not url or not facts:
            raise ValueError("Each release citation needs publisher, title, URL, and fact types")
        _source_family(url)
        for fact in facts:
            key = (url, fact)
            if key in seen_facts:
                raise ValueError(f"Duplicate evidence fact in release: {url} / {fact}")
            seen_facts.add(key)
        citations.append(
            SourceCitation(
                publisher,
                title,
                url,
                facts,
                str(item.get("retrieved_at", source_retrieved_at)),
            )
        )
    if not citations:
        raise ValueError("A release source set cannot be empty")
    return tuple(citations)


def _build_candidate(
    *,
    raw: dict[str, object],
    venues: dict[str, dict[str, object]],
    source_sets: dict[str, list[dict[str, object]]],
    reviewed_on: date,
    source_retrieved_at: str,
) -> tuple[NearbyCandidate, BootstrapMetadata]:
    evidence_set = str(raw["evidence_set"])
    venue_id = str(raw["venue_id"])
    try:
        citations = _read_citations(
            source_sets[evidence_set], source_retrieved_at=source_retrieved_at
        )
        venue = venues[venue_id]
    except KeyError as exc:
        raise ValueError(f"Unknown release reference: {exc.args[0]}") from exc

    source_families = {_source_family(citation.url) for citation in citations}
    evidence_fact_count = sum(len(citation.fact_types) for citation in citations)
    if not _REQUIRED_FACT_TYPES.issubset(
        {fact for citation in citations for fact in citation.fact_types}
    ):
        raise ValueError(f"Release candidate {raw['person_id']} lacks required reviewed fact types")

    review_flags = tuple(str(flag) for flag in raw.get("review_flags", []))
    if len(source_families) < 2 and "SINGLE_SOURCE_FAMILY" not in review_flags:
        review_flags = (*review_flags, "SINGLE_SOURCE_FAMILY")
    role_profile = str(raw["role_profile"])
    lane = ProfessionalLane(str(raw["lane"]))
    point = GeoPoint(float(venue["latitude"]), float(venue["longitude"]))
    candidate = NearbyCandidate(
        person_id=str(raw["person_id"]),
        display_name=str(raw["display_name"]),
        headline=str(raw["headline"]),
        profile_class=ProfileClass.PUBLIC_PROFESSIONAL,
        verification_status=VerificationStatus.VERIFIED,
        primary_lane=lane,
        organization_id=str(raw["organization_id"]),
        organization_name=str(raw["organization_name"]),
        graph_community_id=f"kirkland-{lane.value.casefold()}",
        location=PublicLocationAssociation(
            label=str(raw["location_label"]),
            point=point,
            kind=LocationAssociationKind(str(raw["association_kind"])),
            granularity=LocationGranularity(str(raw["granularity"])),
            confidence=float(venue["confidence"]),
            source_count=len(citations),
            as_of_date=reviewed_on,
        ),
        features=_feature_vector(
            role_profile=role_profile,
            lane=lane,
            source_family_count=len(source_families),
            evidence_fact_count=evidence_fact_count,
            review_flags=review_flags,
        ),
        tags=tuple(str(tag) for tag in raw["tags"]),
    )
    return candidate, BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=bool(review_flags),
        citations=citations,
        source_family_count=len(source_families),
        evidence_fact_count=evidence_fact_count,
        review_flags=review_flags,
    )


def load_market_release(path: Path = _RELEASE_PATH) -> MarketRelease:
    """Validate and load an immutable reviewed-market manifest."""

    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw["schema_version"] != 1:
        raise ValueError("Unsupported market-release schema version")
    reviewed_on = date.fromisoformat(str(raw["reviewed_at"]))
    source_retrieved_at = str(raw["source_retrieved_at"])
    date.fromisoformat(source_retrieved_at)
    venues = raw["venues"]
    source_sets = raw["source_sets"]
    raw_candidates = raw["candidates"]
    if raw["candidate_count"] != len(raw_candidates):
        raise ValueError("Release candidate_count does not match candidates")

    candidates: list[NearbyCandidate] = []
    metadata: dict[str, BootstrapMetadata] = {}
    for candidate_raw in raw_candidates:
        candidate, candidate_metadata = _build_candidate(
            raw=candidate_raw,
            venues=venues,
            source_sets=source_sets,
            reviewed_on=reviewed_on,
            source_retrieved_at=source_retrieved_at,
        )
        if candidate.person_id in metadata:
            raise ValueError(f"Duplicate person_id in market release: {candidate.person_id}")
        candidates.append(candidate)
        metadata[candidate.person_id] = candidate_metadata

    if len(candidates) < 1:
        raise ValueError("Market release has no candidates")
    return MarketRelease(
        release_id=str(raw["release_id"]),
        market_id=str(raw["market_id"]),
        market_label=str(raw["market_label"]),
        reviewed_at=reviewed_on.isoformat(),
        source_retrieved_at=source_retrieved_at,
        source_policy_version=str(raw["source_policy_version"]),
        model_version=str(raw["model_version"]),
        candidates=tuple(candidates),
        metadata=metadata,
        candidate_set_sha256=sha256(_canonical_json(raw_candidates)).hexdigest(),
        source_registry_sha256=sha256(_canonical_json(source_sets)).hexdigest(),
        manifest_sha256=sha256(_canonical_json(raw)).hexdigest(),
    )


@lru_cache(maxsize=1)
def get_market_release() -> MarketRelease:
    return load_market_release()
