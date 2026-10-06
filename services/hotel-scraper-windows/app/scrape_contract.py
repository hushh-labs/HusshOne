"""Canonical scrape outcomes and record validation.

This module deliberately has no database or browser dependency.  It gives the
worker one vocabulary for the distinction that matters most in production:
an explicitly empty Maps result is not the same thing as a blocked, broken, or
unparseable Maps page.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import math
from typing import Any, Dict, Iterable, List, Optional, Tuple


class ScrapeStatus(str, Enum):
    SUCCESS = "success"
    EXPLICIT_EMPTY = "explicit_empty"
    BLOCKED = "blocked"
    SELECTOR_FAILURE = "selector_failure"
    TRANSPORT_FAILURE = "transport_failure"


@dataclass
class ScrapeResult:
    status: ScrapeStatus
    records: List[Dict[str, Any]] = field(default_factory=list)
    reason: Optional[str] = None
    query: Optional[str] = None
    selector: Optional[str] = None

    @property
    def is_success(self) -> bool:
        return self.status == ScrapeStatus.SUCCESS

    @property
    def is_explicit_empty(self) -> bool:
        return self.status == ScrapeStatus.EXPLICIT_EMPTY

    def as_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status.value,
            "records": self.records,
            "reason": self.reason,
            "query": self.query,
            "selector": self.selector,
        }


@dataclass(frozen=True)
class ValidationFailure:
    name: Optional[str]
    reason: str

    def as_dict(self) -> Dict[str, Optional[str]]:
        return {"name": self.name, "reason": self.reason}


def _as_finite_number(value: Any, field_name: str) -> float:
    # bool is a subclass of int but is never a valid coordinate/rating.
    if isinstance(value, bool):
        raise ValueError(f"{field_name} is not a number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} is missing or invalid") from None
    if not math.isfinite(number):
        raise ValueError(f"{field_name} is not finite")
    return number


def haversine_km(lat_a: float, lng_a: float, lat_b: float, lng_b: float) -> float:
    """Great-circle distance; accurate enough for a conservative ZIP sanity gate."""
    radius_km = 6371.0088
    lat_a_rad, lng_a_rad = math.radians(lat_a), math.radians(lng_a)
    lat_b_rad, lng_b_rad = math.radians(lat_b), math.radians(lng_b)
    sin_lat = math.sin((lat_b_rad - lat_a_rad) / 2)
    sin_lng = math.sin((lng_b_rad - lng_a_rad) / 2)
    a = sin_lat * sin_lat + math.cos(lat_a_rad) * math.cos(lat_b_rad) * sin_lng * sin_lng
    return radius_km * 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1 - a)))


def google_cid(record: Dict[str, Any]) -> Optional[str]:
    """Return the normalized Maps CID carried in the canonical raw payload."""
    raw = record.get("raw") or {}
    value = record.get("google_cid") or (raw.get("google_cid") if isinstance(raw, dict) else None)
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def validate_record(
    candidate: Dict[str, Any],
    *,
    zip_lat: float,
    zip_lng: float,
    max_distance_km: float,
) -> Dict[str, Any]:
    """Return a normalized valid record or raise ``ValueError`` with a safe reason.

    Missing coordinates are intentionally rejected.  Filling them with the ZIP
    centroid makes malformed Maps data look valid and produces bad dedup keys.
    """
    record = dict(candidate)
    name = record.get("name")
    if not isinstance(name, str) or not name.replace("\x00", "").strip():
        raise ValueError("name is empty")
    record["name"] = name.replace("\x00", "").strip()

    lat = _as_finite_number(record.get("lat"), "latitude")
    lng = _as_finite_number(record.get("lng"), "longitude")
    if not -90 <= lat <= 90 or not -180 <= lng <= 180:
        raise ValueError("coordinates are outside Earth bounds")

    rating = record.get("rating")
    if rating is not None:
        rating = _as_finite_number(rating, "rating")
        if not 1 <= rating <= 5:
            raise ValueError("rating is outside 1-5")
        record["rating"] = rating

    distance = haversine_km(float(zip_lat), float(zip_lng), lat, lng)
    if distance > max_distance_km:
        raise ValueError(f"coordinates are {distance:.1f} km from ZIP centroid")

    sources = record.get("sources") or []
    if not isinstance(sources, list) or not sources or any(s not in {"places", "osm"} for s in sources):
        raise ValueError("record has an unsupported source")
    record["sources"] = sorted(set(sources))
    record["lat"], record["lng"] = lat, lng
    raw = record.get("raw")
    record["raw"] = dict(raw) if isinstance(raw, dict) else {}
    return record


def validate_records(
    candidates: Iterable[Dict[str, Any]],
    *,
    zip_lat: float,
    zip_lng: float,
    max_distance_km: float,
) -> Tuple[List[Dict[str, Any]], List[ValidationFailure]]:
    valid: List[Dict[str, Any]] = []
    rejected: List[ValidationFailure] = []
    for candidate in candidates:
        try:
            valid.append(
                validate_record(
                    candidate,
                    zip_lat=zip_lat,
                    zip_lng=zip_lng,
                    max_distance_km=max_distance_km,
                )
            )
        except ValueError as exc:
            rejected.append(ValidationFailure(candidate.get("name"), str(exc)))
    return valid, rejected
