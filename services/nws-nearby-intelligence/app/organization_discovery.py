"""Organization-first discovery intake with a hard review-and-release boundary.

The public NWS route is a reviewed market release, not a live people crawler.
This module is the first operational layer behind a future organization census:
it constrains which public organization pages may be fetched, turns contracted
role observations into *review proposals*, and deliberately has no code path
that writes a candidate into the public API or a market release.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit

from app.collectors.contracts import (
    ArtifactManifest,
    CandidateProposalMode,
    ParsedObservation,
    SourceContract,
)
from app.collectors.fetcher import FetchScope
from app.nws_models import LocationAssociationKind
from app.parsers.contracts import ObservationPolicyGate

_ANCHOR_PATH = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "markets"
    / "us-wa-kirkland"
    / "2026-08-13"
    / "organization_anchors.json"
)


class OrganizationLocationClassification(StrEnum):
    """What a public organization address means before any person is considered."""

    VERIFIED_HEADQUARTERS = "VERIFIED_HEADQUARTERS"
    VERIFIED_OPERATING_SITE = "VERIFIED_OPERATING_SITE"
    PUBLIC_BRANCH_OR_CAMPUS = "PUBLIC_BRANCH_OR_CAMPUS"
    GOVERNMENT_OR_INSTITUTIONAL_OFFICE = "GOVERNMENT_OR_INSTITUTIONAL_OFFICE"
    REGISTERED_OFFICE = "REGISTERED_OFFICE"
    REGISTERED_AGENT = "REGISTERED_AGENT"
    MAILING_ADDRESS = "MAILING_ADDRESS"
    HISTORICAL_SITE = "HISTORICAL_SITE"

    @property
    def supports_stable_local_association(self) -> bool:
        return self in {
            OrganizationLocationClassification.VERIFIED_HEADQUARTERS,
            OrganizationLocationClassification.VERIFIED_OPERATING_SITE,
            OrganizationLocationClassification.PUBLIC_BRANCH_OR_CAMPUS,
            OrganizationLocationClassification.GOVERNMENT_OR_INSTITUTIONAL_OFFICE,
        }


class PublicAssociationCategory(StrEnum):
    """Human-readable semantics for a public association, never live presence."""

    BASED_HERE = "BASED_HERE"
    CONNECTED_HERE = "CONNECTED_HERE"
    APPEARING_NEARBY = "APPEARING_NEARBY"
    OPTED_IN_LOCATION = "OPTED_IN_LOCATION"


class OrganizationProposalStatus(StrEnum):
    DISCOVERED = "DISCOVERED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    REJECTED = "REJECTED"


_ROLE_FACT_TYPES = frozenset(
    {
        "current_role",
        "public_role",
        "director_role",
        "founder_role",
        "board_role",
        "partner_role",
        "public_official_role",
        "faculty_role",
        "lab_leadership",
    }
)
_SENSITIVE_ATTRIBUTE_TOKENS = frozenset(
    {
        "address",
        "street",
        "email",
        "phone",
        "telephone",
        "postal",
        "zip",
        "residence",
        "home",
        "latitude",
        "longitude",
        "coordinate",
    }
)


def _compact_text(value: object) -> str:
    return " ".join(str(value or "").strip().casefold().split())


def _canonical_json(payload: object) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def _host_family(uri: str) -> str:
    host = urlsplit(uri).hostname
    if not host:
        raise ValueError(f"A public source URI requires a host: {uri}")
    return host.removeprefix("www.").casefold()


@dataclass(frozen=True)
class OrganizationAnchor:
    """A reviewed organization/page scope; it contains no person information."""

    anchor_id: str
    organization_id: str
    organization_name: str
    source_contract_id: str
    canonical_domain: str
    approved_hosts: tuple[str, ...]
    approved_path_prefixes: tuple[str, ...]
    location_classification: OrganizationLocationClassification
    public_market_label: str

    def __post_init__(self) -> None:
        for field_name, value in (
            ("anchor_id", self.anchor_id),
            ("organization_id", self.organization_id),
            ("organization_name", self.organization_name),
            ("source_contract_id", self.source_contract_id),
            ("canonical_domain", self.canonical_domain),
            ("public_market_label", self.public_market_label),
        ):
            if not value.strip():
                raise ValueError(f"{field_name} is required")
        if "/" in self.canonical_domain or ":" in self.canonical_domain:
            raise ValueError("canonical_domain must be a host name")
        if not self.approved_hosts:
            raise ValueError("organization anchor needs at least one approved host")
        normalized_hosts = {host.casefold() for host in self.approved_hosts}
        if self.canonical_domain.casefold() not in normalized_hosts:
            raise ValueError("organization anchor approved_hosts must include its canonical domain")
        if any(not host.strip() or "/" in host or ":" in host for host in self.approved_hosts):
            raise ValueError("organization anchor approved_hosts must be host names")
        if not self.approved_path_prefixes:
            raise ValueError("organization anchor needs at least one approved path prefix")
        if any(
            not prefix.startswith("/") or "?" in prefix or "#" in prefix
            for prefix in self.approved_path_prefixes
        ):
            raise ValueError("organization anchor paths must be absolute path prefixes")

    @property
    def supports_stable_local_association(self) -> bool:
        return self.location_classification.supports_stable_local_association

    def fetch_scope(self) -> FetchScope:
        return FetchScope(
            allowed_hosts=frozenset(self.approved_hosts),
            allowed_path_prefixes=frozenset(self.approved_path_prefixes),
        )

    def permits_uri(self, uri: str) -> bool:
        return self.fetch_scope().permits_uri(uri)


@dataclass(frozen=True)
class OrganizationAnchorRelease:
    schema_version: str
    release_id: str
    market_id: str
    reviewed_at: str
    source_policy_version: str
    market_census_complete: bool
    automatic_candidate_publication: bool
    anchors: tuple[OrganizationAnchor, ...]
    manifest_sha256: str

    def __post_init__(self) -> None:
        if self.automatic_candidate_publication:
            raise ValueError("organization anchor releases must never auto-publish candidates")
        if not self.anchors:
            raise ValueError("organization anchor release cannot be empty")
        if len({anchor.anchor_id for anchor in self.anchors}) != len(self.anchors):
            raise ValueError("organization anchor IDs must be unique")
        if len({anchor.organization_id for anchor in self.anchors}) != len(self.anchors):
            raise ValueError("organization IDs must be unique in an anchor release")
        if len(self.manifest_sha256) != 64:
            raise ValueError("anchor manifest hash must be a SHA-256 digest")

    def api_summary(self) -> dict[str, object]:
        return {
            "mode": "ORGANIZATION_ANCHOR_REVIEW_PIPELINE_O1",
            "organization_anchor_release_id": self.release_id,
            "organization_anchor_manifest_sha256": self.manifest_sha256,
            "organization_anchor_count": len(self.anchors),
            "market_census_complete": self.market_census_complete,
            "automatic_candidate_publication": self.automatic_candidate_publication,
            "note": (
                "Anchors may produce review proposals only. A person enters the nearby API "
                "only through a separately reviewed, versioned market release."
            ),
        }


@dataclass(frozen=True)
class OrganizationRoleProposal:
    """A minimal public-role proposal for an analyst, never a publishable profile."""

    proposal_id: str
    status: OrganizationProposalStatus
    anchor_id: str
    organization_id: str
    organization_name: str
    person_external_id: str
    display_name: str
    role_title: str
    fact_type: str
    source_id: str
    source_family: str
    source_uri: str
    artifact_sha256: str
    parser_version: str
    occurred_on: str | None
    review_reason: str

    @property
    def release_eligible(self) -> bool:
        """No crawler-created proposal is eligible before a human review/release step."""

        return False


@dataclass(frozen=True)
class OrganizationProposalRejection:
    observation_id: str
    rule_id: str
    reason: str


@dataclass(frozen=True)
class OrganizationDiscoveryBatch:
    proposals: tuple[OrganizationRoleProposal, ...]
    rejections: tuple[OrganizationProposalRejection, ...]

    @property
    def has_publishable_candidates(self) -> bool:
        return False


def public_association_context(kind: LocationAssociationKind) -> dict[str, str]:
    """Explain the local relationship without implying a person is physically there."""

    if kind in {
        LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE,
        LocationAssociationKind.PUBLIC_SERVICE_JURISDICTION,
    }:
        category = PublicAssociationCategory.BASED_HERE
        definition = (
            "Current verified public organization or civic association in this market; "
            "not a claim of physical presence or residence."
        )
    elif kind is LocationAssociationKind.EVENT_ONLY:
        category = PublicAssociationCategory.APPEARING_NEARBY
        definition = (
            "Time-bounded public event association. It is not a stable local association and "
            "is excluded from the current nearby release."
        )
    elif kind is LocationAssociationKind.OPT_IN_LOCATION:
        category = PublicAssociationCategory.OPTED_IN_LOCATION
        definition = "A user-controlled, revocable opted-in association; not a residence."
    else:
        category = PublicAssociationCategory.CONNECTED_HERE
        definition = (
            "Reviewed public professional or institutional connection in this market; "
            "not a claim of physical presence or residence."
        )
    return {"category": category.value, "definition": definition}


def _contains_sensitive_attribute(value: object) -> bool:
    if isinstance(value, Mapping):
        for key, nested in value.items():
            normalized_key = _compact_text(key)
            if any(token in normalized_key for token in _SENSITIVE_ATTRIBUTE_TOKENS):
                return True
            if _contains_sensitive_attribute(nested):
                return True
    elif isinstance(value, (list, tuple)):
        return any(_contains_sensitive_attribute(item) for item in value)
    return False


def _proposal_id(
    *,
    anchor: OrganizationAnchor,
    observation: ParsedObservation,
    display_name: str,
    role_title: str,
) -> str:
    return "orgprop_" + sha256(
        _canonical_json(
            {
                "anchor_id": anchor.anchor_id,
                "observation_id": observation.observation_id,
                "display_name": display_name,
                "role_title": role_title,
            }
        )
    ).hexdigest()[:32]


class OrganizationDiscoveryReviewPolicy:
    """Compile only contracted observations into an explicit human-review queue."""

    policy_version = "organization-discovery-o1"

    def __init__(self, observation_gate: ObservationPolicyGate | None = None) -> None:
        self.observation_gate = observation_gate or ObservationPolicyGate()

    def build_review_batch(
        self,
        *,
        anchor: OrganizationAnchor,
        contract: SourceContract,
        artifact: ArtifactManifest,
        observations: Sequence[ParsedObservation],
    ) -> OrganizationDiscoveryBatch:
        rejections: list[OrganizationProposalRejection] = []
        if contract.source_id != anchor.source_contract_id:
            return self._reject_all(
                observations,
                "ANCHOR-SOURCE-CONTRACT-MISMATCH",
                "The organization anchor is not approved for this source contract.",
            )
        if artifact.source_id != contract.source_id:
            return self._reject_all(
                observations,
                "ARTIFACT-SOURCE-CONTRACT-MISMATCH",
                "The artifact source does not match the selected source contract.",
            )
        if not anchor.supports_stable_local_association:
            return self._reject_all(
                observations,
                "ANCHOR-LOCATION-NOT-PUBLISHABLE",
                "Registered, mailing, agent, and historical locations cannot create local "
                "proposals.",
            )
        if not (
            anchor.permits_uri(artifact.requested_uri)
            and anchor.permits_uri(artifact.final_uri)
        ):
            return self._reject_all(
                observations,
                "ARTIFACT-OUTSIDE-ANCHOR-SCOPE",
                "The requested or final artifact URI is outside the approved organization scope.",
            )
        if contract.candidate_proposal_mode is CandidateProposalMode.DISCOVERY_ONLY:
            return self._reject_all(
                observations,
                "SOURCE-DISCOVERY-ONLY",
                "This source may discover official pages but cannot create person-role proposals.",
            )

        accepted, policy_rejections = self.observation_gate.filter_allowed(observations, contract)
        rejections.extend(
            OrganizationProposalRejection(
                observation_id=observation.observation_id,
                rule_id=decision.rule_id,
                reason=decision.reason,
            )
            for observation, decision in policy_rejections
        )
        identities: dict[str, str] = {}
        for observation in accepted:
            if observation.fact_type.casefold() != "identity_alias":
                continue
            display_name = str(observation.attributes.get("display_name") or "").strip()
            if display_name and not _contains_sensitive_attribute(observation.attributes):
                identities[observation.subject_external_id] = display_name

        proposals: list[OrganizationRoleProposal] = []
        source_family = _host_family(artifact.final_uri)
        for observation in accepted:
            fact_type = observation.fact_type.casefold()
            if fact_type not in _ROLE_FACT_TYPES:
                continue
            if _contains_sensitive_attribute(observation.attributes):
                rejections.append(
                    OrganizationProposalRejection(
                        observation_id=observation.observation_id,
                        rule_id="PERSONAL-ATTRIBUTE-REJECTED",
                        reason=(
                            "A role proposal may not carry an address, contact, or coordinate "
                            "field."
                        ),
                    )
                )
                continue
            display_name = identities.get(observation.subject_external_id, "")
            if not display_name:
                rejections.append(
                    OrganizationProposalRejection(
                        observation_id=observation.observation_id,
                        rule_id="MISSING-IDENTITY-ALIAS",
                        reason=(
                            "A role observation requires an identity alias from the same artifact."
                        ),
                    )
                )
                continue
            organization_name = _compact_text(observation.attributes.get("organization_name"))
            if organization_name != _compact_text(anchor.organization_name):
                rejections.append(
                    OrganizationProposalRejection(
                        observation_id=observation.observation_id,
                        rule_id="ANCHOR-ORGANIZATION-MISMATCH",
                        reason=(
                            "The role observation does not explicitly name the reviewed "
                            "organization anchor."
                        ),
                    )
                )
                continue
            role_title = str(observation.attributes.get("title") or "").strip()
            if not role_title:
                rejections.append(
                    OrganizationProposalRejection(
                        observation_id=observation.observation_id,
                        rule_id="MISSING-ROLE-TITLE",
                        reason="A candidate proposal needs an explicit public role title.",
                    )
                )
                continue
            proposals.append(
                OrganizationRoleProposal(
                    proposal_id=_proposal_id(
                        anchor=anchor,
                        observation=observation,
                        display_name=display_name,
                        role_title=role_title,
                    ),
                    status=OrganizationProposalStatus.REVIEW_REQUIRED,
                    anchor_id=anchor.anchor_id,
                    organization_id=anchor.organization_id,
                    organization_name=anchor.organization_name,
                    person_external_id=observation.subject_external_id,
                    display_name=display_name,
                    role_title=role_title,
                    fact_type=fact_type,
                    source_id=contract.source_id,
                    source_family=source_family,
                    source_uri=artifact.final_uri,
                    artifact_sha256=artifact.sha256,
                    parser_version=observation.parser_version,
                    occurred_on=observation.occurred_on,
                    review_reason=(
                        "Automated intake is limited to a public role proposal; a reviewer must "
                        "verify identity, current role, organization association, and release "
                        "evidence."
                    ),
                )
            )
        return OrganizationDiscoveryBatch(tuple(proposals), tuple(rejections))

    @staticmethod
    def _reject_all(
        observations: Iterable[ParsedObservation], rule_id: str, reason: str
    ) -> OrganizationDiscoveryBatch:
        return OrganizationDiscoveryBatch(
            proposals=(),
            rejections=tuple(
                OrganizationProposalRejection(
                    observation_id=observation.observation_id,
                    rule_id=rule_id,
                    reason=reason,
                )
                for observation in observations
            ),
        )


def load_organization_anchor_release(path: str | Path = _ANCHOR_PATH) -> OrganizationAnchorRelease:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("anchors"), list):
        raise ValueError("organization anchor release must contain an anchors array")
    try:
        anchors = tuple(
            OrganizationAnchor(
                anchor_id=str(item["anchor_id"]),
                organization_id=str(item["organization_id"]),
                organization_name=str(item["organization_name"]),
                source_contract_id=str(item["source_contract_id"]),
                canonical_domain=str(item["canonical_domain"]),
                approved_hosts=tuple(str(host) for host in item["approved_hosts"]),
                approved_path_prefixes=tuple(str(path) for path in item["approved_path_prefixes"]),
                location_classification=OrganizationLocationClassification(
                    str(item["location_classification"])
                ),
                public_market_label=str(item["public_market_label"]),
            )
            for item in raw["anchors"]
        )
        return OrganizationAnchorRelease(
            schema_version=str(raw["schema_version"]),
            release_id=str(raw["release_id"]),
            market_id=str(raw["market_id"]),
            reviewed_at=str(raw["reviewed_at"]),
            source_policy_version=str(raw["source_policy_version"]),
            market_census_complete=bool(raw["market_census_complete"]),
            automatic_candidate_publication=bool(raw["automatic_candidate_publication"]),
            anchors=anchors,
            manifest_sha256=sha256(_canonical_json(raw)).hexdigest(),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"invalid organization anchor release: {exc}") from exc


@lru_cache(maxsize=1)
def get_organization_anchor_release() -> OrganizationAnchorRelease:
    return load_organization_anchor_release()


def validate_anchor_coverage(
    anchor_release: OrganizationAnchorRelease,
    *,
    market_id: str,
    organization_ids: Iterable[str | None],
) -> None:
    """Fail startup if a public release names an organization outside its anchors."""

    if anchor_release.market_id != market_id:
        raise ValueError("organization anchor release does not match the active market release")
    anchored_ids = {anchor.organization_id for anchor in anchor_release.anchors}
    missing = sorted(
        {
            organization_id
            for organization_id in organization_ids
            if organization_id is not None and organization_id not in anchored_ids
        }
    )
    if missing:
        raise ValueError(
            "active market release has organizations without reviewed discovery anchors: "
            + ", ".join(missing)
        )
