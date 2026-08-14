from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from app.net_worth import NWS_SCALE_VERSION, net_worth_to_nws
from app.net_worth_v4 import (
    CoordinateConsentReceipt,
    NetWorthV4CallerContext,
    NetWorthV4Filters,
    NetWorthV4ProjectionError,
    NetWorthV4Query,
    NetWorthV4Request,
    NetWorthV4Selection,
    project_nearby_net_worth_v4,
)

MODEL_VERSION = "net-worth-v1.0.0"


def _context(
    *,
    model_version: str = MODEL_VERSION,
    authorization_scope: str = "PUBLIC_SAFE",
    requested_data_tier: str = "PUBLIC_SAFE",
) -> NetWorthV4CallerContext:
    return NetWorthV4CallerContext.model_validate_json(
        "{"
        '"project_id":"project-one",'
        '"purpose_id":"NET_WORTH_LOOKUP",'
        f'"authorization_scope":"{authorization_scope}",'
        f'"requested_data_tier":"{requested_data_tier}",'
        '"audit_actor":"service-account@nws",'
        f'"model_version":"{model_version}"'
        "}"
    )


def _request(
    *,
    financial_mode: str = "estimated",
    geography_mode: str = "nearest-count",
    maximum_radius_miles: float | None = None,
    minimum_confidence: str = "C",
    minimum_coverage: float = 0.55,
    asset_families: list[str] | None = None,
    context: NetWorthV4CallerContext | None = None,
) -> NetWorthV4Request:
    return NetWorthV4Request(
        query=NetWorthV4Query(postal_code="98033", country_code="US"),
        selection=NetWorthV4Selection.model_validate_json(
            "{"
            '"count":100,'
            f'"financial_mode":"{financial_mode}",'
            f'"geography_mode":"{geography_mode}"'
            + (
                f',"maximum_radius_miles":{maximum_radius_miles}'
                if maximum_radius_miles is not None
                else ""
            )
            + "}"
        ),
        filters=NetWorthV4Filters.model_validate_json(
            "{"
            f'"minimum_confidence":"{minimum_confidence}",'
            f'"minimum_coverage":{minimum_coverage},'
            f'"asset_families":{asset_families or []!r}'.replace("'", '"')
            + "}"
        ),
        caller_context=context or _context(),
    )


def _component(
    status: str,
    *,
    low: int | None = None,
    middle: int | None = None,
    high: int | None = None,
) -> dict[str, object]:
    return {
        "status": status,
        "low_usd": low,
        "most_likely_usd": middle,
        "high_usd": high,
        "confidence": 0.9 if low is not None else None,
    }


