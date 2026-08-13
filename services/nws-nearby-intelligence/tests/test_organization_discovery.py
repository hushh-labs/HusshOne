from datetime import UTC, datetime
from pathlib import Path

from app.bootstrap_data import BOOTSTRAP_CANDIDATES
from app.collectors.contracts import (
    AcquisitionMode,
    ArtifactManifest,
    CandidateProposalMode,
    ParsedObservation,
    SourceContract,
    SourceTrustTier,
)
from app.collectors.registry import SourceRegistry
from app.nws_models import LocationAssociationKind
from app.organization_discovery import (
    OrganizationAnchor,
    OrganizationDiscoveryReviewPolicy,
    OrganizationLocationClassification,
    OrganizationProposalStatus,
    get_organization_anchor_release,
    public_association_context,
    validate_anchor_coverage,
)


def _artifact(
    *,
    source_id: str = "official_company_pages",
    uri: str = "https://example.org/team/",
) -> ArtifactManifest:
    return ArtifactManifest(
        source_id=source_id,
        requested_uri=uri,
        final_uri=uri,
        retrieved_at=datetime(2026, 8, 13, tzinfo=UTC),
        status_code=200,
        content_type="text/html",
        content_length=42,
        sha256="a" * 64,
    )


def _observation(
    *,
    observation_id: str,
    fact_type: str,
    subject: str = "official/person/alex",
    attributes: dict[str, object],
) -> ParsedObservation:
    return ParsedObservation(
        observation_id=observation_id,
        source_id="official_company_pages",
        artifact_sha256="a" * 64,
        parser_version="test-parser-v1",
        fact_type=fact_type,
        subject_external_id=subject,
        object_external_id="official/organization/example",
        confidence=0.8,
        occurred_on="2026-08-13",
        attributes=attributes,
    )


def _anchor() -> OrganizationAnchor:
    return OrganizationAnchor(
        anchor_id="example-anchor",
        organization_id="example-org",
        organization_name="Example Organization",
        source_contract_id="official_company_pages",
        canonical_domain="example.org",
        approved_hosts=("example.org", "www.example.org"),
        approved_path_prefixes=("/team/",),
        location_classification=OrganizationLocationClassification.VERIFIED_OPERATING_SITE,
        public_market_label="Example market",
    )


def _contract(
    mode: CandidateProposalMode = CandidateProposalMode.REVIEW_REQUIRED,
) -> SourceContract:
    return SourceContract(
        source_id="official_company_pages",
        authority="Example Organization",
        acquisition_mode=AcquisitionMode.PUBLIC_PAGE,
        trust_tier=SourceTrustTier.PRIMARY,
        base_reliability=0.9,
        allowed_fact_types=frozenset({"identity_alias", "current_role"}),
        forbidden_fact_types=frozenset({"private_residence", "personal_contact"}),
        candidate_proposal_mode=mode,
    )


def test_anchor_release_covers_each_current_market_organization_without_claiming_a_census() -> None:
    release = get_organization_anchor_release()
    assert release.release_id == "us-wa-kirkland-organization-anchors-2026-08-13"
    assert len(release.anchors) == 13
    assert release.market_census_complete is False
    assert release.automatic_candidate_publication is False
    assert all(anchor.supports_stable_local_association for anchor in release.anchors)
    validate_anchor_coverage(
        release,
        market_id="us-wa-kirkland-public-association",
        organization_ids=(candidate.organization_id for candidate in BOOTSTRAP_CANDIDATES),
    )


def test_anchor_source_contracts_exist_in_the_reviewed_registry() -> None:
    registry_path = Path(__file__).resolve().parents[1] / "config" / "sources.yaml"
    registry = SourceRegistry.from_yaml(registry_path)
    release = get_organization_anchor_release()
    assert {
        anchor.source_contract_id for anchor in release.anchors
    }.issubset({contract.source_id for contract in registry.all()})


def test_anchor_scope_allows_only_approved_https_hosts_and_paths() -> None:
    anchor = _anchor()
    assert anchor.permits_uri("https://www.example.org/team/leadership")
    assert not anchor.permits_uri("https://example.org/contact")
    assert not anchor.permits_uri("https://unreviewed.example.net/team/leadership")
    assert not anchor.permits_uri("http://example.org/team/leadership")


