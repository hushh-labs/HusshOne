from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict
from decimal import Decimal
from urllib.parse import parse_qs, urlsplit

import pytest

from app.florida_net_worth import (
    FloridaForm6NetWorthAdapter,
    FloridaForm6Outcome,
    FloridaForm6SourceError,
    PublicJurisdiction,
    PublicJurisdictionKind,
)


class FakeTransport:
    def __init__(
        self,
        payloads: list[Mapping[str, object]],
        *,
        error: Exception | None = None,
    ) -> None:
        self.payloads = payloads
        self.error = error
        self.calls: list[tuple[str, dict[str, str], float]] = []

    def get_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> Mapping[str, object]:
        self.calls.append((url, dict(headers), timeout_seconds))
        if self.error is not None:
            raise self.error
        return self.payloads[len(self.calls) - 1]


def record(
    *,
    filing_id: int,
    amount: object,
    office: str = "Miami-Dade County",
    county: str | None = "Miami-Dade",
) -> dict[str, object]:
    return {
        "name": f"PUBLIC FILER {filing_id}",
        "prefix": "Honorable",
        "offices": [office],
        "county": county,
        "formYear": 2025,
        "netWorth": amount,
        "filingUrl": (
            "https://disclosure.floridaethics.gov/api/Report/RenderPdf/"
            f"{filing_id}/False"
        ),
        # These hostile or overbroad fields must never cross the output allowlist.
        "homeAddress": "901 PRIVATE STREET",
        "phone": "555-0100",
        "email": "private@example.test",
        "assetSchedule": [{"property": "901 PRIVATE STREET"}],
        "liabilitySchedule": [{"creditor": "PRIVATE BANK"}],
        "incomeSchedule": [{"employer": "PRIVATE EMPLOYER"}],
    }


def payload(
    people: list[object],
    *,
    total: int | None = None,
    partial: bool = False,
) -> dict[str, object]:
    total = len(people) if total is None else total
    return {
        "ok": True,
        "total": total,
        "returned": len(people),
        "people": people,
        "index": {
            "built": True,
            "builtAt": "2026-08-11T18:46:24.202Z",
            "formYear": 2025,
            "filingsSeen": 120,
            "withNetWorth": 118,
            "unreadable": 2,
            "partial": partial,
            "people": 118,
            "unexpectedIndexField": "ignored",
        },
        "coverage": (
            "Florida officials required to file Form 6. This is the only US regime "
            "publishing an exact sworn net worth."
        ),
        "disclosure": (
            "Only the sworn net-worth figure is extracted from each filing. The asset, "
            "liability and income schedules are never read or stored."
        ),
        "attribution": {
            "source": (
                "Florida Commission on Ethics — Form 6, Art. II §8(j)(1), Fla. Const."
            ),
            "sourceUrl": "https://disclosure.floridaethics.gov/PublicSearch/Filings",
            "notice": "The Commission record is authoritative.",
        },
        "debug": {"rawPdfText": "must be ignored"},
    }


def adapter(
    transport: FakeTransport,
    *,
    page_size: int = 50,
    max_pages: int = 2,
    clock=lambda: 10.0,
) -> FloridaForm6NetWorthAdapter:
    return FloridaForm6NetWorthAdapter(
        base_url="https://insider-source.test",
        bearer_token="server-held-secret",
        transport=transport,
        timeout_seconds=4,
        cache_ttl_seconds=30,
        page_size=page_size,
        max_pages=max_pages,
        allowed_hosts=frozenset({"insider-source.test"}),
        clock=clock,
    )


def office_jurisdiction(token: str = "Miami-Dade") -> PublicJurisdiction:
    return PublicJurisdiction(kind=PublicJurisdictionKind.OFFICE, token=token)


def test_maps_only_sworn_whole_declaration_and_public_provenance() -> None:
    transport = FakeTransport([payload([record(filing_id=1060050, amount=36_014_962.58)])])
    batch = adapter(transport).discover(public_jurisdiction=office_jurisdiction(), limit=25)

    assert batch.outcome is FloridaForm6Outcome.OK
    assert len(batch.records) == 1
    declaration = batch.records[0]
    assert declaration.subject_id == "florida-form6:1060050"
    assert declaration.name == "PUBLIC FILER 1060050"
    assert declaration.declared_net_worth_usd == Decimal("36014962.58")
    assert declaration.public_offices == ("Miami-Dade County",)
    assert declaration.form_year == 2025
    assert declaration.provenance.declaration_scope == "SWORN_WHOLE_DECLARED_NET_WORTH"

    url, headers, timeout = transport.calls[0]
    query = parse_qs(urlsplit(url).query)
    assert urlsplit(url).scheme == "https"
    assert urlsplit(url).path == "/v1/net-worth"
    assert query == {"office": ["Miami-Dade"], "limit": ["25"], "offset": ["0"]}
    assert "server-held-secret" not in url
    assert headers["Authorization"] == "Bearer server-held-secret"
    assert headers["Accept"] == "application/json"
    assert timeout == 4

    public_result = json.dumps(asdict(declaration), default=str).casefold()
    for forbidden in (
        "private street",
        "phone",
        "email",
        "assetschedule",
        "liabilityschedule",
        "incomeschedule",
        "rawpdftext",
        "prefix",
    ):
        assert forbidden not in public_result


