from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import database, worker as module
from app.chrome_scraper import _detail_fields, _place_id_from_url, _parse_review_count, ScrapeBlocked
from app.free_scraper import normalize_name
from app.models import Base, Hotel, ZipCode
from app.worker import ScraperBackgroundWorker, _now


@pytest.fixture
def queue(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "queue.db"))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(module, "get_db_session", sessions)
    monkeypatch.setattr(database, "is_sqlite", lambda: True)
    monkeypatch.setattr(ScraperBackgroundWorker, "_assert_current_write_contract", lambda self: None)
    monkeypatch.setattr(ScraperBackgroundWorker, "_assert_inventory_safe", lambda *args: None)
    with sessions() as db:
        db.add(ZipCode(zip="98033", city="Kirkland", state="WA", lat=47.68, lng=-122.2,
                       places_status="pending", dist_km_from_kirkland=0))
        db.commit()
    yield sessions
    engine.dispose()


def test_shared_queue_claim_excludes_another_worker_and_heartbeats(queue):
    first, second = ScraperBackgroundWorker(), ScraperBackgroundWorker()
    assert first._next_zip_sync()[0] == "98033"
    assert second._next_zip_sync() is None
    with queue() as db:
        row = db.get(ZipCode, "98033")
        assert row.places_status == "in_progress"
        assert row.last_error == first._zip_claims["98033"]
        row.updated_at = _now() - timedelta(minutes=20)
        db.commit()
    first._heartbeat_claims()
    with queue() as db:
        assert db.get(ZipCode, "98033").updated_at > (_now() - timedelta(minutes=1)).replace(tzinfo=None)


def test_expired_browser_claim_is_recovered_but_vm_claim_is_preserved(queue):
    first, second = ScraperBackgroundWorker(), ScraperBackgroundWorker()
    first._next_zip_sync()
    with queue() as db:
        row = db.get(ZipCode, "98033")
        row.updated_at = _now() - timedelta(minutes=31)
        db.commit()
    assert second._next_zip_sync()[0] == "98033"
    assert first._zip_claims["98033"] != second._zip_claims["98033"]
    with queue() as db:
        row = db.get(ZipCode, "98033")
        row.last_error = None  # The VM does not use a browser ownership marker.
        row.updated_at = _now() - timedelta(minutes=31)
        db.commit()
    assert first._next_zip_sync() is None


def test_lost_claim_cannot_write_hotels_or_complete_someone_elses_zip(queue):
    first = ScraperBackgroundWorker()
    first._next_zip_sync()
    with queue() as db:
        row = db.get(ZipCode, "98033")
        row.last_error = "another worker"
        db.commit()
    with pytest.raises(database.DatabaseUnavailable, match="lease lost"):
        first._save_results("98033", "WA", 47.68, -122.2,
                            [{"name": "Example", "lat": 47.68, "lng": -122.2, "sources": ["places"]}])
    with queue() as db:
        assert db.query(Hotel).count() == 0
        assert db.get(ZipCode, "98033").places_status == "in_progress"


def test_outbox_waits_for_vm_and_reclaims_completed_zip(queue):
    worker = ScraperBackgroundWorker()
    entry = SimpleNamespace(zip_code="98033", metadata={"claim_token": "husshone-browser:old"})
    with queue() as db:
        db.get(ZipCode, "98033").places_status = "in_progress"
        db.commit()
    with pytest.raises(database.DatabaseUnavailable, match="Another worker"):
        worker._claim_outbox_zip(entry)
    with queue() as db:
        db.get(ZipCode, "98033").places_status = "done"
        db.commit()
    worker._claim_outbox_zip(entry)
    with queue() as db:
        assert db.get(ZipCode, "98033").last_error == entry.metadata["claim_token"]


def test_hotel_count_uses_inventory_and_status_is_not_invented(queue):
    worker = ScraperBackgroundWorker()
    worker._next_zip_sync()
    records = [{"name": "One", "lat": 47.68, "lng": -122.2, "sources": ["places"]},
               {"name": "Two", "lat": 47.681, "lng": -122.201, "sources": ["places"]}]
    worker._save_results("98033", "WA", 47.68, -122.2, records)
    worker._save_results("98033", "WA", 47.68, -122.2, records[:1])
    with queue() as db:
        assert db.get(ZipCode, "98033").hotels_found == 2
        assert all(row.business_status is None for row in db.query(Hotel).all())


def test_normalization_matches_vm_for_combining_marks_and_non_ascii():
    assert normalize_name("Ho\u0302tel & Café") == "hotel and cafe"
    assert normalize_name("Straße Hotel") == "stra e hotel"


def test_stale_outbox_does_not_replace_newer_vm_data():
    row = Hotel(name="Existing", sources=["places"], rating=4.8, raw={"origin": "vm"},
                last_seen=_now())
    ScraperBackgroundWorker._touch_row(row, {
        "sources": ["places"], "rating": 1.5,
        "raw": {"scraped_at": (_now() - timedelta(days=2)).isoformat()},
    }, _now())
    assert row.rating == 4.8
    assert row.raw == {"origin": "vm"}


def test_clean_shutdown_releases_only_owned_claims(queue):
    worker = ScraperBackgroundWorker()
    worker._next_zip_sync()
    worker._release_zip_claims()
    with queue() as db:
        assert db.get(ZipCode, "98033").places_status == "pending"
    assert worker._zip_claims == {}


class Element:
    def __init__(self, label=None, href=None):
        self.label, self.href = label, href
    def get_attribute(self, name):
        return self.label if name == "aria-label" else self.href
    def inner_text(self):
        return self.label or ""


class DetailPage:
    url = "https://www.google.com/maps/place/Example/data=!1sChIJ_verified_example!3d47.68!4d-122.2"
    body = "Example Hotel 1,234 reviews Temporarily closed"
    def inner_text(self, selector):
        return self.body
    def query_selector(self, selector):
        if 'data-item-id="address"' in selector:
            return Element("Address: 123 Main St, Kirkland, WA 98033")
        if 'data-item-id^="phone:' in selector:
            return Element("Phone: +1 555 123 4567")
        if 'data-item-id="authority"' in selector:
            return Element(href="https://example.org")
        if 'aria-label^="Price:' in selector:
            return Element("Price: $$")
        return None
    def query_selector_all(self, selector):
        return [Element("4.3 stars")]


def test_visible_detail_fields_and_verified_place_identity():
    row = _detail_fields(DetailPage())
    assert row["phone"] == "+1 555 123 4567"
    assert row["website"] == "https://example.org"
    assert row["zip"] == "98033" and row["state"] == "WA"
    assert row["user_ratings_total"] == 1234 and row["rating"] == 4.3
    assert row["business_status"] == "CLOSED_TEMPORARILY"
    assert row["price_level"] == "PRICE_LEVEL_MODERATE"
    assert row["place_id"] == "ChIJ_verified_example"
    assert row["lat"] == 47.68
    assert _place_id_from_url("https://www.google.com/maps?cid=123456789") is None
    assert _place_id_from_url("https://www.google.com/maps/place/X/!1s0x123:0x456") is None
    assert _parse_review_count("No reviews yet") is None


def test_detail_block_is_not_silently_accepted():
    page = DetailPage()
    page.body = "Our systems detected unusual traffic"
    with pytest.raises(ScrapeBlocked):
        _detail_fields(page)
