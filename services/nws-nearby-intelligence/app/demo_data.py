from __future__ import annotations

from datetime import date
from math import cos, pi, radians, sin

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


def _unit(index: int, salt: int) -> float:
    """Deterministic pseudo-random value in [0, 1] without external state."""

    return ((index * (73 + salt * 17) + salt * 101) % 997) / 996.0


def _bounded(index: int, salt: int, low: float = 0.25, high: float = 0.98) -> float:
    return low + (high - low) * _unit(index, salt)


def synthetic_candidates(
    *,
    center: GeoPoint = GeoPoint(47.6720, -122.1910),
    count: int = 520,
) -> list[NearbyCandidate]:
    """Create synthetic public-professional profiles for local demos only.

    No returned profile represents a real person. Production deployments use the PostGIS
    repository and approved public-professional records.
    """

    lanes = tuple(ProfessionalLane)
    profiles: list[NearbyCandidate] = []
    lon_scale = max(0.25, cos(radians(center.latitude)))

    for index in range(1, count + 1):
        # Deterministic spiral covering roughly 1–110 km from the sample ZIP centroid.
        radius_km = 1.0 + 109.0 * _unit(index, 31)
        angle = 2.0 * pi * _unit(index, 37)
        latitude = center.latitude + (radius_km / 111.32) * cos(angle)
        longitude = center.longitude + (radius_km / (111.32 * lon_scale)) * sin(angle)
        lane = lanes[(index - 1) % len(lanes)]

        core = _bounded(index, 1)
        graph = min(0.99, 0.55 * core + 0.45 * _bounded(index, 2))
        institution = min(0.99, 0.45 * core + 0.55 * _bounded(index, 3))
        outcomes = min(0.99, 0.50 * core + 0.50 * _bounded(index, 4))
        source_quality = _bounded(index, 20, 0.72, 0.99)
        source_diversity = _bounded(index, 21, 0.58, 0.96)
        identity_confidence = _bounded(index, 22, 0.82, 0.995)

        features = NwsFeatureVector(
            pagerank_percentile=graph,
            kcore_percentile=_bounded(index, 5),
            bridging_percentile=_bounded(index, 6),
            cross_sector_percentile=_bounded(index, 7),
            role_authority_percentile=institution,
            institution_strength_percentile=_bounded(index, 8),
            founder_board_percentile=_bounded(index, 9),
            outcome_track_record_percentile=outcomes,
            knowledge_creation_percentile=_bounded(index, 10),
            civic_leadership_percentile=_bounded(index, 11),
            capital_access_percentile=_bounded(index, 12),
            trusted_reach_percentile=_bounded(index, 13),
            verified_social_reach_percentile=_bounded(index, 14, 0.05, 0.90),
            freshness=_bounded(index, 15, 0.55, 0.99),
            source_quality=source_quality,
            source_diversity=source_diversity,
            identity_confidence=identity_confidence,
            evidence_count=5 + int(35 * _unit(index, 16)),
            suspicious_pattern_ratio=_bounded(index, 17, 0.0, 0.15),
            self_published_source_ratio=_bounded(index, 18, 0.02, 0.42),
            dominant_source_ratio=_bounded(index, 19, 0.12, 0.58),
        )

        profiles.append(
            NearbyCandidate(
                person_id=f"demo-public-professional-{index:04d}",
                display_name=f"Synthetic Professional {index:04d}",
                headline=f"Synthetic {lane.value.title()} leader for reference testing",
                profile_class=(
                    ProfileClass.OPTED_IN if index % 11 == 0 else ProfileClass.PUBLIC_PROFESSIONAL
                ),
                verification_status=VerificationStatus.VERIFIED,
                primary_lane=lane,
                organization_id=f"demo-org-{(index - 1) % 64:03d}",
                organization_name=f"Synthetic Organization {(index - 1) % 64:03d}",
                graph_community_id=f"demo-community-{(index - 1) % 24:02d}",
                location=PublicLocationAssociation(
                    label="Synthetic public professional association near the 98033 demo area",
                    point=GeoPoint(latitude, longitude),
                    kind=(
                        LocationAssociationKind.OPT_IN_LOCATION
                        if index % 11 == 0
                        else LocationAssociationKind.OFFICIAL_BIO
                    ),
                    granularity=LocationGranularity.CITY,
                    confidence=_bounded(index, 23, 0.70, 0.98),
                    source_count=1 if index % 11 == 0 else 2 + index % 3,
                    as_of_date=date(2026, 8, 1),
                ),
                features=features,
                public_profile_url=None,
                tags=(lane.value.lower(), "synthetic-demo"),
            )
        )

    return profiles
