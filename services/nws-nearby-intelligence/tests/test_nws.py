from datetime import date

from app.nws import score_candidate
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


def features(**overrides: float | int) -> NwsFeatureVector:
    values: dict[str, float | int] = {
        "pagerank_percentile": 0.8,
        "kcore_percentile": 0.8,
        "bridging_percentile": 0.8,
        "cross_sector_percentile": 0.7,
        "role_authority_percentile": 0.8,
        "institution_strength_percentile": 0.8,
        "founder_board_percentile": 0.7,
        "outcome_track_record_percentile": 0.8,
        "knowledge_creation_percentile": 0.5,
        "civic_leadership_percentile": 0.4,
        "capital_access_percentile": 0.7,
        "trusted_reach_percentile": 0.6,
        "verified_social_reach_percentile": 0.5,
        "freshness": 0.9,
        "source_quality": 0.9,
        "source_diversity": 0.8,
        "identity_confidence": 0.95,
        "evidence_count": 15,
        "suspicious_pattern_ratio": 0.0,
        "self_published_source_ratio": 0.1,
        "dominant_source_ratio": 0.3,
    }
    values.update(overrides)
    return NwsFeatureVector(**values)  # type: ignore[arg-type]


def candidate(identifier: str, feature_vector: NwsFeatureVector) -> NearbyCandidate:
    return NearbyCandidate(
        person_id=identifier,
        display_name="Example Person",
        headline="Founder and engineer",
        profile_class=ProfileClass.PUBLIC_PROFESSIONAL,
        verification_status=VerificationStatus.VERIFIED,
        primary_lane=ProfessionalLane.BUILDER,
        organization_id="org-1",
        organization_name="Example Co",
        graph_community_id="community-1",
        location=PublicLocationAssociation(
            label="Kirkland, Washington",
            point=GeoPoint(47.67, -122.19),
            kind=LocationAssociationKind.OFFICIAL_BIO,
            granularity=LocationGranularity.CITY,
            confidence=0.9,
            source_count=2,
            as_of_date=date(2026, 8, 1),
        ),
        features=feature_vector,
    )


def test_social_reach_cannot_outweigh_real_network_strength() -> None:
    strong = candidate("strong", features())
    social_only = candidate(
        "social",
        features(
            pagerank_percentile=0.1,
            kcore_percentile=0.1,
            bridging_percentile=0.1,
            cross_sector_percentile=0.1,
            role_authority_percentile=0.15,
            institution_strength_percentile=0.1,
            founder_board_percentile=0.1,
            outcome_track_record_percentile=0.1,
            knowledge_creation_percentile=0.1,
            civic_leadership_percentile=0.1,
            capital_access_percentile=0.1,
            trusted_reach_percentile=0.2,
            verified_social_reach_percentile=1.0,
        ),
    )
    query = GeoPoint(47.67, -122.19)
    assert score_candidate(strong, query_point=query, radius_km=20).global_nws > score_candidate(
        social_only, query_point=query, radius_km=20
    ).global_nws


def test_proximity_changes_nearby_score_not_global_nws() -> None:
    item = candidate("person", features())
    near = score_candidate(item, query_point=GeoPoint(47.67, -122.19), radius_km=30)
    far = score_candidate(item, query_point=GeoPoint(47.3, -122.5), radius_km=30)
    assert near.global_nws == far.global_nws
    assert near.nearby_rank_score > far.nearby_rank_score