def test_negative_and_zero_declarations_survive_bounded_pagination() -> None:
    shared = {
        "total": 2,
        "partial": True,
    }
    transport = FakeTransport(
        [
            payload([record(filing_id=1001, amount=-12_345)], **shared),
            payload([record(filing_id=1002, amount=0)], **shared),
        ]
    )
    batch = adapter(transport, page_size=1, max_pages=2).discover(
        public_jurisdiction=office_jurisdiction(),
        limit=2,
    )

    assert batch.outcome is FloridaForm6Outcome.OK
    assert [item.declared_net_worth_usd for item in batch.records] == [
        Decimal("-12345"),
        Decimal("0"),
    ]
    assert batch.source_status.pages_fetched == 2
    assert batch.source_status.index_partial is True
    assert batch.source_status.truncated is False
    queries = [parse_qs(urlsplit(call[0]).query) for call in transport.calls]
    assert [query["offset"] for query in queries] == [["0"], ["1"]]
    assert all("minNetWorth" not in query for query in queries)


def test_missing_net_worth_fails_closed_instead_of_becoming_zero() -> None:
    missing = record(filing_id=1003, amount=50)
    missing.pop("netWorth")
    batch = adapter(FakeTransport([payload([missing])])).discover(
        public_jurisdiction=office_jurisdiction()
    )

    assert batch.outcome is FloridaForm6Outcome.UNAVAILABLE
    assert batch.records == ()
    assert batch.source_status.error_code == "SOURCE_CONTRACT_VIOLATION"


def test_empty_and_unavailable_are_distinct_source_outcomes() -> None:
    empty = adapter(FakeTransport([payload([], total=0, partial=True)])).discover(
        public_jurisdiction=office_jurisdiction()
    )
    unavailable = adapter(
        FakeTransport([], error=FloridaForm6SourceError("timed out"))
    ).discover(public_jurisdiction=office_jurisdiction())

    assert empty.outcome is FloridaForm6Outcome.EMPTY
    assert empty.records == ()
    assert empty.source_status.index_partial is True
    assert empty.source_status.error_code is None
    assert unavailable.outcome is FloridaForm6Outcome.UNAVAILABLE
    assert unavailable.source_status.index_partial is None
    assert unavailable.source_status.error_code == "SOURCE_UNAVAILABLE"


def test_partial_index_and_truncation_are_disclosed_and_successes_are_cached() -> None:
    now = [100.0]
    transport = FakeTransport(
        [payload([record(filing_id=1004, amount=1_000_000)], total=8, partial=True)]
    )
    source = adapter(transport, max_pages=1, clock=lambda: now[0])

    first = source.discover(public_jurisdiction=office_jurisdiction(), limit=1)
    second = source.discover(public_jurisdiction=office_jurisdiction(), limit=1)

    assert first.source_status.index_partial is True
    assert first.source_status.truncated is True
    assert first.source_status.upstream_total == 8
    assert first.source_status.cache_hit is False
    assert second.source_status.cache_hit is True
    assert len(transport.calls) == 1

    now[0] += 31
    transport.payloads.append(
        payload([record(filing_id=1004, amount=1_000_000)], total=8, partial=True)
    )
    third = source.discover(public_jurisdiction=office_jurisdiction(), limit=1)
    assert third.source_status.cache_hit is False
    assert len(transport.calls) == 2


@pytest.mark.parametrize(
    ("jurisdiction", "query_field", "office", "county"),
    [
        (
            PublicJurisdiction(PublicJurisdictionKind.COUNTY, "Hillsborough"),
            "county",
            "Supervisor Of Elections",
            "Hillsborough",
        ),
        (
            PublicJurisdiction(PublicJurisdictionKind.CITY, "Jacksonville"),
            "office",
            "Jacksonville",
            None,
        ),
        (
            PublicJurisdiction(PublicJurisdictionKind.OFFICE, "Sheriff"),
            "office",
            "Orange County Sheriff",
            "Orange",
        ),
    ],
)
def test_queries_only_the_route_resolved_public_jurisdiction(
    jurisdiction: PublicJurisdiction,
    query_field: str,
    office: str,
    county: str | None,
) -> None:
    transport = FakeTransport(
        [payload([record(filing_id=1005, amount=42, office=office, county=county)])]
    )
    batch = adapter(transport).discover(public_jurisdiction=jurisdiction)

    assert batch.outcome is FloridaForm6Outcome.OK
    query = parse_qs(urlsplit(transport.calls[0][0]).query)
    assert query[query_field] == [jurisdiction.token]
    assert "lat" not in query
    assert "lng" not in query
    assert batch.records[0].public_jurisdiction == jurisdiction


def test_source_contract_and_endpoint_allowlist_fail_closed() -> None:
    unsafe_contract = payload([record(filing_id=1006, amount=12)])
    unsafe_contract["coverage"] = "This is a securities holding."
    result = adapter(FakeTransport([unsafe_contract])).discover(
        public_jurisdiction=office_jurisdiction()
    )
    assert result.outcome is FloridaForm6Outcome.UNAVAILABLE
    assert result.source_status.error_code == "SOURCE_CONTRACT_VIOLATION"

    with pytest.raises(ValueError, match="allowlisted HTTPS origin"):
        FloridaForm6NetWorthAdapter(
            base_url="http://insider-source.test",
            bearer_token="secret",
            allowed_hosts=frozenset({"insider-source.test"}),
        )
    with pytest.raises(ValueError, match="allowlisted HTTPS origin"):
        FloridaForm6NetWorthAdapter(
            base_url="https://untrusted-source.test",
            bearer_token="secret",
            allowed_hosts=frozenset({"insider-source.test"}),
        )