def _result(
    person_id: str,
    *,
    median: int,
    grade: str = "A",
    coverage: float = 0.9,
    public_status: str = "SUPPORTED",
    liability_status: str = "SUPPORTED",
    headline: str = "Founder and Director",
    method: str = "MONTE_CARLO",
    source_url: str = "https://www.sec.gov/Archives/example",
) -> dict[str, object]:
    p10 = round(median * 0.8)
    p90 = round(median * 1.2)
    included = method == "DECLARED_TOTAL_SIMULATION"
    components = {
        "cash_and_near_cash": _component(
            "INCLUDED_IN_DECLARED_TOTAL" if included else "NOT_APPLICABLE"
        ),
        "public_securities": _component(
            "INCLUDED_IN_DECLARED_TOTAL" if included else public_status,
            low=None if included or public_status not in {"SUPPORTED", "MODELED_RANGE"} else p10,
            middle=(
                None if included or public_status not in {"SUPPORTED", "MODELED_RANGE"} else median
            ),
            high=None if included or public_status not in {"SUPPORTED", "MODELED_RANGE"} else p90,
        ),
        "private_business_equity": _component(
            "INCLUDED_IN_DECLARED_TOTAL" if included else "NOT_APPLICABLE"
        ),
        "real_estate_equity": _component(
            "INCLUDED_IN_DECLARED_TOTAL" if included else "NOT_APPLICABLE"
        ),
        "other_assets": _component("INCLUDED_IN_DECLARED_TOTAL" if included else "NOT_APPLICABLE"),
        "liabilities": _component(
            "INCLUDED_IN_DECLARED_TOTAL" if included else liability_status,
            low=None if included or liability_status != "SUPPORTED" else 10_000,
            middle=None if included or liability_status != "SUPPORTED" else 15_000,
            high=None if included or liability_status != "SUPPORTED" else 20_000,
        ),
    }
    return {
        "rank": 1,
        "person": {
            "id": person_id,
            "name": f"Person {person_id}",
            "headline": headline,
            "organization": "Example Corp",
        },
        "profile_status": "VERIFIED" if grade in {"A", "B"} else "PARTIALLY_OBSERVABLE",
        "estimated_net_worth": {
            "status": "AVAILABLE" if grade in {"A", "B"} else "PARTIAL_ESTIMATE",
            "currency": "USD",
            "p10_usd": p10,
            "median_usd": median,
            "p90_usd": p90,
            "method": method,
            "as_of": "2026-08-14",
        },
        "nws": {
            "status": "AVAILABLE",
            "value": net_worth_to_nws(median),
            "scale_version": NWS_SCALE_VERSION,
        },
        "confidence": {"score": coverage, "grade": grade, "coverage": coverage},
        "components": components,
        "liquid_wealth": {
            "status": "UNKNOWN",
            "currency": "USD",
            "p10_usd": None,
            "median_usd": None,
            "p90_usd": None,
        },
        "liquidity_score": None,
        "location_relationship": {
            "label": "Kirkland, Washington",
            "association_kind": "CURRENT_ORGANIZATION_OFFICE",
            "granularity": "CITY",
            "approximate_distance_band": "Within 10 miles",
            "note": "Public association only.",
        },
        "last_financial_update": "2026-08-14",
        "financial_update_precision": "DAY",
        "sources": [
            {
                "publisher": "Public authority",
                "title": "Public financial record",
                "url": source_url,
                "fact_types": ["PUBLIC_FINANCIAL_RECORD"],
                "source_date": "2026-08-14",
                "retrieved_at": "2026-08-14T12:00:00Z",
            }
        ],
    }


def _upstream(
    results: list[dict[str, object]],
    *,
    scope: str = "ASSOCIATION_RADIUS",
) -> dict[str, object]:
    count = len(results)
    for rank, result in enumerate(results, start=1):
        result["rank"] = rank
    return {
        "query": {
            "label": "Kirkland, Washington 98033",
            "mode": "POSTAL_CODE",
            "postal_code": "98033",
            "country_code": "US",
            "approximate": True,
        },
        "coverage": {
            "status": "COVERED",
            "reason_code": "US_ZCTA_RESOLVED",
            "market_label": "Kirkland, Washington",
            "country_code": "US",
            "complete": False,
            "message": "Covered by the national candidate layer.",
        },
        "snapshot": {
            "score_kind": "NET_WORTH_SCORE",
            "scale_version": NWS_SCALE_VERSION,
            "model_version": MODEL_VERSION,
            "complete": False,
            "as_of": "2026-08-14",
            "semantics": "Public financial evidence only.",
        },
        "financial_coverage": {
            "status": "AVAILABLE" if count else "FINANCIAL_COVERAGE_INSUFFICIENT",
            "candidate_count": count,
            "discovered_count": count,
            "evaluated_count": count,
            "unevaluated_count": 0,
            "scored_count": count,
            "insufficient_evidence_count": 0,
        },
        "result_set": {
            "status": "PARTIAL" if count else "EMPTY",
            "requested_count": 100,
            "returned_count": count,
            "shortfall_count": 100 - count,
            "target_satisfied": False,
            "reasons": ["SOURCE_INDEX_PARTIAL"],
        },
        "search": {
            "performed": True,
            "scope": scope,
            "expanded": scope == "ASSOCIATION_RADIUS",
            "expansion_steps_km": [20.0, 35.0, 61.25, 100.0]
            if scope == "ASSOCIATION_RADIUS"
            else [],
            "initial_radius_km": 20.0,
            "effective_radius_km": 100.0 if scope == "ASSOCIATION_RADIUS" else 0.0,
            "maximum_radius_km": 100.0,
            "maximum_radius_reached": scope == "ASSOCIATION_RADIUS",
        },
        "source_status": [
            {
                "source": "NET_WORTH_LEDGER",
                "purpose": "FINANCIAL_EVIDENCE",
                "status": "OK" if count else "EMPTY",
                "as_of": "2026-08-14" if count else None,
                "reason_code": None if count else "NO_ELIGIBLE_FINANCIAL_LEDGER_CONFIGURED",
            }
        ],
        "generated_at": "2026-08-14T12:00:00Z",
        "results": results,
    }


