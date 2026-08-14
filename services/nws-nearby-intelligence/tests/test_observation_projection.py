from datetime import date

from app.collectors.contracts import ParsedObservation
from app.feature_engineering import FeatureSignalKind
from app.observation_projection import ObservationProjector


def observation(
    fact: str,
    *,
    attributes: dict[str, object],
    source_id: str = "official_company_pages",
    object_external_id: str | None = "external-org",
) -> ParsedObservation:
    return ParsedObservation(
        observation_id=f"obs-{fact}",
        source_id=source_id,
        artifact_sha256="a" * 64,
        parser_version="test-v1",
        fact_type=fact,
        subject_external_id="external-person",
        object_external_id=object_external_id,
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


def _project(
    observations: list[ParsedObservation],
    *,
    include_issuer_mapping: bool = True,
):  # type: ignore[no-untyped-def]
    external_to_canonical = {"external-person": "person-1"}
    if include_issuer_mapping:
        external_to_canonical["external-org"] = "org-1"
    return ObservationProjector().project(
        observations,
        external_to_canonical=external_to_canonical,
        source_quality_by_source={
            "official_company_pages": 0.9,
            "sec_edgar_ownership": 0.98,
        },
        identity_confidence_by_person={"person-1": 0.95},
        default_observed_on=date(2026, 8, 12),
    )


def test_beneficial_ownership_is_evidence_only_regardless_of_financial_values() -> None:
    low_value = _project(
        [
            observation(
                "beneficial_ownership",
                source_id="sec_edgar_ownership",
                attributes={"post_transaction_shares": "1", "price_per_share": "0.01"},
            )
        ]
    )
    high_value = _project(
        [
            observation(
                "beneficial_ownership",
                source_id="sec_edgar_ownership",
                attributes={
                    "post_transaction_shares": "999999999999",
                    "price_per_share": "999999999",
                    "market_value": "financial-canary",
                },
            )
        ]
    )

    assert low_value.graph_edges == high_value.graph_edges == ()
    assert low_value.feature_signals == high_value.feature_signals == ()
    assert low_value.ignored_observation_ids == high_value.ignored_observation_ids == (
        "obs-beneficial_ownership",
    )


def test_owner_only_sec_relationship_has_no_graph_or_score_signal() -> None:
    batch = _project(
        [
            observation(
                "issuer_relationship",
                source_id="sec_edgar_ownership",
                attributes={
                    "is_director": False,
                    "is_officer": False,
                    "is_ten_percent_owner": True,
                },
            ),
            observation(
                "beneficial_ownership",
                source_id="sec_edgar_ownership",
                attributes={"shares": "5000000", "price_per_share": "1000"},
            ),
        ]
    )

    assert batch.graph_edges == ()
    assert batch.feature_signals == ()
    assert batch.ignored_observation_ids == (
        "obs-issuer_relationship",
        "obs-beneficial_ownership",
    )


def test_sec_officer_role_requires_resolved_issuer_scope() -> None:
    role = observation(
        "public_role",
        source_id="sec_edgar_ownership",
        attributes={"title": "Chief Executive Officer"},
    )

    unresolved = _project([role], include_issuer_mapping=False)
    resolved = _project([role], include_issuer_mapping=True)

    assert unresolved.graph_edges == ()
    assert unresolved.feature_signals == ()
    assert unresolved.ignored_observation_ids == ("obs-public_role",)
    assert [edge.relation for edge in resolved.graph_edges] == ["CURRENT_CEO"]
    assert {signal.kind for signal in resolved.feature_signals} == {
        FeatureSignalKind.ROLE_AUTHORITY,
        FeatureSignalKind.CAPITAL_ACCESS,
    }


def test_company_event_financial_amounts_cannot_change_score_signal() -> None:
    small = _project(
        [
            observation(
                "funding_event",
                attributes={"funding_amount_usd": 1, "normalized_magnitude": 0.01},
            )
        ]
    )
    large = _project(
        [
            observation(
                "funding_event",
                attributes={
                    "funding_amount_usd": 100_000_000_000,
                    "normalized_magnitude": 1_000_000,
                    "transaction_value_usd": "financial-canary",
                },
            )
        ]
    )

    assert small.graph_edges == large.graph_edges == ()
    assert small.feature_signals == large.feature_signals
    assert len(small.feature_signals) == 1
    assert small.feature_signals[0].kind is FeatureSignalKind.OUTCOME_TRACK_RECORD
    assert small.feature_signals[0].magnitude == 1.0
