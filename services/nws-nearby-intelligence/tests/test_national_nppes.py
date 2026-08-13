from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.national_nppes import NPPES_REGISTRY_URL, NppesCandidateProvider
from app.nws_models import (
    GeoPoint,
    LocationAssociationKind,
    LocationGranularity,
    ProfessionalLane,
)

NOW = datetime(2026, 8, 14, 2, 0, tzinfo=UTC)


def _row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "npi": "1962647586",
        "first_name": "MA. THERESA",
        "middle_name": None,
        "last_name": "ABARING",
        "credential": "CRNA",
        "primary_taxonomy_code": "367500000X",
        "primary_taxonomy_desc": "Nurse Anesthetist, Certified Registered",
        "city": "CHICAGO",
        "state": "IL",
        "zip": "60637",
        "lat": 41.782504,
        "lng": -87.602734,
        "last_seen": datetime(2026, 7, 28, 14, 4, tzinfo=UTC),
    }
    row.update(overrides)
    return row


def _provider(rows: list[dict[str, object]]) -> NppesCandidateProvider:
    return NppesCandidateProvider(row_query=lambda _query, _params: rows, clock=lambda: NOW)


def test_fetch_queries_least_privilege_view_by_postgis_radius() -> None:
    captured: dict[str, object] = {}

    def query(sql: str, params: dict[str, object]) -> list[dict[str, object]]:
        captured["sql"] = sql
        captured["params"] = dict(params)
        return [_row()]

    result = NppesCandidateProvider(row_query=query, clock=lambda: NOW).fetch(
        query_point=GeoPoint(41.782504, -87.602734),
        radius_km=40.2336,
        limit=60,
    )

    sql = str(captured["sql"])
    assert "FROM public.nws_public_professionals p" in sql
    assert "FROM providers" not in sql
    assert "ST_DWithin" in sql
    assert "address_line" not in sql
    assert "phone" not in sql
    assert "raw" not in sql
    assert captured["params"] == {
        "latitude": 41.782504,
        "longitude": -87.602734,
        "radius_meters": 40233.6,
        "limit": 60,
    }
    assert result.source_status["status"] == "OK"
    assert result.source_status["query_mode"] == "COORDINATE_RADIUS"


def test_postal_query_uses_indexed_exact_zip_path() -> None:
    captured: dict[str, object] = {}

    def query(sql: str, params: dict[str, object]) -> list[dict[str, object]]:
        captured["sql"] = sql
        captured["params"] = dict(params)
        return [_row()]

    result = NppesCandidateProvider(row_query=query, clock=lambda: NOW).fetch(
        query_point=GeoPoint(41.782504, -87.602734),
        radius_km=25,
        limit=60,
        postal_code="60637",
    )

    sql = str(captured["sql"])
    assert "FROM public.nws_public_professionals p" in sql
    assert "p.zip = %(postal_code)s" in sql
    assert "ST_DWithin" not in sql
    assert captured["params"] == {"postal_code": "60637", "limit": 60}
    assert result.source_status["query_mode"] == "POSTAL_CODE"


def test_row_becomes_source_verified_public_practice_candidate() -> None:
    result = _provider([_row()]).fetch(query_point=GeoPoint(41.78, -87.60), radius_km=25, limit=10)

    assert len(result.candidates) == 1
    candidate = result.candidates[0]
    assert candidate.person_id == "nppes:1962647586"
    assert candidate.display_name == "Ma. Theresa Abaring"
    assert candidate.headline == "CRNA · Nurse Anesthetist, Certified Registered"
    assert candidate.primary_lane is ProfessionalLane.KNOWLEDGE
    assert candidate.organization_id is None
    assert candidate.graph_community_id is None
    assert candidate.location.label == "Chicago, IL 60637 public practice area"
    assert candidate.location.kind is LocationAssociationKind.SELF_PUBLISHED_PROFESSIONAL
    assert candidate.location.granularity is LocationGranularity.POSTAL_AREA
    assert candidate.public_profile_url == f"{NPPES_REGISTRY_URL}provider-view/1962647586"


