"""The score has to be able to explain itself.

Every response carried a number and four sentences of prose. The seven
components behind the number were computed on every request and thrown away, so
a reader could not tell a genuinely strong profile from a merely well-sourced
one, and had no way to check the arithmetic.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.bootstrap_data import BOOTSTRAP_CANDIDATES
from app.geospatial import GeoPoint
from app.main import app
from app.nws import COMPONENT_LABELS, GLOBAL_NWS_WEIGHTS, score_candidate
from app.security import rate_limiter

API_HEADERS = {"X-NWS-API-Key": "local-development-only"}


def setup_function() -> None:
    # The limiter is in-process and shared across the suite, so a test that runs
    # after a chatty one would otherwise fail on 429 rather than on its subject.
    rate_limiter._events.clear()  # noqa: SLF001 - test reset for the in-process limiter


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def _first(client: TestClient) -> dict:
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "98033"}},
    )
    assert response.status_code == 200
    return response.json()["results"][0]


def test_weights_sum_to_one() -> None:
    """A weighting that does not sum to 1 makes every published contribution a lie."""
    assert sum(GLOBAL_NWS_WEIGHTS.values()) == pytest.approx(1.0)


def test_every_component_has_a_weight_and_a_label() -> None:
    """A component with no weight would be silently dropped from the explanation."""
    names = set(
        score_candidate(
            BOOTSTRAP_CANDIDATES[0],
            query_point=GeoPoint(latitude=47.67, longitude=-122.21),
            radius_km=20.0,
        )
        .components.as_dict()
        .keys()
    )
    assert names == set(GLOBAL_NWS_WEIGHTS)
    assert names == set(COMPONENT_LABELS)


def test_breakdown_is_published_with_every_result(client: TestClient) -> None:
    breakdown = _first(client)["score_breakdown"]

    assert len(breakdown["components"]) == len(GLOBAL_NWS_WEIGHTS)
    for component in breakdown["components"]:
        assert 0.0 <= component["value"] <= 1.0
        assert component["weight"] == GLOBAL_NWS_WEIGHTS[component["key"]]
        assert component["contribution"] == pytest.approx(
            component["weight"] * component["value"], abs=1e-4
        )
        assert component["label"]


def test_components_are_ordered_by_influence(client: TestClient) -> None:
    """Heaviest first, so the first line read is the one that moved the score most."""
    weights = [c["weight"] for c in _first(client)["score_breakdown"]["components"]]
    assert weights == sorted(weights, reverse=True)


def test_the_published_multipliers_explain_the_gap_to_the_final_score(
    client: TestClient,
) -> None:
    """The weighted sum alone does not reproduce the score, and must not appear to.

    Coverage scales it up toward 1.0 and the integrity penalty pulls it down, so
    both travel with the components. Without them the arithmetic looks wrong.
    """
    record = _first(client)
    breakdown = record["score_breakdown"]
    subtotal = sum(c["contribution"] for c in breakdown["components"])

    assert 0.0 <= subtotal <= 1.0
    assert 0.78 <= breakdown["coverage_multiplier"] <= 1.0
    assert 0.0 <= breakdown["integrity_penalty"] <= 0.30
    assert breakdown["evidence_count"] >= 0

    # The score sits within the band those multipliers permit. The balance term
    # is deliberately not published — it is a guard against one-dimensional
    # profiles, not a component a reader is meant to reason about.
    ceiling = 100.0 * subtotal * breakdown["coverage_multiplier"]
    assert record["global_nws"] <= ceiling * 1.15
    assert record["global_nws"] > 0


def test_local_relevance_explains_the_nearby_rank(client: TestClient) -> None:
    """The list is ordered by nearby rank, so its 10% local term must be visible."""
    record = _first(client)
    local = record["score_breakdown"]["local_relevance"]

    assert 0.0 <= local <= 1.0
    assert record["nearby_rank_score"] == pytest.approx(
        0.90 * record["global_nws"] + 0.10 * (100.0 * local), abs=0.01
    )


def test_breakdown_carries_no_private_or_precise_location_data(client: TestClient) -> None:
    """This block is public-safe or it does not ship."""
    breakdown = _first(client)["score_breakdown"]
    serialized = repr(breakdown)

    for leak in ("latitude", "longitude", "address", "email", "phone", "residence"):
        assert leak not in serialized.lower()


def test_an_uncovered_market_publishes_no_breakdown(client: TestClient) -> None:
    """No people, no scores, nothing to explain."""
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"latitude": 28.6139, "longitude": 77.209, "country_code": "IN"}},
    )
    payload = response.json()

    assert payload["coverage"]["status"] == "NOT_COVERED"
    assert payload["results"] == []


def test_method_sentence_is_present_and_mentions_the_adjustments(client: TestClient) -> None:
    method = _first(client)["score_breakdown"]["method"].lower()

    assert "weight" in method
    assert "coverage" in method
    assert "10%" in method or "nearby rank" in method


def test_publishing_the_breakdown_did_not_move_any_score(client: TestClient) -> None:
    """Refactoring the weighted sum onto a table must not re-score anyone.

    These are every production value for the approved market, read from the live
    service before the change rather than transcribed from a rounded display.
    If a re-weighting is ever intended, this is where it has to be acknowledged.
    """
    expected = {
        "bootstrap_amy_morrison": 74.0106,
        "bootstrap_bryan_mistele": 79.5482,
        "bootstrap_eben_frankenberg": 77.9906,
        "bootstrap_ettore_palazzo": 72.5392,
        "bootstrap_harold_zeitz": 77.2119,
        "bootstrap_kelli_curtis": 72.5637,
        "bootstrap_kurt_triplett": 74.1618,
        "bootstrap_michael_hsing": 83.4022,
        "bootstrap_neal_black": 66.9703,
        "bootstrap_neville_meijers": 78.6279,
        "bootstrap_yun_zhang": 69.3951,
    }
    response = client.post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "98033"}, "top_n": 400},
    )
    actual = {r["person_id"]: r["global_nws"] for r in response.json()["results"]}

    for person_id, score in expected.items():
        assert actual[person_id] == pytest.approx(score, abs=1e-3), person_id
