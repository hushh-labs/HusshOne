from __future__ import annotations

from math import sqrt

from app.geospatial import haversine_km, location_relevance
from app.nws_models import (
    GeoPoint,
    NearbyCandidate,
    NwsComponents,
    NwsScore,
    ProfessionalLane,
)


MODEL_VERSION = "nws-v2.1.0"


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _track_record(candidate: NearbyCandidate) -> float:
    features = candidate.features
    lane_weights: dict[ProfessionalLane, tuple[float, float, float]] = {
        ProfessionalLane.BUILDER: (0.60, 0.25, 0.15),
        ProfessionalLane.CAPITAL: (0.65, 0.15, 0.20),
        ProfessionalLane.KNOWLEDGE: (0.25, 0.65, 0.10),
        ProfessionalLane.CIVIC: (0.25, 0.10, 0.65),
        ProfessionalLane.CONNECTOR: (0.40, 0.25, 0.35),
        ProfessionalLane.GENERAL: (0.45, 0.30, 0.25),
    }
    outcome_weight, knowledge_weight, civic_weight = lane_weights[candidate.primary_lane]
    return _clamp(
        outcome_weight * features.outcome_track_record_percentile
        + knowledge_weight * features.knowledge_creation_percentile
        + civic_weight * features.civic_leadership_percentile
    )


def build_components(candidate: NearbyCandidate) -> NwsComponents:
    f = candidate.features
    graph = _clamp(
        0.42 * f.pagerank_percentile
        + 0.23 * f.kcore_percentile
        + 0.25 * f.bridging_percentile
        + 0.10 * f.cross_sector_percentile
    )
    institution = _clamp(
        0.45 * f.role_authority_percentile
        + 0.35 * f.institution_strength_percentile
        + 0.20 * f.founder_board_percentile
    )
    track = _track_record(candidate)
    capital = _clamp(f.capital_access_percentile)
    # Social reach is capped to 15% of a small reach component. It cannot create a high NWS alone.
    reach = _clamp(0.85 * f.trusted_reach_percentile + 0.15 * f.verified_social_reach_percentile)
    evidence = _clamp(
        0.40 * f.source_quality
        + 0.25 * f.source_diversity
        + 0.25 * f.identity_confidence
        + 0.10 * candidate.location.confidence
    )
    return NwsComponents(
        graph_authority=graph,
        institutional_influence=institution,
        verified_track_record=track,
        capital_access=capital,
        trusted_reach=reach,
        freshness=f.freshness,
        evidence_confidence=evidence,
    )


def _confidence_grade(confidence: float) -> str:
    if confidence >= 0.85:
        return "A"
    if confidence >= 0.70:
        return "B"
    if confidence >= 0.55:
        return "C"
    return "D"


def _explanations(components: NwsComponents, local: float, candidate: NearbyCandidate) -> tuple[str, ...]:
    labels = {
        "graph_authority": "Strong position in the verified professional graph",
        "institutional_influence": "High-authority roles at influential institutions",
        "verified_track_record": "Strong verified execution and achievement record",
        "capital_access": "Strong access to company-building or investment networks",
        "trusted_reach": "Meaningful reach through trusted public sources",
        "freshness": "Recent evidence supports the current profile",
        "evidence_confidence": "Identity and evidence are well corroborated",
    }
    ordered = sorted(components.as_dict().items(), key=lambda item: (-item[1], item[0]))
    reasons = [labels[name] for name, _ in ordered[:3]]
    if local >= 0.65:
        reasons.append(f"Strong public professional association with {candidate.location.label}")
    elif local >= 0.35:
        reasons.append(f"Relevant public professional association with {candidate.location.label}")
    return tuple(reasons[:4])


def _warnings(candidate: NearbyCandidate, confidence: float) -> tuple[str, ...]:
    f = candidate.features
    warnings: list[str] = []
    if f.evidence_count < 5:
        warnings.append("Limited evidence coverage; score is conservative.")
    if f.dominant_source_ratio > 0.75:
        warnings.append("Most evidence comes from one source family.")
    if f.self_published_source_ratio > 0.60:
        warnings.append("A large share of evidence is self-published.")
    if f.suspicious_pattern_ratio > 0.25:
        warnings.append("Possible promotional or reciprocal-network inflation was discounted.")
    if confidence < 0.55:
        warnings.append("Low-confidence profile; review before prominent placement.")
    return tuple(warnings)


def score_candidate(
    candidate: NearbyCandidate,
    *,
    query_point: GeoPoint,
    radius_km: float,
) -> NwsScore:
    components = build_components(candidate)
    f = candidate.features

    weighted = (
        0.30 * components.graph_authority
        + 0.20 * components.institutional_influence
        + 0.20 * components.verified_track_record
        + 0.10 * components.capital_access
        + 0.07 * components.trusted_reach
        + 0.05 * components.freshness
        + 0.08 * components.evidence_confidence
    )
    # A small balance term prevents one-dimensional profiles from winning on a single signal.
    balance = sqrt(
        max(0.02, components.graph_authority)
        * max(0.02, max(components.institutional_influence, components.verified_track_record))
    )
    base = 0.88 * weighted + 0.12 * balance

    coverage = min(1.0, sqrt(f.evidence_count / 12.0)) if f.evidence_count else 0.0
    coverage_multiplier = 0.78 + 0.22 * coverage
    anti_gaming_penalty = min(
        0.30,
        0.18 * f.suspicious_pattern_ratio
        + 0.07 * f.self_published_source_ratio
        + 0.08 * f.dominant_source_ratio,
    )
    global_nws = 100.0 * _clamp(base * coverage_multiplier * (1.0 - anti_gaming_penalty))

    distance = haversine_km(query_point, candidate.location.point)
    local = location_relevance(
        distance,
        radius_km=radius_km,
        location_confidence=candidate.location.confidence,
    )
    nearby_score = 0.90 * global_nws + 0.10 * (100.0 * local)

    confidence = _clamp(
        components.evidence_confidence
        * (0.72 + 0.28 * coverage)
        * (1.0 - 0.35 * f.suspicious_pattern_ratio)
    )
    return NwsScore(
        person_id=candidate.person_id,
        global_nws=round(global_nws, 4),
        nearby_rank_score=round(nearby_score, 4),
        local_relevance=round(local, 4),
        distance_km=round(distance, 3),
        confidence=round(confidence, 4),
        confidence_grade=_confidence_grade(confidence),
        components=components,
        reasons=_explanations(components, local, candidate),
        warnings=_warnings(candidate, confidence),
        model_version=MODEL_VERSION,
    )
