from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import cast

from fastapi.testclient import TestClient

import app.main as main
from app.bootstrap_data import BOOTSTRAP_CANDIDATES
from app.florida_net_worth import (
    FloridaForm6Batch,
    FloridaForm6Outcome,
    FloridaForm6Provenance,
    FloridaForm6Record,
    FloridaForm6SourceStatus,
    PublicJurisdiction,
    PublicJurisdictionKind,
)
from app.main import NetWorthCandidatePool, app
from app.net_worth import (
    BalanceSheetCoverage,
    ComponentKind,
    CoverageState,
    CoverageSupport,
    DeclaredNetWorthRange,
    EstimateBasis,
    EstimateStatus,
    EvidenceDatePrecision,
    EvidenceKind,
    EvidencePurpose,
    EvidenceRecord,
    FinancialComponent,
    FractionRange,
    MonetaryRange,
    NetWorthEngine,
    NetWorthSubject,
    ProfileBasis,
)
from app.nws_models import GeoPoint
from app.security import rate_limiter

API_HEADERS = {"X-NWS-API-Key": "local-development-only"}


def setup_function() -> None:
    rate_limiter._events.clear()  # noqa: SLF001 - test reset for the in-process limiter


def test_v3_requires_authentication() -> None:
    response = TestClient(app).post(
        "/v3/nearby-net-worth/discover",
        json={"query": {"postal_code": "98033"}},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "API_KEY_REQUIRED"


def test_v3_strict_request_excludes_professional_filters_and_diversity() -> None:
    client = TestClient(app)
    for extra in (
        {"diversity": True},
        {"filters": {"lanes": ["CAPITAL"]}},
        {"top_n": "100"},
        {"initial_radius_km": "20"},
        {"auto_expand": "true"},
        {"query": {"latitude": "47.67", "longitude": -122.21}},
    ):
        response = client.post(
            "/v3/nearby-net-worth/discover",
            headers=API_HEADERS,
            json={"query": {"postal_code": "98033"}, **extra},
        )
        assert response.status_code == 422


def test_v3_default_provider_fails_closed_without_manufacturing_nws() -> None:
    response = TestClient(app).post(
        "/v3/nearby-net-worth/discover",
        headers=API_HEADERS,
        json={
            "query": {"postal_code": "98033"},
            "top_n": 10,
            "initial_radius_km": 20,
            "max_radius_km": 100,
            "auto_expand": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["snapshot"]["score_kind"] == "NET_WORTH_SCORE"
    assert body["snapshot"]["scale_version"] == "nws-fixed-us-log-v1.0.0"
    assert body["financial_coverage"] == {
        "status": "FINANCIAL_COVERAGE_INSUFFICIENT",
        "candidate_count": 60,
        "discovered_count": 60,
        "evaluated_count": 60,
        "unevaluated_count": 0,
        "scored_count": 0,
        "insufficient_evidence_count": 60,
    }
    assert body["result_set"]["status"] == "EMPTY"
    assert "FINANCIAL_COVERAGE_INSUFFICIENT" in body["result_set"]["reasons"]
    assert body["search"]["effective_radius_km"] == 100
    assert body["search"]["maximum_radius_reached"] is True
    assert body["results"] == []
    assert body["search"]["performed"] is True
    assert all("global_nws" not in item for item in body["results"])
    assert sum(item["source"] == "NET_WORTH_LEDGER" for item in body["source_status"]) == 1
    assert body["source_status"][-1] == {
        "source": "NET_WORTH_LEDGER",
        "purpose": "FINANCIAL_EVIDENCE",
        "status": "EMPTY",
        "as_of": None,
        "reason_code": "NO_ELIGIBLE_FINANCIAL_LEDGER_CONFIGURED",
    }


def test_v3_non_us_and_unresolved_locations_are_not_financial_searches() -> None:
    client = TestClient(app)
    payloads = (
        {"query": {"latitude": 28.6139, "longitude": 77.209, "country_code": "IN"}},
        {"query": {"postal_code": "00000", "country_code": "US"}},
    )

    for payload in payloads:
        response = client.post(
            "/v3/nearby-net-worth/discover",
            headers=API_HEADERS,
            json=payload,
        )
        assert response.status_code == 200
        body = response.json()
        assert body["financial_coverage"] == {
            "status": "NOT_SEARCHED",
            "candidate_count": 0,
            "discovered_count": 0,
            "evaluated_count": 0,
            "unevaluated_count": 0,
            "scored_count": 0,
            "insufficient_evidence_count": 0,
        }
        assert body["result_set"]["status"] == "NOT_SEARCHED"
        assert body["search"]["performed"] is False
        assert body["results"] == []
        assert {source["status"] for source in body["source_status"]} == {"NOT_QUERIED"}


class _FakeFloridaAdapter:
    def __init__(self, batch: FloridaForm6Batch) -> None:
        self.batch = batch
        self.calls: list[tuple[PublicJurisdiction, int]] = []

    def discover(
        self,
        *,
        public_jurisdiction: PublicJurisdiction,
        limit: int,
    ) -> FloridaForm6Batch:
        self.calls.append((public_jurisdiction, limit))
        return self.batch


def _florida_record(*, subject_id: str, name: str, net_worth: str) -> FloridaForm6Record:
    filing_id = subject_id.rsplit(":", 1)[-1]
    jurisdiction = PublicJurisdiction(
        PublicJurisdictionKind.OFFICE,
        "Miami-Dade County",
    )
    filing_url = f"https://disclosure.floridaethics.gov/api/Report/RenderPdf/{filing_id}/False"
    return FloridaForm6Record(
        subject_id=subject_id,
        name=name,
        declared_net_worth_usd=Decimal(net_worth),
        public_offices=("Miami-Dade County Commissioner",),
        public_jurisdiction=jurisdiction,
        form_year=2025,
        filing_url=filing_url,
        provenance=FloridaForm6Provenance(
            source_id="florida_form_6",
            source_authority="Florida Commission on Ethics",
            source_url="https://disclosure.floridaethics.gov/PublicSearch/Filings",
            filing_url=filing_url,
            declaration_scope="SWORN_WHOLE_DECLARED_NET_WORTH",
        ),
    )


def test_v3_florida_postal_publishes_direct_sworn_totals_without_fuzzy_join(
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    records = (
        _florida_record(
            subject_id="florida-form6:101",
            name="Lower Filer",
            net_worth="10000000",
        ),
        _florida_record(
            subject_id="florida-form6:102",
            name="Higher Filer",
            net_worth="100000000",
        ),
    )
    fake = _FakeFloridaAdapter(
        FloridaForm6Batch(
            outcome=FloridaForm6Outcome.OK,
            records=records,
            source_status=FloridaForm6SourceStatus(
                index_built_at="2026-08-11T18:46:24.202Z",
                index_form_year=2025,
                index_partial=False,
                accepted_record_count=2,
                requested_limit=2,
            ),
        )
    )
    monkeypatch.setattr(main, "_florida_net_worth_adapter", lambda: fake)
    monkeypatch.setattr(
        main,
        "_net_worth_candidate_pool",
        lambda **_: (_ for _ in ()).throw(AssertionError("professional pool must not run")),
    )

    response = TestClient(app).post(
        "/v3/nearby-net-worth/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "33130"}, "top_n": 2},
    )

    assert response.status_code == 200
    body = response.json()
    assert fake.calls == [
        (
            PublicJurisdiction(PublicJurisdictionKind.OFFICE, "Miami-Dade County"),
            2,
        )
    ]
    assert body["coverage"]["reason_code"] == "FLORIDA_PUBLIC_FORM_6_JURISDICTION"
    assert body["search"]["scope"] == "PUBLIC_JURISDICTION"
    assert [result["person"]["name"] for result in body["results"]] == [
        "Higher Filer",
        "Lower Filer",
    ]
    assert [result["nws"]["value"] for result in body["results"]] == [67, 50]
    assert body["financial_coverage"] == {
        "status": "AVAILABLE",
        "candidate_count": 2,
        "discovered_count": 2,
        "evaluated_count": 2,
        "unevaluated_count": 0,
        "scored_count": 2,
        "insufficient_evidence_count": 0,
    }
    assert all(
        result["components"]["liabilities"]["status"] == "INCLUDED_IN_DECLARED_TOTAL"
        for result in body["results"]
    )
    assert all(result["financial_update_precision"] == "YEAR" for result in body["results"])
    assert all(result["last_financial_update"] == "2025" for result in body["results"])
    assert all(result["estimated_net_worth"]["as_of"] == "2025" for result in body["results"])
    assert all(
        result["confidence"]["score"] != result["nws"]["value"] / 100
        for result in body["results"]
    )
    assert all(
        result["sources"][0]["url"]
        == "https://disclosure.floridaethics.gov/PublicSearch/Filings"
        for result in body["results"]
    )
    assert all(result["sources"][0]["source_date"] == "2025" for result in body["results"])
    serialized = str(body).casefold()
    for forbidden in ("street_address", "phone", "email", "asset_schedule"):
        assert forbidden not in serialized


def test_v3_florida_partial_index_never_claims_available_coverage(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    record = _florida_record(
        subject_id="florida-form6:103",
        name="Partial Index Filer",
        net_worth="1000000",
    )
    fake = _FakeFloridaAdapter(
        FloridaForm6Batch(
            outcome=FloridaForm6Outcome.OK,
            records=(record,),
            source_status=FloridaForm6SourceStatus(
                index_built_at="2026-08-11T18:46:24.202Z",
                index_form_year=2025,
                index_partial=True,
                accepted_record_count=1,
                requested_limit=1,
            ),
        )
    )
    monkeypatch.setattr(main, "_florida_net_worth_adapter", lambda: fake)

    body = (
        TestClient(app)
        .post(
            "/v3/nearby-net-worth/discover",
            headers=API_HEADERS,
            json={"query": {"postal_code": "33130"}, "top_n": 1},
        )
        .json()
    )

    assert body["financial_coverage"]["status"] == "PARTIAL"
    assert body["result_set"]["status"] == "TARGET_MET"
    assert "SOURCE_INDEX_PARTIAL" in body["result_set"]["reasons"]
    assert {source["reason_code"] for source in body["source_status"]} == {"SOURCE_INDEX_PARTIAL"}


def test_v3_florida_coordinate_resolves_bounded_zcta_to_public_jurisdiction(
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    record = _florida_record(
        subject_id="florida-form6:104",
        name="Coordinate Filer",
        net_worth="10000000",
    )
    fake = _FakeFloridaAdapter(
        FloridaForm6Batch(
            outcome=FloridaForm6Outcome.OK,
            records=(record,),
            source_status=FloridaForm6SourceStatus(
                index_built_at="2026-08-11T18:46:24.202Z",
                index_form_year=2025,
                index_partial=False,
                accepted_record_count=1,
                requested_limit=1,
            ),
        )
    )
    monkeypatch.setattr(main, "_florida_net_worth_adapter", lambda: fake)

    response = TestClient(app).post(
        "/v3/nearby-net-worth/discover",
        headers=API_HEADERS,
        json={
            "query": {
                "latitude": 25.7617,
                "longitude": -80.1918,
                "country_code": "US",
            },
            "top_n": 1,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["query"]["mode"] == "COARSE_COORDINATE"
    assert body["query"]["approximate"] is True
    assert body["search"]["scope"] == "PUBLIC_JURISDICTION"
    assert body["coverage"]["reason_code"] == "FLORIDA_PUBLIC_FORM_6_JURISDICTION"
    assert "nearby Census ZCTA" in body["coverage"]["message"]
    assert body["results"][0]["person"]["name"] == "Coordinate Filer"
    assert (
        "public jurisdiction match"
        == body["results"][0]["location_relationship"]["approximate_distance_band"]
    )
    assert fake.calls[0][0] == PublicJurisdiction(
        PublicJurisdictionKind.OFFICE,
        "Miami-Dade County",
    )


def test_v3_florida_future_form_year_fails_closed(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    future = replace(
        _florida_record(
            subject_id="florida-form6:105",
            name="Future Record",
            net_worth="10000000",
        ),
        form_year=2099,
    )
    fake = _FakeFloridaAdapter(
        FloridaForm6Batch(
            outcome=FloridaForm6Outcome.OK,
            records=(future,),
            source_status=FloridaForm6SourceStatus(
                index_built_at="2026-08-11T18:46:24.202Z",
                index_form_year=2099,
                index_partial=False,
                accepted_record_count=1,
                requested_limit=1,
            ),
        )
    )
    monkeypatch.setattr(main, "_florida_net_worth_adapter", lambda: fake)

    body = (
        TestClient(app)
        .post(
            "/v3/nearby-net-worth/discover",
            headers=API_HEADERS,
            json={"query": {"postal_code": "33130"}, "top_n": 1},
        )
        .json()
    )

    assert body["financial_coverage"]["status"] == "FINANCIAL_COVERAGE_INSUFFICIENT"
    assert body["financial_coverage"]["candidate_count"] == 1
    assert body["financial_coverage"]["scored_count"] == 0
    assert body["financial_coverage"]["insufficient_evidence_count"] == 1
    assert body["results"] == []


def test_v3_florida_source_unavailable_is_distinct_from_no_declarations(
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    unavailable = _FakeFloridaAdapter(
        FloridaForm6Batch(
            outcome=FloridaForm6Outcome.UNAVAILABLE,
            records=(),
            source_status=FloridaForm6SourceStatus(
                requested_limit=10,
                error_code="SOURCE_UNAVAILABLE",
            ),
        )
    )
    monkeypatch.setattr(main, "_florida_net_worth_adapter", lambda: unavailable)

    body = (
        TestClient(app)
        .post(
            "/v3/nearby-net-worth/discover",
            headers=API_HEADERS,
            json={"query": {"postal_code": "33130"}, "top_n": 10},
        )
        .json()
    )

    assert body["financial_coverage"]["status"] == "FINANCIAL_COVERAGE_INSUFFICIENT"
    assert body["results"] == []
    assert "FINANCIAL_SOURCE_UNAVAILABLE" in body["result_set"]["reasons"]
    assert {source["status"] for source in body["source_status"]} == {"UNAVAILABLE"}


class _DeclaredTotalProvider:
    def __init__(self, values: dict[str, float]) -> None:
        self.values = values
        self.engine = NetWorthEngine(simulation_count=1_000)

    def estimate(self, candidate, *, as_of_date):  # type: ignore[no-untyped-def]
        value = self.values.get(candidate.person_id)
        if value is None:
            return self.engine.estimate(
                subject=NetWorthSubject(
                    candidate.person_id,
                    ProfileBasis.VERIFIED_PUBLIC_FINANCIAL_PROFILE,
                ),
                components=(),
                coverage=main.BalanceSheetCoverage(),
                as_of_date=as_of_date,
            )
        evidence = EvidenceRecord(
            evidence_id=f"declared:{candidate.person_id}",
            kind=EvidenceKind.STATE_WHOLE_NET_WORTH_DISCLOSURE,
            purpose=EvidencePurpose.DECLARED_NET_WORTH_TOTAL,
            source_authority="Florida Commission on Ethics",
            source_uri=f"https://example.gov/form6/{candidate.person_id}",
            source_date=date(2026, 7, 1),
            retrieved_at=datetime(2026, 8, 14, tzinfo=UTC),
            quality=0.95,
        )
        return self.engine.estimate_declared_total(
            subject=NetWorthSubject(
                candidate.person_id,
                ProfileBasis.VERIFIED_PUBLIC_FINANCIAL_PROFILE,
            ),
            declared_total=DeclaredNetWorthRange(value, value, value),
            evidence=evidence,
            as_of_date=as_of_date,
        )

    def source_status(self) -> dict[str, object]:
        return {
            "source": "FLORIDA_FORM_6",
            "purpose": "FINANCIAL_EVIDENCE",
            "status": "OK",
            "as_of": "2026-07-01",
            "reason_code": None,
        }


def _pool_for(candidates) -> NetWorthCandidatePool:  # type: ignore[no-untyped-def]
    return NetWorthCandidatePool(
        candidates=tuple(candidates),
        source_status=(
            {
                "source": "TEST_PUBLIC_ASSOCIATIONS",
                "status": "OK",
                "source_as_of": "2026-08-01",
            },
        ),
        expansion_steps_km=(20.0,),
        effective_radius_km=20.0,
    )


def test_v3_ranks_only_available_financial_results_by_median_not_distance(
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    near = replace(
        BOOTSTRAP_CANDIDATES[0],
        person_id="person-near",
        display_name="Near Lower",
        location=replace(
            BOOTSTRAP_CANDIDATES[0].location,
            point=GeoPoint(47.68, -122.21),
        ),
    )
    far = replace(
        BOOTSTRAP_CANDIDATES[1],
        person_id="person-far",
        display_name="Far Higher",
        location=replace(
            BOOTSTRAP_CANDIDATES[1].location,
            point=GeoPoint(47.75, -122.21),
        ),
    )
    unscored = replace(
        BOOTSTRAP_CANDIDATES[2],
        person_id="person-unscored",
        display_name="No Ledger",
    )
    monkeypatch.setattr(
        main,
        "_net_worth_candidate_pool",
        lambda **_: _pool_for((near, far, unscored)),
    )
    monkeypatch.setattr(
        main,
        "_net_worth_provider",
        lambda: _DeclaredTotalProvider({near.person_id: 10_000_000, far.person_id: 100_000_000}),
    )

    body = (
        TestClient(app)
        .post(
            "/v3/nearby-net-worth/discover",
            headers=API_HEADERS,
            json={"query": {"postal_code": "98033"}, "top_n": 3},
        )
        .json()
    )

    assert body["financial_coverage"] == {
        "status": "PARTIAL",
        "candidate_count": 3,
        "discovered_count": 3,
        "evaluated_count": 3,
        "unevaluated_count": 0,
        "scored_count": 2,
        "insufficient_evidence_count": 1,
    }
    assert [result["person"]["name"] for result in body["results"]] == [
        "Far Higher",
        "Near Lower",
    ]
    assert [result["nws"]["value"] for result in body["results"]] == [67, 50]
    assert all(result["estimated_net_worth"]["status"] == "AVAILABLE" for result in body["results"])
    assert all(
        result["estimated_net_worth"]["method"] == "DECLARED_TOTAL_SIMULATION"
        for result in body["results"]
    )
    assert all(result["liquid_wealth"]["status"] == "UNKNOWN" for result in body["results"])
    assert all(
        result["components"]["liabilities"]["status"] == "INCLUDED_IN_DECLARED_TOTAL"
        for result in body["results"]
    )
    assert all(result["sources"] for result in body["results"])
    assert body["result_set"]["status"] == "PARTIAL"


def test_v3_expands_until_financially_eligible_target_not_raw_candidate_target(
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    near_unscored = replace(
        BOOTSTRAP_CANDIDATES[0],
        person_id="person-near-unscored",
        display_name="Near No Ledger",
        location=replace(
            BOOTSTRAP_CANDIDATES[0].location,
            point=GeoPoint(47.68, -122.21),
        ),
    )
    farther_scored = replace(
        BOOTSTRAP_CANDIDATES[1],
        person_id="person-farther-scored",
        display_name="Farther Verified",
        location=replace(
            BOOTSTRAP_CANDIDATES[1].location,
            point=GeoPoint(47.90, -122.21),
        ),
    )
    monkeypatch.setattr(
        main,
        "_net_worth_candidate_pool",
        lambda **_: _pool_for((near_unscored, farther_scored)),
    )
    monkeypatch.setattr(
        main,
        "_net_worth_provider",
        lambda: _DeclaredTotalProvider({farther_scored.person_id: 10_000_000}),
    )

    body = (
        TestClient(app)
        .post(
            "/v3/nearby-net-worth/discover",
            headers=API_HEADERS,
            json={
                "query": {"postal_code": "98033"},
                "top_n": 1,
                "initial_radius_km": 5,
                "max_radius_km": 40,
                "auto_expand": True,
            },
        )
        .json()
    )

    assert [result["person"]["name"] for result in body["results"]] == [
        "Farther Verified"
    ]
    assert body["search"]["expanded"] is True
    assert body["search"]["effective_radius_km"] > 20
    assert body["result_set"]["target_satisfied"] is True
    assert body["financial_coverage"]["discovered_count"] == 2
    assert body["financial_coverage"]["evaluated_count"] == 2


def test_generic_serializer_preserves_latest_annual_precision_with_older_citations() -> None:
    candidate = replace(BOOTSTRAP_CANDIDATES[0], person_id="annual-ledger-person")

    def annual_evidence(
        evidence_id: str,
        kind: EvidenceKind,
        purpose: EvidencePurpose,
        year: int,
    ) -> EvidenceRecord:
        return EvidenceRecord(
            evidence_id=evidence_id,
            kind=kind,
            purpose=purpose,
            source_authority="Official annual disclosure",
            source_uri=f"https://example.gov/annual/{evidence_id}",
            source_date=date(year, 1, 1),
            source_date_precision=EvidenceDatePrecision.YEAR,
            retrieved_at=datetime(2026, 8, 14, tzinfo=UTC),
            quality=0.95,
        )

    stock = FinancialComponent(
        component_id="stock",
        subject_id=candidate.person_id,
        kind=ComponentKind.PUBLIC_SECURITIES,
        economic_interest_id="issuer:annual",
        amount=MonetaryRange(900_000, 1_000_000, 1_100_000),
        basis=EstimateBasis.DERIVED_FROM_VERIFIED_INPUTS,
        confidence=0.9,
        evidence=(
            annual_evidence(
                "ownership-2024",
                EvidenceKind.SEC_FORM_3_4_5,
                EvidencePurpose.PERSONAL_OWNERSHIP,
                2024,
            ),
            annual_evidence(
                "market-2025",
                EvidenceKind.MARKET_PRICE,
                EvidencePurpose.MARKET_VALUE,
                2025,
            ),
        ),
        liquid_fraction=FractionRange(0.5, 0.7, 0.8),
    )
    liability = FinancialComponent(
        component_id="debt",
        subject_id=candidate.person_id,
        kind=ComponentKind.LIABILITY,
        economic_interest_id="debt:annual",
        amount=MonetaryRange(50_000, 75_000, 100_000),
        basis=EstimateBasis.DIRECT_DISCLOSURE,
        confidence=0.9,
        evidence=(
            annual_evidence(
                "debt-2024",
                EvidenceKind.OGE_PUBLIC_FINANCIAL_DISCLOSURE,
                EvidencePurpose.LIABILITY_AMOUNT,
                2024,
            ),
        ),
    )
    not_applicable_kinds = (
        ComponentKind.CASH_AND_NEAR_CASH,
        ComponentKind.PRIVATE_BUSINESS_EQUITY,
        ComponentKind.REAL_ESTATE_EQUITY,
        ComponentKind.OTHER_SUPPORTED_ASSETS,
    )
    coverage = BalanceSheetCoverage(
        cash_and_near_cash=CoverageState.NOT_APPLICABLE,
        public_securities=CoverageState.VERIFIED,
        private_business_equity=CoverageState.NOT_APPLICABLE,
        real_estate_equity=CoverageState.NOT_APPLICABLE,
        other_supported_assets=CoverageState.NOT_APPLICABLE,
        liabilities=CoverageState.VERIFIED,
        not_applicable_support=tuple(
            CoverageSupport(
                kind=kind,
                evidence=annual_evidence(
                    f"coverage-{kind.value.lower()}",
                    EvidenceKind.OGE_PUBLIC_FINANCIAL_DISCLOSURE,
                    EvidencePurpose.COVERAGE_DECLARATION,
                    2024,
                ),
            )
            for kind in not_applicable_kinds
        ),
    )
    estimate = NetWorthEngine(simulation_count=1_000).estimate(
        subject=NetWorthSubject(
            candidate.person_id,
            ProfileBasis.VERIFIED_PUBLIC_FINANCIAL_PROFILE,
        ),
        components=(stock, liability),
        coverage=coverage,
        as_of_date=date(2026, 8, 14),
    )

    serialized = main._serialize_net_worth_result(  # noqa: SLF001
        rank=1,
        candidate=candidate,
        estimate=estimate,
        query_point=candidate.location.point,
    )

    assert serialized["financial_update_precision"] == "YEAR"
    assert serialized["last_financial_update"] == "2025"
    assert serialized["estimated_net_worth"]["as_of"] == "2025"  # type: ignore[index]
    sources = cast(list[dict[str, object]], serialized["sources"])
    assert {source["source_date"] for source in sources} == {
        "2024",
        "2025",
    }


def test_v3_unknown_liabilities_never_publish_a_score(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    candidate = replace(BOOTSTRAP_CANDIDATES[0], person_id="unknown-liabilities")
    monkeypatch.setattr(main, "_net_worth_candidate_pool", lambda **_: _pool_for((candidate,)))
    monkeypatch.setattr(main, "_net_worth_provider", lambda: main.FailClosedNetWorthProvider())

    body = (
        TestClient(app)
        .post(
            "/v3/nearby-net-worth/discover",
            headers=API_HEADERS,
            json={"query": {"postal_code": "98033"}, "top_n": 1},
        )
        .json()
    )

    assert body["financial_coverage"]["scored_count"] == 0
    assert body["financial_coverage"]["insufficient_evidence_count"] == 1
    assert body["results"] == []


def test_v3_does_not_change_v2_professional_semantics() -> None:
    v2 = TestClient(app).post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "98033"}, "top_n": 1},
    )

    assert v2.status_code == 200
    body = v2.json()
    assert body["snapshot"]["score_kind"] == "PROFESSIONAL_NETWORK_PROVISIONAL"
    assert body["results"][0]["score_kind"] == "PROFESSIONAL_NETWORK_PROVISIONAL"
    assert body["results"][0]["global_nws"] is not None
    assert body["financial_context"]["status"] == "NOT_PROFILED"
    assert EstimateStatus.INSUFFICIENT_EVIDENCE.value not in str(body)
