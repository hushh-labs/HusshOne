import pytest

from app.scrape_contract import ScrapeStatus, google_cid, validate_record, validate_records


def _candidate(**overrides):
    row = {
        "name": "Example Hotel",
        "sources": ["places"],
        "lat": 47.675,
        "lng": -122.20,
        "rating": 4.2,
        "raw": {"google_cid": "123"},
    }
    row.update(overrides)
    return row


def test_valid_record_is_normalized_without_losing_cid():
    result = validate_record(
        _candidate(name="  Example Hotel\x00  "),
        zip_lat=47.68,
        zip_lng=-122.20,
        max_distance_km=75,
    )
    assert result["name"] == "Example Hotel"
    assert result["rating"] == 4.2
    assert google_cid(result) == "123"


@pytest.mark.parametrize(
    "override,reason",
    [
        ({"name": "  "}, "name is empty"),
        ({"lat": None}, "latitude is missing or invalid"),
        ({"rating": 5.1}, "rating is outside 1-5"),
        ({"sources": ["maps"]}, "unsupported source"),
    ],
)
def test_invalid_records_are_rejected(override, reason):
    with pytest.raises(ValueError, match=reason):
        validate_record(_candidate(**override), zip_lat=47.68, zip_lng=-122.20, max_distance_km=75)


def test_far_records_are_rejected_and_batch_keeps_evidence():
    valid, rejected = validate_records(
        [_candidate(), _candidate(name="Far Away", lat=40.0, lng=-74.0)],
        zip_lat=47.68,
        zip_lng=-122.20,
        max_distance_km=75,
    )
    assert len(valid) == 1
    assert rejected[0].name == "Far Away"
    assert "ZIP centroid" in rejected[0].reason


def test_scrape_statuses_remain_distinct():
    assert ScrapeStatus.EXPLICIT_EMPTY.value != ScrapeStatus.SELECTOR_FAILURE.value