def test_request_requires_exact_count_and_coordinate_consent() -> None:
    with pytest.raises(ValidationError):
        NetWorthV4Selection(count=10)  # type: ignore[arg-type]

    coordinate = NetWorthV4Query(latitude=47.67, longitude=-122.21, country_code="US")
    with pytest.raises(ValidationError, match="consent receipt"):
        NetWorthV4Request(
            query=coordinate,
            selection=NetWorthV4Selection(),
            caller_context=_context(),
        )

    issued = datetime(2026, 8, 14, tzinfo=UTC)
    receipt = CoordinateConsentReceipt(
        receipt_id="receipt-0123456789abcdef",
        purpose_id="NET_WORTH_LOOKUP",
        audit_actor="service-account@nws",
        scope="APPROXIMATE_LOCATION_QUERY",
        issued_at=issued,
        expires_at=issued + timedelta(hours=1),
    )
    request = NetWorthV4Request(
        query=coordinate,
        selection=NetWorthV4Selection(),
        caller_context=_context(),
        coordinate_consent=receipt,
    )
    assert request.query.uses_coordinates is True

    maximum_receipt = CoordinateConsentReceipt(
        receipt_id="nwc1." + ("a" * 507),
        purpose_id="NET_WORTH_LOOKUP",
        audit_actor="service-account@nws",
        scope="APPROXIMATE_LOCATION_QUERY",
        issued_at=issued,
        expires_at=issued + timedelta(hours=1),
    )
    assert len(maximum_receipt.receipt_id) == 512


def test_estimated_allows_qualified_c_but_never_d_or_unqualified_c() -> None:
    upstream = _upstream(
        [
            _result("a", median=100_000_000, grade="A", coverage=0.9),
            _result("b", median=90_000_000, grade="B", coverage=0.75),
            _result("c", median=80_000_000, grade="C", coverage=0.60),
            _result("c-low", median=70_000_000, grade="C", coverage=0.50),
            _result("d", median=200_000_000, grade="D", coverage=0.80),
        ]
    )
    response = project_nearby_net_worth_v4(upstream, _request())

    assert [item.person.id for item in response.results] == ["a", "b", "c"]
    assert {item.confidence.grade for item in response.results} == {"A", "B", "C"}
    assert "CONFIDENCE_FILTER_EXCLUDED_PROFILES" in response.result_set.reasons
    assert "COVERAGE_FILTER_EXCLUDED_PROFILES" in response.result_set.reasons


def test_verified_mode_requires_a_or_b_direct_evidence_and_seventy_percent_coverage() -> None:
    upstream = _upstream(
        [
            _result("a", median=100_000_000, grade="A", coverage=0.9),
            _result("b-low", median=95_000_000, grade="B", coverage=0.65),
            _result("c", median=90_000_000, grade="C", coverage=0.8),
            _result(
                "modeled",
                median=85_000_000,
                grade="A",
                coverage=0.9,
                public_status="MODELED_RANGE",
            ),
        ]
    )
    response = project_nearby_net_worth_v4(
        upstream,
        _request(financial_mode="verified", minimum_coverage=0.0),
    )

    assert [item.person.id for item in response.results] == ["a"]
    assert "VERIFIED_MODE_EXCLUDED_PROFILES" in response.result_set.reasons


def test_observed_only_uses_supported_floor_and_asset_filters() -> None:
    supported = _result("supported", median=1_000_000, public_status="SUPPORTED")
    modeled_liability = _result(
        "modeled-debt",
        median=2_000_000,
        public_status="SUPPORTED",
        liability_status="MODELED_RANGE",
    )
    declared = _result(
        "declared",
        median=3_000_000,
        method="DECLARED_TOTAL_SIMULATION",
    )
    response = project_nearby_net_worth_v4(
        _upstream([supported, modeled_liability, declared]),
        _request(
            financial_mode="observed-only",
            asset_families=["public_securities"],
        ),
    )

    assert [item.person.id for item in response.results] == ["supported"]
    assert response.results[0].observed_net_worth_floor.amount_usd == 780_000
    assert response.results[0].rank_interval.low == response.results[0].rank_interval.high == 1
    assert "OBSERVED_FLOOR_UNAVAILABLE" in response.result_set.reasons
    assert "ASSET_FILTER_EXCLUDED_PROFILES" in response.result_set.reasons