def test_public_association_context_never_claims_presence_or_residence() -> None:
    based_here = public_association_context(LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE)
    connected_here = public_association_context(LocationAssociationKind.OFFICIAL_BIO)
    event = public_association_context(LocationAssociationKind.EVENT_ONLY)

    assert based_here["category"] == "BASED_HERE"
    assert connected_here["category"] == "CONNECTED_HERE"
    assert event["category"] == "APPEARING_NEARBY"
    assert all("residence" in item["definition"] for item in (based_here, connected_here))


def test_review_policy_emits_review_required_proposal_but_never_a_publishable_candidate() -> None:
    observations = [
        _observation(
            observation_id="identity",
            fact_type="identity_alias",
            attributes={"display_name": "Alex Example"},
        ),
        _observation(
            observation_id="role",
            fact_type="current_role",
            attributes={
                "title": "Chief Executive Officer",
                "organization_name": "Example Organization",
            },
        ),
    ]
    batch = OrganizationDiscoveryReviewPolicy().build_review_batch(
        anchor=_anchor(),
        contract=_contract(),
        artifact=_artifact(),
        observations=observations,
    )

    assert len(batch.proposals) == 1
    proposal = batch.proposals[0]
    assert proposal.status is OrganizationProposalStatus.REVIEW_REQUIRED
    assert proposal.display_name == "Alex Example"
    assert proposal.source_family == "example.org"
    assert proposal.release_eligible is False
    assert batch.has_publishable_candidates is False


def test_discovery_only_source_cannot_create_person_role_proposals() -> None:
    batch = OrganizationDiscoveryReviewPolicy().build_review_batch(
        anchor=_anchor(),
        contract=_contract(CandidateProposalMode.DISCOVERY_ONLY),
        artifact=_artifact(),
        observations=[
            _observation(
                observation_id="role",
                fact_type="current_role",
                attributes={
                    "title": "Chief Executive Officer",
                    "organization_name": "Example Organization",
                },
            )
        ],
    )
    assert batch.proposals == ()
    assert batch.rejections[0].rule_id == "SOURCE-DISCOVERY-ONLY"


def test_sensitive_attribute_and_out_of_scope_redirect_are_rejected() -> None:
    identity = _observation(
        observation_id="identity",
        fact_type="identity_alias",
        attributes={"display_name": "Alex Example"},
    )
    sensitive_role = _observation(
        observation_id="sensitive-role",
        fact_type="current_role",
        attributes={
            "title": "Chief Executive Officer",
            "organization_name": "Example Organization",
            "email": "alex@example.org",
        },
    )
    policy = OrganizationDiscoveryReviewPolicy()
    sensitive = policy.build_review_batch(
        anchor=_anchor(),
        contract=_contract(),
        artifact=_artifact(),
        observations=[identity, sensitive_role],
    )
    assert sensitive.proposals == ()
    assert any(item.rule_id == "PERSONAL-ATTRIBUTE-REJECTED" for item in sensitive.rejections)

    out_of_scope = policy.build_review_batch(
        anchor=_anchor(),
        contract=_contract(),
        artifact=_artifact(uri="https://unreviewed.example.net/team/"),
        observations=[identity],
    )
    assert out_of_scope.proposals == ()
    assert out_of_scope.rejections[0].rule_id == "ARTIFACT-OUTSIDE-ANCHOR-SCOPE"


def test_registered_or_mailing_anchor_cannot_create_a_local_role_proposal() -> None:
    unsafe_anchor = OrganizationAnchor(
        anchor_id="registered-agent-anchor",
        organization_id="example-org",
        organization_name="Example Organization",
        source_contract_id="official_company_pages",
        canonical_domain="example.org",
        approved_hosts=("example.org",),
        approved_path_prefixes=("/team/",),
        location_classification=OrganizationLocationClassification.REGISTERED_AGENT,
        public_market_label="Example market",
    )
    batch = OrganizationDiscoveryReviewPolicy().build_review_batch(
        anchor=unsafe_anchor,
        contract=_contract(),
        artifact=_artifact(),
        observations=[
            _observation(
                observation_id="identity",
                fact_type="identity_alias",
                attributes={"display_name": "Alex Example"},
            )
        ],
    )
    assert batch.proposals == ()
    assert batch.rejections[0].rule_id == "ANCHOR-LOCATION-NOT-PUBLISHABLE"
