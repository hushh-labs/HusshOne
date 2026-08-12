from datetime import date, timedelta

from app.feature_engineering import (
    EvidenceSignal,
    FeatureSignalKind,
    PersonFeatureContext,
    build_feature_vectors,
)
from app.graph_scoring import GraphPersonSignals
from app.nws_models import ProfessionalLane


def graph(value: float) -> GraphPersonSignals:
    return GraphPersonSignals(value, value, value, value)


def signal(
    person: str,
    kind: FeatureSignalKind,
    magnitude: float,
    key: str,
    *,
    family: str = "official",
    quality: float = 0.9,
    days_old: int = 0,
    self_published: bool = False,
    suspicious: bool = False,
) -> EvidenceSignal:
    as_of = date(2026, 8, 12)
    return EvidenceSignal(
        person_id=person,
        kind=kind,
        magnitude=magnitude,
        source_family=family,
        source_quality=quality,
        observed_on=as_of - timedelta(days=days_old),
        half_life_days=365,
        evidence_key=key,
        self_published=self_published,
        suspicious=suspicious,
    )


def test_duplicate_evidence_key_does_not_multiply_feature() -> None:
    contexts = [
        PersonFeatureContext("a", ProfessionalLane.BUILDER, 0.95),
        PersonFeatureContext("b", ProfessionalLane.BUILDER, 0.95),
    ]
    duplicated = signal("a", FeatureSignalKind.OUTCOME_TRACK_RECORD, 10, "same-fact")
    result = build_feature_vectors(
        contexts=contexts,
        graph_signals={"a": graph(0.8), "b": graph(0.5)},
        evidence_signals=[
            duplicated,
            duplicated,
            signal("b", FeatureSignalKind.OUTCOME_TRACK_RECORD, 5, "other-fact"),
        ],
        as_of=date(2026, 8, 12),
    )
    assert result.dropped_duplicate_count == 1
    assert result.deduplicated_signal_count == 2
    assert result.vectors["a"].outcome_track_record_percentile > result.vectors["b"].outcome_track_record_percentile


def test_source_diversity_and_anti_gaming_ratios_are_computed() -> None:
    contexts = [PersonFeatureContext("a", ProfessionalLane.CONNECTOR, 0.9)]
    result = build_feature_vectors(
        contexts=contexts,
        graph_signals={"a": graph(0.7)},
        evidence_signals=[
            signal("a", FeatureSignalKind.TRUSTED_REACH, 10, "one", family="official"),
            signal(
                "a",
                FeatureSignalKind.TRUSTED_REACH,
                8,
                "two",
                family="self-site",
                self_published=True,
                suspicious=True,
            ),
        ],
        as_of=date(2026, 8, 12),
    )
    vector = result.vectors["a"]
    assert vector.source_diversity > 0.8
    assert 0 < vector.self_published_source_ratio < 1
    assert 0 < vector.suspicious_pattern_ratio < 1
    assert 0.5 < vector.dominant_source_ratio < 0.7


def test_old_evidence_is_decayed() -> None:
    contexts = [
        PersonFeatureContext("fresh", ProfessionalLane.KNOWLEDGE, 0.95),
        PersonFeatureContext("old", ProfessionalLane.KNOWLEDGE, 0.95),
    ]
    result = build_feature_vectors(
        contexts=contexts,
        graph_signals={"fresh": graph(0.5), "old": graph(0.5)},
        evidence_signals=[
            signal("fresh", FeatureSignalKind.KNOWLEDGE_CREATION, 10, "fresh"),
            signal(
                "old",
                FeatureSignalKind.KNOWLEDGE_CREATION,
                10,
                "old",
                days_old=730,
            ),
        ],
        as_of=date(2026, 8, 12),
    )
    assert result.vectors["fresh"].freshness > result.vectors["old"].freshness
    assert result.vectors["fresh"].knowledge_creation_percentile > result.vectors["old"].knowledge_creation_percentile
