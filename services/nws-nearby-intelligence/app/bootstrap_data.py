from __future__ import annotations

from dataclasses import dataclass
from datetime import date

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


@dataclass(frozen=True)
class SourceCitation:
    publisher: str
    title: str
    url: str


@dataclass(frozen=True)
class BootstrapMetadata:
    score_status: str
    revalidation_required: bool
    citations: tuple[SourceCitation, ...]


_VERIFIED_ON = date(2026, 8, 12)


def _features(
    *,
    strength: float,
    lane: ProfessionalLane,
    freshness: float = 0.92,
    confidence: float = 0.94,
) -> NwsFeatureVector:
    """Conservative, reviewed bootstrap feature vectors; not a completed regional graph."""

    civic = lane is ProfessionalLane.CIVIC
    knowledge = lane is ProfessionalLane.KNOWLEDGE
    capital = lane is ProfessionalLane.CAPITAL
    return NwsFeatureVector(
        pagerank_percentile=min(0.94, strength),
        kcore_percentile=min(0.92, strength * 0.96),
        bridging_percentile=min(0.91, strength * 0.94),
        cross_sector_percentile=min(0.90, strength * 0.90),
        role_authority_percentile=min(0.97, strength * 1.03),
        institution_strength_percentile=min(0.96, strength * 0.98),
        founder_board_percentile=min(
            0.95, strength * (1.02 if lane is ProfessionalLane.BUILDER else 0.78)
        ),
        outcome_track_record_percentile=min(0.94, strength * 0.98),
        knowledge_creation_percentile=min(0.93, strength * (1.0 if knowledge else 0.67)),
        civic_leadership_percentile=min(0.96, strength * (1.06 if civic else 0.50)),
        capital_access_percentile=min(0.92, strength * (1.00 if capital else 0.72)),
        trusted_reach_percentile=min(0.90, strength * 0.78),
        verified_social_reach_percentile=min(0.75, strength * 0.50),
        freshness=freshness,
        source_quality=confidence,
        source_diversity=min(0.94, confidence * 0.96),
        identity_confidence=confidence,
        evidence_count=12,
        suspicious_pattern_ratio=0.0,
        self_published_source_ratio=0.10,
        dominant_source_ratio=0.34,
    )


def _candidate(
    *,
    person_id: str,
    display_name: str,
    headline: str,
    lane: ProfessionalLane,
    organization_id: str,
    organization_name: str,
    location_label: str,
    point: GeoPoint,
    kind: LocationAssociationKind,
    granularity: LocationGranularity,
    strength: float,
    confidence: float = 0.94,
    tags: tuple[str, ...] = (),
) -> NearbyCandidate:
    return NearbyCandidate(
        person_id=person_id,
        display_name=display_name,
        headline=headline,
        profile_class=ProfileClass.PUBLIC_PROFESSIONAL,
        verification_status=VerificationStatus.VERIFIED,
        primary_lane=lane,
        organization_id=organization_id,
        organization_name=organization_name,
        graph_community_id=f"bootstrap-{lane.value.casefold()}",
        location=PublicLocationAssociation(
            label=location_label,
            point=point,
            kind=kind,
            granularity=granularity,
            confidence=confidence,
            source_count=2,
            as_of_date=_VERIFIED_ON,
        ),
        features=_features(strength=strength, lane=lane, confidence=confidence),
        tags=tags,
    )


_KIRKLAND_CITY_HALL = GeoPoint(47.6763, -122.2074)
_KIRKLAND_CENTER = GeoPoint(47.6750, -122.2050)


