from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime

import pytest

from app.net_worth import (
    BalanceSheetCoverage,
    ComponentKind,
    CoverageState,
    CoverageSupport,
    DeclaredNetWorthRange,
    DoubleCountRiskError,
    EstimateBasis,
    EstimateStatus,
    EvidenceKind,
    EvidencePurpose,
    EvidenceRecord,
    FinancialComponent,
    FractionRange,
    MonetaryRange,
    NetWorthEngine,
    NetWorthSubject,
    ProfileBasis,
    net_worth_to_nws,
)

AS_OF = date(2026, 8, 14)
RETRIEVED = datetime(2026, 8, 14, 12, tzinfo=UTC)


def evidence(
    evidence_id: str,
    kind: EvidenceKind,
    purpose: EvidencePurpose,
    *,
    source_date: date = date(2026, 8, 1),
    quality: float = 0.9,
) -> EvidenceRecord:
    return EvidenceRecord(
        evidence_id=evidence_id,
        kind=kind,
        purpose=purpose,
        source_authority="Official source",
        source_uri=f"https://example.gov/evidence/{evidence_id}",
        source_date=source_date,
        retrieved_at=RETRIEVED,
        quality=quality,
    )


def subject(
    profile_basis: ProfileBasis = ProfileBasis.VERIFIED_PUBLIC_FINANCIAL_PROFILE,
) -> NetWorthSubject:
    return NetWorthSubject(subject_id="person-1", profile_basis=profile_basis)


def public_stock(
    *,
    component_id: str = "stock",
    economic_interest_id: str = "issuer:ABC:common",
    amount: MonetaryRange = MonetaryRange(90_000_000, 100_000_000, 110_000_000),
    confidence: float = 0.9,
    source_date: date = date(2026, 8, 1),
    basis: EstimateBasis = EstimateBasis.DERIVED_FROM_VERIFIED_INPUTS,
) -> FinancialComponent:
    return FinancialComponent(
        component_id=component_id,
        subject_id="person-1",
        kind=ComponentKind.PUBLIC_SECURITIES,
        economic_interest_id=economic_interest_id,
        amount=amount,
        basis=basis,
        confidence=confidence,
        evidence=(
            evidence(
                f"{component_id}-ownership",
                EvidenceKind.SEC_FORM_3_4_5,
                EvidencePurpose.PERSONAL_OWNERSHIP,
                source_date=source_date,
                quality=confidence,
            ),
            evidence(
                f"{component_id}-price",
                EvidenceKind.MARKET_PRICE,
                EvidencePurpose.MARKET_VALUE,
                source_date=source_date,
                quality=confidence,
            ),
        ),
        liquid_fraction=FractionRange(0.55, 0.7, 0.85),
    )


def liability(
    *,
    component_id: str = "liability",
    economic_interest_id: str = "liability:disclosed-total",
    amount: MonetaryRange = MonetaryRange(5_000_000, 7_000_000, 10_000_000),
    confidence: float = 0.8,
) -> FinancialComponent:
    return FinancialComponent(
        component_id=component_id,
        subject_id="person-1",
        kind=ComponentKind.LIABILITY,
        economic_interest_id=economic_interest_id,
        amount=amount,
        basis=EstimateBasis.DIRECT_DISCLOSURE,
        confidence=confidence,
        evidence=(
            evidence(
                f"{component_id}-amount",
                EvidenceKind.OGE_PUBLIC_FINANCIAL_DISCLOSURE,
                EvidencePurpose.LIABILITY_AMOUNT,
                quality=confidence,
            ),
        ),
    )


