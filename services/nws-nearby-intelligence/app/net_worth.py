"""Versioned Net Worth Score domain engine.

This module deliberately has no dependency on the service's professional-network
scorer.  It converts supported, attributable financial ranges into a probabilistic
net-worth estimate and then maps the median estimate to a fixed national 0-100
scale.  Evidence confidence is reported separately and never changes NWS.

The engine is fail-closed:

* no attributable asset evidence means no estimate;
* liabilities require a supported disclosed or explicitly modelled range;
* organizational values (funding, revenue, AUM, nonprofit assets), Form D,
  compensation, and lifestyle/social observations cannot support personal wealth;
* duplicate representations of the same economic interest are counted once.
"""

from __future__ import annotations

import hashlib
import math
import random
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import StrEnum

NET_WORTH_MODEL_VERSION = "net-worth-v1.0.0"
NWS_SCALE_VERSION = "nws-fixed-us-log-v1.0.0"


class EstimateStatus(StrEnum):
    AVAILABLE = "AVAILABLE"
    PARTIAL_ESTIMATE = "PARTIAL_ESTIMATE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class ProfileBasis(StrEnum):
    VERIFIED_PUBLIC_FINANCIAL_PROFILE = "VERIFIED_PUBLIC_FINANCIAL_PROFILE"
    PARTIALLY_OBSERVABLE = "PARTIALLY_OBSERVABLE"
    OPTED_IN_VERIFIED = "OPTED_IN_VERIFIED"
    PRIVATE_PERSON = "PRIVATE_PERSON"


class ComponentKind(StrEnum):
    CASH_AND_NEAR_CASH = "CASH_AND_NEAR_CASH"
    PUBLIC_SECURITIES = "PUBLIC_SECURITIES"
    PRIVATE_BUSINESS_EQUITY = "PRIVATE_BUSINESS_EQUITY"
    REAL_ESTATE_EQUITY = "REAL_ESTATE_EQUITY"
    OTHER_SUPPORTED_ASSETS = "OTHER_SUPPORTED_ASSETS"
    LIABILITY = "LIABILITY"


_ASSET_KINDS = (
    ComponentKind.CASH_AND_NEAR_CASH,
    ComponentKind.PUBLIC_SECURITIES,
    ComponentKind.PRIVATE_BUSINESS_EQUITY,
    ComponentKind.REAL_ESTATE_EQUITY,
    ComponentKind.OTHER_SUPPORTED_ASSETS,
)


class EstimateBasis(StrEnum):
    DIRECT_DISCLOSURE = "DIRECT_DISCLOSURE"
    DERIVED_FROM_VERIFIED_INPUTS = "DERIVED_FROM_VERIFIED_INPUTS"
    EXPLICIT_MODEL_ASSUMPTION = "EXPLICIT_MODEL_ASSUMPTION"
    DECLARED_TOTAL = "DECLARED_TOTAL"


class CoverageState(StrEnum):
    VERIFIED = "VERIFIED"
    PARTIAL = "PARTIAL"
    MODELED = "MODELED"
    UNKNOWN = "UNKNOWN"
    NOT_PROVIDED = "NOT_PROVIDED"
    NOT_APPLICABLE = "NOT_APPLICABLE"


class EvidencePurpose(StrEnum):
    PERSONAL_AMOUNT = "PERSONAL_AMOUNT"
    PERSONAL_OWNERSHIP = "PERSONAL_OWNERSHIP"
    MARKET_VALUE = "MARKET_VALUE"
    LIABILITY_AMOUNT = "LIABILITY_AMOUNT"
    MODEL_ASSUMPTION = "MODEL_ASSUMPTION"
    DECLARED_NET_WORTH_TOTAL = "DECLARED_NET_WORTH_TOTAL"
    COVERAGE_DECLARATION = "COVERAGE_DECLARATION"
    DISCOVERY_OR_CONTEXT = "DISCOVERY_OR_CONTEXT"


class EvidenceDatePrecision(StrEnum):
    DAY = "DAY"
    YEAR = "YEAR"


class EvidenceKind(StrEnum):
    OGE_PUBLIC_FINANCIAL_DISCLOSURE = "OGE_PUBLIC_FINANCIAL_DISCLOSURE"
    SEC_FORM_3_4_5 = "SEC_FORM_3_4_5"
    SEC_SCHEDULE_13D_13G = "SEC_SCHEDULE_13D_13G"
    SEC_PROXY = "SEC_PROXY"
    SEC_S1_OWNERSHIP = "SEC_S1_OWNERSHIP"
    SEC_ANNUAL_REPORT = "SEC_ANNUAL_REPORT"
    MARKET_PRICE = "MARKET_PRICE"
    OFFICIAL_PRIVATE_OWNERSHIP = "OFFICIAL_PRIVATE_OWNERSHIP"
    PRIVATE_COMPANY_VALUATION = "PRIVATE_COMPANY_VALUATION"
    PROPERTY_ASSESSMENT = "PROPERTY_ASSESSMENT"
    PROPERTY_RECORDER = "PROPERTY_RECORDER"
    ARM_LENGTH_PROPERTY_SALE = "ARM_LENGTH_PROPERTY_SALE"
    FHFA_HOUSE_PRICE_INDEX = "FHFA_HOUSE_PRICE_INDEX"
    OPT_IN_VERIFIED_FINANCIAL = "OPT_IN_VERIFIED_FINANCIAL"
    OTHER_OFFICIAL_FINANCIAL_DISCLOSURE = "OTHER_OFFICIAL_FINANCIAL_DISCLOSURE"
    MODEL_ASSUMPTION_POLICY = "MODEL_ASSUMPTION_POLICY"
    STATE_WHOLE_NET_WORTH_DISCLOSURE = "STATE_WHOLE_NET_WORTH_DISCLOSURE"

    # These sources may help discovery or context, but never support a person's amount.
    SEC_FORM_D = "SEC_FORM_D"
    COMPANY_FUNDING = "COMPANY_FUNDING"
    COMPANY_REVENUE = "COMPANY_REVENUE"
    FUND_AUM = "FUND_AUM"
    IRS_FORM_990_OR_NONPROFIT_ASSETS = "IRS_FORM_990_OR_NONPROFIT_ASSETS"
    SALARY_OR_COMPENSATION = "SALARY_OR_COMPENSATION"
    LIFESTYLE_OR_SOCIAL = "LIFESTYLE_OR_SOCIAL"


