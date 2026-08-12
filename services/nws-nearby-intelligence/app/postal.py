from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

from app.nws_models import GeoPoint


@dataclass(frozen=True)
class PostalCentroid:
    postal_code: str
    point: GeoPoint
    label: str
    source_note: str | None = None


class PostalCentroidIndex:
    def __init__(self, records: dict[str, PostalCentroid]) -> None:
        self._records = records

    @classmethod
    def from_csv(cls, path: str | Path) -> "PostalCentroidIndex":
        records: dict[str, PostalCentroid] = {}
        with Path(path).open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                postal_code = row["postal_code"].strip()
                records[postal_code] = PostalCentroid(
                    postal_code=postal_code,
                    point=GeoPoint(float(row["latitude"]), float(row["longitude"])),
                    label=row.get("label", postal_code).strip(),
                    source_note=(row.get("source_note") or "").strip() or None,
                )
        return cls(records)

    def resolve(self, postal_code: str) -> PostalCentroid:
        normalized = postal_code.strip()
        if normalized not in self._records:
            raise KeyError(f"postal code {normalized!r} is not loaded")
        return self._records[normalized]