def complete_coverage() -> BalanceSheetCoverage:
    not_applicable = tuple(
        CoverageSupport(
            kind=kind,
            evidence=evidence(
                f"coverage-{kind.value.lower()}",
                EvidenceKind.OGE_PUBLIC_FINANCIAL_DISCLOSURE,
                EvidencePurpose.COVERAGE_DECLARATION,
            ),
        )
        for kind in (
            ComponentKind.CASH_AND_NEAR_CASH,
            ComponentKind.PRIVATE_BUSINESS_EQUITY,
            ComponentKind.REAL_ESTATE_EQUITY,
            ComponentKind.OTHER_SUPPORTED_ASSETS,
        )
    )
    return BalanceSheetCoverage(
        cash_and_near_cash=CoverageState.NOT_APPLICABLE,
        public_securities=CoverageState.VERIFIED,
        private_business_equity=CoverageState.NOT_APPLICABLE,
        real_estate_equity=CoverageState.NOT_APPLICABLE,
        other_supported_assets=CoverageState.NOT_APPLICABLE,
        liabilities=CoverageState.VERIFIED,
        not_applicable_support=not_applicable,
    )


def declared_evidence(
    *,
    amount_quality: float = 0.95,
    source_date: date = date(2026, 7, 1),
) -> EvidenceRecord:
    return evidence(
        "fl-form-6-total",
        EvidenceKind.STATE_WHOLE_NET_WORTH_DISCLOSURE,
        EvidencePurpose.DECLARED_NET_WORTH_TOTAL,
        source_date=source_date,
        quality=amount_quality,
    )


@pytest.mark.parametrize(
    ("net_worth", "expected"),
    [
        (-1_000_000, 0),
        (0, 0),
        (10_000, 0),
        (100_000, 17),
        (1_000_000, 33),
        (10_000_000, 50),
        (100_000_000, 67),
        (1_000_000_000, 83),
        (10_000_000_000, 100),
        (100_000_000_000, 100),
    ],
)
def test_fixed_national_log_scale_anchors(net_worth: float, expected: int) -> None:
    assert net_worth_to_nws(net_worth) == expected


def test_fixed_scale_rejects_non_finite_input() -> None:
    with pytest.raises(ValueError, match="finite"):
        net_worth_to_nws(float("nan"))


def test_component_engine_produces_probabilistic_net_worth_and_liquid_wealth() -> None:
    result = NetWorthEngine(simulation_count=2_000, seed=31).estimate(
        subject=subject(),
        components=[public_stock(), liability()],
        coverage=complete_coverage(),
        as_of_date=AS_OF,
    )

    assert result.status is EstimateStatus.AVAILABLE
    assert result.net_worth is not None
    assert result.net_worth.p10_usd < result.net_worth.median_usd < result.net_worth.p90_usd
    assert 82_000_000 < result.net_worth.median_usd < 97_000_000
    assert result.liquid_wealth is not None
    assert result.liquid_wealth.median_usd < result.net_worth.median_usd
    assert result.nws is not None
    assert result.nws.score == net_worth_to_nws(result.net_worth.median_usd)
    assert result.confidence is not None
    assert result.confidence.score != result.nws.score / 100
    assert result.last_financial_update == date(2026, 8, 1)
    assert result.model_version == "net-worth-v1.0.0"


def test_simulation_is_seeded_reproducible_and_input_order_independent() -> None:
    engine = NetWorthEngine(simulation_count=2_000, seed=44)
    first = engine.estimate(
        subject=subject(),
        components=[public_stock(), liability()],
        coverage=complete_coverage(),
        as_of_date=AS_OF,
    )
    second = engine.estimate(
        subject=subject(),
        components=[liability(), public_stock()],
        coverage=complete_coverage(),
        as_of_date=AS_OF,
    )

    assert first.net_worth == second.net_worth
    assert first.liquid_wealth == second.liquid_wealth
    assert first.nws == second.nws


def test_confidence_changes_do_not_change_nws() -> None:
    high = NetWorthEngine(simulation_count=2_000, seed=5).estimate(
        subject=subject(),
        components=[public_stock(confidence=0.98), liability(confidence=0.98)],
        coverage=complete_coverage(),
        as_of_date=AS_OF,
    )
    low = NetWorthEngine(simulation_count=2_000, seed=5).estimate(
        subject=subject(),
        components=[public_stock(confidence=0.45), liability(confidence=0.45)],
        coverage=complete_coverage(),
        as_of_date=AS_OF,
    )

    assert high.net_worth == low.net_worth
    assert high.nws == low.nws
    assert high.confidence is not None
    assert low.confidence is not None
    assert high.confidence.score > low.confidence.score


