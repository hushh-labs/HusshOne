from datetime import date

from app.nearby_policy import NearbyPolicyEngine
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


def candidate(profile_class: ProfileClass, kind: LocationAssociationKind) -> NearbyCandidate:
    f = NwsFeatureVector(
        pagerank_percentile=0.5,
        kcore_percentile=0.5,
        bridging_percentile=0.5,
        cross_sector_percentile=0.5,
        role_authority_percentile=0.5,
        institution_strength_percentile=0.5,
        founder_board_percentile=0.5,
        outcome_track_record_percentile=0.5,
        knowledge_creation_percentile=0.5,
        civic_leadership_percentile=0.5,
        capital_access_percentile=0.5,
        trusted_reach_percentile=0.5,
        verified_social_reach_percentile=0.5,
        freshness=0.8,
        source_quality=0.8,
        source_diversity=0.8,
        identity_confidence=0.9,
        evidence_count=10,
    )
    return NearbyCandidate(
        person_id="p",
        display_name="Person",
        headline="Professional",
        profile_class=profile_class,
        verification_status=VerificationStatus.VERIFIED,
        primary_lane=ProfessionalLane.GENERAL,
        organization_id=None,
        organization_name=None,
        graph_community_id=None,
        location=PublicLocationAssociation(
            label="Kirkland",
            point=GeoPoint(47.67, -122.19),
            kind=kind,
            granularity=LocationGranularity.CITY,
            confidence=0.9,
            source_count=2,
            as_of_date=date(2026, 8, 1),
        ),
        features=f,
    )


def test_private_person_is_not_publishable() -> None:
    assert not NearbyPolicyEngine().authorize_candidate(
        candidate(ProfileClass.PRIVATE_PERSON, LocationAssociationKind.OFFICIAL_BIO)
    ).allowed


def test_event_only_location_is_not_publishable() -> None:
    assert not NearbyPolicyEngine().authorize_candidate(
        candidate(ProfileClass.PUBLIC_PROFESSIONAL, LocationAssociationKind.EVENT_ONLY)
    ).allowed