_CONTEXT_ONLY_EVIDENCE = frozenset(
    {
        EvidenceKind.SEC_FORM_D,
        EvidenceKind.COMPANY_FUNDING,
        EvidenceKind.COMPANY_REVENUE,
        EvidenceKind.FUND_AUM,
        EvidenceKind.IRS_FORM_990_OR_NONPROFIT_ASSETS,
        EvidenceKind.SALARY_OR_COMPENSATION,
        EvidenceKind.LIFESTYLE_OR_SOCIAL,
    }
)

_ALLOWED_PURPOSES: Mapping[EvidenceKind, frozenset[EvidencePurpose]] = {
    EvidenceKind.OGE_PUBLIC_FINANCIAL_DISCLOSURE: frozenset(
        {
            EvidencePurpose.PERSONAL_AMOUNT,
            EvidencePurpose.PERSONAL_OWNERSHIP,
            EvidencePurpose.LIABILITY_AMOUNT,
            EvidencePurpose.COVERAGE_DECLARATION,
        }
    ),
    EvidenceKind.SEC_FORM_3_4_5: frozenset({EvidencePurpose.PERSONAL_OWNERSHIP}),
    EvidenceKind.SEC_SCHEDULE_13D_13G: frozenset({EvidencePurpose.PERSONAL_OWNERSHIP}),
    EvidenceKind.SEC_PROXY: frozenset({EvidencePurpose.PERSONAL_OWNERSHIP}),
    EvidenceKind.SEC_S1_OWNERSHIP: frozenset({EvidencePurpose.PERSONAL_OWNERSHIP}),
    EvidenceKind.SEC_ANNUAL_REPORT: frozenset({EvidencePurpose.PERSONAL_OWNERSHIP}),
    EvidenceKind.MARKET_PRICE: frozenset({EvidencePurpose.MARKET_VALUE}),
    EvidenceKind.OFFICIAL_PRIVATE_OWNERSHIP: frozenset(
        {EvidencePurpose.PERSONAL_OWNERSHIP}
    ),
    EvidenceKind.PRIVATE_COMPANY_VALUATION: frozenset({EvidencePurpose.MARKET_VALUE}),
    EvidenceKind.PROPERTY_ASSESSMENT: frozenset({EvidencePurpose.MARKET_VALUE}),
    EvidenceKind.PROPERTY_RECORDER: frozenset(
        {
            EvidencePurpose.PERSONAL_OWNERSHIP,
            EvidencePurpose.LIABILITY_AMOUNT,
        }
    ),
    EvidenceKind.ARM_LENGTH_PROPERTY_SALE: frozenset({EvidencePurpose.MARKET_VALUE}),
    EvidenceKind.FHFA_HOUSE_PRICE_INDEX: frozenset({EvidencePurpose.MARKET_VALUE}),
    EvidenceKind.OPT_IN_VERIFIED_FINANCIAL: frozenset(
        {
            EvidencePurpose.PERSONAL_AMOUNT,
            EvidencePurpose.PERSONAL_OWNERSHIP,
            EvidencePurpose.MARKET_VALUE,
            EvidencePurpose.LIABILITY_AMOUNT,
            EvidencePurpose.COVERAGE_DECLARATION,
        }
    ),
    EvidenceKind.OTHER_OFFICIAL_FINANCIAL_DISCLOSURE: frozenset(
        {
            EvidencePurpose.PERSONAL_AMOUNT,
            EvidencePurpose.PERSONAL_OWNERSHIP,
            EvidencePurpose.MARKET_VALUE,
            EvidencePurpose.LIABILITY_AMOUNT,
            EvidencePurpose.COVERAGE_DECLARATION,
        }
    ),
    EvidenceKind.MODEL_ASSUMPTION_POLICY: frozenset({EvidencePurpose.MODEL_ASSUMPTION}),
    EvidenceKind.STATE_WHOLE_NET_WORTH_DISCLOSURE: frozenset(
        {EvidencePurpose.DECLARED_NET_WORTH_TOTAL}
    ),
    **{
        kind: frozenset({EvidencePurpose.DISCOVERY_OR_CONTEXT})
        for kind in _CONTEXT_ONLY_EVIDENCE
    },
}