def test_no_asset_evidence_is_insufficient_not_zero() -> None:
    result = NetWorthEngine(simulation_count=1_000).estimate(
        subject=subject(),
        components=[liability()],
        coverage=complete_coverage(),
        as_of_date=AS_OF,
    )

    assert result.status is EstimateStatus.INSUFFICIENT_EVIDENCE
    assert result.nws is None
    assert result.net_worth is None
    assert "prevents NWS calculation" in (result.reason or "")


def test_liability_coverage_and_supported_range_are_mandatory() -> None:
    unknown_coverage = BalanceSheetCoverage(
        public_securities=CoverageState.VERIFIED,
        liabilities=CoverageState.UNKNOWN,
    )
    engine = NetWorthEngine(simulation_count=1_000)
    unknown = engine.estimate(
        subject=subject(),
        components=[public_stock()],
        coverage=unknown_coverage,
        as_of_date=AS_OF,
    )
    declared_but_missing = engine.estimate(
        subject=subject(),
        components=[public_stock()],
        coverage=complete_coverage(),
        as_of_date=AS_OF,
    )

    assert unknown.status is EstimateStatus.INSUFFICIENT_EVIDENCE
    assert unknown.nws is None
    assert "Liability coverage" in (unknown.reason or "")
    assert declared_but_missing.status is EstimateStatus.INSUFFICIENT_EVIDENCE
    assert declared_but_missing.nws is None
    assert "liability range" in (declared_but_missing.reason or "")


def test_unknown_asset_category_is_not_implicitly_treated_as_zero() -> None:
    bounded = complete_coverage()
    coverage = replace(
        bounded,
        cash_and_near_cash=CoverageState.UNKNOWN,
        not_applicable_support=tuple(
            support
            for support in bounded.not_applicable_support
            if support.kind is not ComponentKind.CASH_AND_NEAR_CASH
        ),
    )
    result = NetWorthEngine(simulation_count=1_000).estimate(
        subject=subject(),
        components=[public_stock(), liability()],
        coverage=coverage,
        as_of_date=AS_OF,
    )

    assert result.status is EstimateStatus.INSUFFICIENT_EVIDENCE
    assert result.net_worth is None
    assert result.nws is None
    assert "CASH_AND_NEAR_CASH" in (result.reason or "")


def test_not_applicable_asset_category_needs_person_specific_coverage_support() -> None:
    unsupported = BalanceSheetCoverage(
        cash_and_near_cash=CoverageState.NOT_APPLICABLE,
        public_securities=CoverageState.VERIFIED,
        private_business_equity=CoverageState.NOT_APPLICABLE,
        real_estate_equity=CoverageState.NOT_APPLICABLE,
        other_supported_assets=CoverageState.NOT_APPLICABLE,
        liabilities=CoverageState.VERIFIED,
    )
    result = NetWorthEngine(simulation_count=1_000).estimate(
        subject=subject(),
        components=[public_stock(), liability()],
        coverage=unsupported,
        as_of_date=AS_OF,
    )

    assert result.status is EstimateStatus.INSUFFICIENT_EVIDENCE
    assert result.nws is None
    assert "CASH_AND_NEAR_CASH" in (result.reason or "")
    assert "OTHER_SUPPORTED_ASSETS" in (result.reason or "")


def test_private_person_never_gets_named_nws_from_supplied_components() -> None:
    result = NetWorthEngine(simulation_count=1_000).estimate(
        subject=subject(ProfileBasis.PRIVATE_PERSON),
        components=[public_stock(), liability()],
        coverage=complete_coverage(),
        as_of_date=AS_OF,
    )

    assert result.status is EstimateStatus.INSUFFICIENT_EVIDENCE
    assert result.nws is None
    assert result.components == ()
    assert set(result.excluded_component_ids) == {"stock", "liability"}


