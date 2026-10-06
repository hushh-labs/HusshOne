"""Focused tests for the read-only production schema guard."""

from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest

from app.schema_guard import (
    PRODUCTION_PUBLIC_SCHEMA_CONTRACT,
    UnsupportedSchemaGuardDialect,
    compare_schema,
    inspect_schema,
)


class FakeEngine:
    def __init__(self, dialect: str = "postgresql"):
        self.dialect = SimpleNamespace(name=dialect)


class FakeInspector:
    def __init__(self, contract=PRODUCTION_PUBLIC_SCHEMA_CONTRACT):
        self.contract = contract

    def get_pk_constraint(self, table_name, schema=None):
        for constraint in self.contract.tables[table_name].constraints:
            if constraint.kind == "primary_key":
                return {"name": constraint.name, "constrained_columns": list(constraint.columns)}
        return {"name": None, "constrained_columns": []}

    def get_unique_constraints(self, table_name, schema=None):
        return [
            {"name": constraint.name, "column_names": list(constraint.columns)}
            for constraint in self.contract.tables[table_name].constraints
            if constraint.kind == "unique"
        ]

    def get_foreign_keys(self, table_name, schema=None):
        return [
            {
                "name": constraint.name,
                "constrained_columns": list(constraint.columns),
                "referred_schema": constraint.referred_schema,
                "referred_table": constraint.referred_table,
                "referred_columns": list(constraint.referred_columns),
            }
            for constraint in self.contract.tables[table_name].constraints
            if constraint.kind == "foreign_key"
        ]


def _data_type_for(pg_type):
    return {
        "int8": "bigint",
        "int4": "integer",
        "float8": "double precision",
        "float4": "real",
        "bpchar": "character",
        "_text": "ARRAY",
        "timestamptz": "timestamp with time zone",
        "bool": "boolean",
    }.get(pg_type, pg_type)


def _default_sql(column, table_name):
    if column.default_kind == "none":
        return None
    if column.default_kind == "sequence":
        return f"nextval('{table_name}_id_seq'::regclass)"
    if column.default_kind == "now":
        return "now()"
    if column.default_kind == "empty_text_array":
        return "'{}'::text[]"
    if column.default_kind == "empty_json_array":
        return "'[]'::jsonb"
    if column.default_value is True:
        return "true"
    if column.default_value is False:
        return "false"
    if isinstance(column.default_value, int):
        return f"{column.default_value}::integer"
    return f"'{column.default_value}'::text"


def _column_rows(contract=PRODUCTION_PUBLIC_SCHEMA_CONTRACT):
    rows = []
    for table_name, table in contract.tables.items():
        for ordinal, column in enumerate(table.columns, start=1):
            rows.append(
                {
                    "table_name": table_name,
                    "column_name": column.name,
                    "ordinal_position": ordinal,
                    "is_nullable": "YES" if column.nullable else "NO",
                    "data_type": _data_type_for(column.pg_type),
                    "udt_name": column.pg_type,
                    "character_maximum_length": column.char_length,
                    "column_default": _default_sql(column, table_name),
                    "is_generated": "ALWAYS" if column.generated else "NEVER",
                    "generation_expression": column.generated_expression,
                }
            )
    return rows


def _index_definition(table_name, index):
    columns = ", ".join(index.columns)
    definition = f"CREATE INDEX {index.name} ON public.{table_name} USING {index.method} ({columns})"
    if index.where:
        definition += f" WHERE {index.where}"
    return definition


def _index_rows(contract=PRODUCTION_PUBLIC_SCHEMA_CONTRACT):
    return [
        {
            "table_name": table_name,
            "index_name": index.name,
            "index_definition": _index_definition(table_name, index),
        }
        for table_name, table in contract.tables.items()
        for index in table.indexes
    ]


def _executor(columns, indexes, calls=None):
    def execute(statement, params):
        if calls is not None:
            calls.append((statement, params))
        if "information_schema.columns" in statement:
            return columns
        if "pg_indexes" in statement:
            return indexes
        raise AssertionError(f"Unexpected catalog statement: {statement}")

    return execute


