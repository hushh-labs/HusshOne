from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from math import ceil

from app.geospatial import haversine_km
from app.nearby_policy import NearbyPolicyEngine
from app.nws import score_candidate
from app.nws_models import (
    GeoPoint,
    NearbyCandidate,
    NearbyDiscoverySummary,
    NearbyRankedPerson,
    NwsScore,
)


@dataclass(frozen=True)
class _ScoredCandidate:
    candidate: NearbyCandidate
    score: NwsScore


def _candidate_similarity(left: NearbyCandidate, right: NearbyCandidate) -> float:
    similarity = 0.0
    if left.organization_id and left.organization_id == right.organization_id:
        similarity += 0.60
    if left.graph_community_id and left.graph_community_id == right.graph_community_id:
        similarity += 0.25
    if left.primary_lane == right.primary_lane:
        similarity += 0.15
    return min(1.0, similarity)


def _diversified_select(
    records: list[_ScoredCandidate],
    *,
    count: int,
    lambda_relevance: float = 0.88,
) -> list[_ScoredCandidate]:
    if count <= 0 or not records:
        return []

    organization_limit = max(5, ceil(count * 0.08))
    community_limit = max(10, ceil(count * 0.20))
    selected: list[_ScoredCandidate] = []
    remaining = list(records)
    organization_counts: Counter[str] = Counter()
    community_counts: Counter[str] = Counter()

    while remaining and len(selected) < count:
        eligible: list[_ScoredCandidate] = []
        for item in remaining:
            organization = item.candidate.organization_id
            community = item.candidate.graph_community_id
            if organization and organization_counts[organization] >= organization_limit:
                continue
            if community and community_counts[community] >= community_limit:
                continue
            eligible.append(item)

        # Relax caps rather than silently returning fewer results when the local graph is sparse.
        pool = eligible or remaining
        best: _ScoredCandidate | None = None
        best_mmr = float("-inf")
        for item in pool:
            relevance = item.score.nearby_rank_score / 100.0
            redundancy = max(
                (_candidate_similarity(item.candidate, prior.candidate) for prior in selected),
                default=0.0,
            )
            mmr = lambda_relevance * relevance - (1.0 - lambda_relevance) * redundancy
            # Stable deterministic tie breaking without an opaque numeric epsilon.
            if (
                best is None
                or mmr > best_mmr
                or (mmr == best_mmr and item.candidate.person_id < best.candidate.person_id)
            ):
                best_mmr = mmr
                best = item

        assert best is not None
        selected.append(best)
        remaining.remove(best)
        if best.candidate.organization_id:
            organization_counts[best.candidate.organization_id] += 1
        if best.candidate.graph_community_id:
            community_counts[best.candidate.graph_community_id] += 1

    return selected


def discover_nearby_people(
    candidates: Iterable[NearbyCandidate],
    *,
    query_point: GeoPoint,
    top_n: int = 100,
    initial_radius_km: float = 20.0,
    max_radius_km: float = 100.0,
    auto_expand: bool = True,
    diversity: bool = True,
    minimum_confidence: float = 0.70,
    policy: NearbyPolicyEngine | None = None,
    model_version: str | None = None,
) -> tuple[list[NearbyRankedPerson], NearbyDiscoverySummary]:
    """Filter, score and rank verified nearby public professionals.

    Production candidate retrieval happens in PostGIS. This deterministic implementation is the
    executable reference for confidence gating, radius expansion, scoring and diversification.
    """

    if not 1 <= top_n <= 400:
        raise ValueError("top_n must be between 1 and 400")
    if initial_radius_km <= 0:
        raise ValueError("initial_radius_km must be positive")
    if max_radius_km < initial_radius_km:
        raise ValueError("max_radius_km must be >= initial_radius_km")
    if not 0 <= minimum_confidence <= 1:
        raise ValueError("minimum_confidence must be in [0, 1]")

    policy = policy or NearbyPolicyEngine()
    candidate_list = list(candidates)
    policy_eligible = [item for item in candidate_list if policy.authorize_candidate(item).allowed]
    distances = {
        item.person_id: haversine_km(query_point, item.location.point) for item in policy_eligible
    }

    # Confidence and Global NWS do not depend on the effective search radius. A preliminary pass
    # lets radius expansion count only profiles that can actually be published at this threshold.
    preliminary = {
        item.person_id: score_candidate(
            item,
            query_point=query_point,
            radius_km=max_radius_km,
            **({"model_version": model_version} if model_version else {}),
        )
        for item in policy_eligible
    }
    confidence_eligible = [
        item
        for item in policy_eligible
        if preliminary[item.person_id].confidence >= minimum_confidence
    ]

    effective_radius = initial_radius_km
    expansion_steps = [effective_radius]
    desired_pool = min(len(confidence_eligible), max(top_n, ceil(top_n * 1.6)))
    while auto_expand:
        pool_size = sum(
            distances[item.person_id] <= effective_radius for item in confidence_eligible
        )
        if pool_size >= desired_pool or effective_radius >= max_radius_km:
            break
        effective_radius = min(max_radius_km, effective_radius * 1.75)
        if effective_radius == expansion_steps[-1]:
            break
        expansion_steps.append(effective_radius)

    in_radius = [
        item for item in confidence_eligible if distances[item.person_id] <= effective_radius
    ]
    scored = [
        _ScoredCandidate(
            candidate=item,
            score=score_candidate(
                item,
                query_point=query_point,
                radius_km=effective_radius,
                **({"model_version": model_version} if model_version else {}),
            ),
        )
        for item in in_radius
    ]
    scored.sort(
        key=lambda item: (
            -item.score.nearby_rank_score,
            -item.score.global_nws,
            -item.score.confidence,
            item.candidate.person_id,
        )
    )

    chosen = (
        _diversified_select(scored, count=min(top_n, len(scored))) if diversity else scored[:top_n]
    )
    results = [
        NearbyRankedPerson(rank=index + 1, candidate=item.candidate, score=item.score)
        for index, item in enumerate(chosen)
    ]
    summary = NearbyDiscoverySummary(
        query_radius_km=initial_radius_km,
        effective_radius_km=round(effective_radius, 3),
        candidate_pool_size=len(candidate_list),
        eligible_candidate_count=len(policy_eligible),
        confidence_eligible_candidate_count=len(confidence_eligible),
        returned_count=len(results),
        expansion_steps=tuple(round(step, 3) for step in expansion_steps),
        diversity_applied=diversity,
    )
    return results, summary