@pytest.mark.parametrize(
    "kind",
    [
        EvidenceKind.SEC_FORM_D,
        EvidenceKind.COMPANY_FUNDING,
        EvidenceKind.COMPANY_REVENUE,
        EvidenceKind.FUND_AUM,
        EvidenceKind.IRS_FORM_990_OR_NONPROFIT_ASSETS,
        EvidenceKind.SALARY_OR_COMPENSATION,
        EvidenceKind.LIFESTYLE_OR_SOCIAL,
    ],
)
def test_context_only_sources_cannot_be_labelled_personal_financial_evidence(
    kind: EvidenceKind,
) -> None:
    with pytest.raises(ValueError, match="cannot be used"):
        evidence("unsafe", kind, EvidencePurpose.PERSONAL_AMOUNT)


def test_context_only_component_is_excluded_and_does_not_create_nws() -> None:
    funding = FinancialComponent(
        component_id="funding",
        subject_id="person-1",
        kind=ComponentKind.CASH_AND_NEAR_CASH,
        economic_interest_id="company:funding-round",
        amount=MonetaryRange(100_000_000, 100_000_000, 100_000_000),
        basis=EstimateBasis.DIRECT_DISCLOSURE,
        confidence=1,
        evidence=(
            evidence(
                "form-d",
                EvidenceKind.SEC_FORM_D,
                EvidencePurpose.DISCOVERY_OR_CONTEXT,
            ),
        ),
        liquid_fraction=FractionRange(1, 1, 1),
    )
    result = NetWorthEngine(simulation_count=1_000).estimate(
        subject=subject(),
        components=[funding, liability()],
        coverage=BalanceSheetCoverage(
            cash_and_near_cash=CoverageState.VERIFIED,
            liabilities=CoverageState.VERIFIED,
        ),
        as_of_date=AS_OF,
    )

    assert result.status is EstimateStatus.INSUFFICIENT_EVIDENCE
    assert result.nws is None
    assert result.excluded_component_ids == ("funding",)


def test_same_economic_interest_is_counted_once_using_newest_supported_estimate() -> None:
    old_private = public_stock(
        component_id="pre-ipo",
        economic_interest_id="issuer:ABC:founder-position",
        amount=MonetaryRange(40_000_000, 50_000_000, 60_000_000),
        source_date=date(2025, 1, 1),
        basis=EstimateBasis.DIRECT_DISCLOSURE,
    )
    current_public = public_stock(
        component_id="post-ipo",
        economic_interest_id="issuer:ABC:founder-position",
        amount=MonetaryRange(90_000_000, 100_000_000, 110_000_000),
        source_date=date(2026, 8, 1),
    )
    result = NetWorthEngine(simulation_count=1_000).estimate(
        subject=subject(),
        components=[old_private, current_public, liability()],
        coverage=complete_coverage(),
        as_of_date=AS_OF,
    )

    assert [component.component_id for component in result.components] == [
        "liability",
        "post-ipo",
    ]
    assert result.excluded_component_ids == ("pre-ipo",)


def test_same_fact_cannot_support_different_economic_interests() -> None:
    reused_ownership = evidence(
        "same-fact",
        EvidenceKind.SEC_FORM_3_4_5,
        EvidencePurpose.PERSONAL_OWNERSHIP,
    )

    def component(component_id: str, interest: str) -> FinancialComponent:
        return FinancialComponent(
            component_id=component_id,
            subject_id="person-1",
            kind=ComponentKind.PUBLIC_SECURITIES,
            economic_interest_id=interest,
            amount=MonetaryRange(1, 1, 1),
            basis=EstimateBasis.DERIVED_FROM_VERIFIED_INPUTS,
            confidence=0.9,
            evidence=(
                reused_ownership,
                evidence(
                    f"{component_id}-price",
                    EvidenceKind.MARKET_PRICE,
                    EvidencePurpose.MARKET_VALUE,
                ),
            ),
            liquid_fraction=FractionRange(1, 1, 1),
        )

    with pytest.raises(DoubleCountRiskError, match="reused"):
        NetWorthEngine(simulation_count=1_000).estimate(
            subject=subject(),
            components=[component("one", "interest-one"), component("two", "interest-two")],
            coverage=complete_coverage(),
            as_of_date=AS_OF,
        )


