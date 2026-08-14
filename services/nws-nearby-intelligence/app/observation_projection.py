from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from math import isfinite

from app.collectors.contracts import ParsedObservation
from app.feature_engineering import EvidenceSignal, FeatureSignalKind
from app.graph_scoring import GraphEdge


@dataclass(frozen=True)
class ProjectedObservationBatch:
    graph_edges: tuple[GraphEdge, ...]
    feature_signals: tuple[EvidenceSignal, ...]
    ignored_observation_ids: tuple[str, ...]


def _normalized_title(attributes: Mapping[str, object]) -> str:
    return str(attributes.get("title") or attributes.get("officer_title") or "").casefold()


def _finite_number(attributes: Mapping[str, object], key: str, *, default: float) -> float:
    raw = attributes.get(key)
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if isfinite(value) else default


def _role_authority(title: str, fact_type: str) -> float:
    value = f"{fact_type.casefold()} {title}"
    if "founder" in value:
        return 1.00
    if "chief executive" in value or " ceo" in f" {value}":
        return 0.95
    if "general partner" in value or "managing partner" in value:
        return 0.90
    if "board" in value or "director_role" in value:
        return 0.85
    if any(token in value for token in ("cto", "cfo", "coo", "chief ")):
        return 0.82
    if "agency" in value or "public_official" in value:
        return 0.85
    if "lab lead" in value or "laboratory director" in value:
        return 0.74
    if "chair" in value or "trustee" in value:
        return 0.72
    if "professor" in value or "faculty" in value:
        return 0.62
    if "advisor" in value:
        return 0.35
    return 0.55


def _relation_for_role(fact_type: str, title: str) -> str:
    value = f"{fact_type.casefold()} {title}"
    if "founder" in value:
        return "FOUNDED"
    if "director_role" in value or "board" in value:
        return "BOARD_MEMBER"
    if "partner" in value:
        return "GENERAL_PARTNER"
    if "public_official" in value or "agency" in value:
        return "PUBLIC_OFFICIAL"
    if "lab" in value:
        return "RESEARCH_LAB_LEAD"
    if "chief executive" in value or " ceo" in f" {value}":
        return "CURRENT_CEO"
    if any(token in value for token in ("cto", "cfo", "coo", "chief ")):
        return "CURRENT_CXO"
    return "CURRENT_ROLE"


