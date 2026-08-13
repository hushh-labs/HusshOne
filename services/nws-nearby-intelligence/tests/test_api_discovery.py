import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import QueryLocationInput, app
from app.security import rate_limiter

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
        "complete": False,
        "model_version": "nws-v2.3.0-kirkland.2026-08-13",
        "verified_at": "2026-08-13",
        "reviewed_at": "2026-08-13",
    }
    assert body["summary"]["verified_seed_candidate_count"] == 60
    assert body["summary"]["reviewed_public_association_candidate_count"] == 60
    assert body["summary"]["returned_count"] == 60
    assert body["coverage"]["status"] == "COVERED"
    assert body["coverage"]["market_id"] == "us-wa-kirkland-public-association"
    assert body["summary"]["search_performed"] is True
    assert body["summary"]["candidate_backend"] == "reviewed-public-association-release"
    assert all(item["score_status"] == "PROVISIONAL" for item in body["results"])
    assert all("distance_km" not in item for item in body["results"])
    assert all(item["sources"] for item in body["results"])
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


def test_nonlegacy_postal_code_requires_country_context() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "10001"}},
    )
    assert response.status_code == 422


def test_unindexed_us_postal_is_a_truthful_non_error_coverage_state() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "10001", "country_code": "US"}},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["coverage"]["status"] == "LOCATION_UNRESOLVED"
    assert body["coverage"]["reason_code"] == "POSTAL_CODE_NOT_IN_GEOGRAPHY_INDEX"
    assert body["results"] == []
    assert body["summary"]["verified_seed_candidate_count"] == 0
    assert body["summary"]["search_performed"] is False
    assert "Kirkland" not in body["query"]["label"]


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
    assert body["coverage"]["reason_code"] == "NO_APPROVED_MARKET_DATA"
    assert body["results"] == []
    assert body["summary"]["verified_seed_candidate_count"] == 0
    assert "Kirkland" not in body["query"]["label"]


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
    assert body["coverage"]["reason_code"] == "COUNTRY_CONTEXT_DOES_NOT_MATCH_APPROVED_MARKET"
    assert body["results"] == []


def test_uncovered_us_coordinate_does_not_fall_back_to_kirkland() -> None:
    client = TestClient(app)
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={
            "query": {"latitude": 40.7128, "longitude": -74.0060, "country_code": "US"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["coverage"]["status"] == "NOT_COVERED"
    assert body["coverage"]["reason_code"] == "NO_APPROVED_MARKET_DATA"
    assert body["results"] == []
    assert "Kirkland" not in body["query"]["label"]


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


def test_health_and_readiness_are_public_but_discovery_is_the_only_business_route() -> None:
    client = TestClient(app)
    assert client.get("/health").status_code == 200
    ready = client.get("/ready")
    assert ready.status_code == 200
    assert ready.json()["candidate_count"] == 60
    preview = client.post("/internal/v2/nearby-network/score-preview", headers=API_HEADERS)
    assert preview.status_code == 404
    assert client.post("/v1/anonymous-affluence/rank", headers=API_HEADERS).status_code == 404
    assert client.get("/docs").status_code == 200


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
