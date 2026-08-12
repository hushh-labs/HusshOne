from app.collectors.contracts import ParsedObservation
from app.feature_engineering import FeatureSignalKind
from app.observation_projection import ObservationProjector
from datetime import date


def observation(fact: str, *, attributes: dict[str, object]) -> ParsedObservation:
    return ParsedObservation(
        observation_id=f"obs-{fact}",
        source_id="official_company_pages",
        artifact_sha256="a" * 64,
        parser_version="test-v1",
        fact_type=fact,
        subject_external_id="external-person",
        object_external_id="external-org",
        confidence=0.9,
        occurred_on="2026-08-01",
        attributes=attributes,
    )


def test_current_ceo_projects_role_graph_and_capital_signals() -> None:
    batch = ObservationProjector().project(
        [observation("current_role", attributes={"title": "Chief Executive Officer"})],
        external_to_canonical={"external-person": "person-1", "external-org": "org-1"},
        source_quality_by_source={"official_company_pages": 0.9},
        identity_confidence_by_person={"person-1": 0.95},
        default_observed_on=date(2026, 8, 12),
    )
    assert [edge.relation for edge in batch.graph_edges] == ["CURRENT_CEO"]
    assert {signal.kind for signal in batch.feature_signals} == {
        FeatureSignalKind.ROLE_AUTHORITY,
        FeatureSignalKind.CAPITAL_ACCESS,
    }


def test_identity_alias_does_not_create_score_signal() -> None:
    batch = ObservationProjector().project(
        [observation("identity_alias", attributes={"display_name": "Example"})],
        external_to_canonical={"external-person": "person-1", "external-org": "org-1"},
        source_quality_by_source={"official_company_pages": 0.9},
        identity_confidence_by_person={"person-1": 0.95},
        default_observed_on=date(2026, 8, 12),
    )
    assert not batch.graph_edges
    assert not batch.feature_signals
    assert batch.ignored_observation_ids == ("obs-identity_alias",)


def test_beneficial_ownership_uses_relationship_not_share_value() -> None:
    batch = ObservationProjector().project(
        [
            observation(
                "beneficial_ownership",
                attributes={"post_transaction_shares": "999999999", "price_per_share": "1000"},
            )
        ],
        external_to_canonical={"external-person": "person-1", "external-org": "org-1"},
        source_quality_by_source={"official_company_pages": 0.9},
        identity_confidence_by_person={"person-1": 0.95},
        default_observed_on=date(2026, 8, 12),
    )
    signal = batch.feature_signals[0]
    assert signal.kind is FeatureSignalKind.CAPITAL_ACCESS
    assert signal.magnitude == 0.5
