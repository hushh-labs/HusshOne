import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.main as main
from app.bootstrap_data import BOOTSTRAP_CANDIDATES, BOOTSTRAP_METADATA
from app.main import NearbyDiscoveryRequest, NearbyFiltersInput, QueryLocationInput, app
from app.nws_models import GeoPoint, NearbyDiscoverySummary
from app.security import rate_limiter
from app.settings import get_settings

API_HEADERS = {"X-NWS-API-Key": "local-development-only"}


def setup_function() -> None:
    rate_limiter._events.clear()  # noqa: SLF001 - test reset for the in-process limiter


def test_public_discovery_requires_an_api_key() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        json={"query": {"postal_code": "98033"}},
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "API_KEY_REQUIRED"


def test_market_release_discovery_returns_reviewed_public_association_records() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={
            "query": {"postal_code": "98033"},
            "top_n": 100,
            "initial_radius_km": 20,
            "max_radius_km": 100,
            "filters": {"minimum_confidence_grade": "B"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["snapshot"] == {
        "data_mode": "REVIEWED_PUBLIC_ASSOCIATION_RELEASE",
        "score_status": "PROVISIONAL",
        "score_kind": "PROFESSIONAL_NETWORK_PROVISIONAL",
        "complete": False,
        "model_version": "nws-v2.3.0-kirkland.2026-08-13",
        "verified_at": "2026-08-13",
        "reviewed_at": "2026-08-13",
        "semantics": (
            "Immutable reviewed Kirkland public-association release; not live physical "
            "tracking or a residence claim."
        ),
    }
    assert body["summary"]["verified_seed_candidate_count"] == 60
    assert body["summary"]["reviewed_public_association_candidate_count"] == 60
    assert body["summary"]["returned_count"] == 60
    assert body["coverage"]["status"] == "COVERED"
    assert body["coverage"]["market_id"] == "us-wa-kirkland-public-association"
    assert body["summary"]["search_performed"] is True
    assert body["summary"]["candidate_backend"] == "reviewed-public-association-release"
    assert body["result_set"]["status"] == "PARTIAL"
    assert body["result_set"]["shortfall_count"] == 40
    assert body["result_set"]["target_satisfied"] is False
    assert body["source_health"]["status"] == "NOT_QUERIED"
    assert body["source_health"]["mode"] == "REVIEWED_RELEASE"
    assert body["search"]["performed"] is True
    assert sum(band["count"] for band in body["search"]["returned_by_distance_band"]) == 60
    assert body["discovery"]["mode"] == "ORGANIZATION_ANCHOR_REVIEW_PIPELINE_O1"
    assert body["discovery"]["organization_anchor_count"] == 13
    assert body["discovery"]["market_census_complete"] is False
    assert body["discovery"]["automatic_candidate_publication"] is False
    assert body["financial_context"]["status"] == "NOT_PROFILED"
    assert body["financial_context"]["personal_financial_strength"] == "NOT_PROVIDED"
    assert all(item["score_status"] == "PROVISIONAL" for item in body["results"])
    assert all(item["score_kind"] == "PROFESSIONAL_NETWORK_PROVISIONAL" for item in body["results"])
    assert all(item["financial_evidence"]["status"] == "NOT_PROFILED" for item in body["results"])
    assert all(item["financial_evidence"]["used_for_ranking"] is False for item in body["results"])
    assert all(item["freshness"]["association_as_of"] for item in body["results"])
    assert all("distance_km" not in item for item in body["results"])
    assert all(item["sources"] for item in body["results"])
    assert all(item["public_association_context"]["category"] for item in body["results"])
    assert all("financial_strength" not in item for item in body["results"])
    assert body["release"]["release_id"] == "us-wa-kirkland-public-association-2026-08-13"
    assert len(body["release"]["candidate_set_sha256"]) == 64


def test_corrected_kirkland_coordinate_is_coarsened_and_covered() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={
            "query": {"latitude": 47.6715, "longitude": -122.2133, "country_code": "us"},
            "top_n": 100,
            "max_radius_km": 50,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query"]["normalized_coordinate"] == {
        "latitude": 47.67,
        "longitude": -122.21,
    }
    assert body["coverage"]["status"] == "COVERED"
    assert body["summary"]["returned_count"] == 60


def test_legacy_and_explicit_us_kirkland_postal_requests_are_compatible() -> None:
    client = TestClient(app)
    legacy = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "98033"}},
    )
    explicit_us = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "98033", "country_code": "us"}},
    )
    assert legacy.status_code == explicit_us.status_code == 200
    assert legacy.json()["coverage"] == explicit_us.json()["coverage"]
    assert legacy.json()["query"] == explicit_us.json()["query"]