@dataclass(frozen=True)
class MonetaryRange:
    """A bounded triangular input distribution in US dollars."""

    low_usd: float
    most_likely_usd: float
    high_usd: float

    def __post_init__(self) -> None:
        values = (self.low_usd, self.most_likely_usd, self.high_usd)
        if not all(math.isfinite(value) for value in values):
            raise ValueError("monetary values must be finite")
        if self.low_usd < 0 or not self.low_usd <= self.most_likely_usd <= self.high_usd:
            raise ValueError("expected 0 <= low_usd <= most_likely_usd <= high_usd")


@dataclass(frozen=True)
class DeclaredNetWorthRange:
    """A signed whole-net-worth range that is already net of liabilities."""

    low_usd: float
    most_likely_usd: float
    high_usd: float

    def __post_init__(self) -> None:
        values = (self.low_usd, self.most_likely_usd, self.high_usd)
        if not all(math.isfinite(value) for value in values):
            raise ValueError("declared net-worth values must be finite")
        if not self.low_usd <= self.most_likely_usd <= self.high_usd:
            raise ValueError("expected low_usd <= most_likely_usd <= high_usd")


@dataclass(frozen=True)
class FractionRange:
    """A bounded triangular fraction used only for liquid-capacity modelling."""

    low: float
    most_likely: float
    high: float

    def __post_init__(self) -> None:
        values = (self.low, self.most_likely, self.high)
        if not all(math.isfinite(value) for value in values):
            raise ValueError("fraction values must be finite")
        if self.low < 0 or not self.low <= self.most_likely <= self.high <= 1:
            raise ValueError("expected 0 <= low <= most_likely <= high <= 1")


@dataclass(frozen=True)
class EvidenceRecord:
    """Fact-level provenance for one financial input.

    ``evidence_id`` should identify an extracted fact, not merely a source document. This
    lets the engine detect accidental reuse of the same fact across different interests.
    """

    evidence_id: str
    kind: EvidenceKind
    purpose: EvidencePurpose
    source_authority: str
    source_uri: str
    source_date: date
    retrieved_at: datetime
    quality: float
    source_date_precision: EvidenceDatePrecision = EvidenceDatePrecision.DAY

    def __post_init__(self) -> None:
        if not self.evidence_id.strip():
            raise ValueError("evidence_id is required")
        if not self.source_authority.strip():
            raise ValueError("source_authority is required")
        if not self.source_uri.startswith("https://"):
            raise ValueError("source_uri must be an HTTPS URL")
        if self.retrieved_at.tzinfo is None:
            raise ValueError("retrieved_at must be timezone-aware")
        if not 0 <= self.quality <= 1:
            raise ValueError("quality must be in [0, 1]")
        if self.purpose not in _ALLOWED_PURPOSES[self.kind]:
            raise ValueError(f"{self.kind.value} cannot be used for {self.purpose.value}")

    @property
    def supports_personal_net_worth(self) -> bool:
        return self.kind not in _CONTEXT_ONLY_EVIDENCE


@dataclass(frozen=True)
class FinancialComponent:
    component_id: str
    subject_id: str
    kind: ComponentKind
    economic_interest_id: str
    amount: MonetaryRange
    basis: EstimateBasis
    confidence: float
    evidence: tuple[EvidenceRecord, ...]
    liquid_fraction: FractionRange | None = None
    netted_liability_interest_ids: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        for value, label in (
            (self.component_id, "component_id"),
            (self.subject_id, "subject_id"),
            (self.economic_interest_id, "economic_interest_id"),
        ):
            if not value.strip():
                raise ValueError(f"{label} is required")
        if not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be in [0, 1]")
        if not self.evidence:
            raise ValueError("every component requires provenance")
        if self.basis is EstimateBasis.DECLARED_TOTAL:
            raise ValueError("DECLARED_TOTAL is only valid for a whole-net-worth disclosure")
        if self.kind is ComponentKind.LIABILITY:
            if self.liquid_fraction is not None:
                raise ValueError("liabilities cannot have a liquid fraction")
            if self.netted_liability_interest_ids:
                raise ValueError("a liability cannot contain netted liability ids")
        elif self.liquid_fraction is None:
            raise ValueError("every asset requires an explicit liquid fraction")
        if len(set(self.netted_liability_interest_ids)) != len(
            self.netted_liability_interest_ids
        ):
            raise ValueError("netted liability ids must be unique")


@dataclass(frozen=True)
class CoverageSupport:
    kind: ComponentKind
    evidence: EvidenceRecord

    def __post_init__(self) -> None:
        if self.kind not in _ASSET_KINDS:
            raise ValueError("coverage support is only defined for asset categories")
        if self.evidence.purpose is not EvidencePurpose.COVERAGE_DECLARATION:
            raise ValueError(
                "not-applicable coverage requires a person-specific coverage declaration"
            )


