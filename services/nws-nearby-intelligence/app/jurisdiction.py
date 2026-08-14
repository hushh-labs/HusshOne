"""Versioned coarse public-jurisdiction resolution for financial disclosures.

The relationship file is used only to associate a postal query with a public
county jurisdiction.  It must never be described as a person's residence.  A
ZCTA can cross county lines, so the selected county and overlap fraction remain
explicitly approximate.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from functools import lru_cache
from hashlib import sha256
from pathlib import Path

from app.postal import normalize_us_postal_code

_DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "geography" / "us" / "2020"
_DATA_PATH = _DATA_DIR / "zcta-primary-counties.tsv"
_MANIFEST_PATH = _DATA_DIR / "zcta-primary-counties-manifest.json"


@dataclass(frozen=True)
class PublicJurisdiction:
    postal_code: str
    county_geoid: str
    county_name: str
    overlap_fraction: float
    source_vintage: int

    @property
    def state_fips(self) -> str:
        return self.county_geoid[:2]

    @property
    def approximate(self) -> bool:
        return self.overlap_fraction < 0.999999


class PublicJurisdictionIndex:
    def __init__(self, records: dict[str, PublicJurisdiction]) -> None:
        if not records:
            raise ValueError("public jurisdiction index cannot be empty")
        self._records = records

    def __len__(self) -> int:
        return len(self._records)

    def resolve(self, postal_code: str) -> PublicJurisdiction:
        normalized = normalize_us_postal_code(postal_code)
        try:
            return self._records[normalized]
        except KeyError as exc:
            raise KeyError(f"postal code {normalized!r} has no jurisdiction mapping") from exc


@lru_cache(maxsize=1)
def get_public_jurisdiction_index() -> PublicJurisdictionIndex:
    manifest = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
    digest = sha256(_DATA_PATH.read_bytes()).hexdigest()
    if digest != manifest["reduced_file_sha256"]:
        raise RuntimeError("ZCTA-to-county digest does not match its release manifest")

    vintage = int(manifest["vintage"])
    records: dict[str, PublicJurisdiction] = {}
    with _DATA_PATH.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        required = {"postal_code", "county_geoid", "county_name", "overlap_fraction"}
        if reader.fieldnames is None or not required.issubset(reader.fieldnames):
            raise RuntimeError("ZCTA-to-county file has an invalid header")
        for row in reader:
            postal_code = normalize_us_postal_code(row["postal_code"])
            county_geoid = row["county_geoid"].strip()
            county_name = row["county_name"].strip()
            overlap_fraction = float(row["overlap_fraction"])
            if len(county_geoid) != 5 or not county_geoid.isdigit() or not county_name:
                raise RuntimeError("ZCTA-to-county file contains an invalid county")
            if not 0 < overlap_fraction <= 1:
                raise RuntimeError("ZCTA-to-county overlap must be in (0, 1]")
            if postal_code in records:
                raise RuntimeError(f"duplicate ZCTA-to-county record: {postal_code}")
            records[postal_code] = PublicJurisdiction(
                postal_code=postal_code,
                county_geoid=county_geoid,
                county_name=county_name,
                overlap_fraction=overlap_fraction,
                source_vintage=vintage,
            )

    if len(records) != int(manifest["record_count"]):
        raise RuntimeError("ZCTA-to-county count does not match its release manifest")
    return PublicJurisdictionIndex(records)
