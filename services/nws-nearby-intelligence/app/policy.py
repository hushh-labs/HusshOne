from __future__ import annotations

from dataclasses import dataclass

from app.domain.models import (
    Evidence,
    EvidenceKind,
    EvidenceUse,
    PublicFigureStatus,
    Subject,
    SubjectType,
)


class PolicyViolation(RuntimeError):
    pass


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    rule_id: str
    reason: str


class PolicyEngine:
    """Hard gates that keep the analytical service inside its declared purpose."""

    _PERSONAL_WEALTH_EVIDENCE = {
        EvidenceKind.SEC_OWNERSHIP,
        EvidenceKind.SEC_PROXY,
        EvidenceKind.SEC_MAJOR_HOLDER,
        EvidenceKind.MARKET_PRICE,
        EvidenceKind.PRIVATE_COMPANY_DISCLOSURE,
        EvidenceKind.SELF_DISCLOSED_REAL_ESTATE,
        EvidenceKind.DISCLOSED_LIABILITY,
    }

    _SOCIAL_OR_GENERAL_WEB = {
        EvidenceKind.PUBLIC_WEB,
        EvidenceKind.PUBLIC_SOCIAL,
        EvidenceKind.OFFICIAL_BIO,
    }

    def authorize_subject_for_named_wealth(self, subject: Subject) -> PolicyDecision:
        if subject.subject_type is not SubjectType.PUBLIC_FIGURE:
            return PolicyDecision(
                False,
                "SUBJECT-001",
                "Named wealth output is limited to verified public figures.",
            )
        if subject.public_figure_status is not PublicFigureStatus.VERIFIED:
            return PolicyDecision(
                False,
                "SUBJECT-002",
                "The public-figure classification has not passed human verification.",
            )
        return PolicyDecision(True, "SUBJECT-ALLOW", "Verified public figure.")

    def authorize_evidence(self, evidence: Evidence, requested_use: EvidenceUse) -> PolicyDecision:
        if requested_use not in evidence.allowed_uses:
            return PolicyDecision(
                False,
                "EVIDENCE-001",
                f"The source record does not permit use={requested_use.value}.",
            )

        if evidence.subject_type is SubjectType.PRIVATE_PERSON:
            return PolicyDecision(
                False,
                "EVIDENCE-002",
                "Named private-person financial profiling is not an allowed analytical path.",
            )

        if evidence.kind in self._SOCIAL_OR_GENERAL_WEB and requested_use is EvidenceUse.WEALTH:
            return PolicyDecision(
                False,
                "EVIDENCE-003",
                "Public web or social content may support identity/affiliation, not a wealth amount.",
            )

        if evidence.kind is EvidenceKind.IRS_990 and requested_use is EvidenceUse.WEALTH:
            return PolicyDecision(
                False,
                "EVIDENCE-004",
                "Foundation or nonprofit assets are not the associated person's personal assets.",
            )

        if evidence.kind in {EvidenceKind.PROPERTY_ASSESSMENT, EvidenceKind.PROPERTY_SALE}:
            if evidence.subject_type is SubjectType.ANONYMOUS_ASSET_CLUSTER:
                if requested_use is EvidenceUse.AFFLUENCE:
                    return PolicyDecision(True, "EVIDENCE-ALLOW-ANON-PROPERTY", "Anonymous use allowed.")
                return PolicyDecision(
                    False,
                    "EVIDENCE-005",
                    "Anonymous property evidence is limited to affluence analysis.",
                )
            if evidence.kind is not EvidenceKind.SELF_DISCLOSED_REAL_ESTATE:
                return PolicyDecision(
                    False,
                    "EVIDENCE-006",
                    "Property records cannot be converted into named personal wealth evidence.",
                )

        if requested_use is EvidenceUse.WEALTH:
            if evidence.subject_type is not SubjectType.PUBLIC_FIGURE:
                return PolicyDecision(False, "EVIDENCE-007", "Wealth use requires a public figure.")
            if evidence.kind not in self._PERSONAL_WEALTH_EVIDENCE:
                return PolicyDecision(
                    False,
                    "EVIDENCE-008",
                    f"Evidence kind {evidence.kind.value} cannot create a personal asset amount.",
                )

        return PolicyDecision(True, "EVIDENCE-ALLOW", "Evidence use is allowed.")

    def require(self, decision: PolicyDecision) -> None:
        if not decision.allowed:
            raise PolicyViolation(f"{decision.rule_id}: {decision.reason}")
