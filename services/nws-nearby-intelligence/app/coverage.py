from __future__ import annotations

from dataclasses import dataclass

from app.geospatial import haversine_km, quantize_location
from app.nws_models import GeoPoint
from app.postal import get_us_postal_index, normalize_us_postal_code
from app.us_boundary import get_us_boundary_index

_MARKET_RELEASE_DATA_MODE = "REVIEWED_PUBLIC_ASSOCIATION_RELEASE"
_NATIONAL_DATA_MODE = "NATIONAL_PUBLIC_PROFESSIONAL_SNAPSHOT"
_KIRKLAND_COVERAGE_RADIUS_KM = 35.0
_KIRKLAND_MARKET_ID = "us-wa-kirkland-public-association"
_KIRKLAND_MARKET_LABEL = "Kirkland public-association market"
_KIRKLAND_CANDIDATE_BACKEND = "reviewed-public-association-release"
_US_NATIONAL_MARKET_ID = "us-national-public-association"
_US_NATIONAL_MARKET_LABEL = "United States national public-association index"
_US_NATIONAL_CANDIDATE_BACKEND = "national-public-association-index"


@dataclass(frozen=True)
class QueryResolution:
    """A request location paired with explicit people-index coverage."""

    point: GeoPoint | None
    query: dict[str, object]
    coverage: dict[str, object]

    @property
    def is_covered(self) -> bool:
        return self.coverage["status"] == "COVERED"


def resolve_postal_query(*, postal_code: str, country_code: str | None) -> QueryResolution:
    """Resolve US postal geography independently from the selected people backend."""

    normalized_country = country_code.strip().upper() if country_code else None
    normalized_postal: str | None = None
    if normalized_country in {None, "US"}:
        try:
            normalized_postal = normalize_us_postal_code(postal_code)
        except ValueError:
            normalized_postal = None

    # A bare, syntactically valid five-digit ZIP or ZIP+4 means US. Other
    # countries remain explicit and are never mapped into the US index.
    if normalized_country is None and normalized_postal is not None:
        normalized_country = "US"

    if normalized_country != "US" or normalized_postal is None:
        return _unresolved_postal(
            postal_code=postal_code,
            country_code=normalized_country,
        )

    try:
        record = get_us_postal_index().resolve(normalized_postal)
    except KeyError:
        return _unresolved_postal(
            postal_code=normalized_postal,
            country_code="US",
        )

    query: dict[str, object] = {
        "label": record.label,
        "mode": "POSTAL_CODE",
        "postal_code": record.postal_code,
        "country_code": "US",
        "source_note": (
            "The postal code resolves to an approximate Census ZCTA internal point; "
            "it is not a residence or rooftop coordinate."
        ),
        "location_resolution": {
            "status": "RESOLVED",
            "method": "CENSUS_ZCTA_INTERNAL_POINT",
            "approximate": True,
            "source": record.source_note,
            "source_vintage": record.source_vintage,
            "representative_point": {
                "latitude": record.point.latitude,
                "longitude": record.point.longitude,
            },
        },
    }
    if postal_code.strip() != record.postal_code:
        query["input_postal_code"] = postal_code.strip()

    if record.postal_code == "98033":
        query["label"] = "Kirkland, Washington 98033 query area"
        return QueryResolution(
            point=record.point,
            query=query,
            coverage=_covered_kirkland_release(),
        )

    return QueryResolution(
        point=record.point,
        query=query,
        coverage=_covered_national_index(),
    )


def resolve_coordinate_query(
    *,
    latitude: float,
    longitude: float,
    country_code: str | None,
    decimals: int,
) -> QueryResolution:
    """Coarsen a device coordinate, then select Kirkland or the national backend.

    Country context is checked against the bundled Census state/territory boundary.
    With no country context the boundary provides an offline US determination; a
    client hint never overrides conflicting geography.
    """

    coarse = quantize_location(GeoPoint(latitude, longitude), decimals=decimals)
    normalized_country = country_code.strip().upper() if country_code else None
    query: dict[str, object] = {
        "label": "Coarsened coordinate query area",
        "mode": "COARSE_COORDINATE",
        "normalized_coordinate": {
            "latitude": coarse.latitude,
            "longitude": coarse.longitude,
        },
        "source_note": "The supplied coordinate was coarsened before retrieval and is not logged.",
    }

    boundary = get_us_boundary_index()
    center_inside_us = boundary.contains(coarse)
    inside_us = center_inside_us or boundary.intersects_quantized_cell(coarse, decimals=decimals)
    boundary_method = (
        "CENSUS_STATE_TERRITORY_BOUNDARY"
        if center_inside_us
        else "CENSUS_STATE_TERRITORY_BOUNDARY_QUANTIZED_CELL_INTERSECTION"
    )
    if normalized_country is not None:
        query["country_code_hint"] = normalized_country
        query["country_resolution"] = {
            "status": "RESOLVED",
            "country_code": normalized_country,
            "method": "CLIENT_SUPPLIED",
            "approximate": False,
        }
        if normalized_country != "US":
            return QueryResolution(
                point=None,
                query=query,
                coverage=_not_covered_country(normalized_country),
            )
        if not inside_us:
            query["country_resolution"] = {
                "status": "MISMATCH",
                "country_code": "US",
                "method": "CLIENT_SUPPLIED_CHECKED_AGAINST_CENSUS_BOUNDARY",
                "approximate": True,
                "source": "U.S. Census Bureau 2025 cartographic state boundaries",
                "source_vintage": 2025,
            }
            return QueryResolution(
                point=None,
                query=query,
                coverage=_not_covered_outside_us_boundary(),
            )
    else:
        if not inside_us:
            query["country_resolution"] = {
                "status": "UNRESOLVED",
                "method": "CENSUS_STATE_TERRITORY_BOUNDARY",
                "approximate": True,
                "source": "U.S. Census Bureau 2025 cartographic state boundaries",
                "source_vintage": 2025,
            }
            return QueryResolution(
                point=None,
                query=query,
                coverage=_not_covered_unresolved_country(),
            )
        normalized_country = "US"
        query["country_resolution"] = {
            "status": "RESOLVED",
            "country_code": "US",
            "method": boundary_method,
            "approximate": True,
            "source": "U.S. Census Bureau 2025 cartographic state boundaries",
            "source_vintage": 2025,
        }

    kirkland_point = get_us_postal_index().resolve("98033").point
    if haversine_km(coarse, kirkland_point) <= _KIRKLAND_COVERAGE_RADIUS_KM:
        query["label"] = "Kirkland public-association market query area"
        return QueryResolution(
            point=coarse,
            query=query,
            coverage=_covered_kirkland_release(),
        )

    query["label"] = "United States national public-association query area"
    return QueryResolution(
        point=coarse,
        query=query,
        coverage=_covered_national_index(),
    )


