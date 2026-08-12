from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from math import exp, log, log1p
from statistics import fmean
from typing import Iterable, Mapping

from app.graph_scoring import GraphPersonSignals
from app.nws_models import NwsFeatureVector, ProfessionalLane


class FeatureSignalKind(StrEnum):
    ROLE_AUTHORITY = "ROLE_AUTHORITY"
    INSTITUTION_STRENGTH = "INSTITUTION_STRENGTH"
    FOUNDER_BOARD = "FOUNDER_BOARD"
    OUTCOME_TRACK_RECORD = "OUTCOME_TRACK_RECORD"
    KNOWLEDGE_CREATION = "KNOWLEDGE_CREATION"
    CIVIC_LEADERSHIP = "CIVIC_LEADERSHIP"
    CAPITAL_ACCESS = "CAPITAL_ACCESS"
    TRUSTED_REACH = "TRUSTED_REACH"
    VERIFIED_SOCIAL_REACH = "VERIFIED_SOCIAL_REACH"


@dataclass(frozen=True)
class PersonFeatureContext:
    person_id: str
    lane: ProfessionalLane
    identity_confidence: float

    def __post_init__(self) -> None:
        if not self.person_id.strip():
            raise ValueError("person_id is required")
        if not 0 <= self.identity_confidence <= 1:
            raise ValueError("identity_confidence must be in [0, 1]")


@dataclass(frozen=True)
class EvidenceSignal:
    person_id: str
    kind: FeatureSignalKind
    magnitude: float
    source_family: str
    source_quality: float
    observed_on: date
    half_life_days: int
    evidence_key: str
    self_published: bool = False
    suspicious: bool = False

    def __post_init__(self) -> None:
        if not self.person_id.strip() or not self.source_family.strip() or not self.evidence_key.strip():
            raise ValueError("person_id, source_family and evidence_key are required")
        if self.magnitude < 0:
            raise ValueError("magnitude cannot be negative")
        if not 0 <= self.source_quality <= 1:
            raise ValueError("source_quality must be in [0, 1]")
        if self.half_life_days <= 0:
            raise ValueError("half_life_days must be positive")

    def age_days(self, as_of: date) -> int:
        return max(0, (as_of - self.observed_on).days)

    def freshness(self, as_of: date) -> float:
        return exp(-log(2) * self.age_days(as_of) / self.half_life_days)

    def effective_value(self, as_of: date) -> float:
        # log1p prevents a raw count of 1,000 from being 1,000x a count of one.
        return log1p(self.magnitude) * self.source_quality * self.freshness(as_of)


@dataclass(frozen=True)
class FeatureEngineeringResult:
    vectors: Mapping[str, NwsFeatureVector]
    raw_feature_totals: Mapping[str, Mapping[FeatureSignalKind, float]]
    deduplicated_signal_count: int
    dropped_duplicate_count: int


def _deduplicate(signals: Iterable[EvidenceSignal], *, as_of: date) -> tuple[list[EvidenceSignal], int]:
    """Keep one observation per semantic evidence key.

    Mirrors and repeated parses of the same underlying fact therefore corroborate through source
    metadata elsewhere, but cannot multiply a raw feature count.
    """

    selected: dict[tuple[str, FeatureSignalKind, str], EvidenceSignal] = {}
    duplicates = 0
    for signal in signals:
        key = (signal.person_id, signal.kind, signal.evidence_key)
        previous = selected.get(key)
        if previous is None:
            selected[key] = signal
            continue
        duplicates += 1
        previous_rank = (
            previous.effective_value(as_of),
            previous.observed_on,
            previous.source_quality,
            previous.source_family,
        )
        current_rank = (
            signal.effective_value(as_of),
            signal.observed_on,
            signal.source_quality,
            signal.source_family,
        )
        if current_rank > previous_rank:
            selected[key] = signal
    return list(selected.values()), duplicates


