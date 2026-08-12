from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Protocol, Sequence

from app.collectors.contracts import ArtifactManifest, ParsedObservation, SourceContract


def deterministic_observation_id(
    *,
    source_id: str,
    artifact_sha256: str,
    fact_type: str,
    subject_external_id: str,
    object_external_id: str | None,
    attributes: dict[str, object],
) -> str:
    canonical = json.dumps(
        {
            "source_id": source_id,
            "artifact_sha256": artifact_sha256,
            "fact_type": fact_type.casefold(),
            "subject_external_id": subject_external_id,
            "object_external_id": object_external_id,
            "attributes": attributes,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return "obs_" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


class ObservationParser(Protocol):
    parser_id: str
    parser_version: str
    supported_source_ids: frozenset[str]

    def parse(self, content: bytes, manifest: ArtifactManifest) -> list[ParsedObservation]: ...


@dataclass(frozen=True)
class ObservationPolicyDecision:
    allowed: bool
    rule_id: str
    reason: str


class ObservationPolicyGate:
    """Enforces the source contract after parsing and before canonical ingestion."""

    def authorize(
        self,
        observation: ParsedObservation,
        contract: SourceContract,
    ) -> ObservationPolicyDecision:
        if observation.source_id != contract.source_id:
            return ObservationPolicyDecision(
                False,
                "SOURCE-ID-MISMATCH",
                "The parser observation source does not match the acquisition contract.",
            )
        fact = observation.fact_type.casefold()
        allowed = {item.casefold() for item in contract.allowed_fact_types}
        forbidden = {item.casefold() for item in contract.forbidden_fact_types}
        if fact in forbidden:
            return ObservationPolicyDecision(
                False,
                "FACT-FORBIDDEN",
                f"Fact type {observation.fact_type!r} is forbidden for this source.",
            )
        if fact not in allowed:
            return ObservationPolicyDecision(
                False,
                "FACT-NOT-CONTRACTED",
                f"Fact type {observation.fact_type!r} is outside this source contract.",
            )
        if observation.confidence > contract.base_reliability + 0.05:
            return ObservationPolicyDecision(
                False,
                "CONFIDENCE-ABOVE-SOURCE",
                "Parser confidence materially exceeds the configured source reliability.",
            )
        return ObservationPolicyDecision(True, "OBSERVATION-ALLOW", "Observation is contracted.")

    def filter_allowed(
        self,
        observations: Sequence[ParsedObservation],
        contract: SourceContract,
    ) -> tuple[list[ParsedObservation], list[tuple[ParsedObservation, ObservationPolicyDecision]]]:
        accepted: list[ParsedObservation] = []
        rejected: list[tuple[ParsedObservation, ObservationPolicyDecision]] = []
        for observation in observations:
            decision = self.authorize(observation, contract)
            if decision.allowed:
                accepted.append(observation)
            else:
                rejected.append((observation, decision))
        return accepted, rejected