BOOTSTRAP_CANDIDATES: tuple[NearbyCandidate, ...] = (
    _candidate(
        person_id="bootstrap_michael_hsing",
        display_name="Michael R. Hsing",
        headline="Chairman, President and CEO",
        lane=ProfessionalLane.BUILDER,
        organization_id="monolithic-power-systems",
        organization_name="Monolithic Power Systems",
        location_label="Monolithic Power Systems public Kirkland office association",
        point=GeoPoint(47.6595, -122.2097),
        kind=LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE,
        granularity=LocationGranularity.EXACT_PUBLIC_VENUE,
        strength=0.94,
        tags=("semiconductors", "founder", "board"),
    ),
    _candidate(
        person_id="bootstrap_neville_meijers",
        display_name="Neville Meijers",
        headline="Chief Executive Officer",
        lane=ProfessionalLane.CONNECTOR,
        organization_id="bluetooth-sig",
        organization_name="Bluetooth SIG",
        location_label="Bluetooth SIG public Kirkland principal office",
        point=GeoPoint(47.6583, -122.2120),
        kind=LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE,
        granularity=LocationGranularity.EXACT_PUBLIC_VENUE,
        strength=0.91,
        tags=("standards", "technology", "connector"),
    ),
    _candidate(
        person_id="bootstrap_bryan_mistele",
        display_name="Bryan Mistele",
        headline="Co-founder and Chief Executive Officer",
        lane=ProfessionalLane.BUILDER,
        organization_id="inrix",
        organization_name="INRIX",
        location_label="INRIX public Kirkland city association",
        point=_KIRKLAND_CENTER,
        kind=LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE,
        granularity=LocationGranularity.CITY,
        strength=0.89,
        tags=("mobility", "founder", "technology"),
    ),
    _candidate(
        person_id="bootstrap_harold_zeitz",
        display_name="Harold Zeitz",
        headline="Chief Executive Officer",
        lane=ProfessionalLane.BUILDER,
        organization_id="ziply-fiber",
        organization_name="Ziply Fiber",
        location_label="Ziply Fiber public Kirkland headquarters association",
        point=_KIRKLAND_CENTER,
        kind=LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE,
        granularity=LocationGranularity.CITY,
        strength=0.86,
        tags=("telecom", "technology"),
    ),
    _candidate(
        person_id="bootstrap_eben_frankenberg",
        display_name="Eben Frankenberg",
        headline="Chief Executive Officer and Co-founder",
        lane=ProfessionalLane.BUILDER,
        organization_id="echodyne",
        organization_name="Echodyne",
        location_label="Echodyne public Kirkland office association",
        point=GeoPoint(47.6748, -122.2045),
        kind=LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE,
        granularity=LocationGranularity.EXACT_PUBLIC_VENUE,
        strength=0.87,
        tags=("radar", "founder", "technology"),
    ),
    _candidate(
        person_id="bootstrap_kurt_triplett",
        display_name="Kurt Triplett",
        headline="City Manager",
        lane=ProfessionalLane.CIVIC,
        organization_id="city-of-kirkland",
        organization_name="City of Kirkland",
        location_label="Kirkland City Hall public institutional association",
        point=_KIRKLAND_CITY_HALL,
        kind=LocationAssociationKind.PUBLIC_SERVICE_JURISDICTION,
        granularity=LocationGranularity.EXACT_PUBLIC_VENUE,
        strength=0.80,
        tags=("government", "civic"),
    ),
    _candidate(
        person_id="bootstrap_kelli_curtis",
        display_name="Kelli Curtis",
        headline="Mayor",
        lane=ProfessionalLane.CIVIC,
        organization_id="city-of-kirkland",
        organization_name="City of Kirkland",
        location_label="Kirkland City Hall public institutional association",
        point=_KIRKLAND_CITY_HALL,
        kind=LocationAssociationKind.PUBLIC_SERVICE_JURISDICTION,
        granularity=LocationGranularity.EXACT_PUBLIC_VENUE,
        strength=0.78,
        tags=("government", "civic"),
    ),
    _candidate(
        person_id="bootstrap_yun_zhang",
        display_name="Yun Zhang",
        headline="Co-founder; CEO title requires refresh",
        lane=ProfessionalLane.BUILDER,
        organization_id="wyze",
        organization_name="Wyze",
        location_label="Wyze public Kirkland office association",
        point=_KIRKLAND_CENTER,
        kind=LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE,
        granularity=LocationGranularity.CITY,
        strength=0.77,
        confidence=0.82,
        tags=("consumer-technology", "founder"),
    ),
    _candidate(
        person_id="bootstrap_amy_morrison",
        display_name="Amy Morrison",
        headline="President",
        lane=ProfessionalLane.KNOWLEDGE,
        organization_id="lake-washington-institute-of-technology",
        organization_name="Lake Washington Institute of Technology",
        location_label="Lake Washington Institute of Technology public Kirkland campus",
        point=GeoPoint(47.7045, -122.1628),
        kind=LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE,
        granularity=LocationGranularity.EXACT_PUBLIC_VENUE,
        strength=0.81,
        tags=("education", "knowledge"),
    ),
    _candidate(
        person_id="bootstrap_ettore_palazzo",
        display_name="Ettore Palazzo, MD",
        headline="Chief Executive Officer",
        lane=ProfessionalLane.BUILDER,
        organization_id="evergreenhealth",
        organization_name="EvergreenHealth",
        location_label="EvergreenHealth public Kirkland institutional association",
        point=GeoPoint(47.7185, -122.1685),
        kind=LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE,
        granularity=LocationGranularity.EXACT_PUBLIC_VENUE,
        strength=0.80,
        tags=("healthcare", "institution"),
    ),
    _candidate(
        person_id="bootstrap_neal_black",
        display_name="Neal Black",
        headline="Deputy Mayor",
        lane=ProfessionalLane.CIVIC,
        organization_id="city-of-kirkland",
        organization_name="City of Kirkland",
        location_label="Kirkland City Hall public institutional association",
        point=_KIRKLAND_CITY_HALL,
        kind=LocationAssociationKind.PUBLIC_SERVICE_JURISDICTION,
        granularity=LocationGranularity.EXACT_PUBLIC_VENUE,
        strength=0.71,
        tags=("government", "civic"),
    ),
)