@dataclass(frozen=True)
class BalanceSheetCoverage:
    cash_and_near_cash: CoverageState = CoverageState.UNKNOWN
    public_securities: CoverageState = CoverageState.UNKNOWN
    private_business_equity: CoverageState = CoverageState.UNKNOWN
    real_estate_equity: CoverageState = CoverageState.UNKNOWN
    other_supported_assets: CoverageState = CoverageState.UNKNOWN
    liabilities: CoverageState = CoverageState.UNKNOWN
    not_applicable_support: tuple[CoverageSupport, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        support_kinds = [support.kind for support in self.not_applicable_support]
        if len(support_kinds) != len(set(support_kinds)):
            raise ValueError("not-applicable coverage support must be unique by category")
        for support in self.not_applicable_support:
            if self.state_for(support.kind) is not CoverageState.NOT_APPLICABLE:
                raise ValueError(
                    f"{support.kind.value} has support but is not marked NOT_APPLICABLE"
                )

    def has_not_applicable_support(self, kind: ComponentKind) -> bool:
        return any(support.kind is kind for support in self.not_applicable_support)

    def state_for(self, kind: ComponentKind) -> CoverageState:
        return {
            ComponentKind.CASH_AND_NEAR_CASH: self.cash_and_near_cash,
            ComponentKind.PUBLIC_SECURITIES: self.public_securities,
            ComponentKind.PRIVATE_BUSINESS_EQUITY: self.private_business_equity,
            ComponentKind.REAL_ESTATE_EQUITY: self.real_estate_equity,
            ComponentKind.OTHER_SUPPORTED_ASSETS: self.other_supported_assets,
            ComponentKind.LIABILITY: self.liabilities,
        }[kind]

    def asset_states(self) -> tuple[CoverageState, ...]:
        return tuple(self.state_for(kind) for kind in _ASSET_KINDS)


@dataclass(frozen=True)
class NetWorthSubject:
    subject_id: str
    profile_basis: ProfileBasis

    def __post_init__(self) -> None:
        if not self.subject_id.strip():
            raise ValueError("subject_id is required")


@dataclass(frozen=True)
class DistributionSummary:
    p10_usd: float
    median_usd: float
    p90_usd: float
    probability_negative: float
    simulation_count: int


@dataclass(frozen=True)
class NwsValue:
    score: int
    median_net_worth_usd: float
    scale_version: str = NWS_SCALE_VERSION


@dataclass(frozen=True)
class ConfidenceSummary:
    score: float
    grade: str
    evidence_quality: float
    freshness: float
    coverage: float
    assumption_share: float
    stale_evidence_count: int


@dataclass(frozen=True)
class ComponentResult:
    component_id: str
    kind: ComponentKind
    economic_interest_id: str
    amount: MonetaryRange
    basis: EstimateBasis
    confidence: float
    evidence: tuple[EvidenceRecord, ...]


@dataclass(frozen=True)
class DeclaredTotalResult:
    amount: DeclaredNetWorthRange
    basis: EstimateBasis
    evidence: EvidenceRecord


@dataclass(frozen=True)
class NetWorthResult:
    subject_id: str
    status: EstimateStatus
    reason: str | None
    net_worth: DistributionSummary | None
    liquid_wealth: DistributionSummary | None
    nws: NwsValue | None
    confidence: ConfidenceSummary | None
    valuation_basis: EstimateBasis | None
    component_coverage: BalanceSheetCoverage
    components: tuple[ComponentResult, ...]
    declared_total: DeclaredTotalResult | None
    excluded_component_ids: tuple[str, ...]
    warnings: tuple[str, ...]
    last_financial_update: date | None
    oldest_supporting_evidence: date | None
    model_version: str
    simulation_seed: int | None


class DoubleCountRiskError(ValueError):
    """Raised when input would subtract a debt already embedded in an asset value."""


@dataclass(frozen=True)
class NetWorthEngine:
    simulation_count: int = 25_000
    seed: int = 7
    stale_after_days: int = 365
    model_version: str = NET_WORTH_MODEL_VERSION

    def __post_init__(self) -> None:
        if not 1_000 <= self.simulation_count <= 250_000:
            raise ValueError("simulation_count must be between 1,000 and 250,000")
        if self.stale_after_days < 1:
            raise ValueError("stale_after_days must be positive")
        if not self.model_version.strip():
            raise ValueError("model_version is required")

    def estimate(
        self,
        *,
        subject: NetWorthSubject,
        components: Iterable[FinancialComponent],
        coverage: BalanceSheetCoverage,
        as_of_date: date,
    ) -> NetWorthResult:
        supplied = list(components)
        _validate_component_collection(subject, supplied, as_of_date)
        _validate_coverage_support(coverage, as_of_date)

        if subject.profile_basis is ProfileBasis.PRIVATE_PERSON:
            return self._insufficient(
                subject,
                reason="Not enough verified public financial information.",
                excluded=tuple(sorted(component.component_id for component in supplied)),
            )

        usable: list[FinancialComponent] = []
        excluded: list[str] = []
        warnings: list[str] = []
        for component in supplied:
            if not _component_has_required_support(component):
                excluded.append(component.component_id)
                warnings.append(
                    f"{component.component_id}: excluded because its provenance does not "
                    "support attributable personal value."
                )
                continue
            if coverage.state_for(component.kind) in {
                CoverageState.UNKNOWN,
                CoverageState.NOT_APPLICABLE,
            }:
                excluded.append(component.component_id)
                warnings.append(
                    f"{component.component_id}: excluded because coverage is not declared."
                )
                continue
            usable.append(component)

        selected, duplicate_ids = _deduplicate(usable)
        excluded.extend(duplicate_ids)
        if duplicate_ids:
            warnings.append(
                "Duplicate representations of the same economic interest were counted once."
            )
        _validate_netted_liabilities(selected)

        assets = [component for component in selected if component.kind in _ASSET_KINDS]
        liabilities = [
            component for component in selected if component.kind is ComponentKind.LIABILITY
        ]
        if coverage.liabilities in {
            CoverageState.UNKNOWN,
            CoverageState.NOT_PROVIDED,
            CoverageState.NOT_APPLICABLE,
        }:
            return self._insufficient(
                subject,
                reason="Liability coverage is required before NWS can be calculated.",
                excluded=tuple(sorted(set(excluded))),
                warnings=tuple(warnings),
            )
        if not liabilities:
            return self._insufficient(
                subject,
                reason="A supported liability range is required before NWS can be calculated.",
                excluded=tuple(sorted(set(excluded))),
                warnings=tuple(warnings),
            )
        coverage_gap = _asset_coverage_gap(coverage, assets)
        if coverage_gap:
            return self._insufficient(
                subject,
                reason=coverage_gap,
                excluded=tuple(sorted(set(excluded))),
                warnings=tuple(warnings),
            )
        if not assets or not any(component.amount.high_usd > 0 for component in assets):
            return self._insufficient(
                subject,
                reason="Not enough verified public financial information.",
                excluded=tuple(sorted(set(excluded))),
                warnings=tuple(warnings),
            )
        if not any(_asset_has_attributable_personal_evidence(asset) for asset in assets):
            return self._insufficient(
                subject,
                reason=(
                    "At least one asset requires attributable person-specific financial "
                    "evidence before NWS can be calculated."
                ),
                excluded=tuple(sorted(set(excluded))),
                warnings=tuple(warnings),
            )
        net_samples, liquid_samples = _simulate(
            subject.subject_id,
            selected,
            count=self.simulation_count,
            seed=self.seed,
        )
        net_summary = _summarize(net_samples)
        liquid_summary = _summarize(liquid_samples)
        nws = NwsValue(
            score=net_worth_to_nws(net_summary.median_usd),
            median_net_worth_usd=net_summary.median_usd,
        )
        confidence = _confidence_summary(
            selected,
            coverage=coverage,
            as_of_date=as_of_date,
            stale_after_days=self.stale_after_days,
        )
        evidence = [
            record
            for component in selected
            for record in component.evidence
            if record.supports_personal_net_worth
        ]
        status = _result_status(coverage, selected)
        if status is EstimateStatus.PARTIAL_ESTIMATE:
            warnings.append("Estimate has incomplete or modelled balance-sheet coverage.")

        return NetWorthResult(
            subject_id=subject.subject_id,
            status=status,
            reason=None,
            net_worth=net_summary,
            liquid_wealth=liquid_summary,
            nws=nws,
            confidence=confidence,
            valuation_basis=None,
            component_coverage=coverage,
            components=tuple(_to_component_result(component) for component in selected),
            declared_total=None,
            excluded_component_ids=tuple(sorted(set(excluded))),
            warnings=tuple(warnings),
            last_financial_update=max(record.source_date for record in evidence),
            oldest_supporting_evidence=min(record.source_date for record in evidence),
            model_version=self.model_version,
            simulation_seed=self.seed,
        )

    def estimate_declared_total(
        self,
        *,
        subject: NetWorthSubject,
        declared_total: DeclaredNetWorthRange,
        evidence: EvidenceRecord,
        as_of_date: date,
        additional_components: Iterable[FinancialComponent] = (),
    ) -> NetWorthResult:
        """Publish a legally declared whole-net-worth total without decomposing it.

        A whole-net-worth disclosure has already added assets and subtracted liabilities.
        Therefore this method refuses every additional component. A reconciler must replace
        the declared-total path with the component-ledger path rather than summing both.
        """

        if subject.profile_basis is ProfileBasis.PRIVATE_PERSON:
            return self._insufficient(
                subject,
                reason="Not enough verified public financial information.",
            )
        if evidence.purpose is not EvidencePurpose.DECLARED_NET_WORTH_TOTAL:
            raise ValueError("declared total requires DECLARED_NET_WORTH_TOTAL evidence")
        if not evidence.supports_personal_net_worth:
            raise ValueError("declared total requires personal financial evidence")
        if evidence.source_date > as_of_date:
            raise ValueError(f"{evidence.evidence_id} has a future source_date")
        if evidence.retrieved_at.date() > as_of_date:
            raise ValueError(f"{evidence.evidence_id} has a future retrieved_at")
        extra = list(additional_components)
        if extra:
            raise DoubleCountRiskError(
                "a declared whole-net-worth total cannot be combined with asset or "
                "liability components"
            )

        samples = _simulate_declared_total(
            subject.subject_id,
            declared_total,
            count=self.simulation_count,
            seed=self.seed,
        )
        summary = _summarize(samples)
        freshness = max(
            0.0,
            1 - (as_of_date - evidence.source_date).days / (self.stale_after_days * 2),
        )
        confidence_score = 0.75 * evidence.quality + 0.25 * freshness
        if confidence_score >= 0.85:
            grade = "A"
        elif confidence_score >= 0.70:
            grade = "B"
        elif confidence_score >= 0.55:
            grade = "C"
        elif confidence_score >= 0.40:
            grade = "D"
        else:
            grade = "E"
        not_provided = BalanceSheetCoverage(
            cash_and_near_cash=CoverageState.NOT_PROVIDED,
            public_securities=CoverageState.NOT_PROVIDED,
            private_business_equity=CoverageState.NOT_PROVIDED,
            real_estate_equity=CoverageState.NOT_PROVIDED,
            other_supported_assets=CoverageState.NOT_PROVIDED,
            liabilities=CoverageState.NOT_PROVIDED,
        )
        return NetWorthResult(
            subject_id=subject.subject_id,
            status=EstimateStatus.AVAILABLE,
            reason=None,
            net_worth=summary,
            liquid_wealth=None,
            nws=NwsValue(
                score=net_worth_to_nws(summary.median_usd),
                median_net_worth_usd=summary.median_usd,
            ),
            confidence=ConfidenceSummary(
                score=round(confidence_score, 4),
                grade=grade,
                evidence_quality=round(evidence.quality, 4),
                freshness=round(freshness, 4),
                coverage=1.0,
                assumption_share=0.0,
                stale_evidence_count=int(
                    (as_of_date - evidence.source_date).days > self.stale_after_days
                ),
            ),
            valuation_basis=EstimateBasis.DECLARED_TOTAL,
            component_coverage=not_provided,
            components=(),
            declared_total=DeclaredTotalResult(
                amount=declared_total,
                basis=EstimateBasis.DECLARED_TOTAL,
                evidence=evidence,
            ),
            excluded_component_ids=(),
            warnings=(
                "Declared total does not provide a component breakdown or liquid-wealth "
                "estimate.",
            ),
            last_financial_update=evidence.source_date,
            oldest_supporting_evidence=evidence.source_date,
            model_version=self.model_version,
            simulation_seed=self.seed,
        )

    def _insufficient(
        self,
        subject: NetWorthSubject,
        *,
        reason: str,
        excluded: tuple[str, ...] = (),
        warnings: tuple[str, ...] = (),
    ) -> NetWorthResult:
        return NetWorthResult(
            subject_id=subject.subject_id,
            status=EstimateStatus.INSUFFICIENT_EVIDENCE,
            reason=reason,
            net_worth=None,
            liquid_wealth=None,
            nws=None,
            confidence=None,
            valuation_basis=None,
            component_coverage=BalanceSheetCoverage(),
            components=(),
            declared_total=None,
            excluded_component_ids=excluded,
            warnings=warnings,
            last_financial_update=None,
            oldest_supporting_evidence=None,
            model_version=self.model_version,
            simulation_seed=None,
        )


def net_worth_to_nws(median_net_worth_usd: float) -> int:
    """Map net worth to a fixed national log scale, independent of location.

    Anchors: <=$10k => 0, $100k => 17, $1m => 33, $10m => 50,
    $100m => 67, $1b => 83, and >=$10b => 100.
    """

    if not math.isfinite(median_net_worth_usd):
        raise ValueError("median net worth must be finite")
    if median_net_worth_usd <= 10_000:
        return 0
    if median_net_worth_usd >= 10_000_000_000:
        return 100
    raw_score = (math.log10(median_net_worth_usd) - 4) * (100 / 6)
    return min(100, max(0, math.floor(raw_score + 0.5)))


def _validate_component_collection(
    subject: NetWorthSubject,
    components: list[FinancialComponent],
    as_of_date: date,
) -> None:
    component_ids: set[str] = set()
    evidence_interest: dict[str, str] = {}
    for component in components:
        if component.subject_id != subject.subject_id:
            raise ValueError("all components must refer to the requested subject")
        if component.component_id in component_ids:
            raise ValueError(f"duplicate component_id: {component.component_id}")
        component_ids.add(component.component_id)
        for record in component.evidence:
            if record.source_date > as_of_date:
                raise ValueError(f"{record.evidence_id} has a future source_date")
            if record.retrieved_at.date() > as_of_date:
                raise ValueError(f"{record.evidence_id} has a future retrieved_at")
            prior_interest = evidence_interest.get(record.evidence_id)
            if prior_interest is not None and prior_interest != component.economic_interest_id:
                raise DoubleCountRiskError(
                    f"evidence {record.evidence_id} is reused across different economic interests"
                )
            evidence_interest[record.evidence_id] = component.economic_interest_id


def _validate_coverage_support(coverage: BalanceSheetCoverage, as_of_date: date) -> None:
    for support in coverage.not_applicable_support:
        if support.evidence.source_date > as_of_date:
            raise ValueError(f"{support.evidence.evidence_id} has a future source_date")
        if support.evidence.retrieved_at.date() > as_of_date:
            raise ValueError(f"{support.evidence.evidence_id} has a future retrieved_at")


def _asset_coverage_gap(
    coverage: BalanceSheetCoverage,
    assets: list[FinancialComponent],
) -> str | None:
    asset_kinds_present = {component.kind for component in assets}
    unbounded: list[str] = []
    for kind in _ASSET_KINDS:
        state = coverage.state_for(kind)
        if state in {CoverageState.UNKNOWN, CoverageState.NOT_PROVIDED}:
            unbounded.append(kind.value)
            continue
        if state is CoverageState.NOT_APPLICABLE:
            if not coverage.has_not_applicable_support(kind):
                unbounded.append(kind.value)
            continue
        if kind not in asset_kinds_present:
            unbounded.append(kind.value)
    if not unbounded:
        return None
    return (
        "Unbounded asset coverage prevents NWS calculation: "
        + ", ".join(sorted(unbounded))
        + "."
    )


def _component_has_required_support(component: FinancialComponent) -> bool:
    usable = [record for record in component.evidence if record.supports_personal_net_worth]
    purposes = {record.purpose for record in usable}
    if component.kind is ComponentKind.CASH_AND_NEAR_CASH:
        return EvidencePurpose.PERSONAL_AMOUNT in purposes
    if component.kind in {
        ComponentKind.PUBLIC_SECURITIES,
        ComponentKind.PRIVATE_BUSINESS_EQUITY,
        ComponentKind.OTHER_SUPPORTED_ASSETS,
    }:
        return EvidencePurpose.PERSONAL_AMOUNT in purposes or {
            EvidencePurpose.PERSONAL_OWNERSHIP,
            EvidencePurpose.MARKET_VALUE,
        }.issubset(purposes)
    if component.kind is ComponentKind.REAL_ESTATE_EQUITY:
        has_value = EvidencePurpose.PERSONAL_AMOUNT in purposes or {
            EvidencePurpose.PERSONAL_OWNERSHIP,
            EvidencePurpose.MARKET_VALUE,
        }.issubset(purposes)
        has_debt = bool(
            purposes & {EvidencePurpose.LIABILITY_AMOUNT, EvidencePurpose.MODEL_ASSUMPTION}
        )
        return has_value and has_debt
    return EvidencePurpose.LIABILITY_AMOUNT in purposes


def _asset_has_attributable_personal_evidence(component: FinancialComponent) -> bool:
    """Return whether an asset starts from a fact attributable to this person.

    Model policy can widen or otherwise adjust a supported range, but it cannot invent an
    asset for a named person. Market data alone is likewise insufficient without ownership.
    """

    if component.kind not in _ASSET_KINDS:
        return False
    purposes = {
        record.purpose
        for record in component.evidence
        if record.supports_personal_net_worth
    }
    return bool(
        purposes
        & {
            EvidencePurpose.PERSONAL_AMOUNT,
            EvidencePurpose.PERSONAL_OWNERSHIP,
        }
    )


def _deduplicate(
    components: list[FinancialComponent],
) -> tuple[list[FinancialComponent], list[str]]:
    by_interest: dict[str, list[FinancialComponent]] = {}
    for component in components:
        by_interest.setdefault(component.economic_interest_id, []).append(component)

    selected: list[FinancialComponent] = []
    excluded: list[str] = []
    basis_rank = {
        EstimateBasis.DIRECT_DISCLOSURE: 3,
        EstimateBasis.DERIVED_FROM_VERIFIED_INPUTS: 2,
        EstimateBasis.EXPLICIT_MODEL_ASSUMPTION: 1,
    }
    for interest_id in sorted(by_interest):
        candidates = by_interest[interest_id]
        signs = {component.kind is ComponentKind.LIABILITY for component in candidates}
        if len(signs) > 1:
            raise DoubleCountRiskError(
                f"economic interest {interest_id} is represented as both an asset and liability"
            )

        def selection_key(component: FinancialComponent) -> tuple[date, int, float, str]:
            latest_date = max(
                record.source_date
                for record in component.evidence
                if record.supports_personal_net_worth
            )
            return (
                latest_date,
                basis_rank[component.basis],
                component.confidence,
                component.component_id,
            )

        winner = max(candidates, key=selection_key)
        selected.append(winner)
        excluded.extend(
            component.component_id for component in candidates if component is not winner
        )
    selected.sort(key=lambda component: (component.kind.value, component.economic_interest_id))
    return selected, excluded


def _validate_netted_liabilities(components: list[FinancialComponent]) -> None:
    liability_ids = {
        component.economic_interest_id
        for component in components
        if component.kind is ComponentKind.LIABILITY
    }
    for asset in (component for component in components if component.kind in _ASSET_KINDS):
        conflicts = liability_ids.intersection(asset.netted_liability_interest_ids)
        if conflicts:
            conflict = sorted(conflicts)[0]
            raise DoubleCountRiskError(
                f"liability {conflict} is already netted into asset {asset.component_id}"
            )


def _stable_seed(seed: int, *parts: str) -> int:
    payload = "\x1f".join((str(seed), *parts)).encode()
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")


def _sample_range(value: MonetaryRange | FractionRange, rng: random.Random) -> float:
    low = value.low_usd if isinstance(value, MonetaryRange) else value.low
    mode = value.most_likely_usd if isinstance(value, MonetaryRange) else value.most_likely
    high = value.high_usd if isinstance(value, MonetaryRange) else value.high
    if low == high:
        return low
    return rng.triangular(low, high, mode)


def _simulate(
    subject_id: str,
    components: list[FinancialComponent],
    *,
    count: int,
    seed: int,
) -> tuple[list[float], list[float]]:
    net_samples = [0.0] * count
    liquid_samples = [0.0] * count
    for component in components:
        amount_rng = random.Random(
            _stable_seed(seed, subject_id, component.economic_interest_id, "amount")
        )
        fraction_rng = random.Random(
            _stable_seed(seed, subject_id, component.economic_interest_id, "liquid")
        )
        for index in range(count):
            amount = _sample_range(component.amount, amount_rng)
            if component.kind is ComponentKind.LIABILITY:
                net_samples[index] -= amount
                continue
            net_samples[index] += amount
            assert component.liquid_fraction is not None
            liquid_samples[index] += amount * _sample_range(
                component.liquid_fraction, fraction_rng
            )
    return net_samples, liquid_samples


def _simulate_declared_total(
    subject_id: str,
    declared_total: DeclaredNetWorthRange,
    *,
    count: int,
    seed: int,
) -> list[float]:
    if declared_total.low_usd == declared_total.high_usd:
        return [declared_total.low_usd] * count
    rng = random.Random(_stable_seed(seed, subject_id, "declared-total"))
    return [
        rng.triangular(
            declared_total.low_usd,
            declared_total.high_usd,
            declared_total.most_likely_usd,
        )
        for _ in range(count)
    ]


def _quantile(sorted_values: list[float], probability: float) -> float:
    position = (len(sorted_values) - 1) * probability
    lower_index = math.floor(position)
    upper_index = math.ceil(position)
    if lower_index == upper_index:
        return sorted_values[lower_index]
    weight = position - lower_index
    return sorted_values[lower_index] * (1 - weight) + sorted_values[upper_index] * weight


def _summarize(samples: list[float]) -> DistributionSummary:
    ordered = sorted(samples)
    return DistributionSummary(
        p10_usd=_quantile(ordered, 0.10),
        median_usd=_quantile(ordered, 0.50),
        p90_usd=_quantile(ordered, 0.90),
        probability_negative=sum(value < 0 for value in samples) / len(samples),
        simulation_count=len(samples),
    )


def _coverage_score(coverage: BalanceSheetCoverage) -> float:
    values = {
        CoverageState.VERIFIED: 1.0,
        CoverageState.PARTIAL: 0.55,
        CoverageState.MODELED: 0.4,
        CoverageState.UNKNOWN: 0.0,
        CoverageState.NOT_PROVIDED: 0.0,
        CoverageState.NOT_APPLICABLE: 1.0,
    }
    states = (*coverage.asset_states(), coverage.liabilities)
    return sum(values[state] for state in states) / len(states)


def _confidence_summary(
    components: list[FinancialComponent],
    *,
    coverage: BalanceSheetCoverage,
    as_of_date: date,
    stale_after_days: int,
) -> ConfidenceSummary:
    evidence = [
        record
        for component in components
        for record in component.evidence
        if record.supports_personal_net_worth
    ]
    evidence_quality = sum(record.quality for record in evidence) / len(evidence)
    ages = [(as_of_date - record.source_date).days for record in evidence]
    freshness_values = [max(0.0, 1 - age / (stale_after_days * 2)) for age in ages]
    freshness = sum(freshness_values) / len(freshness_values)
    component_confidence = sum(component.confidence for component in components) / len(components)
    coverage_value = _coverage_score(coverage)
    gross_most_likely = sum(component.amount.most_likely_usd for component in components)
    assumed_most_likely = sum(
        component.amount.most_likely_usd
        for component in components
        if component.basis is EstimateBasis.EXPLICIT_MODEL_ASSUMPTION
    )
    assumption_share = assumed_most_likely / gross_most_likely if gross_most_likely else 0.0
    score = (
        0.30 * evidence_quality
        + 0.25 * component_confidence
        + 0.20 * freshness
        + 0.25 * coverage_value
    ) * (1 - 0.35 * assumption_share)
    score = min(1.0, max(0.0, score))
    if score >= 0.85:
        grade = "A"
    elif score >= 0.70:
        grade = "B"
    elif score >= 0.55:
        grade = "C"
    elif score >= 0.40:
        grade = "D"
    else:
        grade = "E"
    return ConfidenceSummary(
        score=round(score, 4),
        grade=grade,
        evidence_quality=round(evidence_quality, 4),
        freshness=round(freshness, 4),
        coverage=round(coverage_value, 4),
        assumption_share=round(assumption_share, 4),
        stale_evidence_count=sum(age > stale_after_days for age in ages),
    )


def _result_status(
    coverage: BalanceSheetCoverage,
    components: list[FinancialComponent],
) -> EstimateStatus:
    states = (*coverage.asset_states(), coverage.liabilities)
    has_incomplete_coverage = any(
        state
        in {
            CoverageState.UNKNOWN,
            CoverageState.NOT_PROVIDED,
            CoverageState.PARTIAL,
            CoverageState.MODELED,
        }
        for state in states
    )
    has_assumption = any(
        component.basis is EstimateBasis.EXPLICIT_MODEL_ASSUMPTION
        for component in components
    )
    if has_incomplete_coverage or has_assumption:
        return EstimateStatus.PARTIAL_ESTIMATE
    return EstimateStatus.AVAILABLE


def _to_component_result(component: FinancialComponent) -> ComponentResult:
    return ComponentResult(
        component_id=component.component_id,
        kind=component.kind,
        economic_interest_id=component.economic_interest_id,
        amount=component.amount,
        basis=component.basis,
        confidence=component.confidence,
        evidence=tuple(
            record for record in component.evidence if record.supports_personal_net_worth
        ),
    )
