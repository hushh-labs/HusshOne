from __future__ import annotations

import json
from dataclasses import asdict
from datetime import date
from urllib.parse import parse_qs, urlsplit

import pytest

from app.national_sec import NationalSecProfessionalAdapter, NationalSecSourceError
from app.nearby_policy import NearbyPolicyEngine
from app.nws_models import GeoPoint, LocationGranularity, ProfessionalLane


class FakeTransport:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload
        self.calls: list[tuple[str, dict[str, str], float]] = []

    def get_json(
        self,
        url: str,
        *,
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> dict[str, object]:
        self.calls.append((url, dict(headers), timeout_seconds))
        return self.payload


def holder(
    *,
    cik: str,
    name: str,
    roles: list[str],
    issuer_cik: str = "100",
    filing_as_of: str = "2026-08-01",
    latitude: float = 41.881,
    longitude: float = -87.632,
    precision: str = "street_interpolated",
) -> dict[str, object]:
    return {
        "cik": cik,
        "name": name,
        "roles": roles,
        "title": "Chief Operating Officer" if "Officer" in roles else None,
        "subjectType": "person",
        "issuer": {
            "cik": issuer_cik,
            "name": "Example Public Company",
            "city": "Chicago",
            "state": "IL",
            "zip": "60606",
            "street1": "444 SECRET-FROM-NWS STREET",
            "phone": "555-0100",
        },
        "professional": {
            "roleAuthority": 2,
            "filingAsOf": filing_as_of,
            "issuerOffice": {
                "latitude": latitude,
                "longitude": longitude,
                "geoPrecision": precision,
            },
        },
        "position": {
            "security": "COMMON STOCK",
            "shares": 9_999_999,
            "disclosedValue": 123_000_000,
            "marketValue": 999_000_000,
            "marketPrice": 999,
        },
        "liquidity": {"aggregateMarketValue": 42_000_000},
        "distanceMiles": 4.2,
        "resolved": {"lat": 41.78, "lng": -87.60},
    }


def payload() -> dict[str, object]:
    return {
        "ok": True,
        "ranking": {
            "mode": "professional",
            "relationshipScope": "selected_position",
            "orderedBy": [
                "officer_director_role_authority",
                "filing_recency",
                "issuer_office_distance",
            ],
            "excludes": ["disclosed_value", "market_value"],
        },
        "index": {
            "built": True,
            "builtAt": "2026-08-11T21:15:57.138Z",
            "partial": False,
            "stale": False,
        },
        "holders": [
            holder(cik="000123", name="ALICE EXAMPLE", roles=["Officer", "Director"]),
            holder(
                cik="456",
                name="BOB EXAMPLE",
                roles=["Director"],
                issuer_cik="200",
                precision="zip_centroid",
            ),
            holder(cik="789", name="EXAMPLE CAPITAL LLC", roles=["Officer"]),
            holder(cik="900", name="OWNER ONLY", roles=["TenPercentOwner"]),
            holder(cik="not-a-cik", name="INVALID RECORD", roles=["Officer"]),
        ],
        "total": 500,
        "hasMore": True,
    }


def adapter(transport: FakeTransport, *, clock=lambda: 10.0) -> NationalSecProfessionalAdapter:
    return NationalSecProfessionalAdapter(
        base_url="https://insider-source.test",
        bearer_token="server-held-secret",
        transport=transport,
        cache_ttl_seconds=30,
        clock=clock,
        today=lambda: date(2026, 8, 14),
    )


def test_adapter_requests_professional_mode_and_maps_only_public_professional_facts() -> None:
    transport = FakeTransport(payload())
    batch = adapter(transport).discover(
        query_point=GeoPoint(41.782504, -87.602734),
        radius_km=40,
        limit=100,
    )

    assert [candidate.display_name for candidate in batch.candidates] == [
        "ALICE EXAMPLE",
        "BOB EXAMPLE",
    ]
    assert batch.source_status.accepted_candidate_count == 2
    assert batch.source_status.upstream_total == 500
    assert batch.source_status.truncated is True
    assert batch.source_status.index_stale is False
    assert batch.source_status.rejected_entity_count == 1
    assert batch.source_status.rejected_owner_only_count == 1
    assert batch.source_status.rejected_invalid_count == 1

    url, headers, timeout = transport.calls[0]
    query = parse_qs(urlsplit(url).query)
    assert query["ranking"] == ["professional"]
    assert query["subjectType"] == ["person"]
    assert query["lat"] == ["41.78"]
    assert query["lng"] == ["-87.6"]
    assert query["stream"] == ["json"]
    assert "server-held-secret" not in url
    assert headers["Authorization"] == "Bearer server-held-secret"
    assert timeout == 5.0

    alice, bob = batch.candidates
    assert alice.person_id == "sec-reporting-owner:123"
    assert alice.organization_id == "sec-issuer:100"
    assert alice.primary_lane is ProfessionalLane.BUILDER
    assert alice.features.capital_access_percentile == 0.0
    assert alice.features.pagerank_percentile == 0.0
    assert alice.location.point == GeoPoint(41.88, -87.63)
    assert NearbyPolicyEngine().authorize_candidate(alice).allowed
    assert bob.location.granularity is LocationGranularity.POSTAL_AREA
    assert bob.primary_lane is ProfessionalLane.CONNECTOR

    public_boundary = json.dumps(
        {
            "metadata": {person_id: asdict(item) for person_id, item in batch.metadata.items()},
            "labels": [candidate.location.label for candidate in batch.candidates],
            "headlines": [candidate.headline for candidate in batch.candidates],
            "tags": [candidate.tags for candidate in batch.candidates],
        }
    ).casefold()
    for forbidden in (
        "marketvalue",
        "disclosedvalue",
        "shares",
        "security",
        "marketprice",
        "street1",
        "secret-from-nws",
        "phone",
        "latitude",
        "longitude",
        "distance",
        "liquidity",
    ):
        assert forbidden not in public_boundary


def test_adapter_caches_a_safe_batch_briefly_and_revalidates_after_ttl() -> None:
    now = [100.0]
    transport = FakeTransport(payload())
    source = adapter(transport, clock=lambda: now[0])
    arguments = {
        "query_point": GeoPoint(41.782504, -87.602734),
        "radius_km": 40,
        "limit": 60,
    }

    first = source.discover(**arguments)
    second = source.discover(**arguments)
    assert first.source_status.cache_hit is False
    assert second.source_status.cache_hit is True
    assert len(transport.calls) == 1

    now[0] += 31
    third = source.discover(**arguments)
    assert third.source_status.cache_hit is False
    assert len(transport.calls) == 2


def test_adapter_fails_closed_if_source_does_not_confirm_value_free_ranking() -> None:
    unsafe = payload()
    unsafe["ranking"] = {"mode": "financial", "excludes": []}
    source = adapter(FakeTransport(unsafe))

    with pytest.raises(NationalSecSourceError, match="professional ranking"):
        source.discover(query_point=GeoPoint(41.78, -87.60), radius_km=40)


def test_adapter_fails_closed_if_roles_are_not_scoped_to_selected_issuer() -> None:
    unsafe = payload()
    ranking = unsafe["ranking"]
    assert isinstance(ranking, dict)
    ranking.pop("relationshipScope")

    with pytest.raises(NationalSecSourceError, match="selected issuer position"):
        adapter(FakeTransport(unsafe)).discover(query_point=GeoPoint(41.78, -87.60), radius_km=40)
