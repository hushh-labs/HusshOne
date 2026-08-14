from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import app.main as main
from app.bootstrap_data import BOOTSTRAP_CANDIDATES, BOOTSTRAP_METADATA
from app.coverage import QueryResolution
from app.main import NearbyDiscoveryRequest, NearbyFiltersInput, QueryLocationInput
from app.national_nppes import NationalNppesResult, NppesCandidateProvider
from app.nws_models import GeoPoint


class StubNppesProvider(NppesCandidateProvider):
    def __init__(self, results: list[NationalNppesResult]) -> None:
        self.results = list(results)
        self.calls: list[dict[str, object]] = []

    def fetch(  # type: ignore[override]
        self,
        *,
        query_point: GeoPoint,
        radius_km: float,
        limit: int,
        postal_code: str | None = None,
    ) -> NationalNppesResult:
        self.calls.append(
            {
                "query_point": query_point,
                "radius_km": radius_km,
                "limit": limit,
                "postal_code": postal_code,
            }
        )
        return self.results.pop(0)


def _result(
    *person_ids: str,
    status: str = "OK",
    query_mode: str = "COORDINATE_RADIUS",
) -> NationalNppesResult:
    candidates = tuple(
        replace(
            BOOTSTRAP_CANDIDATES[index % len(BOOTSTRAP_CANDIDATES)],
            person_id=person_id,
        )
        for index, person_id in enumerate(person_ids)
    )
    metadata = {
        candidate.person_id: BOOTSTRAP_METADATA[
            BOOTSTRAP_CANDIDATES[index % len(BOOTSTRAP_CANDIDATES)].person_id
        ]
        for index, candidate in enumerate(candidates)
    }
    source_status: dict[str, object] = {
        "source": "CMS_NPPES",
        "status": status,
        "scope": "US_NATIONAL",
        "candidate_count": len(candidates),
        "rows_received": len(candidates),
        "rows_rejected": 0,
        "source_as_of": "2026-08-13T00:00:00+00:00" if candidates else None,
        "queried_at": "2026-08-14T00:00:00+00:00",
        "query_mode": query_mode,
        "truncated": False,
        "location_granularity": "POSTAL_AREA",
        "score_status": "PROVISIONAL",
    }
    if status == "UNAVAILABLE":
        source_status["error_code"] = "NPPES_QUERY_FAILED"
    return NationalNppesResult(candidates, metadata, source_status)


def _resolution() -> QueryResolution:
    return QueryResolution(
        point=GeoPoint(41.78, -87.60),
        query={"mode": "POSTAL_CODE", "postal_code": "60637"},
        coverage={"status": "COVERED"},
    )


def _request(*, top_n: int = 4, auto_expand: bool = True) -> NearbyDiscoveryRequest:
    return NearbyDiscoveryRequest(
        query=QueryLocationInput(postal_code="60637"),
        top_n=top_n,
        initial_radius_km=10,
        max_radius_km=40,
        auto_expand=auto_expand,
    )


