from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
from datetime import date
from typing import Iterable

import numpy as np

from app.domain.models import (
    AssetCategory,
    EstimateComponent,
    TriangularDistribution,
    ValuationSummary,
    ensure_same_subject,
)


def _validate_triplet(low: float, mode: float, high: float, name: str) -> None:
    if low < 0 or not low <= mode <= high:
        raise ValueError(f"invalid {name} range")


def estimate_public_equity(
    *,
    component_id: str,
    subject_id: str,
    shares: tuple[float, float, float],
    price_usd: tuple[float, float, float],
    liquidity_discount: tuple[float, float, float] = (0.0, 0.0, 0.0),
    evidence_ids: tuple[str, ...],
    quality_score: float,
    as_of_date: date,
    double_count_group: str | None = None,
) -> EstimateComponent:
    """Build a conservative range for publicly traded securities.

    liquidity_discount is expressed as a fraction, where 0.20 means a 20% haircut.
    The discount tuple is (low, mode, high), with the largest discount applied to the low case.
    """

    _validate_triplet(*shares, "shares")
    _validate_triplet(*price_usd, "price")
    _validate_triplet(*liquidity_discount, "liquidity_discount")
    if liquidity_discount[2] > 1:
        raise ValueError("liquidity discount cannot exceed 1")

    low = shares[0] * price_usd[0] * (1 - liquidity_discount[2])
    mode = shares[1] * price_usd[1] * (1 - liquidity_discount[1])
    high = shares[2] * price_usd[2] * (1 - liquidity_discount[0])
    return EstimateComponent(
        component_id=component_id,
        subject_id=subject_id,
        category=AssetCategory.PUBLIC_EQUITY,
        distribution=TriangularDistribution(low, mode, high),
        evidence_ids=evidence_ids,
        quality_score=quality_score,
        as_of_date=as_of_date,
        double_count_group=double_count_group,
    )


def estimate_options(
    *,
    component_id: str,
    subject_id: str,
    option_count: tuple[float, float, float],
    market_price: tuple[float, float, float],
    strike_price: tuple[float, float, float],
    vested_fraction: tuple[float, float, float],
    exercise_tax_haircut: tuple[float, float, float],
    evidence_ids: tuple[str, ...],
    quality_score: float,
    as_of_date: date,
    double_count_group: str | None = None,
) -> EstimateComponent:
    for triplet, name in (
        (option_count, "option_count"),
        (market_price, "market_price"),
        (strike_price, "strike_price"),
        (vested_fraction, "vested_fraction"),
        (exercise_tax_haircut, "exercise_tax_haircut"),
    ):
        _validate_triplet(*triplet, name)
    if vested_fraction[2] > 1 or exercise_tax_haircut[2] > 1:
        raise ValueError("fractions cannot exceed 1")

    def value(count: float, price: float, strike: float, vested: float, haircut: float) -> float:
        return count * max(price - strike, 0.0) * vested * (1.0 - haircut)

    low = value(option_count[0], market_price[0], strike_price[2], vested_fraction[0], exercise_tax_haircut[2])
    mode = value(option_count[1], market_price[1], strike_price[1], vested_fraction[1], exercise_tax_haircut[1])
    high = value(option_count[2], market_price[2], strike_price[0], vested_fraction[2], exercise_tax_haircut[0])
    mode = min(max(mode, low), high)
    return EstimateComponent(
        component_id=component_id,
        subject_id=subject_id,
        category=AssetCategory.OPTIONS,
        distribution=TriangularDistribution(low, mode, high),
        evidence_ids=evidence_ids,
        quality_score=quality_score,
        as_of_date=as_of_date,
        double_count_group=double_count_group,
    )


def estimate_private_equity(
    *,
    component_id: str,
    subject_id: str,
    company_valuation: tuple[float, float, float],
    ownership_fraction: tuple[float, float, float],
    liquidity_multiplier: tuple[float, float, float],
    preference_multiplier: tuple[float, float, float],
    staleness_multiplier: tuple[float, float, float],
    evidence_ids: tuple[str, ...],
    quality_score: float,
    as_of_date: date,
    double_count_group: str | None = None,
) -> EstimateComponent:
    for triplet, name in (
        (company_valuation, "company_valuation"),
        (ownership_fraction, "ownership_fraction"),
        (liquidity_multiplier, "liquidity_multiplier"),
        (preference_multiplier, "preference_multiplier"),
        (staleness_multiplier, "staleness_multiplier"),
    ):
        _validate_triplet(*triplet, name)
    for triplet in (ownership_fraction, liquidity_multiplier, preference_multiplier, staleness_multiplier):
        if triplet[2] > 1:
            raise ValueError("fractional multipliers cannot exceed 1")

    low = (
        company_valuation[0]
        * ownership_fraction[0]
        * liquidity_multiplier[0]
        * preference_multiplier[0]
        * staleness_multiplier[0]
    )
    mode = (
        company_valuation[1]
        * ownership_fraction[1]
        * liquidity_multiplier[1]
        * preference_multiplier[1]
        * staleness_multiplier[1]
    )
    high = (
        company_valuation[2]
        * ownership_fraction[2]
        * liquidity_multiplier[2]
        * preference_multiplier[2]
        * staleness_multiplier[2]
    )
    return EstimateComponent(
        component_id=component_id,
        subject_id=subject_id,
        category=AssetCategory.PRIVATE_EQUITY,
        distribution=TriangularDistribution(low, mode, high),
        evidence_ids=evidence_ids,
        quality_score=quality_score,
        as_of_date=as_of_date,
        double_count_group=double_count_group,
    )