def test_liability_already_netted_into_property_cannot_be_subtracted_again() -> None:
    property_equity = FinancialComponent(
        component_id="home-equity",
        subject_id="person-1",
        kind=ComponentKind.REAL_ESTATE_EQUITY,
        economic_interest_id="property:parcel-1:equity",
        amount=MonetaryRange(1_000_000, 1_500_000, 2_000_000),
        basis=EstimateBasis.DERIVED_FROM_VERIFIED_INPUTS,
        confidence=0.7,
        evidence=(
            evidence(
                "parcel-owner",
                EvidenceKind.PROPERTY_RECORDER,
                EvidencePurpose.PERSONAL_OWNERSHIP,
            ),
            evidence(
                "parcel-value",
                EvidenceKind.PROPERTY_ASSESSMENT,
                EvidencePurpose.MARKET_VALUE,
            ),
            evidence(
                "mortgage-evidence",
                EvidenceKind.PROPERTY_RECORDER,
                EvidencePurpose.LIABILITY_AMOUNT,
            ),
        ),
        liquid_fraction=FractionRange(0, 0.05, 0.1),
        netted_liability_interest_ids=("mortgage:parcel-1",),
    )
    mortgage = liability(economic_interest_id="mortgage:parcel-1")
    coverage = BalanceSheetCoverage(
        real_estate_equity=CoverageState.VERIFIED,
        liabilities=CoverageState.VERIFIED,
    )

    with pytest.raises(DoubleCountRiskError, match="already netted"):
        NetWorthEngine(simulation_count=1_000).estimate(
            subject=subject(),
            components=[property_equity, mortgage],
            coverage=coverage,
            as_of_date=AS_OF,
        )


def test_modeled_component_is_partial_and_reduces_confidence_not_nws() -> None:
    modeled_liability = FinancialComponent(
        component_id="modeled-liability",
        subject_id="person-1",
        kind=ComponentKind.LIABILITY,
        economic_interest_id="liability:modeled-total",
        amount=MonetaryRange(0, 3_000_000, 12_000_000),
        basis=EstimateBasis.EXPLICIT_MODEL_ASSUMPTION,
        confidence=0.4,
        evidence=(
            evidence(
                "disclosed-liability-band",
                EvidenceKind.OGE_PUBLIC_FINANCIAL_DISCLOSURE,
                EvidencePurpose.LIABILITY_AMOUNT,
                quality=0.7,
            ),
            evidence(
                "liability-policy-v1",
                EvidenceKind.MODEL_ASSUMPTION_POLICY,
                EvidencePurpose.MODEL_ASSUMPTION,
                quality=0.5,
            ),
        ),
    )
    result = NetWorthEngine(simulation_count=1_000).estimate(
        subject=subject(ProfileBasis.PARTIALLY_OBSERVABLE),
        components=[public_stock(), modeled_liability],
        coverage=replace(complete_coverage(), liabilities=CoverageState.MODELED),
        as_of_date=AS_OF,
    )

    assert result.status is EstimateStatus.PARTIAL_ESTIMATE
    assert result.nws is not None
    assert result.confidence is not None
    assert result.confidence.assumption_share > 0
    assert any("modelled" in warning for warning in result.warnings)


