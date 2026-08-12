from __future__ import annotations

from math import asin, cos, exp, radians, sin, sqrt

from app.nws_models import GeoPoint


_EARTH_RADIUS_KM = 6371.0088


def haversine_km(left: GeoPoint, right: GeoPoint) -> float:
    """Great-circle distance suitable for candidate filtering and ranking."""

    lat1, lon1 = radians(left.latitude), radians(left.longitude)
    lat2, lon2 = radians(right.latitude), radians(right.longitude)
    delta_lat = lat2 - lat1
    delta_lon = lon2 - lon1
    value = sin(delta_lat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(delta_lon / 2) ** 2
    return 2 * _EARTH_RADIUS_KM * asin(sqrt(min(1.0, value)))


def location_relevance(
    distance_km: float,
    *,
    radius_km: float,
    location_confidence: float,
) -> float:
    """Returns a [0, 1] local relevance signal.

    The half-life adapts to the query radius. Proximity is intentionally only a query
    relevance signal; it does not change the person's global professional NWS.
    """

    if distance_km < 0:
        raise ValueError("distance_km cannot be negative")
    if radius_km <= 0:
        raise ValueError("radius_km must be positive")
    if not 0 <= location_confidence <= 1:
        raise ValueError("location_confidence must be in [0, 1]")

    scale_km = max(5.0, radius_km / 2.0)
    return max(0.0, min(1.0, location_confidence * exp(-distance_km / scale_km)))


def quantize_location(point: GeoPoint, decimals: int = 2) -> GeoPoint:
    """Coarsen user location before storage; two decimals are roughly city-neighborhood scale."""

    if decimals < 0 or decimals > 4:
        raise ValueError("decimals must be between 0 and 4")
    return GeoPoint(round(point.latitude, decimals), round(point.longitude, decimals))