def _quantile(values: list[float], probability: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = probability * (len(ordered) - 1)
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _winsorize(values: Mapping[str, float], *, lower: float = 0.01, upper: float = 0.99) -> dict[str, float]:
    if not values:
        return {}
    sequence = list(values.values())
    floor = _quantile(sequence, lower)
    ceiling = _quantile(sequence, upper)
    return {key: min(ceiling, max(floor, value)) for key, value in values.items()}


def _percentiles(values: Mapping[str, float], *, zero_is_zero: bool = True) -> dict[str, float]:
    if not values:
        return {}
    ordered = sorted(values.items(), key=lambda item: (item[1], item[0]))
    result: dict[str, float] = {}
    total = len(ordered)
    index = 0
    while index < total:
        end = index + 1
        while end < total and ordered[end][1] == ordered[index][1]:
            end += 1
        percentile = ((index + end - 1) / 2 + 0.5) / total
        for key, value in ordered[index:end]:
            result[key] = 0.0 if zero_is_zero and value <= 0 else percentile
        index = end
    return result


def _lane_shrunk_percentiles(
    totals: Mapping[str, float],
    contexts: Mapping[str, PersonFeatureContext],
    *,
    shrinkage_k: float = 20.0,
) -> dict[str, float]:
    winsorized = _winsorize(totals)
    global_percentiles = _percentiles(winsorized)
    lane_members: dict[ProfessionalLane, list[str]] = defaultdict(list)
    for person_id, context in contexts.items():
        lane_members[context.lane].append(person_id)

    result: dict[str, float] = {}
    for lane, member_ids in lane_members.items():
        lane_values = {person_id: winsorized.get(person_id, 0.0) for person_id in member_ids}
        lane_percentiles = _percentiles(lane_values)
        n = len(member_ids)
        lane_weight = n / (n + shrinkage_k)
        for person_id in member_ids:
            result[person_id] = (
                lane_weight * lane_percentiles[person_id]
                + (1.0 - lane_weight) * global_percentiles[person_id]
            )
    return result


def _source_diversity(signals: list[EvidenceSignal], *, as_of: date) -> tuple[float, float]:
    weights: Counter[str] = Counter()
    for signal in signals:
        weights[signal.source_family] += signal.effective_value(as_of)
    total = sum(weights.values())
    if total <= 0:
        return 0.0, 1.0 if signals else 0.0
    dominant = max(weights.values()) / total
    if len(weights) <= 1:
        return 0.0, dominant
    entropy = -sum((weight / total) * log(weight / total) for weight in weights.values() if weight > 0)
    diversity = entropy / log(len(weights))
    return max(0.0, min(1.0, diversity)), max(0.0, min(1.0, dominant))


def build_feature_vectors(
    *,
    contexts: Iterable[PersonFeatureContext],
    graph_signals: Mapping[str, GraphPersonSignals],
    evidence_signals: Iterable[EvidenceSignal],
    as_of: date,
) -> FeatureEngineeringResult:
    """Convert deduplicated, decayed raw public evidence into NWS feature vectors.

    All raw magnitudes are transformed and normalized across peer cohorts. The output is suitable
    for `app.nws.score_candidate`; no private financial or residential feature is accepted.
    """

    context_by_person = {context.person_id: context for context in contexts}
    if not context_by_person:
        return FeatureEngineeringResult({}, {}, 0, 0)
    unknown_graph = set(graph_signals) - set(context_by_person)
    if unknown_graph:
        raise ValueError(f"graph signals contain unknown people: {sorted(unknown_graph)}")

    deduplicated, duplicate_count = _deduplicate(evidence_signals, as_of=as_of)
    unknown_evidence = {signal.person_id for signal in deduplicated} - set(context_by_person)
    if unknown_evidence:
        raise ValueError(f"evidence signals contain unknown people: {sorted(unknown_evidence)}")

    by_person: dict[str, list[EvidenceSignal]] = defaultdict(list)
    totals: dict[str, dict[FeatureSignalKind, float]] = {
        person_id: {kind: 0.0 for kind in FeatureSignalKind}
        for person_id in context_by_person
    }
    for signal in deduplicated:
        by_person[signal.person_id].append(signal)
        totals[signal.person_id][signal.kind] += signal.effective_value(as_of)

    percentiles_by_kind: dict[FeatureSignalKind, dict[str, float]] = {}
    for kind in FeatureSignalKind:
        values = {person_id: totals[person_id][kind] for person_id in context_by_person}
        percentiles_by_kind[kind] = _lane_shrunk_percentiles(values, context_by_person)

    vectors: dict[str, NwsFeatureVector] = {}
    for person_id, context in context_by_person.items():
        person_signals = by_person.get(person_id, [])
        graph = graph_signals.get(
            person_id,
            GraphPersonSignals(
                pagerank_percentile=0.0,
                kcore_percentile=0.0,
                bridging_percentile=0.0,
                cross_sector_percentile=0.0,
            ),
        )
        weights = [signal.effective_value(as_of) for signal in person_signals]
        weight_total = sum(weights)
        if weight_total > 0:
            source_quality = sum(
                weight * signal.source_quality
                for weight, signal in zip(weights, person_signals, strict=True)
            ) / weight_total
            freshness = sum(
                weight * signal.freshness(as_of)
                for weight, signal in zip(weights, person_signals, strict=True)
            ) / weight_total
            self_published_ratio = sum(
                weight
                for weight, signal in zip(weights, person_signals, strict=True)
                if signal.self_published
            ) / weight_total
            suspicious_ratio = sum(
                weight
                for weight, signal in zip(weights, person_signals, strict=True)
                if signal.suspicious
            ) / weight_total
        else:
            source_quality = 0.0
            freshness = 0.0
            self_published_ratio = 0.0
            suspicious_ratio = 0.0
        source_diversity, dominant_source_ratio = _source_diversity(
            person_signals, as_of=as_of
        )

        p = {kind: percentiles_by_kind[kind][person_id] for kind in FeatureSignalKind}
        vectors[person_id] = NwsFeatureVector(
            pagerank_percentile=graph.pagerank_percentile,
            kcore_percentile=graph.kcore_percentile,
            bridging_percentile=graph.bridging_percentile,
            cross_sector_percentile=graph.cross_sector_percentile,
            role_authority_percentile=p[FeatureSignalKind.ROLE_AUTHORITY],
            institution_strength_percentile=p[FeatureSignalKind.INSTITUTION_STRENGTH],
            founder_board_percentile=p[FeatureSignalKind.FOUNDER_BOARD],
            outcome_track_record_percentile=p[FeatureSignalKind.OUTCOME_TRACK_RECORD],
            knowledge_creation_percentile=p[FeatureSignalKind.KNOWLEDGE_CREATION],
            civic_leadership_percentile=p[FeatureSignalKind.CIVIC_LEADERSHIP],
            capital_access_percentile=p[FeatureSignalKind.CAPITAL_ACCESS],
            trusted_reach_percentile=p[FeatureSignalKind.TRUSTED_REACH],
            verified_social_reach_percentile=p[FeatureSignalKind.VERIFIED_SOCIAL_REACH],
            freshness=max(0.0, min(1.0, freshness)),
            source_quality=max(0.0, min(1.0, source_quality)),
            source_diversity=source_diversity,
            identity_confidence=context.identity_confidence,
            evidence_count=len(person_signals),
            suspicious_pattern_ratio=max(0.0, min(1.0, suspicious_ratio)),
            self_published_source_ratio=max(0.0, min(1.0, self_published_ratio)),
            dominant_source_ratio=dominant_source_ratio,
        )

    return FeatureEngineeringResult(
        vectors=vectors,
        raw_feature_totals={
            person_id: dict(person_totals) for person_id, person_totals in totals.items()
        },
        deduplicated_signal_count=len(deduplicated),
        dropped_duplicate_count=duplicate_count,
    )