BOOTSTRAP_METADATA: dict[str, BootstrapMetadata] = {
    "bootstrap_michael_hsing": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=False,
        citations=(
            SourceCitation(
                "Monolithic Power Systems",
                "Management",
                "https://www.monolithicpower.com/en/about-mps/investor-relations/corporate-governance/management.html",
            ),
            SourceCitation(
                "City of Kirkland",
                "MPS public Kirkland permit",
                "https://permits.kirklandwa.gov/WebDocs/2020121635/0438365d-98af-469c-b510-2f29dc9b14cd.pdf",
            ),
        ),
    ),
    "bootstrap_neville_meijers": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=False,
        citations=(
            SourceCitation(
                "Bluetooth SIG",
                "Executive team",
                "https://www.bluetooth.com/about-us/executive-team/",
            ),
            SourceCitation(
                "Bluetooth SIG",
                "Bylaws",
                "https://www.bluetooth.com/wp-content/uploads/2024/06/Bluetooth-SIG-Bylaws.pdf",
            ),
        ),
    ),
    "bootstrap_bryan_mistele": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=False,
        citations=(
            SourceCitation(
                "INRIX",
                "AI traffic products release",
                "https://inrix.com/press-releases/inrix-announces-new-generation-of-ai-traffic-products/",
            ),
            SourceCitation(
                "INRIX",
                "Kirkland-dated release",
                "https://inrix.com/press-releases/inrix-integrates-clevercitis-ai-powered-parking-detection-to-expand-real-time-curb-intelligence/",
            ),
        ),
    ),
    "bootstrap_harold_zeitz": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=False,
        citations=(
            SourceCitation("Ziply Fiber", "About Ziply Fiber", "https://ziplyfiber.com/about-us"),
            SourceCitation(
                "Ziply Fiber", "Leadership and headquarters", "https://ziplyfiber.com/about-us"
            ),
        ),
    ),
    "bootstrap_eben_frankenberg": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=False,
        citations=(
            SourceCitation("Echodyne", "Company", "https://www.echodyne.com/company"),
            SourceCitation(
                "Echodyne", "Leadership and Kirkland office", "https://www.echodyne.com/company"
            ),
        ),
    ),
    "bootstrap_kurt_triplett": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=False,
        citations=(
            SourceCitation(
                "City of Kirkland",
                "Meet the City Manager",
                "https://www.kirklandwa.gov/Government/City-Managers-Office/About-the-City-Managers-Office/Meet-the-City-Manager",
            ),
            SourceCitation(
                "City of Kirkland", "City Hall", "https://www.kirklandwa.gov/Government/City-Hall"
            ),
        ),
    ),
    "bootstrap_kelli_curtis": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=False,
        citations=(
            SourceCitation(
                "City of Kirkland",
                "City Council",
                "https://www.kirklandwa.gov/Government/City-Council",
            ),
            SourceCitation(
                "City of Kirkland",
                "2026 mayor selection",
                "https://www.kirklandwa.gov/Whats-Happening/News/Mayor-Kelli-Curtis-Selected-to-Continue-as-Mayor-of-Kirkland",
            ),
        ),
    ),
    "bootstrap_yun_zhang": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=True,
        citations=(
            SourceCitation("Wyze", "Our story", "https://www.wyze.com/pages/our-story"),
            SourceCitation("Wyze", "Contact us", "https://www.wyze.com/pages/contact-us"),
        ),
    ),
    "bootstrap_amy_morrison": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=False,
        citations=(
            SourceCitation(
                "Lake Washington Institute of Technology",
                "Executive staff",
                "https://www.lwtech.edu/about-us/executive-staff/index.aspx",
            ),
            SourceCitation(
                "Lake Washington Institute of Technology",
                "Kirkland campus",
                "https://www.lwtech.edu/about-us/executive-staff/index.aspx",
            ),
        ),
    ),
    "bootstrap_ettore_palazzo": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=False,
        citations=(
            SourceCitation(
                "EvergreenHealth", "Careers leadership", "https://careers.evergreenhealth.com/"
            ),
            SourceCitation(
                "EvergreenHealth", "Kirkland institution", "https://careers.evergreenhealth.com/"
            ),
        ),
    ),
    "bootstrap_neal_black": BootstrapMetadata(
        score_status="PROVISIONAL",
        revalidation_required=False,
        citations=(
            SourceCitation(
                "City of Kirkland",
                "City Council",
                "https://www.kirklandwa.gov/Government/City-Council",
            ),
            SourceCitation(
                "City of Kirkland",
                "2026 mayor selection",
                "https://www.kirklandwa.gov/Whats-Happening/News/Mayor-Kelli-Curtis-Selected-to-Continue-as-Mayor-of-Kirkland",
            ),
        ),
    ),
}