def test_metadata_is_single_source_unscored_and_cites_cms() -> None:
    result = _provider([_row()]).fetch(query_point=GeoPoint(41.78, -87.60), radius_km=25, limit=10)
    metadata = result.metadata["nppes:1962647586"]

    assert metadata.score_status == "PROVISIONAL"
    assert metadata.source_family_count == 1
    assert metadata.evidence_fact_count == 5
    assert metadata.revalidation_required is False
    assert "NO_FINANCIAL_INPUTS" in metadata.review_flags
    assert metadata.citations[0].publisher == "Centers for Medicare & Medicaid Services"
    assert metadata.citations[0].url.endswith("/provider-view/1962647586")


def test_features_leave_network_outcomes_reach_and_finance_at_zero() -> None:
    result = _provider([_row()]).fetch(query_point=GeoPoint(41.78, -87.60), radius_km=25, limit=10)
    features = result.candidates[0].features

    assert features.pagerank_percentile == 0
    assert features.kcore_percentile == 0
    assert features.bridging_percentile == 0
    assert features.outcome_track_record_percentile == 0
    assert features.knowledge_creation_percentile == 0
    assert features.capital_access_percentile == 0
    assert features.trusted_reach_percentile == 0
    assert features.verified_social_reach_percentile == 0
    assert features.evidence_count == 5
    assert features.freshness == pytest.approx(0.9534)


def test_invalid_or_duplicate_rows_are_rejected_without_exposing_payloads() -> None:
    result = _provider(
        [
            _row(npi="bad"),
            _row(),
            _row(phone="312-555-0100", address_line1="private output forbidden"),
        ]
    ).fetch(query_point=GeoPoint(41.78, -87.60), radius_km=25, limit=10)

    assert len(result.candidates) == 1
    assert result.source_status["rows_received"] == 3
    assert result.source_status["rows_rejected"] == 2
    rendered = repr(result)
    assert "312-555-0100" not in rendered
    assert "private output forbidden" not in rendered


def test_empty_and_unavailable_sources_report_explicit_status() -> None:
    empty = _provider([]).fetch(query_point=GeoPoint(41.78, -87.60), radius_km=25, limit=10)
    assert empty.source_status["status"] == "EMPTY"
    assert empty.source_status["candidate_count"] == 0

    def broken(_sql: str, _params: dict[str, object]) -> list[dict[str, object]]:
        raise RuntimeError("postgresql://secret:password@example.invalid/private")

    unavailable = NppesCandidateProvider(row_query=broken, clock=lambda: NOW).fetch(
        query_point=GeoPoint(41.78, -87.60), radius_km=25, limit=10
    )
    assert unavailable.source_status["status"] == "UNAVAILABLE"
    assert unavailable.source_status["error_code"] == "NPPES_QUERY_FAILED"
    assert "password" not in repr(unavailable)


def test_connection_factory_is_supported_without_importing_psycopg() -> None:
    class Cursor:
        def fetchall(self) -> list[dict[str, object]]:
            return [_row()]

    class Connection:
        def __init__(self) -> None:
            self.called = False
            self.timeout_set = False

        def __enter__(self) -> Connection:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def execute(self, sql: str, params: dict[str, object]) -> Cursor:
            if sql.startswith("SET LOCAL statement_timeout"):
                self.timeout_set = params["timeout_ms"] == 8_000
                return Cursor()
            self.called = "ST_DWithin" in sql and params["limit"] == 10
            return Cursor()

    connection = Connection()
    result = NppesCandidateProvider(
        connection_factory=lambda: connection,
        clock=lambda: NOW,
    ).fetch(query_point=GeoPoint(41.78, -87.60), radius_km=25, limit=10)

    assert connection.called is True
    assert connection.timeout_set is True
    assert result.source_status["status"] == "OK"


@pytest.mark.parametrize(
    ("radius_km", "limit"),
    [(0, 1), (501, 1), (1, 0), (1, 2001)],
)
def test_fetch_rejects_unsafe_query_bounds(radius_km: float, limit: int) -> None:
    with pytest.raises(ValueError):
        _provider([]).fetch(
            query_point=GeoPoint(41.78, -87.60),
            radius_km=radius_km,
            limit=limit,
        )


@pytest.mark.parametrize("postal_code", ["", "6063", "60637-1234", "ABCDE"])
def test_fetch_rejects_noncanonical_us_postal_code(postal_code: str) -> None:
    with pytest.raises(ValueError, match="five-digit US ZIP"):
        _provider([]).fetch(
            query_point=GeoPoint(41.78, -87.60),
            radius_km=25,
            limit=10,
            postal_code=postal_code,
        )
