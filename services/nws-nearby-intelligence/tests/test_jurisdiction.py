from __future__ import annotations

import pytest

from app.jurisdiction import get_public_jurisdiction_index


def test_primary_county_index_is_complete_and_versioned() -> None:
    index = get_public_jurisdiction_index()

    assert len(index) == 33_791
    chicago = index.resolve("60637")
    assert chicago.county_geoid == "17031"
    assert chicago.county_name == "Cook County"
    assert chicago.source_vintage == 2020


def test_florida_postal_resolves_to_public_county_jurisdiction() -> None:
    jurisdiction = get_public_jurisdiction_index().resolve("33130-1234")

    assert jurisdiction.postal_code == "33130"
    assert jurisdiction.state_fips == "12"
    assert jurisdiction.county_name == "Miami-Dade County"
    assert jurisdiction.overlap_fraction == 1
    assert jurisdiction.approximate is False


def test_invalid_or_missing_postal_fails_closed() -> None:
    index = get_public_jurisdiction_index()

    with pytest.raises(ValueError):
        index.resolve("980-33")
    with pytest.raises(KeyError):
        index.resolve("00000")