class ObservationProjector:
    """Project approved source observations into graph edges and feature signals.

    This layer is intentionally conservative. It uses relationship presence and verified outcomes;
    it does not convert share values, home values, compensation, or follower counts into personal
    financial wealth.
    """

    projector_version = "observation-projector-v1.0.0"

    def project(
        self,
        observations: Sequence[ParsedObservation],
        *,
        external_to_canonical: Mapping[str, str],
        source_quality_by_source: Mapping[str, float],
        identity_confidence_by_person: Mapping[str, float],
        source_family_by_source: Mapping[str, str] | None = None,
        default_observed_on: date,
    ) -> ProjectedObservationBatch:
        graph_edges: list[GraphEdge] = []
        feature_signals: list[EvidenceSignal] = []
        ignored: list[str] = []
        families = source_family_by_source or {}

        for observation in observations:
            person_id = external_to_canonical.get(observation.subject_external_id)
            if person_id is None:
                ignored.append(observation.observation_id)
                continue
            object_id = (
                external_to_canonical.get(observation.object_external_id)
                if observation.object_external_id
                else None
            )
            source_quality = max(
                0.0,
                min(1.0, source_quality_by_source.get(observation.source_id, 0.5)),
            )
            identity_confidence = max(
                0.0,
                min(1.0, identity_confidence_by_person.get(person_id, 0.5)),
            )
            combined_confidence = (
                source_quality * observation.confidence * identity_confidence
            )
            observed_on = (
                date.fromisoformat(observation.occurred_on)
                if observation.occurred_on
                else default_observed_on
            )
            source_family = families.get(observation.source_id, observation.source_id)
            fact = observation.fact_type.casefold()
            title = _normalized_title(observation.attributes)

            # Ownership filings are retained as source evidence, not NWS score inputs.  A
            # reporting owner can be a passive holder, trust, or other owner with no verified
            # professional role at the issuer.  The parser emits separate ``director_role`` and
            # ``public_role`` observations when the filing actually supports those roles, so
            # projecting the broad relationship or transaction again would both double count the
            # filing and let ownership affect a public-professional ranking.
            if fact in {"beneficial_ownership", "issuer_relationship"}:
                ignored.append(observation.observation_id)
                continue

            # SEC officer/director facts are publishable only when the issuer resolved to the
            # canonical graph.  Without that object scope, the title is not a verified
            # person-to-issuer professional relationship.
            if (
                observation.source_id == "sec_edgar_ownership"
                and fact in {"director_role", "public_role"}
                and object_id is None
            ):
                ignored.append(observation.observation_id)
                continue

            if fact in {
                "current_role",
                "public_role",
                "director_role",
                "founder_role",
                "board_role",
                "partner_role",
                "public_official_role",
                "faculty_role",
                "lab_leadership",
            }:
                authority = _role_authority(title, fact)
                relation = _relation_for_role(fact, title)
                if object_id:
                    graph_edges.append(
                        GraphEdge(
                            source=person_id,
                            target=object_id,
                            relation=relation,
                            base_weight=authority,
                            source_confidence=combined_confidence,
                            age_days=max(0, (default_observed_on - observed_on).days),
                            half_life_days=540,
                        )
                    )
                feature_signals.append(
                    self._signal(
                        observation,
                        person_id=person_id,
                        kind=FeatureSignalKind.ROLE_AUTHORITY,
                        magnitude=authority,
                        source_family=source_family,
                        source_quality=source_quality,
                        observed_on=observed_on,
                        half_life_days=540,
                    )
                )
                if relation in {"FOUNDED", "BOARD_MEMBER"}:
                    feature_signals.append(
                        self._signal(
                            observation,
                            person_id=person_id,
                            kind=FeatureSignalKind.FOUNDER_BOARD,
                            magnitude=authority,
                            source_family=source_family,
                            source_quality=source_quality,
                            observed_on=observed_on,
                            half_life_days=1095,
                            suffix=relation,
                        )
                    )
                if relation in {"FOUNDED", "GENERAL_PARTNER", "BOARD_MEMBER", "CURRENT_CEO"}:
                    feature_signals.append(
                        self._signal(
                            observation,
                            person_id=person_id,
                            kind=FeatureSignalKind.CAPITAL_ACCESS,
                            magnitude=0.4 + 0.6 * authority,
                            source_family=source_family,
                            source_quality=source_quality,
                            observed_on=observed_on,
                            half_life_days=730,
                            suffix="capital-access",
                        )
                    )
                if relation == "PUBLIC_OFFICIAL":
                    feature_signals.append(
                        self._signal(
                            observation,
                            person_id=person_id,
                            kind=FeatureSignalKind.CIVIC_LEADERSHIP,
                            magnitude=authority,
                            source_family=source_family,
                            source_quality=source_quality,
                            observed_on=observed_on,
                            half_life_days=365,
                            suffix="civic",
                        )
                    )
                continue

            if fact == "investor_role":
                if object_id is None:
                    ignored.append(observation.observation_id)
                    continue
                graph_edges.append(
                    GraphEdge(
                        source=person_id,
                        target=object_id,
                        relation="PUBLICLY_INVESTED_IN",
                        base_weight=0.62,
                        source_confidence=combined_confidence,
                        age_days=max(0, (default_observed_on - observed_on).days),
                        half_life_days=730,
                    )
                )
                feature_signals.append(
                    self._signal(
                        observation,
                        person_id=person_id,
                        kind=FeatureSignalKind.CAPITAL_ACCESS,
                        magnitude=0.65,
                        source_family=source_family,
                        source_quality=source_quality,
                        observed_on=observed_on,
                        half_life_days=730,
                    )
                )
                continue

            if fact in {"inventor", "patent", "author", "work", "coauthor"}:
                if object_id:
                    graph_edges.append(
                        GraphEdge(
                            source=person_id,
                            target=object_id,
                            relation="INVENTED" if fact in {"inventor", "patent"} else "AUTHORED",
                            base_weight=0.55 if fact in {"inventor", "patent"} else 0.45,
                            source_confidence=combined_confidence,
                            age_days=max(0, (default_observed_on - observed_on).days),
                            half_life_days=1825,
                        )
                    )
                magnitude = _finite_number(
                    observation.attributes, "normalized_impact", default=1.0
                )
                feature_signals.append(
                    self._signal(
                        observation,
                        person_id=person_id,
                        kind=FeatureSignalKind.KNOWLEDGE_CREATION,
                        magnitude=max(0.0, magnitude),
                        source_family=source_family,
                        source_quality=source_quality,
                        observed_on=observed_on,
                        half_life_days=1825,
                    )
                )
                continue

            if fact in {
                "appointment",
                "acquisition",
                "funding_event",
                "award",
                "company_event",
                "public_partnership",
            }:
                # A funding, acquisition, award, or contract amount belongs to the organization
                # or event. It is not the person's money and cannot make that person rank higher.
                # The verified event contributes only a fixed presence signal.
                magnitude = 1.0
                feature_signals.append(
                    self._signal(
                        observation,
                        person_id=person_id,
                        kind=FeatureSignalKind.OUTCOME_TRACK_RECORD,
                        magnitude=max(0.0, magnitude),
                        source_family=source_family,
                        source_quality=source_quality,
                        observed_on=observed_on,
                        half_life_days=1095,
                    )
                )
                continue

            if fact in {"speaker_role", "panel_role", "trusted_media_mention"}:
                feature_signals.append(
                    self._signal(
                        observation,
                        person_id=person_id,
                        kind=FeatureSignalKind.TRUSTED_REACH,
                        magnitude=0.30 if fact != "trusted_media_mention" else 0.15,
                        source_family=source_family,
                        source_quality=source_quality,
                        observed_on=observed_on,
                        half_life_days=180,
                    )
                )
                continue

            if fact == "bounded_public_reach":
                normalized_reach = min(
                    1.0,
                    max(
                        0.0,
                        _finite_number(
                            observation.attributes, "normalized_reach", default=0.0
                        ),
                    ),
                )
                feature_signals.append(
                    self._signal(
                        observation,
                        person_id=person_id,
                        kind=FeatureSignalKind.VERIFIED_SOCIAL_REACH,
                        magnitude=normalized_reach,
                        source_family=source_family,
                        source_quality=min(source_quality, 0.72),
                        observed_on=observed_on,
                        half_life_days=120,
                        self_published=True,
                    )
                )
                continue

            # Identity aliases, public profile links and location observations are consumed by
            # identity/location services and intentionally do not create NWS feature magnitude.
            ignored.append(observation.observation_id)

        return ProjectedObservationBatch(
            graph_edges=tuple(graph_edges),
            feature_signals=tuple(feature_signals),
            ignored_observation_ids=tuple(ignored),
        )

    @staticmethod
    def _signal(
        observation: ParsedObservation,
        *,
        person_id: str,
        kind: FeatureSignalKind,
        magnitude: float,
        source_family: str,
        source_quality: float,
        observed_on: date,
        half_life_days: int,
        suffix: str = "",
        self_published: bool = False,
    ) -> EvidenceSignal:
        return EvidenceSignal(
            person_id=person_id,
            kind=kind,
            magnitude=magnitude,
            source_family=source_family,
            source_quality=source_quality,
            observed_on=observed_on,
            half_life_days=half_life_days,
            evidence_key=(
                observation.observation_id
                if not suffix
                else f"{observation.observation_id}:{suffix}"
            ),
            self_published=self_published,
            suspicious=False,
        )
