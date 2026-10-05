"""Tests for the application's non-destructive production SQL firewall."""

import pytest
from sqlalchemy import create_engine, text

from app.database import (
    ProductionMutationBlocked,
    _install_production_write_firewall,
    contains_prohibited_production_sql,
)


def test_production_firewall_blocks_destructive_operations():
    for statement in (
        "DELETE FROM hotels WHERE id = 1",
        "TRUNCATE TABLE hotels",
        "ALTER TABLE hotels DROP COLUMN name",
        "WITH removed AS (DELETE FROM hotels RETURNING id) SELECT * FROM removed",
        "DROP TABLE hotels",
    ):
        assert contains_prohibited_production_sql(statement) is True


def test_production_firewall_allows_normal_read_and_upsert_work():
    assert contains_prohibited_production_sql("SELECT * FROM hotels WHERE name = 'Delete Me Motel'") is False
    assert contains_prohibited_production_sql("SELECT 1 AS hotels_delete") is False
    assert contains_prohibited_production_sql("SELECT 1 AS public_schema_create") is False
    assert contains_prohibited_production_sql("UPDATE zips SET places_status = 'done' WHERE zip = '98033'") is False
    assert contains_prohibited_production_sql("INSERT INTO hotels (name) VALUES ('Create Inn')") is False


def test_connection_firewall_rejects_delete_before_database_execution():
    """The installed engine hook blocks the statement, not merely its parser."""
    engine = create_engine("sqlite://")
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE protected_rows (id INTEGER PRIMARY KEY)"))
            connection.execute(text("INSERT INTO protected_rows (id) VALUES (1)"))

        _install_production_write_firewall(engine)
        with pytest.raises(ProductionMutationBlocked):
            with engine.begin() as connection:
                connection.execute(text("DELETE FROM protected_rows WHERE id = 1"))

        with engine.connect() as connection:
            assert connection.execute(text("SELECT count(*) FROM protected_rows")).scalar_one() == 1
    finally:
        engine.dispose()
