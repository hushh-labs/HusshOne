from datetime import date

from app.valuation import (
    deduplicate_components,
    estimate_liability,
    estimate_public_equity,
    sample_net_worth,
    summarize_samples,
)


def test_deduplicates_same_holding_group() -> None:
    older = estimate_public_equity(
        component_id="old",
        subject_id="p1",
        shares=(90, 100, 110),
        price_usd=(9, 10, 11),
        evidence_ids=("e-old",),
        quality_score=0.8,
        as_of_date=date(2026, 1, 1),
        double_count_group="issuer-common",
    )
    newer = estimate_public_equity(
        component_id="new",
        subject_id="p1",
        shares=(90, 100, 110),
        price_usd=(10, 11, 12),
        evidence_ids=("e-new",),
        quality_score=0.9,
        as_of_date=date(2026, 2, 1),
        double_count_group="issuer-common",
    )
    selected = deduplicate_components([older, newer])
    assert [component.component_id for component in selected] == ["new"]


def test_samples_and_summarizes_net_worth() -> None:
    stock = estimate_public_equity(
        component_id="stock",
        subject_id="p1",
        shares=(900, 1000, 1100),
        price_usd=(90, 100, 110),
        evidence_ids=("sec", "price"),
        quality_score=0.95,
        as_of_date=date(2026, 8, 1),
    )
    debt = estimate_liability(
        component_id="debt",
        subject_id="p1",
        amount=(1_000, 5_000, 10_000),
        evidence_ids=("debt-evidence",),
        quality_score=0.8,
        as_of_date=date(2026, 8, 1),
    )
    subject_id, samples = sample_net_worth([stock, debt], simulation_count=2_000, seed=1)
    summary = summarize_samples(subject_id, samples)
    assert summary.p05_usd < summary.median_usd < summary.p95_usd
    assert summary.probability_negative == 0