def test_all_modeled_balance_sheet_cannot_create_named_nws() -> None:
    modeled_asset = FinancialComponent(
        component_id="modeled-asset",
        subject_id="person-1",
        kind=ComponentKind.CASH_AND_NEAR_CASH,
        economic_interest_id="modeled:cash",
        amount=MonetaryRange(1_000_000, 2_000_000, 3_000_000),
        basis=EstimateBasis.EXPLICIT_MODEL_ASSUMPTION,
        confidence=0.3,
        evidence=(
            evidence(
                "asset-policy-v1",
                EvidenceKind.MODEL_ASSUMPTION_POLICY,
                EvidencePurpose.MODEL_ASSUMPTION,
                quality=0.4,
            ),
        ),
        liquid_fraction=FractionRange(1, 1, 1),
    )
    modeled_liability = FinancialComponent(
        component_id="modeled-liability-only",
        subject_id="person-1",
        kind=ComponentKind.LIABILITY,
        economic_interest_id="modeled:liability",
        amount=MonetaryRange(0, 100_000, 500_000),
        basis=EstimateBasis.EXPLICIT_MODEL_ASSUMPTION,
        confidence=0.3,
        evidence=(
            evidence(
                "liability-policy-only-v1",
                EvidenceKind.MODEL_ASSUMPTION_POLICY,
                EvidencePurpose.MODEL_ASSUMPTION,
                quality=0.4,
            ),
        ),
    )
    coverage = BalanceSheetCoverage(
        cash_and_near_cash=CoverageState.MODELED,
        public_securities=CoverageState.NOT_APPLICABLE,
        private_business_equity=CoverageState.NOT_APPLICABLE,
        real_estate_equity=CoverageState.NOT_APPLICABLE,
        other_supported_assets=CoverageState.NOT_APPLICABLE,
        liabilities=CoverageState.MODELED,
        not_applicable_support=tuple(
            CoverageSupport(
                kind=kind,
                evidence=evidence(
                    f"official-coverage-{kind.value.lower()}",
                    EvidenceKind.OGE_PUBLIC_FINANCIAL_DISCLOSURE,
                    EvidencePurpose.COVERAGE_DECLARATION,
                ),
            )
            for kind in (
                ComponentKind.PUBLIC_SECURITIES,
                ComponentKind.PRIVATE_BUSINESS_EQUITY,
                ComponentKind.REAL_ESTATE_EQUITY,
                ComponentKind.OTHER_SUPPORTED_ASSETS,
            )
        ),
    )

    result = NetWorthEngine(simulation_count=1_000).estimate(
        subject=subject(ProfileBasis.PARTIALLY_OBSERVABLE),
        components=[modeled_asset, modeled_liability],
        coverage=coverage,
        as_of_date=AS_OF,
    )

    assert result.status is EstimateStatus.INSUFFICIENT_EVIDENCE
    assert result.net_worth is None
    assert result.nws is None
    assert set(result.excluded_component_ids) == {
        "modeled-asset",
        "modeled-liability-only",
    }


def test_generic_model_policy_cannot_mark_personal_asset_not_applicable() -> None:
    with pytest.raises(ValueError, match="person-specific coverage declaration"):
        CoverageSupport(
            kind=ComponentKind.REAL_ESTATE_EQUITY,
            evidence=evidence(
                "generic-no-real-estate-policy",
                EvidenceKind.MODEL_ASSUMPTION_POLICY,
                EvidencePurpose.MODEL_ASSUMPTION,
            ),
        )


def test_future_evidence_is_rejected() -> None:
    future_stock = public_stock(source_date=date(2026, 8, 15))
    with pytest.raises(ValueError, match="future source_date"):
        NetWorthEngine(simulation_count=1_000).estimate(
            subject=subject(),
            components=[future_stock, liability()],
            coverage=complete_coverage(),
            as_of_date=AS_OF,
        )


