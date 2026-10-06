"""Read-only PostgreSQL schema contract checks for the shared Cloud SQL database.

The scraper writes into tables owned by the directory application.  This module
contains the verified ``public``-schema contract for the tables it depends on
and compares a live PostgreSQL catalog with that contract.  It deliberately
does not import the application's database singleton or ORM models, and it
never creates, changes, locks, or writes database objects.

``compare_schema`` is the normal entry point.  It returns structured
diagnostics instead of raising for an incompatible database, so a caller can
refuse to start a writer and show an actionable operator message.  For tests,
an Inspector and a read-only query executor may be injected.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

from sqlalchemy import inspect as sa_inspect
from sqlalchemy import text


TABLE_NAMES = ("hotels", "zips", "photo_spend", "email_reports")


@dataclass(frozen=True)
class ColumnExpectation:
    """One required column in the production contract.

    ``pg_type`` uses PostgreSQL's stable internal/catalog spelling (for
    example ``int8`` and ``_text``), rather than driver-specific SQLAlchemy
    type reprs.  ``default_kind`` is semantic because PostgreSQL adds casts and
    parentheses when rendering defaults in ``information_schema``.
    """

    name: str
    pg_type: str
    nullable: bool
    char_length: Optional[int] = None
    default_kind: str = "none"
    default_value: Any = None
    generated_expression: Optional[str] = None

    @property
    def generated(self) -> bool:
        return self.generated_expression is not None

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "pg_type": self.pg_type,
            "nullable": self.nullable,
            "char_length": self.char_length,
            "default_kind": self.default_kind,
            "default_value": self.default_value,
            "generated_expression": self.generated_expression,
        }


@dataclass(frozen=True)
class ConstraintExpectation:
    """A primary key, unique constraint, or foreign key the writer relies on."""

    name: str
    kind: str
    columns: tuple[str, ...]
    referred_schema: Optional[str] = None
    referred_table: Optional[str] = None
    referred_columns: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "columns": list(self.columns),
            "referred_schema": self.referred_schema,
            "referred_table": self.referred_table,
            "referred_columns": list(self.referred_columns),
        }


@dataclass(frozen=True)
class IndexExpectation:
    """A non-constraint index that is required by scraper or photo workloads."""

    name: str
    method: str
    columns: tuple[str, ...]
    where: Optional[str] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "method": self.method,
            "columns": list(self.columns),
            "where": self.where,
        }


@dataclass(frozen=True)
class TableExpectation:
    columns: tuple[ColumnExpectation, ...]
    constraints: tuple[ConstraintExpectation, ...] = ()
    indexes: tuple[IndexExpectation, ...] = ()


@dataclass(frozen=True)
class SchemaContract:
    schema: str
    tables: Mapping[str, TableExpectation]


def _column(
    name: str,
    pg_type: str,
    nullable: bool,
    *,
    char_length: Optional[int] = None,
    default_kind: str = "none",
    default_value: Any = None,
    generated_expression: Optional[str] = None,
) -> ColumnExpectation:
    return ColumnExpectation(
        name=name,
        pg_type=pg_type,
        nullable=nullable,
        char_length=char_length,
        default_kind=default_kind,
        default_value=default_value,
        generated_expression=generated_expression,
    )


# These are intentionally human-readable canonical expressions.  Comparison
# below accepts PostgreSQL's equivalent parenthesized/catalog-rendered form.
HOTELS_GEOG_EXPRESSION = (
    "CASE WHEN lat IS NULL OR lng IS NULL THEN NULL "
    "ELSE ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography END"
)
ZIPS_GEOG_EXPRESSION = "ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography"


# Verified against the production Cloud SQL PostgreSQL public schema.  Keep
# changes to this object deliberate: it is the startup write-safety contract.
PRODUCTION_PUBLIC_SCHEMA_CONTRACT = SchemaContract(
    schema="public",
    tables=MappingProxyType(
        {
            "hotels": TableExpectation(
                columns=(
                    _column("id", "int8", False, default_kind="sequence"),
                    _column("dedup_key", "text", False),
                    _column("place_id", "text", True),
                    _column("osm_id", "text", True),
                    _column("sources", "_text", False, default_kind="empty_text_array"),
                    _column("name", "text", False),
                    _column("formatted_address", "text", True),
                    _column("zip", "bpchar", True, char_length=5),
                    _column("query_zip", "bpchar", True, char_length=5),
                    _column("state", "bpchar", True, char_length=2),
                    _column("lat", "float8", True),
                    _column("lng", "float8", True),
                    _column(
                        "geog",
                        "geography",
                        True,
                        generated_expression=HOTELS_GEOG_EXPRESSION,
                    ),
                    _column("rating", "float4", True),
                    _column("user_ratings_total", "int4", True),
                    _column("price_level", "text", True),
                    _column("phone", "text", True),
                    _column("website", "text", True),
                    _column("google_maps_uri", "text", True),
                    _column("primary_type", "text", True),
                    _column("types", "_text", True),
                    _column("business_status", "text", True),
                    _column("raw", "jsonb", True),
                    _column("first_seen", "timestamptz", False, default_kind="now"),
                    _column("last_seen", "timestamptz", False, default_kind="now"),
                    _column("photo_refs", "_text", False, default_kind="empty_text_array"),
                    _column("photos", "jsonb", False, default_kind="empty_json_array"),
                    _column("photos_status", "text", False, default_kind="literal", default_value="pending"),
                    _column("photos_count", "int4", False, default_kind="literal", default_value=0),
                    _column("photos_fetched_at", "timestamptz", True),
                    _column("photos_error", "text", True),
                ),
                constraints=(
                    ConstraintExpectation("hotels_pkey", "primary_key", ("id",)),
                    ConstraintExpectation("hotels_dedup_key_key", "unique", ("dedup_key",)),
                    ConstraintExpectation("hotels_place_id_key", "unique", ("place_id",)),
                    ConstraintExpectation(
                        "hotels_query_zip_fkey",
                        "foreign_key",
                        ("query_zip",),
                        referred_schema="public",
                        referred_table="zips",
                        referred_columns=("zip",),
                    ),
                ),
                indexes=(
                    IndexExpectation("hotels_geog_gix", "gist", ("geog",)),
                    IndexExpectation(
                        "hotels_photos_queue_idx",
                        "btree",
                        ("photos_status",),
                        "place_id IS NOT NULL AND photos_status = ANY (ARRAY['pending', 'in_progress'])",
                    ),
                    IndexExpectation(
                        "hotels_photos_refresh_idx",
                        "btree",
                        ("photos_fetched_at NULLS FIRST",),
                        "place_id IS NOT NULL AND photos_status = 'done'",
                    ),
                    IndexExpectation("hotels_query_zip_idx", "btree", ("query_zip",)),
                    IndexExpectation("hotels_state_idx", "btree", ("state",)),
                    IndexExpectation("hotels_zip_idx", "btree", ("zip",)),
                ),
            ),
            "zips": TableExpectation(
                columns=(
                    _column("zip", "bpchar", False, char_length=5),
                    _column("city", "text", True),
                    _column("state", "bpchar", True, char_length=2),
                    _column("county", "text", True),
                    _column("lat", "float8", False),
                    _column("lng", "float8", False),
                    _column(
                        "geog",
                        "geography",
                        True,
                        generated_expression=ZIPS_GEOG_EXPRESSION,
                    ),
                    _column("dist_km_from_kirkland", "float8", True),
                    _column("osm_status", "text", False, default_kind="literal", default_value="pending"),
                    _column("places_status", "text", False, default_kind="literal", default_value="pending"),
                    _column("places_calls", "int4", False, default_kind="literal", default_value=0),
                    _column("hotels_found", "int4", False, default_kind="literal", default_value=0),
                    _column("last_error", "text", True),
                    _column("last_scraped_at", "timestamptz", True),
                    _column("updated_at", "timestamptz", False, default_kind="now"),
                ),
                constraints=(
                    ConstraintExpectation("zips_pkey", "primary_key", ("zip",)),
                ),
                indexes=(
                    IndexExpectation("zips_geog_gix", "gist", ("geog",)),
                    IndexExpectation(
                        "zips_queue_idx",
                        "btree",
                        ("places_status", "dist_km_from_kirkland"),
                    ),
                    IndexExpectation("zips_refresh_idx", "btree", ("last_scraped_at NULLS FIRST",)),
                ),
            ),
            "photo_spend": TableExpectation(
                columns=(
                    _column("day", "date", False),
                    _column("media_fetches", "int8", False, default_kind="literal", default_value=0),
                ),
                constraints=(
                    ConstraintExpectation("photo_spend_pkey", "primary_key", ("day",)),
                ),
            ),
            "email_reports": TableExpectation(
                columns=(
                    _column("id", "int8", False, default_kind="sequence"),
                    _column("sent_at", "timestamptz", False, default_kind="now"),
                    _column("recipients", "_text", True),
                    _column("zips_done", "int4", True),
                    _column("zips_left", "int4", True),
                    _column("hotels_total", "int4", True),
                    _column("places_calls_total", "int4", True),
                    _column("est_cost_usd", "numeric", True),
                    _column("ok", "bool", False, default_kind="literal", default_value=True),
                    _column("error", "text", True),
                ),
                constraints=(
                    ConstraintExpectation("email_reports_pkey", "primary_key", ("id",)),
                ),
            ),
        }
    ),
)

# A shorter alias is useful to callers while retaining the explicit public name
# above for documents and tests.
EXPECTED_SCHEMA = PRODUCTION_PUBLIC_SCHEMA_CONTRACT


@dataclass(frozen=True)
class ActualColumn:
    name: str
    pg_type: str
    nullable: bool
    char_length: Optional[int]
    default: Optional[str]
    generated: bool
    generation_expression: Optional[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "pg_type": self.pg_type,
            "nullable": self.nullable,
            "char_length": self.char_length,
            "default": self.default,
            "generated": self.generated,
            "generation_expression": self.generation_expression,
        }


@dataclass(frozen=True)
class ActualConstraint:
    name: Optional[str]
    kind: str
    columns: tuple[str, ...]
    referred_schema: Optional[str] = None
    referred_table: Optional[str] = None
    referred_columns: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "columns": list(self.columns),
            "referred_schema": self.referred_schema,
            "referred_table": self.referred_table,
            "referred_columns": list(self.referred_columns),
        }


@dataclass(frozen=True)
class ActualIndex:
    name: str
    definition: str

    def as_dict(self) -> dict[str, str]:
        return {"name": self.name, "definition": self.definition}


@dataclass(frozen=True)
class ActualTable:
    columns: Mapping[str, ActualColumn]
    constraints: tuple[ActualConstraint, ...] = ()
    indexes: tuple[ActualIndex, ...] = ()


@dataclass(frozen=True)
class SchemaSnapshot:
    """A read-only snapshot of just the catalog records this guard checks."""

    schema: str
    tables: Mapping[str, ActualTable]


@dataclass(frozen=True)
class SchemaDiagnostic:
    code: str
    message: str
    severity: str = "error"
    table: Optional[str] = None
    object_type: Optional[str] = None
    object_name: Optional[str] = None
    expected: Any = None
    actual: Any = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "severity": self.severity,
            "table": self.table,
            "object_type": self.object_type,
            "object_name": self.object_name,
            "expected": self.expected,
            "actual": self.actual,
        }


@dataclass(frozen=True)
class SchemaComparison:
    schema: str
    diagnostics: tuple[SchemaDiagnostic, ...] = ()
    snapshot: Optional[SchemaSnapshot] = None

    @property
    def compatible(self) -> bool:
        return not any(diagnostic.severity == "error" for diagnostic in self.diagnostics)

    @property
    def is_compatible(self) -> bool:
        """Alias suitable for a startup guard conditional."""
        return self.compatible

    @property
    def errors(self) -> tuple[SchemaDiagnostic, ...]:
        return tuple(d for d in self.diagnostics if d.severity == "error")

    @property
    def warnings(self) -> tuple[SchemaDiagnostic, ...]:
        return tuple(d for d in self.diagnostics if d.severity == "warning")

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "compatible": self.compatible,
            "diagnostics": [diagnostic.as_dict() for diagnostic in self.diagnostics],
        }


class SchemaInspectionError(RuntimeError):
    """The catalog could not be inspected read-only (e.g. missing privileges)."""


class UnsupportedSchemaGuardDialect(SchemaInspectionError):
    """Raised by ``inspect_schema`` when called with a non-PostgreSQL engine."""


# Both queries are catalog-only SELECT statements.  Do not replace them with
# ORM metadata creation or migration calls: this module must stay read-only.
_COLUMNS_SQL = """
SELECT
    c.table_name,
    c.column_name,
    c.ordinal_position,
    c.is_nullable,
    c.data_type,
    c.udt_name,
    c.character_maximum_length,
    c.column_default,
    c.is_generated,
    c.generation_expression