def test_projection_adds_nws_uncertainty_rank_interval_and_source_families() -> None:
    response = project_nearby_net_worth_v4(
        _upstream(
            [
                _result("one", median=100_000_000, source_url="https://www.sec.gov/a"),
                _result("two", median=90_000_000, source_url="https://disclosure.example.gov/b"),
            ]
        ),
        _request(),
    )

    first = response.results[0]
    assert response.request_policy.project_id == "project-one"
    assert response.request_policy.purpose_id == "NET_WORTH_LOOKUP"
    assert response.request_policy.audit_actor_reference.startswith("actor_")
    assert "service-account@nws" not in response.model_dump_json()
    assert first.nws.uncertainty.low <= first.nws.value <= first.nws.uncertainty.high
    assert first.rank_interval.low == 1
    assert first.rank_interval.high == 2
    assert first.rank_interval.population_complete is False
    assert first.source_families == ["sec.gov"]
    assert all("http" not in item for item in first.source_families)


def test_expansion_is_accountable_without_inventing_per_step_counts() -> None:
    response = project_nearby_net_worth_v4(
        _upstream([_result("one", median=10_000_000)]),
        _request(),
    )

    assert response.expansion.status == "PARTIAL"
    assert len(response.expansion.steps) == 4
    assert response.expansion.steps[0].count_status == "UPSTREAM_NOT_REPORTED"
    assert response.expansion.steps[-1].count_status == "AVAILABLE"
    assert response.expansion.steps[-1].financially_eligible_count == 1
    assert response.result_set.shortfall_count == 99
    assert "UPSTREAM_NEAREST_COUNT_EXPANSION_INCOMPLETE" in response.result_set.reasons


def test_strict_radius_rejects_jurisdiction_or_out_of_boundary_upstream_results() -> None:
    request = _request(
        geography_mode="strict-radius",
        maximum_radius_miles=10.0,
    )
    with pytest.raises(NetWorthV4ProjectionError, match="jurisdiction-wide"):
        project_nearby_net_worth_v4(
            _upstream([_result("one", median=10_000_000)], scope="PUBLIC_JURISDICTION"),
            request,
        )
    with pytest.raises(NetWorthV4ProjectionError, match="exceed the strict radius"):
        project_nearby_net_worth_v4(
            _upstream([_result("one", median=10_000_000)]),
            request,
        )


def test_public_projection_excludes_address_like_profiles_and_restricted_tiers() -> None:
    upstream = _upstream(
        [
            _result("safe", median=10_000_000),
            _result("unsafe", median=20_000_000, headline="Office at 123 Main Street"),
        ]
    )
    response = project_nearby_net_worth_v4(upstream, _request())
    dumped = response.model_dump(mode="json")

    assert [item.person.id for item in response.results] == ["safe"]
    assert "PRIVACY_PROJECTION_EXCLUDED_PROFILES" in response.result_set.reasons
    assert "latitude" not in str(dumped).casefold()
    assert "longitude" not in str(dumped).casefold()
    assert "123 main" not in str(dumped).casefold()

    restricted = _context(
        authorization_scope="RESTRICTED_ANALYTICAL",
        requested_data_tier="RESTRICTED_ANALYTICAL",
    )
    with pytest.raises(NetWorthV4ProjectionError, match="public-safe"):
        project_nearby_net_worth_v4(upstream, _request(context=restricted))


def test_projection_rejects_model_or_nws_scale_mismatch() -> None:
    upstream = _upstream([_result("one", median=10_000_000)])
    with pytest.raises(NetWorthV4ProjectionError, match="model_version"):
        project_nearby_net_worth_v4(
            upstream,
            _request(context=_context(model_version="net-worth-v2.0.0")),
        )

    upstream_result = upstream["results"][0]  # type: ignore[index]
    upstream_result["nws"]["scale_version"] = "unknown-scale"  # type: ignore[index]
    with pytest.raises(NetWorthV4ProjectionError, match="unsupported"):
        project_nearby_net_worth_v4(upstream, _request())