def _unresolved_postal(*, postal_code: str, country_code: str | None) -> QueryResolution:
    return QueryResolution(
        point=None,
        query={
            "label": "Postal-code query area",
            "mode": "POSTAL_CODE",
            "postal_code": postal_code,
            "country_code": country_code,
            "source_note": (
                "No canonical postal geography was selected. This request is not mapped to a "
                "fallback country, market, or guessed coordinate."
            ),
            "location_resolution": {
                "status": "UNRESOLVED",
                "method": "POSTAL_GEOGRAPHY_INDEX",
                "approximate": False,
            },
        },
        coverage={
            "status": "LOCATION_UNRESOLVED",
            "reason_code": "POSTAL_CODE_NOT_IN_GEOGRAPHY_INDEX",
            "country_code": country_code,
            "complete": False,
            "data_mode": _NATIONAL_DATA_MODE,
            "candidate_backend": "none",
            "message": (
                "The postal code was accepted, but this release has no canonical postal "
                "geography for it. Send an approximate coordinate with country context."
            ),
        },
    )


def _not_covered_country(country_code: str) -> dict[str, object]:
    return {
        "status": "NOT_COVERED",
        "reason_code": "COUNTRY_NOT_IN_NATIONAL_INDEX",
        "country_code": country_code,
        "complete": False,
        "data_mode": _NATIONAL_DATA_MODE,
        "candidate_backend": "none",
        "message": (
            "The coordinate was accepted, but the current national people index is US-only. "
            "No people were selected."
        ),
    }


def _not_covered_unresolved_country() -> dict[str, object]:
    return {
        "status": "NOT_COVERED",
        "reason_code": "COUNTRY_CONTEXT_UNRESOLVED",
        "country_code": None,
        "complete": False,
        "data_mode": _NATIONAL_DATA_MODE,
        "candidate_backend": "none",
        "message": (
            "No country was supplied and the coarsened coordinate is outside the Census US "
            "state/territory boundary. No people were selected."
        ),
    }


def _not_covered_outside_us_boundary() -> dict[str, object]:
    return {
        "status": "NOT_COVERED",
        "reason_code": "COORDINATE_OUTSIDE_US_BOUNDARY",
        "country_code": "US",
        "complete": False,
        "data_mode": _NATIONAL_DATA_MODE,
        "candidate_backend": "none",
        "message": (
            "The client supplied US context, but the coarsened coordinate is outside the "
            "Census US state/territory boundary. No people were selected."
        ),
    }


def _covered_kirkland_release() -> dict[str, object]:
    return {
        "status": "COVERED",
        "reason_code": "APPROVED_MARKET_RELEASE",
        "market_id": _KIRKLAND_MARKET_ID,
        "market_label": _KIRKLAND_MARKET_LABEL,
        "country_code": "US",
        "complete": False,
        "data_mode": _MARKET_RELEASE_DATA_MODE,
        "candidate_backend": _KIRKLAND_CANDIDATE_BACKEND,
        "message": (
            "Results use the reviewed Kirkland public-association release for this query area."
        ),
    }


def _covered_national_index() -> dict[str, object]:
    return {
        "status": "COVERED",
        "reason_code": "APPROVED_NATIONAL_INDEX",
        "market_id": _US_NATIONAL_MARKET_ID,
        "market_label": _US_NATIONAL_MARKET_LABEL,
        "country_code": "US",
        "complete": False,
        "data_mode": _NATIONAL_DATA_MODE,
        "candidate_backend": _US_NATIONAL_CANDIDATE_BACKEND,
        "message": (
            "The location is resolved for the US national public-professional candidate index. "
            "Result count depends on policy-validated public registry associations within the "
            "requested radius."
        ),
    }
