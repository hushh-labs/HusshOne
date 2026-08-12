from datetime import date

from app.nearby import discover_nearby_people
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


def feature(score: float) -> NwsFeatureVector:
    return NwsFeatureVector(
        pagerank_percentile=score,
        kcore_percentile=score,
        bridging_percentile=score,
        cross_sector_percentile=score,
        role_authority_percentile=score,
        institution_strength_percentile=score,
        founder_board_percentile=score,
        outcome_track_record_percentile=score,
        knowledge_creation_percentile=score,
        civic_leadership_percentile=score,
        capital_access_percentile=score,
        trusted_reach_percentile=score,
        verified_social_reach_percentile=score,
        freshness=0.9,
        source_quality=0.9,
        source_diversity=0.8,
        identity_confidence=0.95,
        evidence_count=20,
        dominant_source_ratio=0.2,
    )


def make_candidate(
    index: int,
    *,
    org: str,
    score: float,
    profile_class: ProfileClass = ProfileClass.PUBLIC_PROFESSIONAL,
    distance_offset: float = 0.0,
) -> NearbyCandidate:
    return NearbyCandidate(
        person_id=f"p-{index:02d}",
        display_name=f"Person {index}",
        headline="Public professional",
        profile_class=profile_class,
        verification_status=VerificationStatus.VERIFIED,
        primary_lane=ProfessionalLane.BUILDER if index % 2 else ProfessionalLane.KNOWLEDGE,
        organization_id=org,
        organization_name=org,
        graph_community_id=f"community-{index % 4}",
        location=PublicLocationAssociation(
            label="Kirkland, Washington",
            point=GeoPoint(47.67 + distance_offset, -122.19),
            kind=LocationAssociationKind.OFFICIAL_BIO,
            granularity=LocationGranularity.CITY,
            confidence=0.9,
            source_count=2,
            as_of_date=date(2026, 8, 1),
        ),
        features=feature(score),
    )


def test_private_profile_is_filtered() -> None:
    people = [
        make_candidate(1, org="a", score=0.8),
        make_candidate(2, org="b", score=0.9, profile_class=ProfileClass.PRIVATE_PERSON),
    ]
    results, summary = discover_nearby_people(
        people,
        query_point=GeoPoint(47.67, -122.19),
        top_n=2,
    )
    assert [item.candidate.person_id for item in results] == ["p-01"]
    assert summary.eligible_candidate_count == 1


def test_diversity_limits_single_organization_when_alternatives_exist() -> None:
    people = [make_candidate(i, org="dominant", score=0.99 - i * 0.005) for i in range(8)]
    people += [make_candidate(20 + i, org=f"other-{i}", score=0.75 - i * 0.01) for i in range(5)]
    results, _ = discover_nearby_people(
        people,
        query_point=GeoPoint(47.67, -122.19),
        top_n=10,
        diversity=True,
    )
    dominant_count = sum(item.candidate.organization_id == "dominant" for item in results)
    assert dominant_count <= 5
    assert len(results) == 10


def test_radius_auto_expands() -> None:
    people = [
        make_candidate(i, org=f"o-{i}", score=0.8, distance_offset=0.2 + i * 0.01)
        for i in range(5)
    ]
    results, summary = discover_nearby_people(
        people,
        query_point=GeoPoint(47.67, -122.19),
        top_n=3,
        initial_radius_km=5,
        max_radius_km=50,
        auto_expand=True,
    )
    assert summary.effective_radius_km > 5
    assert results
