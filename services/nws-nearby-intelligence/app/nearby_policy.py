from __future__ import annotations

from dataclasses import dataclass

from app.nws_models import (
    LocationAssociationKind,
    NearbyCandidate,
    ProfileClass,
    VerificationStatus,
)


@dataclass(frozen=True)
class NearbyPolicyDecision:
    allowed: bool
    rule_id: str
    reason: str


class NearbyPolicyEngine:
    """Publication gates for a named nearby professional directory."""

    _ALLOWED_PROFILE_CLASSES = {
        ProfileClass.PUBLIC_FIGURE,
        ProfileClass.PUBLIC_PROFESSIONAL,
        ProfileClass.OPTED_IN,
    }

    def authorize_candidate(self, candidate: NearbyCandidate) -> NearbyPolicyDecision:
        if candidate.profile_class not in self._ALLOWED_PROFILE_CLASSES:
            return NearbyPolicyDecision(
                False,
                "NWS-SUBJECT-001",
                "Private individuals are not eligible for a named nearby ranking.",
            )
        if candidate.verification_status is not VerificationStatus.VERIFIED:
            return NearbyPolicyDecision(
                False,
                "NWS-SUBJECT-002",
                "The public professional identity has not passed verification.",
            )
        if candidate.location.kind is LocationAssociationKind.EVENT_ONLY:
            return NearbyPolicyDecision(
                False,
                "NWS-LOCATION-001",
                "One-time event attendance is not a stable local professional association.",
            )
        if candidate.location.confidence < 0.65:
            return NearbyPolicyDecision(
                False,
                "NWS-LOCATION-002",
                "The public local association is below the publication confidence threshold.",
            )
        if (
            candidate.location.source_count < 1
            and candidate.profile_class is not ProfileClass.OPTED_IN
        ):
            return NearbyPolicyDecision(
                False,
                "NWS-LOCATION-003",
                "A non-opt-in local association needs at least one reviewed public source.",
            )
        if (
            candidate.features.evidence_count < 4
            and candidate.profile_class is not ProfileClass.OPTED_IN
        ):
            return NearbyPolicyDecision(
                False,
                "NWS-EVIDENCE-001",
                "A non-opt-in public professional needs four reviewed evidence facts.",
            )
        return NearbyPolicyDecision(True, "NWS-ALLOW", "Verified public or opted-in professional.")