def test_bare_us_postal_code_is_accepted_as_us() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "10001"}},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "NATIONAL_CANDIDATE_BACKEND_UNAVAILABLE"


def test_national_us_postal_uses_the_national_backend() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "10001", "country_code": "US"}},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "NATIONAL_CANDIDATE_BACKEND_UNAVAILABLE"


def test_successful_national_route_exposes_consistent_safe_contract(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    original = BOOTSTRAP_CANDIDATES[0]
    candidate = replace(
        original,
        person_id="nppes:1234567890",
        location=replace(
            original.location,
            label="New York, NY 10001 public practice area",
            point=GeoPoint(40.75, -73.99),
        ),
    )
    metadata = replace(
        BOOTSTRAP_METADATA[original.person_id],
        score_status="PROVISIONAL",
        review_flags=("SOURCE_VERIFIED_PROVISIONAL", "NO_FINANCIAL_INPUTS"),
    )
    batch = main.NationalCandidateBatch(
        candidates=(candidate,),
        metadata={candidate.person_id: metadata},
        source_status=(
            {
                "source": "CMS_NPPES",
                "status": "OK",
                "candidate_count": 1,
                "query_mode": "POSTAL_CODE",
                "score_status": "PROVISIONAL",
            },
        ),
    )
    monkeypatch.setattr(
        main,
        "get_settings",
        lambda: replace(get_settings(), national_sources_enabled=True),
    )
    monkeypatch.setattr(main, "_fetch_national_candidates", lambda **_: batch)

    response = TestClient(app).post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "10001"}, "top_n": 1},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["coverage"]["data_mode"] == "NATIONAL_PUBLIC_PROFESSIONAL_SNAPSHOT"
    assert body["snapshot"]["data_mode"] == "NATIONAL_PUBLIC_PROFESSIONAL_SNAPSHOT"
    assert body["snapshot"]["policy_reviewed_at"] == "2026-08-14"
    assert body["snapshot"]["score_kind"] == "PROFESSIONAL_NETWORK_PROVISIONAL"
    assert "reviewed_at" not in body["snapshot"]
    assert body["source_status"][0]["status"] == "OK"
    assert body["summary"]["public_registry_candidate_count"] == 1
    assert body["summary"]["returned_count"] == 1
    assert body["result_set"] == {
        "status": "TARGET_MET",
        "requested_count": 1,
        "returned_count": 1,
        "shortfall_count": 0,
        "target_satisfied": True,
        "reasons": [],
    }
    assert body["source_health"]["status"] == "HEALTHY"
    assert body["source_health"]["successful_sources"] == ["CMS_NPPES"]
    assert body["search"]["performed"] is True
    assert body["search"]["expansion_steps_km"]
    assert sum(band["count"] for band in body["search"]["returned_by_distance_band"]) == 1
    assert body["results"][0]["model_version"] == ("nws-v3.0.0-us-public-professional.2026-08-14")
    assert body["results"][0]["score_kind"] == "PROFESSIONAL_NETWORK_PROVISIONAL"
    assert body["results"][0]["financial_evidence"] == {
        "status": "NOT_PROFILED",
        "personal_financial_strength": "NOT_PROVIDED",
        "used_for_ranking": False,
    }
    assert body["results"][0]["freshness"]["status"] in {
        "CURRENT_AS_PUBLISHED",
        "REVALIDATION_REQUIRED",
    }
    serialized_result = json.dumps(body["results"][0]).casefold()
    for forbidden in (
        "street_address",
        "phone",
        "email",
        "marketvalue",
        "disclosedvalue",
        '"latitude"',
        '"longitude"',
    ):
        assert forbidden not in serialized_result