def test_integrated_national_fetch_expands_sparse_zip_and_keeps_exact_results_first(
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    provider = StubNppesProvider(
        [
            _result("exact-1", "exact-2", query_mode="POSTAL_CODE"),
            _result("exact-1", "nearby-1"),
            _result("exact-2", "nearby-2", "nearby-3"),
        ]
    )
    monkeypatch.setattr(
        main,
        "get_settings",
        lambda: SimpleNamespace(nppes_source_enabled=True, sec_source_enabled=False),
    )
    monkeypatch.setattr(main, "_nppes_provider", lambda: provider)

    batch = main._fetch_national_candidates(  # noqa: SLF001
        resolution=_resolution(),
        request=_request(),
    )

    assert [candidate.person_id for candidate in batch.candidates] == [
        "exact-1",
        "exact-2",
        "nearby-1",
        "nearby-2",
        "nearby-3",
    ]
    assert [call["postal_code"] for call in provider.calls] == ["60637", None, None]
    assert [call["radius_km"] for call in provider.calls] == [10, 10, 40]
    assert all(call["limit"] == 200 for call in provider.calls)

    status = batch.source_status[0]
    assert status["status"] == "OK"
    assert status["query_mode"] == "POSTAL_THEN_RADIUS_EXPANSION"
    assert status["exact_postal_candidate_count"] == 2
    assert status["fallback_candidate_count"] == 3
    assert status["requested_candidate_target"] == 4
    assert status["target_satisfied"] is True
    assert status["fallback_reason"] == "EXACT_POSTAL_BELOW_TARGET"
    assert status["expansion_radii_km"] == [10, 40]
    stages = status["stages"]
    assert isinstance(stages, list)
    assert [stage["query_mode"] for stage in stages] == [
        "POSTAL_CODE",
        "COORDINATE_RADIUS",
        "COORDINATE_RADIUS",
    ]
    assert [stage.get("radius_km") for stage in stages] == [None, 10, 40]


def test_dense_exact_zip_does_not_run_radius_fallback() -> None:
    provider = StubNppesProvider(
        [_result("exact-1", "exact-2", "exact-3", query_mode="POSTAL_CODE")]
    )

    result = main._fetch_nppes_candidates(  # noqa: SLF001
        provider=provider,
        resolution=_resolution(),
        request=_request(top_n=3),
        candidate_limit=200,
    )

    assert len(provider.calls) == 1
    assert result.source_status["fallback_triggered"] is False
    assert result.source_status["fallback_skipped_reason"] == "EXACT_POSTAL_TARGET_SATISFIED"
    assert result.source_status["target_satisfied"] is True


def test_financial_candidate_fetch_exhausts_radius_even_when_exact_zip_is_dense() -> None:
    provider = StubNppesProvider(
        [
            _result("exact-1", "exact-2", "exact-3", query_mode="POSTAL_CODE"),
            _result("exact-1", "farther-financial-candidate"),
        ]
    )

    result = main._fetch_nppes_candidates(  # noqa: SLF001
        provider=provider,
        resolution=_resolution(),
        request=_request(top_n=3),
        candidate_limit=200,
        exhaust_radius=True,
    )

    assert [call["postal_code"] for call in provider.calls] == ["60637", None]
    assert [call["radius_km"] for call in provider.calls] == [10, 40]
    assert {candidate.person_id for candidate in result.candidates} == {
        "exact-1",
        "exact-2",
        "exact-3",
        "farther-financial-candidate",
    }


def test_auto_expand_false_returns_sparse_exact_zip_without_radius_query() -> None:
    provider = StubNppesProvider([_result("exact-1", query_mode="POSTAL_CODE")])

    result = main._fetch_nppes_candidates(  # noqa: SLF001
        provider=provider,
        resolution=_resolution(),
        request=_request(auto_expand=False),
        candidate_limit=200,
    )

    assert [candidate.person_id for candidate in result.candidates] == ["exact-1"]
    assert len(provider.calls) == 1
    assert result.source_status["status"] == "OK"
    assert result.source_status["target_satisfied"] is False
    assert result.source_status["fallback_skipped_reason"] == "AUTO_EXPAND_DISABLED"


def test_radius_failure_is_fail_soft_when_exact_zip_has_usable_candidates() -> None:
    provider = StubNppesProvider(
        [
            _result("exact-1", query_mode="POSTAL_CODE"),
            _result(status="UNAVAILABLE"),
        ]
    )

    result = main._fetch_nppes_candidates(  # noqa: SLF001
        provider=provider,
        resolution=_resolution(),
        request=_request(),
        candidate_limit=200,
    )

    assert [candidate.person_id for candidate in result.candidates] == ["exact-1"]
    assert len(provider.calls) == 2
    assert result.source_status["status"] == "OK"
    assert result.source_status["degraded"] is True
    assert "error_code" not in result.source_status
    stages = result.source_status["stages"]
    assert isinstance(stages, list)
    assert [stage["status"] for stage in stages] == ["OK", "UNAVAILABLE"]


def test_empty_zip_expansion_is_bounded_by_max_radius() -> None:
    provider = StubNppesProvider(
        [
            _result(status="EMPTY", query_mode="POSTAL_CODE"),
            _result(status="EMPTY"),
            _result(status="EMPTY"),
        ]
    )

    result = main._fetch_nppes_candidates(  # noqa: SLF001
        provider=provider,
        resolution=_resolution(),
        request=_request(),
        candidate_limit=200,
    )

    assert [call["radius_km"] for call in provider.calls] == [10, 10, 40]
    assert result.source_status["status"] == "EMPTY"
    assert result.source_status["target_satisfied"] is False
    assert result.source_status["expansion_radii_km"] == [10, 40]


def test_tiny_initial_radius_never_exceeds_two_expansion_queries() -> None:
    provider = StubNppesProvider(
        [
            _result(status="EMPTY", query_mode="POSTAL_CODE"),
            _result(status="EMPTY"),
            _result(status="EMPTY"),
        ]
    )
    request = NearbyDiscoveryRequest(
        query=QueryLocationInput(postal_code="60637"),
        top_n=4,
        initial_radius_km=0.001,
        max_radius_km=500,
    )

    result = main._fetch_nppes_candidates(  # noqa: SLF001
        provider=provider,
        resolution=_resolution(),
        request=request,
        candidate_limit=200,
    )

    assert len(provider.calls) == 3  # exact ZIP plus at most two radius stages
    assert provider.calls[-1]["radius_km"] == 500
    assert result.source_status["target_satisfied"] is False


def test_source_expansion_target_respects_lane_and_tag_filters() -> None:
    provider = StubNppesProvider(
        [
            _result("exact-1", "exact-2", "exact-3", query_mode="POSTAL_CODE"),
            _result("nearby-1"),
            _result("nearby-2"),
        ]
    )
    request = NearbyDiscoveryRequest(
        query=QueryLocationInput(postal_code="60637"),
        top_n=2,
        initial_radius_km=10,
        max_radius_km=40,
        filters=NearbyFiltersInput(tags=["not-present-in-fixture"]),
    )

    result = main._fetch_nppes_candidates(  # noqa: SLF001
        provider=provider,
        resolution=_resolution(),
        request=request,
        candidate_limit=200,
    )

    assert len(provider.calls) == 3
    assert result.source_status["candidate_count"] == 5
    assert result.source_status["target_eligible_candidate_count"] == 0
    assert result.source_status["target_satisfied"] is False
