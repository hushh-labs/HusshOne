from __future__ import annotations

from dataclasses import dataclass

from app.geospatial import haversine_km, quantize_location
from app.nws_models import GeoPoint

_BOOTSTRAP_DATA_MODE = "VERIFIED_PUBLIC_BOOTSTRAP"
_KIRKLAND_POSTAL_CENTROID = GeoPoint(47.6720, -122.1910)
_KIRKLAND_COVERAGE_RADIUS_KM = 35.0
_KIRKLAND_MARKET_ID = "us-wa-kirkland-bootstrap"
_KIRKLAND_MARKET_LABEL = "Kirkland public-association bootstrap"


@dataclass(frozen=True)
class QueryResolution:
    """A request location paired with explicit coverage—not inferred person proximity."""

    point: GeoPoint | None
    query: dict[str, object]
    coverage: dict[str, object]

    @property
    def is_covered(self) -> bool:
        return self.coverage["status"] == "COVERED"


def resolve_postal_query(
    *, postal_code: str, country_code: str | None
) -> QueryResolution:
    """Resolve only postal geography that is explicitly loaded for this release.

    A syntactically valid international postal code is accepted at the API boundary, but it must
    not be turned into a guessed centroid or a Kirkland result when canonical geography is absent.
    """

    if postal_code == "98033" and country_code in {None, "US"}:
        return QueryResolution(
            point=_KIRKLAND_POSTAL_CENTROID,
            query={
                "label": "Kirkland, Washington 98033 query area",
                "mode": "POSTAL_CODE",
                "postal_code": postal_code,
                "country_code": "US",
                "source_note": (
                    "This release has an approved postal centroid and public-association "
                    "dataset for the Kirkland bootstrap market."
                ),
            },
            coverage=_covered_bootstrap_market(),
        )

    assert country_code is not None
    return QueryResolution(
        point=None,
        query={
            "label": "Postal-code query area",
            "mode": "POSTAL_CODE",
            "postal_code": postal_code,
            "country_code": country_code,
            "source_note": (
                "No canonical postal geography was selected. This request is not mapped to a "
                "fallback market or a guessed coordinate."
            ),
        },
        coverage={
            "status": "LOCATION_UNRESOLVED",
            "reason_code": "POSTAL_CODE_NOT_IN_GEOGRAPHY_INDEX",
            "country_code": country_code,
            "complete": False,
            "data_mode": _BOOTSTRAP_DATA_MODE,
            "message": (
                "The postal code was accepted, but this release has no canonical postal "
                "geography for it. Send an approximate coordinate when available, or wait for "
                "that country and postal index to be approved."
            ),
        },
    )


def resolve_coordinate_query(
    *,
    latitude: float,
    longitude: float,
    country_code: str | None,
    decimals: int,
) -> QueryResolution:
    """Coarsen a device coordinate and select an approved market only when it is covered."""

    coarse = quantize_location(GeoPoint(latitude, longitude), decimals=decimals)
    query: dict[str, object] = {
        "label": "Coarsened coordinate query area",
        "mode": "COARSE_COORDINATE",
        "normalized_coordinate": {"latitude": coarse.latitude, "longitude": coarse.longitude},
        "source_note": "The supplied coordinate was coarsened before retrieval and is not logged.",
    }
    if country_code:
        query["country_code_hint"] = country_code

    if haversine_km(coarse, _KIRKLAND_POSTAL_CENTROID) <= _KIRKLAND_COVERAGE_RADIUS_KM:
        if country_code and country_code != "US":
            return QueryResolution(
                point=None,
                query=query,
                coverage={
                    "status": "NOT_COVERED",
                    "reason_code": "COUNTRY_CONTEXT_DOES_NOT_MATCH_APPROVED_MARKET",
                    "country_code": country_code,
                    "complete": False,
                    "data_mode": _BOOTSTRAP_DATA_MODE,
                    "message": (
                        "The supplied country context does not match the approved Kirkland "
                        "bootstrap market. No people were selected."
                    ),
                },
            )
        query["label"] = "Kirkland public-association bootstrap query area"
        return QueryResolution(
            point=coarse,
            query=query,
            coverage=_covered_bootstrap_market(),
        )

    return QueryResolution(
        point=None,
        query=query,
        coverage={
            "status": "NOT_COVERED",
            "reason_code": "NO_APPROVED_MARKET_DATA",
            "country_code": country_code,
            "complete": False,
            "data_mode": _BOOTSTRAP_DATA_MODE,
            "message": (
                "The location was accepted, but this release has no approved public-association "
                "dataset for that market. No people were selected."
            ),
        },
    )


def _covered_bootstrap_market() -> dict[str, object]:
    return {
        "status": "COVERED",
        "reason_code": "APPROVED_BOOTSTRAP_MARKET",
        "market_id": _KIRKLAND_MARKET_ID,
        "market_label": _KIRKLAND_MARKET_LABEL,
        "country_code": "US",
        "complete": False,
        "data_mode": _BOOTSTRAP_DATA_MODE,
        "message": (
            "Results are limited to reviewed public-association records in the Kirkland "
            "bootstrap market."
        ),
    }
