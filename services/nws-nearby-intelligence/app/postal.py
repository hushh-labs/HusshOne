from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass
from functools import lru_cache
from hashlib import sha256
from pathlib import Path

from app.geospatial import haversine_km
from app.nws_models import GeoPoint

_US_ZCTA_DATA_PATH = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "geography"
    / "us"
    / "2025"
    / "zcta-centroids.tsv"
)
_US_ZCTA_MANIFEST_PATH = _US_ZCTA_DATA_PATH.with_name("manifest.json")
_US_ZCTA_SOURCE = "U.S. Census Bureau 2025 Gazetteer"
_US_ZCTA_SOURCE_VINTAGE = 2025
_US_POSTAL_PATTERN = re.compile(r"^(\d{5})(?:-(\d{4}))?$")


@dataclass(frozen=True)
class PostalCentroid:
    """A representative ZCTA point, not a rooftop or residence coordinate."""

    postal_code: str
    point: GeoPoint
    label: str
    source_note: str | None = None
    source_vintage: int | None = None


def normalize_us_postal_code(postal_code: str) -> str:
    """Return the five-digit base of a US ZIP or ZIP+4.

    Census geography is keyed by five-digit ZCTA. ZIP+4 is therefore deliberately
    reduced to its five-digit base rather than treated as more precise geography.
    """

    candidate = postal_code.strip()
    match = _US_POSTAL_PATTERN.fullmatch(candidate)
    if match is None:
        raise ValueError("US postal code must be five digits or ZIP+4")
    return match.group(1)


class PostalCentroidIndex:
    def __init__(self, records: dict[str, PostalCentroid]) -> None:
        if not records:
            raise ValueError("postal centroid index cannot be empty")
        self._records = records

    @classmethod
    def from_csv(cls, path: str | Path) -> PostalCentroidIndex:
        """Load the legacy development CSV format.

        The production national index uses :meth:`from_tsv`; retaining this loader
        keeps small fixtures and the original development sample useful.
        """

        records: dict[str, PostalCentroid] = {}
        with Path(path).open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                postal_code = normalize_us_postal_code(row["postal_code"])
                if postal_code in records:
                    raise ValueError(f"duplicate postal code in index: {postal_code}")
                records[postal_code] = PostalCentroid(
                    postal_code=postal_code,
                    point=GeoPoint(float(row["latitude"]), float(row["longitude"])),
                    label=(row.get("label") or postal_code).strip(),
                    source_note=(row.get("source_note") or "").strip() or None,
                )
        return cls(records)

    @classmethod
    def from_tsv(
        cls,
        path: str | Path,
        *,
        source_note: str = _US_ZCTA_SOURCE,
        source_vintage: int = _US_ZCTA_SOURCE_VINTAGE,
    ) -> PostalCentroidIndex:
        records: dict[str, PostalCentroid] = {}
        with Path(path).open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle, delimiter="\t")
            required = {"postal_code", "latitude", "longitude"}
            if reader.fieldnames is None or not required.issubset(reader.fieldnames):
                raise ValueError("postal TSV must contain postal_code, latitude, and longitude")
            for row in reader:
                postal_code = normalize_us_postal_code(row["postal_code"])
                if postal_code in records:
                    raise ValueError(f"duplicate postal code in index: {postal_code}")
                records[postal_code] = PostalCentroid(
                    postal_code=postal_code,
                    point=GeoPoint(float(row["latitude"]), float(row["longitude"])),
                    label=f"US ZCTA {postal_code} query area",
                    source_note=source_note,
                    source_vintage=source_vintage,
                )
        return cls(records)

    def __len__(self) -> int:
        return len(self._records)

    def resolve(self, postal_code: str) -> PostalCentroid:
        normalized = normalize_us_postal_code(postal_code)
        if normalized not in self._records:
            raise KeyError(f"postal code {normalized!r} is not loaded")
        return self._records[normalized]

    def nearest(
        self, point: GeoPoint, *, max_distance_km: float
    ) -> tuple[PostalCentroid, float] | None:
        """Return the closest ZCTA internal point within a bounded inference radius.

        This is intentionally an approximate country inference for coordinate requests
        that omit country context. ZCTA representative points are not boundaries.
        """

        if max_distance_km <= 0:
            raise ValueError("max_distance_km must be positive")
        nearest_record: PostalCentroid | None = None
        nearest_distance = float("inf")
        for record in self._records.values():
            distance = haversine_km(point, record.point)
            if distance < nearest_distance:
                nearest_record = record
                nearest_distance = distance
        if nearest_record is None or nearest_distance > max_distance_km:
            return None
        return nearest_record, nearest_distance


@lru_cache(maxsize=1)
def get_us_postal_index() -> PostalCentroidIndex:
    """Load the immutable national ZCTA index once per service process."""

    manifest = json.loads(_US_ZCTA_MANIFEST_PATH.read_text(encoding="utf-8"))
    digest = sha256(_US_ZCTA_DATA_PATH.read_bytes()).hexdigest()
    if digest != manifest["reduced_file_sha256"]:
        raise RuntimeError("US ZCTA geography digest does not match its release manifest")
    index = PostalCentroidIndex.from_tsv(_US_ZCTA_DATA_PATH)
    if len(index) != int(manifest["record_count"]):
        raise RuntimeError("US ZCTA geography count does not match its release manifest")
    return index