def test_declared_total_exact_value_is_available_without_component_breakdown() -> None:
    result = NetWorthEngine(simulation_count=1_000).estimate_declared_total(
        subject=subject(),
        declared_total=DeclaredNetWorthRange(22_000_000, 22_000_000, 22_000_000),
        evidence=declared_evidence(),
        as_of_date=AS_OF,
    )

    assert result.status is EstimateStatus.AVAILABLE
    assert result.valuation_basis is EstimateBasis.DECLARED_TOTAL
    assert result.net_worth is not None
    assert result.net_worth.p10_usd == 22_000_000
    assert result.net_worth.median_usd == 22_000_000
    assert result.net_worth.p90_usd == 22_000_000
    assert result.nws is not None
    assert result.nws.score == net_worth_to_nws(22_000_000)
    assert result.components == ()
    assert result.declared_total is not None
    assert result.declared_total.amount.most_likely_usd == 22_000_000
    assert result.declared_total.evidence.evidence_id == "fl-form-6-total"
    assert result.liquid_wealth is None
    assert set(result.component_coverage.asset_states()) == {CoverageState.NOT_PROVIDED}
    assert result.component_coverage.liabilities is CoverageState.NOT_PROVIDED


@pytest.mark.parametrize(("total", "expected_probability_negative"), [(-500_000, 1.0), (0, 0.0)])
def test_declared_negative_and_zero_are_real_available_scores(
    total: float,
    expected_probability_negative: float,
) -> None:
    result = NetWorthEngine(simulation_count=1_000).estimate_declared_total(
        subject=subject(),
        declared_total=DeclaredNetWorthRange(total, total, total),
        evidence=declared_evidence(),
        as_of_date=AS_OF,
    )

    assert result.status is EstimateStatus.AVAILABLE
    assert result.net_worth is not None
    assert result.net_worth.median_usd == total
    assert result.net_worth.probability_negative == expected_probability_negative
    assert result.nws is not None
    assert result.nws.score == 0


def test_zero_declared_score_is_distinct_from_unavailable_profile() -> None:
    zero = NetWorthEngine(simulation_count=1_000).estimate_declared_total(
        subject=subject(),
        declared_total=DeclaredNetWorthRange(0, 0, 0),
        evidence=declared_evidence(),
        as_of_date=AS_OF,
    )
    unavailable = NetWorthEngine(simulation_count=1_000).estimate(
        subject=subject(),
        components=[],
        coverage=BalanceSheetCoverage(),
        as_of_date=AS_OF,
    )

    assert zero.status is EstimateStatus.AVAILABLE
    assert zero.nws is not None and zero.nws.score == 0
    assert zero.net_worth is not None and zero.net_worth.median_usd == 0
    assert unavailable.status is EstimateStatus.INSUFFICIENT_EVIDENCE
    assert unavailable.nws is None
    assert unavailable.net_worth is None


def test_declared_total_cannot_be_double_counted_with_components() -> None:
    with pytest.raises(DoubleCountRiskError, match="cannot be combined"):
        NetWorthEngine(simulation_count=1_000).estimate_declared_total(
            subject=subject(),
            declared_total=DeclaredNetWorthRange(22_000_000, 22_000_000, 22_000_000),
            evidence=declared_evidence(),
            as_of_date=AS_OF,
            additional_components=[public_stock()],
        )


def test_declared_total_requires_specific_legal_total_evidence() -> None:
    wrong = evidence(
        "oge-asset",
        EvidenceKind.OGE_PUBLIC_FINANCIAL_DISCLOSURE,
        EvidencePurpose.PERSONAL_AMOUNT,
    )
    with pytest.raises(ValueError, match="DECLARED_NET_WORTH_TOTAL"):
        NetWorthEngine(simulation_count=1_000).estimate_declared_total(
            subject=subject(),
            declared_total=DeclaredNetWorthRange(1, 1, 1),
            evidence=wrong,
            as_of_date=AS_OF,
        )


def test_declared_total_basis_cannot_enter_component_ledger() -> None:
    with pytest.raises(ValueError, match="whole-net-worth disclosure"):
        FinancialComponent(
            component_id="invalid",
            subject_id="person-1",
            kind=ComponentKind.OTHER_SUPPORTED_ASSETS,
            economic_interest_id="declared-total",
            amount=MonetaryRange(1, 1, 1),
            basis=EstimateBasis.DECLARED_TOTAL,
            confidence=1,
            evidence=(declared_evidence(),),
            liquid_fraction=FractionRange(0, 0, 0),
        )