def test_india_coordinate_returns_not_covered_without_kirkland_people() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={
            "query": {"latitude": 28.6139, "longitude": 77.2090, "country_code": "IN"},
            "top_n": 100,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["coverage"]["status"] == "NOT_COVERED"
    assert body["coverage"]["reason_code"] == "COUNTRY_NOT_IN_NATIONAL_INDEX"
    assert body["results"] == []
    assert body["summary"]["verified_seed_candidate_count"] == 0
    assert body["result_set"]["status"] == "NOT_SEARCHED"
    assert body["result_set"]["reasons"] == ["COUNTRY_NOT_IN_NATIONAL_INDEX"]
    assert body["search"]["performed"] is False
    assert body["source_health"]["status"] == "NOT_QUERIED"
    assert "Kirkland" not in body["query"]["label"]
    assert body["snapshot"]["data_mode"] == "NATIONAL_PUBLIC_PROFESSIONAL_SNAPSHOT"
    assert body["release"]["market_id"] == "us-national-public-association"
    assert body["discovery"]["mode"] == "AUTHORITATIVE_PUBLIC_REGISTRY_FANOUT"
    assert "kirkland" not in json.dumps(body).casefold()


def test_india_postal_is_accepted_but_not_mapped_to_a_fake_market() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "110001", "country_code": "IN"}},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["coverage"]["status"] == "LOCATION_UNRESOLVED"
    assert body["results"] == []
    assert body["summary"]["returned_count"] == 0
    assert "Kirkland" not in body["query"]["label"]
    assert body["snapshot"]["data_mode"] == "NATIONAL_PUBLIC_PROFESSIONAL_SNAPSHOT"
    assert body["release"]["market_id"] == "us-national-public-association"
    assert body["discovery"]["mode"] == "AUTHORITATIVE_PUBLIC_REGISTRY_FANOUT"
    assert "kirkland" not in json.dumps(body).casefold()


def test_country_context_mismatch_with_kirkland_coordinate_never_returns_people() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={
            "query": {"latitude": 47.6715, "longitude": -122.2133, "country_code": "IN"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["coverage"]["status"] == "NOT_COVERED"
    assert body["coverage"]["reason_code"] == "COUNTRY_NOT_IN_NATIONAL_INDEX"
    assert body["results"] == []


def test_us_coordinate_routes_to_national_backend_without_kirkland_fallback() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={
            "query": {"latitude": 40.7128, "longitude": -74.0060, "country_code": "US"},
        },
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "NATIONAL_CANDIDATE_BACKEND_UNAVAILABLE"


def test_invalid_location_forms_remain_validation_errors() -> None:
    client = TestClient(app)
    for query in (
        {"latitude": 47.6715},
        {"latitude": 47.6715, "longitude": -122.2133, "postal_code": "98033"},
        {"postal_code": "110001"},
        {"postal_code": "110001", "country_code": "IND"},
    ):
        response = client.post(
            "/v2/nearby-network/discover",
            headers=API_HEADERS,
            json={"query": query},
        )
        assert response.status_code == 422

    with pytest.raises(ValidationError):
        QueryLocationInput(latitude=float("nan"), longitude=77.2090)


@pytest.mark.parametrize(
    "payload",
    [
        {"query": {"postal_code": "98033"}, "top_n": "60"},
        {"query": {"postal_code": "98033"}, "initial_radius_km": "20"},
        {"query": {"postal_code": "98033"}, "auto_expand": "true"},
        {
            "query": {
                "latitude": "47.6715",
                "longitude": -122.2133,
                "country_code": "US",
            }
        },
    ],
)
def test_legacy_v2_keeps_scalar_coercion_contract(payload: dict[str, object]) -> None:
    response = TestClient(app).post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json=payload,
    )

    assert response.status_code == 200


@pytest.mark.parametrize(
    "query",
    [
        {"postal_code": "980-33"},
        {"postal_code": "980-33", "country_code": "US"},
    ],
)
def test_malformed_us_postal_code_is_rejected(query: dict[str, str]) -> None:
    response = TestClient(app).post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": query},
    )

    assert response.status_code == 422


def test_canonical_but_absent_us_postal_code_is_location_unresolved() -> None:
    response = TestClient(app).post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "00000", "country_code": "US"}},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["coverage"]["status"] == "LOCATION_UNRESOLVED"
    assert body["result_set"]["status"] == "NOT_SEARCHED"
    assert body["results"] == []


