import pytest

from app.coverage import resolve_coordinate_query, resolve_postal_query
from app.postal import get_us_postal_index, normalize_us_postal_code


def test_national_zcta_index_loads_expected_release() -> None:
    index = get_us_postal_index()

    assert len(index) == 33_791
    chicago = index.resolve("60637")
    assert chicago.point.latitude == pytest.approx(41.782504)
    assert chicago.point.longitude == pytest.approx(-87.602734)
    assert chicago.source_vintage == 2025
    assert chicago.source_note == "U.S. Census Bureau 2025 Gazetteer"


def test_us_zip_plus_four_normalizes_to_five_digit_zcta() -> None:
    assert normalize_us_postal_code("60637-1234") == "60637"
    assert get_us_postal_index().resolve("60637-1234") == get_us_postal_index().resolve("60637")
    assert get_us_postal_index().resolve("00601").postal_code == "00601"

    with pytest.raises(ValueError):
        normalize_us_postal_code("606-37")


def test_bare_60637_implies_us_and_routes_to_national_backend() -> None:
    resolution = resolve_postal_query(postal_code="60637", country_code=None)

    assert resolution.is_covered
    assert resolution.point is not None
    assert resolution.point.latitude == pytest.approx(41.782504)
    assert resolution.point.longitude == pytest.approx(-87.602734)
    assert resolution.query["postal_code"] == "60637"
    assert resolution.query["country_code"] == "US"
    assert resolution.query["location_resolution"] == {
        "status": "RESOLVED",
        "method": "CENSUS_ZCTA_INTERNAL_POINT",
        "approximate": True,
        "source": "U.S. Census Bureau 2025 Gazetteer",
        "source_vintage": 2025,
        "representative_point": {
            "latitude": 41.782504,
            "longitude": -87.602734,
        },
    }
    assert resolution.coverage["reason_code"] == "APPROVED_NATIONAL_INDEX"
    assert resolution.coverage["candidate_backend"] == "national-public-association-index"


def test_zip_plus_four_preserves_input_but_searches_base_zcta() -> None:
    resolution = resolve_postal_query(postal_code="60637-1234", country_code="us")

    assert resolution.query["input_postal_code"] == "60637-1234"
    assert resolution.query["postal_code"] == "60637"
    assert resolution.query["country_code"] == "US"
    assert resolution.coverage["candidate_backend"] == "national-public-association-index"


def test_kirkland_keeps_reviewed_release_backend() -> None:
    resolution = resolve_postal_query(postal_code="98033", country_code=None)

    assert resolution.is_covered
    assert resolution.coverage["market_id"] == "us-wa-kirkland-public-association"
    assert resolution.coverage["candidate_backend"] == "reviewed-public-association-release"


def test_non_us_and_unknown_us_postal_codes_never_fall_back() -> None:
    non_us = resolve_postal_query(postal_code="110001", country_code="IN")
    unknown_us = resolve_postal_query(postal_code="00000", country_code="US")

    for resolution in (non_us, unknown_us):
        assert not resolution.is_covered
        assert resolution.point is None
        assert resolution.coverage["status"] == "LOCATION_UNRESOLVED"
        assert resolution.coverage["candidate_backend"] == "none"


def test_explicit_us_coordinate_routes_chicago_to_national_backend() -> None:
    resolution = resolve_coordinate_query(
        latitude=41.782504,
        longitude=-87.602734,
        country_code="us",
        decimals=2,
    )

    assert resolution.is_covered
    assert resolution.point is not None
    assert resolution.point.latitude == pytest.approx(41.78)
    assert resolution.point.longitude == pytest.approx(-87.60)
    assert resolution.coverage["candidate_backend"] == "national-public-association-index"
    assert resolution.query["country_resolution"] == {
        "status": "RESOLVED",
        "country_code": "US",
        "method": "CLIENT_SUPPLIED",
        "approximate": False,
    }


def test_absent_country_is_resolved_by_offline_us_boundary() -> None:
    resolution = resolve_coordinate_query(
        latitude=41.782504,
        longitude=-87.602734,
        country_code=None,
        decimals=2,
    )

    assert resolution.is_covered
    assert resolution.coverage["candidate_backend"] == "national-public-association-index"
    inference = resolution.query["country_resolution"]
    assert inference["status"] == "RESOLVED"
    assert inference["country_code"] == "US"
    assert inference["method"] == "CENSUS_STATE_TERRITORY_BOUNDARY"
    assert inference["approximate"] is True
    assert inference["source_vintage"] == 2025


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [
        (40.7128, -74.0060),  # New York
        (47.6588, -117.4260),  # Spokane (Seattle is intentionally in Kirkland's pilot radius)
        (61.2181, -149.9003),  # Anchorage
        (21.3069, -157.8583),  # Honolulu
        (18.4655, -66.1057),  # San Juan
    ],
)
def test_offline_boundary_routes_states_and_territories_to_national_backend(
    latitude: float, longitude: float
) -> None:
    resolution = resolve_coordinate_query(
        latitude=latitude,
        longitude=longitude,
        country_code=None,
        decimals=2,
    )

    assert resolution.is_covered
    assert resolution.coverage["candidate_backend"] == "national-public-association-index"
    assert resolution.query["country_resolution"]["country_code"] == "US"


def test_coastal_coordinate_uses_only_the_privacy_quantized_cell_for_boundary_lookup() -> None:
    resolution = resolve_coordinate_query(
        latitude=18.4655,
        longitude=-66.1057,
        country_code=None,
        decimals=2,
    )

    assert resolution.is_covered
    assert resolution.query["normalized_coordinate"] == {
        "latitude": 18.47,
        "longitude": -66.11,
    }
    assert resolution.query["country_resolution"]["method"] == (
        "CENSUS_STATE_TERRITORY_BOUNDARY_QUANTIZED_CELL_INTERSECTION"
    )


def test_absent_country_far_from_us_zctas_stays_uncovered() -> None:
    resolution = resolve_coordinate_query(
        latitude=28.6139,
        longitude=77.2090,
        country_code=None,
        decimals=2,
    )

    assert not resolution.is_covered
    assert resolution.point is None
    assert resolution.coverage["status"] == "NOT_COVERED"
    assert resolution.coverage["reason_code"] == "COUNTRY_CONTEXT_UNRESOLVED"
    assert resolution.query["country_resolution"]["status"] == "UNRESOLVED"


def test_client_us_hint_cannot_override_non_us_coordinate() -> None:
    resolution = resolve_coordinate_query(
        latitude=49.2827,
        longitude=-123.1207,
        country_code="US",
        decimals=2,
    )

    assert not resolution.is_covered
    assert resolution.coverage["reason_code"] == "COORDINATE_OUTSIDE_US_BOUNDARY"
    assert resolution.query["country_resolution"]["status"] == "MISMATCH"


def test_explicit_non_us_coordinate_stays_uncovered_even_near_a_us_zcta() -> None:
    resolution = resolve_coordinate_query(
        latitude=41.782504,
        longitude=-87.602734,
        country_code="IN",
        decimals=2,
    )

    assert not resolution.is_covered
    assert resolution.point is None
    assert resolution.coverage["status"] == "NOT_COVERED"
    assert resolution.coverage["reason_code"] == "COUNTRY_NOT_IN_NATIONAL_INDEX"
    assert resolution.coverage["candidate_backend"] == "none"