def test_verified_contract_snapshot_compares_cleanly_with_injected_catalog():
    report = compare_schema(
        FakeEngine(),
        inspector=FakeInspector(),
        query_executor=_executor(_column_rows(), _index_rows()),
    )

    assert report.compatible
    assert report.errors == ()
    assert report.warnings == ()
    assert report.snapshot is not None
    assert report.snapshot.tables["hotels"].columns["zip"].char_length == 5


def test_guard_reports_column_generated_constraint_and_index_drift():
    columns = deepcopy(_column_rows())
    indexes = deepcopy(_index_rows())
    inspector = FakeInspector()

    for row in columns:
        if row["table_name"] == "hotels" and row["column_name"] == "rating":
            row["udt_name"] = "float8"
        if row["table_name"] == "zips" and row["column_name"] == "state":
            row["character_maximum_length"] = 3
        if row["table_name"] == "hotels" and row["column_name"] == "geog":
            row["generation_expression"] = "ST_SetSRID(ST_MakePoint(lat, lng), 4326)::geography"
    indexes[:] = [row for row in indexes if row["index_name"] != "zips_queue_idx"]

    # Drop the reflected place_id unique constraint while retaining all others.
    original = inspector.get_unique_constraints

    def unique_without_place_id(table_name, schema=None):
        return [
            row for row in original(table_name, schema=schema)
            if row["name"] != "hotels_place_id_key"
        ]

    inspector.get_unique_constraints = unique_without_place_id
    report = compare_schema(
        FakeEngine(),
        inspector=inspector,
        query_executor=_executor(columns, indexes),
    )

    assert not report.compatible
    observed = {(d.code, d.table, d.object_name) for d in report.errors}
    assert ("column_type_mismatch", "hotels", "rating") in observed
    assert ("column_length_mismatch", "zips", "state") in observed
    assert ("column_generation_expression_mismatch", "hotels", "geog") in observed
    assert ("missing_constraint", "hotels", "hotels_place_id_key") in observed
    assert ("missing_index", "zips", "zips_queue_idx") in observed


def test_guard_accepts_postgresql_catalog_rendering_variants():
    columns = deepcopy(_column_rows())
    indexes = deepcopy(_index_rows())
    for row in columns:
        if row["table_name"] == "hotels" and row["column_name"] == "geog":
            row["generation_expression"] = (
                "CASE WHEN ((lat IS NULL) OR (lng IS NULL)) THEN NULL::geography "
                "ELSE (st_setsrid(st_makepoint(lng, lat), 4326))::geography END"
            )
    for row in indexes:
        if row["index_name"] == "hotels_photos_queue_idx":
            row["index_definition"] = (
                "CREATE INDEX hotels_photos_queue_idx ON public.hotels USING btree "
                "(photos_status) WHERE ((place_id IS NOT NULL) AND "
                "(photos_status = ANY (ARRAY['pending'::text, 'in_progress'::text])))"
            )

    report = compare_schema(
        FakeEngine(),
        inspector=FakeInspector(),
        query_executor=_executor(columns, indexes),
    )
    assert report.compatible, [diagnostic.as_dict() for diagnostic in report.diagnostics]


def test_inspection_uses_only_fixed_read_only_selects():
    calls = []
    snapshot = inspect_schema(
        FakeEngine(),
        inspector=FakeInspector(),
        query_executor=_executor(_column_rows(), _index_rows(), calls),
    )

    assert set(snapshot.tables) == {"hotels", "zips", "photo_spend", "email_reports"}
    assert len(calls) == 2
    for statement, params in calls:
        assert statement.lstrip().upper().startswith("SELECT")
        assert params == {"schema": "public"}
        forbidden = (" INSERT ", " UPDATE ", " DELETE ", " ALTER ", " CREATE ", " DROP ")
        assert not any(token in f" {statement.upper()} " for token in forbidden)


def test_non_postgresql_engine_is_rejected_without_catalog_queries():
    calls = []
    report = compare_schema(
        FakeEngine("sqlite"),
        inspector=FakeInspector(),
        query_executor=_executor(_column_rows(), _index_rows(), calls),
    )

    assert not report.compatible
    assert report.errors[0].code == "unsupported_dialect"
    assert calls == []
    with pytest.raises(UnsupportedSchemaGuardDialect):
        inspect_schema(FakeEngine("sqlite"), inspector=FakeInspector())
