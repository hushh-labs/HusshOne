"""Pure canary-health policy used by the worker before it writes production data."""
from __future__ import annotations

from dataclasses import dataclass

from app.scrape_contract import ScrapeResult, ScrapeStatus


@dataclass(frozen=True)
class CanaryAssessment:
    healthy: bool
    reason: str
    result_count: int


def assess_canary(result: ScrapeResult, minimum_results: int) -> CanaryAssessment:
    if minimum_results < 1:
        raise ValueError("minimum_results must be at least 1")
    if result.status != ScrapeStatus.SUCCESS:
        return CanaryAssessment(False, f"canary outcome: {result.status.value}", len(result.records))
    if len(result.records) < minimum_results:
        return CanaryAssessment(
            False,
            f"canary returned {len(result.records)} result(s), below minimum {minimum_results}",
            len(result.records),
        )
    return CanaryAssessment(True, "canary healthy", len(result.records))