def test_filter_tags_are_normalized_deduplicated_and_cannot_be_empty() -> None:
    filters = NearbyFiltersInput(
        tags=[" Healthcare   Leader ", "HEALTHCARE LEADER", "Founder"],
    )
    assert filters.tags == ["healthcare leader", "founder"]

    with pytest.raises(ValidationError):
        NearbyFiltersInput(tags=["   "])


def test_aggregate_source_health_marks_partial_stale_and_unavailable_sources_degraded() -> None:
    health = main._aggregate_source_health(  # noqa: SLF001
        (
            {"source": "CMS_NPPES", "status": "OK", "degraded": True},
            {
                "source": "SEC_SECTION16",
                "status": "OK",
                "index_partial": True,
                "index_stale": True,
            },
            {"source": "FUTURE_SOURCE", "status": "UNAVAILABLE"},
        ),
        mode="LIVE_PUBLIC_SOURCE_SNAPSHOTS",
    )

    assert health["status"] == "DEGRADED"
    assert health["unavailable_sources"] == ["FUTURE_SOURCE"]
    assert health["partial_sources"] == ["SEC_SECTION16"]
    assert health["stale_sources"] == ["SEC_SECTION16"]
    assert health["reasons"] == [
        "SOURCE_UNAVAILABLE",
        "SOURCE_INDEX_PARTIAL",
        "SOURCE_INDEX_STALE",
        "SOURCE_STAGE_DEGRADED",
    ]


def test_partial_result_set_explains_source_degradation_and_shortfall() -> None:
    request = NearbyDiscoveryRequest(
        query=QueryLocationInput(postal_code="60637"),
        top_n=2,
        initial_radius_km=20,
        max_radius_km=100,
    )
    summary = NearbyDiscoverySummary(
        query_radius_km=20,
        effective_radius_km=100,
        candidate_pool_size=1,
        eligible_candidate_count=1,
        confidence_eligible_candidate_count=1,
        returned_count=1,
        expansion_steps=(20, 35, 61.25, 100),
        diversity_applied=True,
    )
    source_status = (
        {"source": "CMS_NPPES", "status": "OK", "target_satisfied": False},
        {"source": "SEC_SECTION16", "status": "UNAVAILABLE"},
    )
    health = main._aggregate_source_health(  # noqa: SLF001
        source_status,
        mode="LIVE_PUBLIC_SOURCE_SNAPSHOTS",
    )

    result_set = main._result_set_accountability(  # noqa: SLF001
        request=request,
        summary=summary,
        source_candidate_count=1,
        filtered_candidate_count=1,
        backend="national-public-association-index",
        source_status=source_status,
        source_health=health,
    )

    assert result_set == {
        "status": "PARTIAL",
        "requested_count": 2,
        "returned_count": 1,
        "shortfall_count": 1,
        "target_satisfied": False,
        "reasons": [
            "SOURCE_DEGRADED",
            "MAX_RADIUS_REACHED",
            "SOURCE_TARGET_NOT_MET",
            "SOURCE_SPARSE",
        ],
    }


def test_health_and_readiness_are_public_but_discovery_is_the_only_business_route() -> None:
    client = TestClient(app)
    assert client.get("/health").status_code == 200
    ready = client.get("/ready")
    assert ready.status_code == 200
    assert ready.json()["candidate_count"] == 60
    assert ready.json()["geography_record_count"] == 33_791
    assert ready.json()["public_jurisdiction_record_count"] == 33_791
    assert ready.json()["net_worth_model_version"] == "net-worth-v1.0.0"
    assert ready.json()["nws_scale_version"] == "nws-fixed-us-log-v1.0.0"
    preview = client.post("/internal/v2/nearby-network/score-preview", headers=API_HEADERS)
    assert preview.status_code == 404
    assert client.post("/v1/anonymous-affluence/rank", headers=API_HEADERS).status_code == 404
    assert client.get("/docs").status_code == 200
    assert client.get("/").status_code == 404
    assert client.post("/").status_code == 404


def test_cors_preflight_is_open_for_non_cookie_cross_project_clients() -> None:
    client = TestClient(app)
    response = client.options(
        "/v2/nearby-network/discover",
        headers={
            "Origin": "https://another-project.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "X-NWS-API-Key, Content-Type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in response.headers