FROM information_schema.columns AS c
WHERE c.table_schema = :schema
  AND c.table_name IN ('hotels', 'zips', 'photo_spend', 'email_reports')
ORDER BY c.table_name, c.ordinal_position
"""

_INDEXES_SQL = """
SELECT
    i.tablename AS table_name,
    i.indexname AS index_name,
    i.indexdef AS index_definition
FROM pg_indexes AS i
WHERE i.schemaname = :schema
  AND i.tablename IN ('hotels', 'zips', 'photo_spend', 'email_reports')
ORDER BY i.tablename, i.indexname
"""

QueryExecutor = Callable[[str, Mapping[str, Any]], Iterable[Mapping[str, Any]]]


def inspect_schema(
    engine: Any,
    *,
    schema: str = "public",
    inspector: Any = None,
    query_executor: Optional[QueryExecutor] = None,
) -> SchemaSnapshot:
    """Read the required PostgreSQL catalog metadata without changing it.

    ``inspector`` and ``query_executor`` are optional dependency-injection
    points for unit tests.  A query executor receives only one of the fixed
    SELECT statements above and ``{"schema": schema}``; production callers
    should leave both arguments unset.

    Raises:
        UnsupportedSchemaGuardDialect: if ``engine`` is not PostgreSQL.
        SchemaInspectionError: if read-only catalog inspection fails.
    """

    _require_postgresql(engine)
    try:
        active_inspector = inspector if inspector is not None else sa_inspect(engine)
        columns_rows = _execute_catalog_query(engine, _COLUMNS_SQL, schema, query_executor)
        indexes_rows = _execute_catalog_query(engine, _INDEXES_SQL, schema, query_executor)
        return _snapshot_from_catalog_rows(
            schema=schema,
            inspector=active_inspector,
            columns_rows=columns_rows,
            indexes_rows=indexes_rows,
        )
    except SchemaInspectionError:
        raise
    except Exception as exc:  # drivers use different exception subclasses
        raise SchemaInspectionError(f"Could not inspect PostgreSQL schema {schema!r}: {exc}") from exc


def compare_schema(
    engine: Any,
    *,
    schema: str = "public",
    contract: SchemaContract = PRODUCTION_PUBLIC_SCHEMA_CONTRACT,
    inspector: Any = None,
    query_executor: Optional[QueryExecutor] = None,
    strict_extra_columns: bool = True,
    strict_names: bool = False,
) -> SchemaComparison:
    """Inspect and compare the live schema, returning structured diagnostics.

    Missing or incompatible objects are errors.  Extra columns are errors by
    default because they signal an unreviewed production migration; callers may
    set ``strict_extra_columns=False`` during an approved additive rollout.
    Constraint/index names are diagnostic-only by default because a semantic
    equivalent constraint remains safe for the writer.  Set ``strict_names``
    when migration naming is also a release requirement.
    """

    try:
        snapshot = inspect_schema(
            engine,
            schema=schema,
            inspector=inspector,
            query_executor=query_executor,
        )
    except UnsupportedSchemaGuardDialect as exc:
        return SchemaComparison(
            schema=schema,
            diagnostics=(
                SchemaDiagnostic(
                    code="unsupported_dialect",
                    message=str(exc),
                    object_type="database",
                    expected="postgresql",
                    actual=_dialect_name(engine),
                ),
            ),
        )
    except SchemaInspectionError as exc:
        return SchemaComparison(
            schema=schema,
            diagnostics=(
                SchemaDiagnostic(
                    code="inspection_error",
                    message=str(exc),
                    object_type="catalog",
                ),
            ),
        )

    return compare_snapshot(
        snapshot,
        contract=contract,
        strict_extra_columns=strict_extra_columns,
        strict_names=strict_names,
    )


def compare_snapshot(
    snapshot: SchemaSnapshot,
    *,
    contract: SchemaContract = PRODUCTION_PUBLIC_SCHEMA_CONTRACT,
    strict_extra_columns: bool = True,
    strict_names: bool = False,
) -> SchemaComparison:
    """Compare an already-read catalog snapshot (a pure, testable operation)."""

    diagnostics: list[SchemaDiagnostic] = []
    if snapshot.schema != contract.schema:
        diagnostics.append(
            SchemaDiagnostic(
                code="schema_name_mismatch",
                message=f"Expected schema {contract.schema!r}, found {snapshot.schema!r}.",
                object_type="schema",
                expected=contract.schema,
                actual=snapshot.schema,
            )
        )

    for table_name, expected_table in contract.tables.items():
        actual_table = snapshot.tables.get(table_name)
        if actual_table is None:
            diagnostics.append(
                SchemaDiagnostic(
                    code="missing_table",
                    message=f"Required table {contract.schema}.{table_name} is missing or unreadable.",
                    table=table_name,
                    object_type="table",
                    object_name=table_name,
                    expected="present",
                    actual="missing",
                )
            )
            continue

        diagnostics.extend(
            _compare_columns(
                table_name,
                expected_table.columns,
                actual_table.columns,
                strict_extra_columns=strict_extra_columns,
            )
        )
        diagnostics.extend(
            _compare_constraints(
                table_name,
                expected_table.constraints,
                actual_table.constraints,
                schema=contract.schema,
                strict_names=strict_names,
            )
        )
        diagnostics.extend(
            _compare_indexes(
                table_name,
                expected_table.indexes,
                actual_table.indexes,
                strict_names=strict_names,
            )
        )

    return SchemaComparison(schema=snapshot.schema, diagnostics=tuple(diagnostics), snapshot=snapshot)


def _require_postgresql(engine: Any) -> None:
    dialect = _dialect_name(engine)
    if dialect != "postgresql":
        raise UnsupportedSchemaGuardDialect(
            "Schema guard supports PostgreSQL only; "
            f"engine dialect is {dialect or 'unknown'}.")


def _dialect_name(engine: Any) -> Optional[str]:
    dialect = getattr(engine, "dialect", None)
    name = getattr(dialect, "name", None)
    return str(name).lower() if name else None


def _execute_catalog_query(
    engine: Any,
    statement: str,
    schema: str,
    query_executor: Optional[QueryExecutor],
) -> list[Mapping[str, Any]]:
    params = {"schema": schema}
    if query_executor is not None:
        return [_as_mapping(row) for row in query_executor(statement, params)]
    with engine.connect() as connection:
        result = connection.execute(text(statement), params)
        return [_as_mapping(row) for row in result.mappings().all()]


def _snapshot_from_catalog_rows(
    *,
    schema: str,
    inspector: Any,
    columns_rows: Iterable[Mapping[str, Any]],
    indexes_rows: Iterable[Mapping[str, Any]],
) -> SchemaSnapshot:
    columns_by_table: dict[str, dict[str, ActualColumn]] = {name: {} for name in TABLE_NAMES}
    for raw_row in columns_rows:
        row = _as_mapping(raw_row)
        table_name = str(row.get("table_name") or "")
        if table_name not in columns_by_table:
            continue
        name = str(row.get("column_name") or "")
        if not name:
            continue
        columns_by_table[table_name][name] = ActualColumn(
            name=name,
            pg_type=_canonical_pg_type(row.get("data_type"), row.get("udt_name")),
            nullable=_catalog_bool(row.get("is_nullable"), true_values={"YES", "TRUE", "1"}),
            char_length=_as_int(row.get("character_maximum_length")),
            default=_optional_string(row.get("column_default")),
            generated=_catalog_bool(row.get("is_generated"), true_values={"ALWAYS", "YES", "TRUE", "1"}),
            generation_expression=_optional_string(row.get("generation_expression")),
        )

    indexes_by_table: dict[str, list[ActualIndex]] = {name: [] for name in TABLE_NAMES}
    for raw_row in indexes_rows:
        row = _as_mapping(raw_row)
        table_name = str(row.get("table_name") or "")
        if table_name not in indexes_by_table:
            continue
        index_name = _optional_string(row.get("index_name"))
        index_definition = _optional_string(row.get("index_definition"))
        if index_name and index_definition:
            indexes_by_table[table_name].append(ActualIndex(index_name, index_definition))

    tables: dict[str, ActualTable] = {}
    for table_name in TABLE_NAMES:
        # A table absent from information_schema must remain absent in the
        # snapshot; representing it as an empty table would hide a missing-table
        # diagnostic behind dozens of missing-column diagnostics.
        if not columns_by_table[table_name]:
            continue
        tables[table_name] = ActualTable(
            columns=MappingProxyType(columns_by_table[table_name]),
            constraints=_read_constraints(inspector, table_name, schema),
            indexes=tuple(indexes_by_table[table_name]),
        )
    return SchemaSnapshot(schema=schema, tables=MappingProxyType(tables))


def _read_constraints(inspector: Any, table_name: str, schema: str) -> tuple[ActualConstraint, ...]:
    constraints: list[ActualConstraint] = []
    primary_key = inspector.get_pk_constraint(table_name, schema=schema) or {}
    primary_columns = tuple(primary_key.get("constrained_columns") or ())
    if primary_columns:
        constraints.append(
            ActualConstraint(
                name=_optional_string(primary_key.get("name")),
                kind="primary_key",
                columns=primary_columns,
            )
        )

    for unique in inspector.get_unique_constraints(table_name, schema=schema) or ():
        columns = tuple(unique.get("column_names") or unique.get("constrained_columns") or ())
        if columns:
            constraints.append(
                ActualConstraint(
                    name=_optional_string(unique.get("name")),
                    kind="unique",
                    columns=columns,
                )
            )

    for foreign_key in inspector.get_foreign_keys(table_name, schema=schema) or ():
        columns = tuple(foreign_key.get("constrained_columns") or ())
        referred_columns = tuple(foreign_key.get("referred_columns") or ())
        referred_table = _optional_string(foreign_key.get("referred_table"))
        if columns and referred_table:
            constraints.append(
                ActualConstraint(
                    name=_optional_string(foreign_key.get("name")),
                    kind="foreign_key",
                    columns=columns,
                    referred_schema=_optional_string(foreign_key.get("referred_schema")),
                    referred_table=referred_table,
                    referred_columns=referred_columns,
                )
            )
    return tuple(constraints)


def _compare_columns(
    table_name: str,
    expected_columns: Sequence[ColumnExpectation],
    actual_columns: Mapping[str, ActualColumn],
    *,
    strict_extra_columns: bool,
) -> list[SchemaDiagnostic]:
    diagnostics: list[SchemaDiagnostic] = []
    expected_by_name = {column.name: column for column in expected_columns}
    for expected in expected_columns:
        actual = actual_columns.get(expected.name)
        if actual is None:
            diagnostics.append(
                _diagnostic(
                    "missing_column",
                    f"Required column {table_name}.{expected.name} is missing.",
                    table_name,
                    "column",
                    expected.name,
                    expected.as_dict(),
                    "missing",
                )
            )
            continue

        if actual.pg_type != expected.pg_type:
            diagnostics.append(
                _diagnostic(
                    "column_type_mismatch",
                    f"{table_name}.{expected.name} has type {actual.pg_type!r}; "
                    f"expected {expected.pg_type!r}.",
                    table_name,
                    "column",
                    expected.name,
                    expected.pg_type,
                    actual.pg_type,
                )
            )
        if actual.nullable != expected.nullable:
            diagnostics.append(
                _diagnostic(
                    "column_nullability_mismatch",
                    f"{table_name}.{expected.name} nullable={actual.nullable}; "
                    f"expected {expected.nullable}.",
                    table_name,
                    "column",
                    expected.name,
                    expected.nullable,
                    actual.nullable,
                )
            )
        if actual.char_length != expected.char_length:
            diagnostics.append(
                _diagnostic(
                    "column_length_mismatch",
                    f"{table_name}.{expected.name} has character length {actual.char_length!r}; "
                    f"expected {expected.char_length!r}.",
                    table_name,
                    "column",
                    expected.name,
                    expected.char_length,
                    actual.char_length,
                )
            )
        if not _default_matches(expected, actual.default):
            diagnostics.append(
                _diagnostic(
                    "column_default_mismatch",
                    f"{table_name}.{expected.name} default does not match the production contract.",
                    table_name,
                    "column",
                    expected.name,
                    {"kind": expected.default_kind, "value": expected.default_value},
                    actual.default,
                )
            )
        if actual.generated != expected.generated:
            diagnostics.append(
                _diagnostic(
                    "column_generated_mismatch",
                    f"{table_name}.{expected.name} generated={actual.generated}; "
                    f"expected {expected.generated}.",
                    table_name,
                    "column",
                    expected.name,
                    expected.generated,
                    actual.generated,
                )
            )
        elif expected.generated and not _generated_expression_matches(
            expected.generated_expression or "", actual.generation_expression
        ):
            diagnostics.append(
                _diagnostic(
                    "column_generation_expression_mismatch",
                    f"{table_name}.{expected.name} has a different generated expression.",
                    table_name,
                    "column",
                    expected.name,
                    expected.generated_expression,
                    actual.generation_expression,
                )
            )

    if strict_extra_columns:
        for name, actual in actual_columns.items():
            if name not in expected_by_name:
                diagnostics.append(
                    _diagnostic(
                        "unexpected_column",
                        f"{table_name}.{name} is not in the approved production contract.",
                        table_name,
                        "column",
                        name,
                        "not present",
                        actual.as_dict(),
                    )
                )
    return diagnostics


def _compare_constraints(
    table_name: str,
    expected_constraints: Sequence[ConstraintExpectation],
    actual_constraints: Sequence[ActualConstraint],
    *,
    schema: str,
    strict_names: bool,
) -> list[SchemaDiagnostic]:
    diagnostics: list[SchemaDiagnostic] = []
    for expected in expected_constraints:
        candidates = [
            actual
            for actual in actual_constraints
            if _constraint_matches(expected, actual, schema)
        ]
        if not candidates:
            same_name = next((actual for actual in actual_constraints if actual.name == expected.name), None)
            code = "constraint_definition_mismatch" if same_name else "missing_constraint"
            message = (
                f"Constraint {table_name}.{expected.name} exists but does not match the contract."
                if same_name
                else f"Required constraint {table_name}.{expected.name} is missing."
            )
            diagnostics.append(
                _diagnostic(
                    code,
                    message,
                    table_name,
                    "constraint",
                    expected.name,
                    expected.as_dict(),
                    same_name.as_dict() if same_name else "missing",
                )
            )
            continue

        actual = candidates[0]
        if actual.name != expected.name:
            diagnostics.append(
                _diagnostic(
                    "constraint_name_mismatch",
                    f"{table_name} has the required {expected.kind} constraint under "
                    f"{actual.name!r}, not expected name {expected.name!r}.",
                    table_name,
                    "constraint",
                    expected.name,
                    expected.name,
                    actual.name,
                    severity="error" if strict_names else "warning",
                )
            )
    return diagnostics


def _compare_indexes(
    table_name: str,
    expected_indexes: Sequence[IndexExpectation],
    actual_indexes: Sequence[ActualIndex],
    *,
    strict_names: bool,
) -> list[SchemaDiagnostic]:
    diagnostics: list[SchemaDiagnostic] = []
    for expected in expected_indexes:
        semantic_matches = [
            actual for actual in actual_indexes if _index_matches(expected, actual.definition)
        ]
        if not semantic_matches:
            same_name = next((actual for actual in actual_indexes if actual.name == expected.name), None)
            code = "index_definition_mismatch" if same_name else "missing_index"
            message = (
                f"Index {table_name}.{expected.name} exists but does not match the contract."
                if same_name
                else f"Required index {table_name}.{expected.name} is missing."
            )
            diagnostics.append(
                _diagnostic(
                    code,
                    message,
                    table_name,
                    "index",
                    expected.name,
                    expected.as_dict(),
                    same_name.as_dict() if same_name else "missing",
                )
            )
            continue

        actual = next((index for index in semantic_matches if index.name == expected.name), semantic_matches[0])
        if actual.name != expected.name:
            diagnostics.append(
                _diagnostic(
                    "index_name_mismatch",
                    f"{table_name} has the required index under {actual.name!r}, not "
                    f"expected name {expected.name!r}.",
                    table_name,
                    "index",
                    expected.name,
                    expected.name,
                    actual.name,
                    severity="error" if strict_names else "warning",
                )
            )
    return diagnostics


def _diagnostic(
    code: str,
    message: str,
    table: str,
    object_type: str,
    object_name: str,
    expected: Any,
    actual: Any,
    *,
    severity: str = "error",
) -> SchemaDiagnostic:
    return SchemaDiagnostic(
        code=code,
        message=message,
        severity=severity,
        table=table,
        object_type=object_type,
        object_name=object_name,
        expected=expected,
        actual=actual,
    )


def _constraint_matches(
    expected: ConstraintExpectation, actual: ActualConstraint, schema: str
) -> bool:
    if expected.kind != actual.kind or expected.columns != actual.columns:
        return False
    if expected.kind != "foreign_key":
        return True
    actual_schema = actual.referred_schema or schema
    expected_schema = expected.referred_schema or schema
    return (
        actual_schema == expected_schema
        and actual.referred_table == expected.referred_table
        and actual.referred_columns == expected.referred_columns
    )


def _index_matches(expected: IndexExpectation, definition: str) -> bool:
    actual_method, actual_columns, actual_where = _parse_index_definition(definition)
    if actual_method != expected.method.lower():
        return False
    expected_columns = tuple(_normalise_index_column(column) for column in expected.columns)
    if actual_columns != expected_columns:
        return False
    expected_where = _normalise_predicate(expected.where)
    return actual_where == expected_where


def _parse_index_definition(definition: str) -> tuple[str, tuple[str, ...], Optional[str]]:
    match = re.search(r"\busing\s+([a-zA-Z0-9_]+)\s*\(", definition, flags=re.IGNORECASE)
    if not match:
        return "", (), _normalise_predicate(_index_where_clause(definition))
    method = match.group(1).lower()
    open_paren = definition.find("(", match.start())
    close_paren = _matching_paren(definition, open_paren)
    if close_paren is None:
        return method, (), _normalise_predicate(_index_where_clause(definition))
    raw_columns = definition[open_paren + 1 : close_paren]
    columns = tuple(
        _normalise_index_column(column)
        for column in _split_top_level(raw_columns)
        if column.strip()
    )
    return method, columns, _normalise_predicate(_index_where_clause(definition[close_paren + 1 :]))


def _matching_paren(value: str, open_paren: int) -> Optional[int]:
    depth = 0
    in_quote = False
    index = open_paren
    while index < len(value):
        char = value[index]
        if char == "'":
            if in_quote and index + 1 < len(value) and value[index + 1] == "'":
                index += 2
                continue
            in_quote = not in_quote
        elif not in_quote:
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    return index
        index += 1
    return None


def _split_top_level(value: str) -> list[str]:
    result: list[str] = []
    start = 0
    depth = 0
    in_quote = False
    index = 0
    while index < len(value):
        char = value[index]
        if char == "'":
            if in_quote and index + 1 < len(value) and value[index + 1] == "'":
                index += 2
                continue
            in_quote = not in_quote
        elif not in_quote:
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
            elif char == "," and depth == 0:
                result.append(value[start:index])
                start = index + 1
        index += 1
    result.append(value[start:])
    return result


def _index_where_clause(value: str) -> Optional[str]:
    match = re.search(r"\bwhere\b\s*(.+)$", value, flags=re.IGNORECASE | re.DOTALL)
    return match.group(1) if match else None


def _normalise_index_column(value: str) -> str:
    compact = _normalise_sql(value)
    return compact.replace("asc", "")


def _normalise_predicate(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    compact = _normalise_sql(_strip_pg_casts(value))
    # pg_get_indexdef wraps logical clauses liberally.  Parentheses do not
    # change these simple approved partial-index predicates.
    return compact.replace("(", "").replace(")", "")


def _generated_expression_matches(expected: str, actual: Optional[str]) -> bool:
    if not actual:
        return False
    # A direct normalized match covers the normal case.  PostgreSQL also adds
    # harmless parentheses, casts NULL to geography, and may qualify functions,
    # so recognize the two verified expressions by their semantics as a
    # fallback.  The checks deliberately preserve lng,lat ordering.
    expected_normalized = _normalise_sql(_strip_pg_casts(expected))
    actual_normalized = _normalise_sql(_strip_pg_casts(actual))
    if expected_normalized == actual_normalized:
        return True
    if expected_normalized.replace("(", "").replace(")", "") == actual_normalized.replace("(", "").replace(")", ""):
        return True

    point_pattern = r"st_makepoint\s*\(\s*(?:public\.)?lng\s*,\s*(?:public\.)?lat\s*\)"
    srid_pattern = (
        r"(?:public\.)?st_setsrid\s*\(\s*(?:\(+\s*)?"
        + point_pattern
        + r"(?:\s*\)+)?\s*,\s*4326\s*\)"
    )
    if not re.search(srid_pattern, actual, flags=re.IGNORECASE) or "geography" not in actual.lower():
        return False
    if "case when" not in expected.lower():
        return True

    actual_lower = actual.lower()
    null_test = r"(?:\(+\s*)?{first}\s+is\s+null(?:\s*\)+)?\s+or\s+(?:\(+\s*)?{second}\s+is\s+null"
    has_null_or = bool(
        re.search(null_test.format(first="lat", second="lng"), actual_lower)
        or re.search(null_test.format(first="lng", second="lat"), actual_lower)
    )
    return "case" in actual_lower and "else" in actual_lower and "end" in actual_lower and has_null_or


def _default_matches(expected: ColumnExpectation, actual_default: Optional[str]) -> bool:
    kind, value = _classify_default(actual_default, expected.pg_type)
    if expected.default_kind == "none":
        return kind == "none"
    if kind != expected.default_kind:
        return False
    return expected.default_kind != "literal" or value == expected.default_value


def _classify_default(value: Optional[str], pg_type: str) -> tuple[str, Any]:
    if value is None:
        return "none", None
    normalized = _unwrap_parentheses(str(value).strip().lower())
    if normalized.startswith("nextval("):
        return "sequence", None
    normalized = _unwrap_parentheses(_strip_pg_casts(normalized))
    if normalized in {"now()", "current_timestamp", "transaction_timestamp()"}:
        return "now", None
    if pg_type == "_text" and normalized in {"'{}'", "{}"}:
        return "empty_text_array", None
    if pg_type == "jsonb" and normalized in {"'[]'", "[]"}:
        return "empty_json_array", None
    literal = normalized
    if len(literal) >= 2 and literal[0] == "'" and literal[-1] == "'":
        literal = literal[1:-1].replace("''", "'")
    if literal == "true":
        return "literal", True
    if literal == "false":
        return "literal", False
    if re.fullmatch(r"[-+]?\d+", literal):
        return "literal", int(literal)
    return "literal", literal


def _unwrap_parentheses(value: str) -> str:
    result = value.strip()
    while result.startswith("(") and result.endswith(")"):
        close = _matching_paren(result, 0)
        if close != len(result) - 1:
            break
        result = result[1:-1].strip()
    return result


def _canonical_pg_type(data_type: Any, udt_name: Any) -> str:
    udt = str(udt_name or "").strip().lower()
    data = str(data_type or "").strip().lower()
    known_udts = {
        "int8", "int4", "float8", "float4", "bpchar", "text", "_text",
        "jsonb", "timestamptz", "date", "bool", "numeric", "geography",
    }
    if udt in known_udts:
        return udt
    aliases = {
        "bigint": "int8",
        "integer": "int4",
        "real": "float4",
        "double precision": "float8",
        "character": "bpchar",
        "char": "bpchar",
        "text": "text",
        "date": "date",
        "boolean": "bool",
        "numeric": "numeric",
        "timestamp with time zone": "timestamptz",
        "timestamp without time zone": "timestamp",
    }
    return aliases.get(data, udt or data)


def _catalog_bool(value: Any, *, true_values: set[str]) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().upper() in true_values


def _as_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_string(value: Any) -> Optional[str]:
    return None if value is None else str(value)


def _as_mapping(row: Any) -> Mapping[str, Any]:
    if isinstance(row, Mapping):
        return row
    row_mapping = getattr(row, "_mapping", None)
    if row_mapping is not None:
        return row_mapping
    try:
        return dict(row)
    except Exception as exc:  # pragma: no cover - protects callers' custom fakes
        raise SchemaInspectionError(f"Catalog query returned a non-mapping row: {row!r}") from exc


def _strip_pg_casts(value: str) -> str:
    # Defaults and generated expressions use simple PostgreSQL casts such as
    # ``'pending'::text`` and ``NULL::geography``.  Removing them before
    # normalization makes semantically identical catalog renderings compare.
    return re.sub(
        r"::(?:pg_catalog\.)?(?:"
        r"(?:timestamp|time)\s+(?:with(?:out)?\s+)?time\s+zone"
        r"|double\s+precision"
        r"|character\s+varying"
        r"|\"?[a-z_][a-z0-9_$]*\"?(?:\[\])?"
        r")",
        "",
        value,
        flags=re.IGNORECASE,
    )


def _normalise_sql(value: str) -> str:
    normalized = value.lower().replace('"', "")
    normalized = re.sub(r"\b(?:public|pg_catalog)\.", "", normalized)
    return re.sub(r"\s+", "", normalized)


__all__ = [
    "ActualColumn",
    "ActualConstraint",
    "ActualIndex",
    "ActualTable",
    "ColumnExpectation",
    "ConstraintExpectation",
    "EXPECTED_SCHEMA",
    "HOTELS_GEOG_EXPRESSION",
    "IndexExpectation",
    "PRODUCTION_PUBLIC_SCHEMA_CONTRACT",
    "SchemaComparison",
    "SchemaContract",
    "SchemaDiagnostic",
    "SchemaInspectionError",
    "SchemaSnapshot",
    "TableExpectation",
    "UnsupportedSchemaGuardDialect",
    "ZIPS_GEOG_EXPRESSION",
    "compare_schema",
    "compare_snapshot",
    "inspect_schema",
]