def estimate_disclosed_real_estate(
    *,
    component_id: str,
    subject_id: str,
    gross_value: tuple[float, float, float],
    debt: tuple[float, float, float],
    ownership_fraction: tuple[float, float, float],
    evidence_ids: tuple[str, ...],
    quality_score: float,
    as_of_date: date,
    double_count_group: str | None = None,
) -> EstimateComponent:
    for triplet, name in (
        (gross_value, "gross_value"),
        (debt, "debt"),
        (ownership_fraction, "ownership_fraction"),
    ):
        _validate_triplet(*triplet, name)
    if ownership_fraction[2] > 1:
        raise ValueError("ownership_fraction cannot exceed 1")

    low = max(gross_value[0] - debt[2], 0.0) * ownership_fraction[0]
    mode = max(gross_value[1] - debt[1], 0.0) * ownership_fraction[1]
    high = max(gross_value[2] - debt[0], 0.0) * ownership_fraction[2]
    mode = min(max(mode, low), high)
    return EstimateComponent(
        component_id=component_id,
        subject_id=subject_id,
        category=AssetCategory.REAL_ESTATE,
        distribution=TriangularDistribution(low, mode, high),
        evidence_ids=evidence_ids,
        quality_score=quality_score,
        as_of_date=as_of_date,
        double_count_group=double_count_group,
    )


def estimate_liability(
    *,
    component_id: str,
    subject_id: str,
    amount: tuple[float, float, float],
    evidence_ids: tuple[str, ...],
    quality_score: float,
    as_of_date: date,
    double_count_group: str | None = None,
) -> EstimateComponent:
    _validate_triplet(*amount, "liability")
    return EstimateComponent(
        component_id=component_id,
        subject_id=subject_id,
        category=AssetCategory.LIABILITY,
        distribution=TriangularDistribution(*amount),
        evidence_ids=evidence_ids,
        quality_score=quality_score,
        as_of_date=as_of_date,
        double_count_group=double_count_group,
    )


def deduplicate_components(components: Iterable[EstimateComponent]) -> list[EstimateComponent]:
    """Choose one estimate per overlapping evidence group.

    A direct holding and the same holding repeated in a proxy statement must not be added twice.
    Ungrouped estimates are retained. Grouped estimates are selected by quality, then recency.
    """

    ungrouped: list[EstimateComponent] = []
    grouped: dict[str, list[EstimateComponent]] = defaultdict(list)
    for component in components:
        if component.double_count_group:
            grouped[component.double_count_group].append(component)
        else:
            ungrouped.append(component)

    for candidates in grouped.values():
        candidates.sort(key=lambda item: (item.quality_score, item.as_of_date), reverse=True)
        ungrouped.append(candidates[0])
    return ungrouped


def sample_net_worth(
    components: Iterable[EstimateComponent],
    *,
    simulation_count: int = 25_000,
    seed: int = 7,
) -> tuple[str, np.ndarray]:
    components = deduplicate_components(list(components))
    subject_id = ensure_same_subject(components)
    if simulation_count < 1_000:
        raise ValueError("simulation_count must be at least 1,000")

    rng = np.random.default_rng(seed)
    total = np.zeros(simulation_count, dtype=float)
    for component in components:
        sample = component.distribution.sample(rng, simulation_count)
        if component.category is AssetCategory.LIABILITY:
            total -= sample
        else:
            total += sample
    return subject_id, total


def summarize_samples(
    subject_id: str,
    samples: np.ndarray,
    *,
    model_version: str = "wealth-v1.0.0",
) -> ValuationSummary:
    if samples.ndim != 1 or len(samples) == 0:
        raise ValueError("samples must be a non-empty one-dimensional array")
    return ValuationSummary(
        subject_id=subject_id,
        p05_usd=float(np.quantile(samples, 0.05)),
        median_usd=float(np.median(samples)),
        p95_usd=float(np.quantile(samples, 0.95)),
        mean_usd=float(np.mean(samples)),
        probability_negative=float(np.mean(samples < 0)),
        simulation_count=len(samples),
        model_version=model_version,
    )
