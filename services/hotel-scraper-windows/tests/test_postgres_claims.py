"""Real PostgreSQL lock verification against an explicitly named throwaway DB."""
import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app import database, worker as module
from app.models import Base, ZipCode
from app.worker import ScraperBackgroundWorker


def test_postgres_skip_locked_claim_is_committed_and_excludes_other_workers(monkeypatch):
    url = os.environ.get("SCRAPER_TEST_POSTGRES_URL")
    if not url:
        pytest.skip("Dedicated PostgreSQL CI database not configured")
    parsed = make_url(url)
    assert parsed.host in ("localhost", "127.0.0.1")
    assert parsed.database == "scraper_ci_windows", "Never run this fixture on an application database"
    engine = create_engine(url, connect_args={"options": "-c statement_timeout=3000"})
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(module, "get_db_session", sessions)
    monkeypatch.setattr(database, "is_sqlite", lambda: False)
    monkeypatch.setattr(ScraperBackgroundWorker, "_assert_current_write_contract", lambda self: None)
    monkeypatch.setattr(module.settings, "REFRESH_AFTER_DAYS", 0)
    try:
        with sessions() as db:
            for zip_code, distance in (("98033", 0), ("98034", 1)):
                db.add(ZipCode(zip=zip_code, lat=47.68, lng=-122.2, places_status="pending",
                               dist_km_from_kirkland=distance))
            db.commit()
        with sessions() as holding:
            holding.query(ZipCode).filter(ZipCode.zip == "98033").with_for_update().one()
            worker = ScraperBackgroundWorker()
            assert worker._next_zip_sync()[0] == "98034"  # Does not block on 98033.
            holding.rollback()
        other = ScraperBackgroundWorker()
        assert other._next_zip_sync()[0] == "98033"
        assert other._next_zip_sync() is None
        with sessions() as db:
            assert all(row.places_status == "in_progress" for row in db.query(ZipCode).all())
    finally:
        engine.dispose()
