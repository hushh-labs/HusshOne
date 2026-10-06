from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.data_quality import audit_hotels
from app.models import Base, Hotel, ZipCode


def _session():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)(), engine


def _hotel(index, **overrides):
    row = {
        "dedup_key": f"hotel-{index}",
        "name": f"Hotel {index}",
        "sources": ["places"],
        "lat": 47.68,
        "lng": -122.20,
        "rating": 4.0,
        "query_zip": "98033",
        "raw": {"scraped_via": "chrome_google_maps", "google_cid": f"cid-{index}", "scrape_run_id": "run-1"},
    }
    row.update(overrides)
    return Hotel(**row)


def test_audit_finds_duplicate_cids_coordinate_and_shape_issues():
    db, _ = _session()
    try:
        db.add(ZipCode(zip="98033", city="Kirkland", state="WA", lat=47.68, lng=-122.20))
        db.add_all(
            [
                _hotel(1, raw={"scraped_via": "chrome_google_maps", "google_cid": " same-cid ", "scrape_run_id": "run-1"}),
                _hotel(2, raw={"scraped_via": "chrome_google_maps", "google_cid": "same-cid", "scrape_run_id": "run-1"}),
                _hotel(3, lat=51.5072, lng=-0.1276),
                _hotel(4, name=" ", rating=5.3, sources=["maps"], raw=[]),
                _hotel(5, lat=40.0, lng=-74.0),
                _hotel(6, raw={"scraped_via": "chrome_google_maps"}),
                _hotel(7, lat=95.0),
            ]
        )
        db.commit()

        report = audit_hotels(db, finding_limit=20, shape_scan_limit=20, max_zip_distance_km=75)

        assert report.duplicate_google_cids[0].google_cid == "same-cid"
        assert report.duplicate_google_cids[0].count == 2
        assert len(report.duplicate_google_cids[0].sample_hotel_ids) == 2
        assert {(item.hotel_id, item.rule) for item in report.coordinate_issues} == {
            (3, "coordinates_outside_us_bounds"),
            (7, "coordinates_outside_earth_bounds"),
        }
        shape_rules = {(item.hotel_id, item.rule) for item in report.shape_issues}
        assert (4, "empty_name") in shape_rules
        assert (4, "rating_outside_1_5") in shape_rules
        assert (4, "invalid_sources") in shape_rules
        assert (4, "raw_not_object") in shape_rules
        assert (5, "coordinates_far_from_query_zip") in shape_rules
        assert (6, "maps_record_missing_google_cid") in shape_rules
        assert (6, "maps_record_missing_run_id") in shape_rules
        assert (7, "coordinates_outside_earth_bounds") in shape_rules
        assert report.is_clean is False
        assert report.as_dict()["summary"]["shape_rows_scanned"] == 7
    finally:
        db.close()


def test_shape_audit_is_keyset_paged_and_reports_partial_coverage():
    db, _ = _session()
    try:
        db.add(ZipCode(zip="98033", city="Kirkland", state="WA", lat=47.68, lng=-122.20))
        db.add_all([_hotel(1), _hotel(2), _hotel(3)])
        db.commit()

        first = audit_hotels(db, shape_scan_limit=2)
        assert first.shape_rows_scanned == 2
        assert first.next_shape_cursor is not None
        assert first.is_partial is True
        assert first.is_clean is False

        second = audit_hotels(db, shape_scan_limit=2, shape_cursor_after_id=first.next_shape_cursor)
        assert second.shape_rows_scanned == 1
        assert second.next_shape_cursor is None
        assert second.is_clean is True
    finally:
        db.close()


def test_audit_only_executes_selects_and_does_not_flush_pending_changes():
    db, engine = _session()
    statements = []

    @event.listens_for(engine, "before_cursor_execute")
    def _record_statement(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement.lstrip().upper())

    try:
        db.add(ZipCode(zip="98033", city="Kirkland", state="WA", lat=47.68, lng=-122.20))
        db.commit()
        statements.clear()
        db.add(_hotel(99))  # Deliberately pending: audit must not flush it.

        report = audit_hotels(db, shape_scan_limit=10)

        assert report.shape_rows_scanned == 0
        assert db.new  # Still pending rather than inserted by an audit read.
        assert statements
        assert all(statement.startswith("SELECT") for statement in statements)
    finally:
        event.remove(engine, "before_cursor_execute", _record_statement)
        db.close()


def test_invalid_audit_limits_are_rejected():
    db, _ = _session()
    try:
        for kwargs in (
            {"finding_limit": 0},
            {"shape_scan_limit": 0},
            {"duplicate_sample_id_limit": 0},
            {"shape_cursor_after_id": "3"},
            {"max_zip_distance_km": 0},
        ):
            try:
                audit_hotels(db, **kwargs)
            except ValueError:
                pass
            else:
                raise AssertionError(f"Expected ValueError for {kwargs}")
    finally:
        db.close()
