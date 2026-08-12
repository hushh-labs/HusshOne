from __future__ import annotations

from dataclasses import fields
from math import log1p
from statistics import median
from typing import Callable, Iterable

from app.domain.models import (
    AnonymousAffluenceResult,
    AnonymousAssetFeatures,
)


_WEIGHTS: dict[str, float] = {
    "assessed_value": 0.30,
    "indexed_sale_value": 0.20,
    "improvement_value": 0.10,
    "lot_area_sqft": 0.06,
    "building_area_sqft": 0.07,
    "quality_index": 0.07,
    "waterfront_flag": 0.06,
    "acs_income_context": 0.06,
    "acs_home_value_context": 0.05,
    "evidence_recency": 0.03,
}


_LOG_FEATURES = {
    "assessed_value",
    "indexed_sale_value",
    "improvement_value",
    "lot_area_sqft",
    "building_area_sqft",
    "acs_income_context",
    "acs_home_value_context",
}


def _percentile(values: list[float], value: float) -> float:
    if len(values) == 1:
        return 0.5
    less = sum(1 for item in values if item < value)
    equal = sum(1 for item in values if item == value)
    return (less + 0.5 * equal) / len(values)


def _winsorize(values: list[float], fraction: float = 0.01) -> list[float]:
    if len(values) < 20:
        return values
    ordered = sorted(values)
    low_index = int((len(ordered) - 1) * fraction)
    high_index = int((len(ordered) - 1) * (1 - fraction))
    low, high = ordered[low_index], ordered[high_index]
    return [min(max(value, low), high) for value in values]


def score_anonymous_assets(
    records: Iterable[AnonymousAssetFeatures],
) -> list[AnonymousAffluenceResult]:
    records = list(records)
    if not records:
        return []
    if len({record.anonymous_id for record in records}) != len(records):
        raise ValueError("anonymous IDs must be unique")

    field_values: dict[str, list[float]] = {}
    transformed_by_id: dict[str, dict[str, float | None]] = {}

    for record in records:
        transformed: dict[str, float | None] = {}
        for feature_name in _WEIGHTS:
            raw = getattr(record, feature_name)
            if raw is None:
                transformed[feature_name] = None
            elif feature_name == "waterfront_flag":
                transformed[feature_name] = 1.0 if raw else 0.0
            elif feature_name in _LOG_FEATURES:
                transformed[feature_name] = log1p(float(raw))
            else:
                transformed[feature_name] = float(raw)
        transformed_by_id[record.anonymous_id] = transformed

    for feature_name in _WEIGHTS:
        observed = [
            values[feature_name]
            for values in transformed_by_id.values()
            if values[feature_name] is not None
        ]
        if not observed:
            field_values[feature_name] = [0.0]
        else:
            field_values[feature_name] = _winsorize([float(value) for value in observed])

    results: list[AnonymousAffluenceResult] = []
    for record in records:
        transformed = transformed_by_id[record.anonymous_id]
        weighted_score = 0.0
        missing = 0
        for feature_name, weight in _WEIGHTS.items():
            value = transformed[feature_name]
            comparison = field_values[feature_name]
            if value is None:
                missing += 1
                feature_percentile = 0.5
            else:
                bounded_value = min(max(float(value), min(comparison)), max(comparison))
                feature_percentile = _percentile(comparison, bounded_value)
            weighted_score += weight * feature_percentile

        missingness_multiplier = max(0.72, 1.0 - missing * 0.04)
        score = 100.0 * weighted_score * missingness_multiplier
        confidence = "HIGH" if missing <= 1 else "MEDIUM" if missing <= 3 else "LOW"
        results.append(
            AnonymousAffluenceResult(
                anonymous_id=record.anonymous_id,
                score=round(score, 4),
                rank=0,
                missing_feature_count=missing,
                confidence=confidence,
            )
        )

    results.sort(key=lambda result: (-result.score, result.anonymous_id))
    return [
        AnonymousAffluenceResult(
            anonymous_id=result.anonymous_id,
            score=result.score,
            rank=index + 1,
            missing_feature_count=result.missing_feature_count,
            confidence=result.confidence,
        )
        for index, result in enumerate(results)
    ]


def select_top_anonymous_assets(
    records: Iterable[AnonymousAssetFeatures],
    *,
    count: int = 514,
) -> list[AnonymousAffluenceResult]:
    if count <= 0:
        raise ValueError("count must be positive")
    return score_anonymous_assets(records)[:count]
