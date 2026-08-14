from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from app.collectors.registry import SourceRegistry
from app.florida_net_worth import (
    FloridaForm6Batch,
    FloridaForm6Outcome,
    FloridaForm6Provenance,
    FloridaForm6Record,
    FloridaForm6SourceStatus,
    PublicJurisdiction,
)
from app.jobs.refresh_net_worth import RefreshJobSettings
from app.net_worth import net_worth_to_nws
from app.snapshots.contracts import (
    ActiveSnapshotPointer,
    PublishedJurisdiction,
    PublishedNetWorthProfile,
    PublishedNetWorthSnapshot,
    SnapshotConfidence,
    SnapshotContractError,
    SnapshotSourceStatus,
    canonical_json_bytes,
    parse_public_snapshot,
    sha256_hex,
)
from app.snapshots.form6_refresh import (
    FloridaForm6SnapshotBuilder,
    SnapshotBuildError,
    SnapshotReleasePublisher,
)
from app.snapshots.gcs_store import (
    GcsObject,
    HttpResult,
    SnapshotGcsStore,
    SnapshotStoreError,
)
from app.snapshots.repository import NetWorthSnapshotRepository, SnapshotUnavailableError

_NOW = datetime(2026, 8, 14, 12, tzinfo=UTC)
_BUILT = datetime(2026, 8, 11, 18, 46, 24, 202000, tzinfo=UTC)
_REGISTRY_SHA = "fb97b845e41998e2d1cdf6c832751605a6285940d885c632883979980511038a"
_SOURCE_SHA = "d1a20016a18cdc474e8dccc062d7cdccc6a4107a963cb96f8d0e9484702522ad"
_SOURCE_ID = "florida-form6-2025-20260811T184624Z-partial"


def _profile() -> PublishedNetWorthProfile:
    return PublishedNetWorthProfile(
        subject_id="florida-form6:1001",
        name="PUBLIC FILER",
        headline="Alachua County Commissioner",
        public_offices=("Alachua County Commissioner",),
        jurisdiction_ids=("US-FL-COUNTY-12001",),
        form_year=2025,
        declared_net_worth_usd=2_000_000,
        p10_usd=2_000_000,
        median_usd=2_000_000,
        p90_usd=2_000_000,
        nws=net_worth_to_nws(2_000_000),
        confidence=SnapshotConfidence(score=0.9, grade="A", coverage=1.0),
    )


def _snapshot() -> PublishedNetWorthSnapshot:
    profile = _profile()
    return PublishedNetWorthSnapshot(
        snapshot_id="nwsnw_0123456789abcdef01234567",
        generated_at=_NOW,
        source_registry_sha256=_REGISTRY_SHA,
        source_registry_id="nws-nearby-source-registry",
        source_registry_version=3,
        model_version="net-worth-v1.0.0",
        scale_version="nws-fixed-us-log-v1.0.0",
        source=SnapshotSourceStatus(
            source_snapshot_id=_SOURCE_ID,
            source_artifact_sha256=_SOURCE_SHA,
            retrieved_at=_BUILT,
            index_built_at=_BUILT,
            form_year=2025,
            partial=True,
            total_count=120,
            evaluated_count=1,
            published_profile_count=1,
            truncated=True,
        ),
        jurisdictions=(
            PublishedJurisdiction(
                jurisdiction_id="US-FL-COUNTY-12001",
                county_geoid="12001",
                county_name="Alachua County",
                public_label="Alachua County, Florida",
            ),
        ),
        profiles=(profile,),
    )


class MemoryStore:
    def __init__(self) -> None:
        self.objects: dict[str, GcsObject] = {}
        self.next_generation = 1

    def read(self, name: str, *, generation: int | None = None) -> GcsObject:
        try:
            item = self.objects[name]
        except KeyError as exc:
            raise SnapshotStoreError("missing", code="OBJECT_NOT_FOUND") from exc
        if generation is not None and generation != item.generation:
            raise SnapshotStoreError("missing generation", code="OBJECT_NOT_FOUND")
        return item

    def write(self, name: str, body: bytes, *, if_generation_match: int) -> GcsObject:
        current = self.objects.get(name)
        actual = 0 if current is None else current.generation
        if actual != if_generation_match:
            raise SnapshotStoreError("CAS", code="GENERATION_PRECONDITION_FAILED")
        item = GcsObject(name=name, generation=self.next_generation, body=body)
        self.next_generation += 1
        self.objects[name] = item
        return item


def test_contract_round_trip_and_recursive_privacy_guard() -> None:
    snapshot = _snapshot()
    stored = canonical_json_bytes(snapshot)
    assert parse_public_snapshot(stored) == snapshot

    hostile = snapshot.model_dump(mode="json")
    hostile["profiles"][0]["email"] = "private@example.test"
    with pytest.raises(SnapshotContractError):
        parse_public_snapshot(json.dumps(hostile).encode())


def test_repository_verifies_digest_and_never_loads_during_query() -> None:
    snapshot = _snapshot()
    body = canonical_json_bytes(snapshot)
    release_name = f"published/net-worth-v1.0.0/releases/{snapshot.snapshot_id}.json"
    pointer = ActiveSnapshotPointer(
        snapshot_id=snapshot.snapshot_id,
        snapshot_object=release_name,
        snapshot_generation="4",
        snapshot_sha256=sha256_hex(body),
        source_registry_sha256=_REGISTRY_SHA,
        generated_at=snapshot.generated_at,
        published_at=snapshot.generated_at,
    )
    store = MemoryStore()
    store.objects["published/net-worth-v1.0.0/active.json"] = GcsObject(
        "published/net-worth-v1.0.0/active.json", 3, canonical_json_bytes(pointer)
    )
    store.objects[release_name] = GcsObject(release_name, 4, body)
    repository = NetWorthSnapshotRepository(
        store=store,  # type: ignore[arg-type]
        prefix="published/net-worth-v1.0.0",
        expected_registry_sha256=_REGISTRY_SHA,
        max_age=timedelta(days=7),
        now=lambda: _NOW,
    )
    with pytest.raises(SnapshotUnavailableError, match="not been loaded") as exc_info:
        repository.profiles_for_jurisdiction("US-FL-COUNTY-12001")
    assert exc_info.value.code == "SNAPSHOT_NOT_LOADED"

    assert repository.load_active() == snapshot
    assert repository.status().source_partial is True
    store.objects.clear()
    assert repository.profiles_for_jurisdiction("US-FL-COUNTY-12001") == (_profile(),)


def test_repository_rejects_digest_mismatch() -> None:
    snapshot = _snapshot()
    body = canonical_json_bytes(snapshot)
    release_name = f"published/net-worth-v1.0.0/releases/{snapshot.snapshot_id}.json"
    pointer = ActiveSnapshotPointer(
        snapshot_id=snapshot.snapshot_id,
        snapshot_object=release_name,
        snapshot_generation="4",
        snapshot_sha256="0" * 64,
        source_registry_sha256=_REGISTRY_SHA,
        generated_at=snapshot.generated_at,
        published_at=snapshot.generated_at,
    )
    store = MemoryStore()
    store.objects["published/net-worth-v1.0.0/active.json"] = GcsObject(
        "published/net-worth-v1.0.0/active.json", 3, canonical_json_bytes(pointer)
    )
    store.objects[release_name] = GcsObject(release_name, 4, body)
    repository = NetWorthSnapshotRepository(
        store=store,  # type: ignore[arg-type]
        prefix="published/net-worth-v1.0.0",
        expected_registry_sha256=_REGISTRY_SHA,
        max_age=timedelta(days=7),
        now=lambda: _NOW,
    )
    with pytest.raises(SnapshotUnavailableError) as exc_info:
        repository.load_active()
    assert exc_info.value.code == "SNAPSHOT_DIGEST_MISMATCH"


class StaticToken:
    def token(self) -> str:
        return "token"


class QueueTransport:
    def __init__(self, results: list[HttpResult]) -> None:
        self.results = results
        self.calls: list[dict[str, object]] = []

    def request(self, **kwargs: object) -> HttpResult:
        self.calls.append(kwargs)
        return self.results.pop(0)


def test_gcs_store_uses_generation_preconditions() -> None:
    transport = QueueTransport(
        [HttpResult(201, b'{"generation":"9"}', {"content-type": "application/json"})]
    )
    store = SnapshotGcsStore(
        bucket="private-snapshots",
        transport=transport,
        token_provider=StaticToken(),
    )
    result = store.write("published/release.json", b"{}\n", if_generation_match=0)
    assert result.generation == 9
    call = transport.calls[0]
    assert "ifGenerationMatch=0" in str(call["url"])
    assert call["headers"]["Authorization"] == "Bearer token"  # type: ignore[index]


class OneRecordAdapter:
    def __init__(self) -> None:
        self.calls: list[PublicJurisdiction] = []

    def discover(
        self, *, public_jurisdiction: PublicJurisdiction, limit: int = 100
    ) -> FloridaForm6Batch:
        self.calls.append(public_jurisdiction)
        status = FloridaForm6SourceStatus(
            source_snapshot_id=_SOURCE_ID,
            source_artifact_sha256=_SOURCE_SHA,
            source_retrieved_at="2026-08-11T18:46:24.202Z",
            index_built_at="2026-08-11T18:46:24.202Z",
            index_form_year=2025,
            index_partial=True,
            filings_seen=120,
            declarations_indexed=120,
            unreadable_filings=0,
            upstream_total=int(public_jurisdiction.token == "Alachua County"),
            requested_limit=limit,
            pages_fetched=1,
            accepted_record_count=int(public_jurisdiction.token == "Alachua County"),
        )
        if public_jurisdiction.token != "Alachua County":
            return FloridaForm6Batch(FloridaForm6Outcome.EMPTY, (), status)
        record = FloridaForm6Record(
            subject_id="florida-form6:1001",
            name="PUBLIC FILER",
            declared_net_worth_usd=Decimal("36014962.58"),
            public_offices=("Alachua County Commissioner",),
            public_jurisdiction=public_jurisdiction,
            form_year=2025,
            filing_url=("https://disclosure.floridaethics.gov/api/Report/RenderPdf/1001/False"),
            provenance=FloridaForm6Provenance(
                source_id="florida_form_6",
                source_authority="Florida Commission on Ethics",
                source_url=("https://disclosure.floridaethics.gov/PublicSearch/Filings"),
                filing_url=("https://disclosure.floridaethics.gov/api/Report/RenderPdf/1001/False"),
                declaration_scope="SWORN_WHOLE_DECLARED_NET_WORTH",
            ),
        )
        return FloridaForm6Batch(FloridaForm6Outcome.OK, (record,), status)


def _verified_registry() -> SourceRegistry:
    service_root = Path(__file__).resolve().parents[1]
    return SourceRegistry.from_verified_yaml(
        service_root / "config/sources.yaml",
        service_root / "config/source-registry-manifest.json",
        expected_registry_sha256=_REGISTRY_SHA,
        expected_registry_version=3,
    )


def test_builder_evaluates_all_counties_and_publisher_is_idempotent() -> None:
    adapter = OneRecordAdapter()
    snapshot = FloridaForm6SnapshotBuilder(
        adapter=adapter,
        registry=_verified_registry(),
        now=lambda: _NOW,
    ).build()
    assert len(adapter.calls) == 67
    assert len(snapshot.jurisdictions) == 67
    assert snapshot.source.source_snapshot_id == _SOURCE_ID
    assert snapshot.source.source_artifact_sha256 == _SOURCE_SHA
    assert snapshot.source.partial is True
    assert snapshot.source.truncated is True
    assert snapshot.profiles[0].declared_net_worth_usd == 36_014_963
    assert "filing_url" not in canonical_json_bytes(snapshot).decode().casefold()

    store = MemoryStore()
    publisher = SnapshotReleasePublisher(
        store=store,  # type: ignore[arg-type]
        prefix="published/net-worth-v1.0.0",
        now=lambda: _NOW,
    )
    first = publisher.publish(snapshot)
    second = publisher.publish(snapshot)
    assert first == second
    assert parse_public_snapshot(store.objects[first.snapshot_object].body) == snapshot


def test_builder_fails_closed_when_overall_refresh_deadline_expires() -> None:
    elapsed = [0.0]

    class SlowAdapter(OneRecordAdapter):
        def discover(
            self, *, public_jurisdiction: PublicJurisdiction, limit: int = 100
        ) -> FloridaForm6Batch:
            result = super().discover(
                public_jurisdiction=public_jurisdiction,
                limit=limit,
            )
            elapsed[0] += 3
            return result

    adapter = SlowAdapter()
    with pytest.raises(SnapshotBuildError) as exc_info:
        FloridaForm6SnapshotBuilder(
            adapter=adapter,
            registry=_verified_registry(),
            now=lambda: _NOW,
            deadline_monotonic=5,
            monotonic=lambda: elapsed[0],
        ).build()

    assert exc_info.value.code == "REFRESH_DEADLINE_EXCEEDED"
    assert len(adapter.calls) == 2


def test_publisher_rejects_snapshot_rollback_and_same_time_conflict() -> None:
    store = MemoryStore()
    publisher = SnapshotReleasePublisher(
        store=store,  # type: ignore[arg-type]
        prefix="published/net-worth-v1.0.0",
        now=lambda: _NOW + timedelta(hours=2),
    )
    newest = _snapshot().model_copy(update={"generated_at": _NOW + timedelta(hours=1)})
    publisher.publish(newest)

    older = _snapshot().model_copy(update={"snapshot_id": "nwsnw_111111111111111111111111"})
    with pytest.raises(SnapshotBuildError) as rollback:
        publisher.publish(older)
    assert rollback.value.code == "SNAPSHOT_ROLLBACK_REJECTED"

    conflicting = newest.model_copy(update={"snapshot_id": "nwsnw_abcdef0123456789abcdef01"})
    with pytest.raises(SnapshotBuildError) as conflict:
        publisher.publish(conflicting)
    assert conflict.value.code == "SNAPSHOT_GENERATION_CONFLICT"


def test_job_settings_require_registry_pins_and_secret() -> None:
    base = {
        "NWS_SNAPSHOT_BUCKET": "private-snapshots",
        "NWS_SOURCE_REGISTRY_PATH": "/app/config/sources.yaml",
        "NWS_SOURCE_REGISTRY_MANIFEST_PATH": "/app/config/source-registry-manifest.json",
        "NWS_SOURCE_REGISTRY_SHA256": _REGISTRY_SHA,
        "NWS_SOURCE_REGISTRY_VERSION": "3",
        "NWS_FORM6_API_BASE_URL": "https://insider-holdings-api-fro3hygenq-uc.a.run.app",
    }
    with pytest.raises(RuntimeError, match="NWS_FORM6_API_KEY"):
        RefreshJobSettings.from_env(base)
    settings = RefreshJobSettings.from_env({**base, "NWS_FORM6_API_KEY": "secret"})
    assert settings.snapshot_prefix == "published/net-worth-v1.0.0"
    assert settings.request_interval_seconds == 2.1
    assert settings.max_rate_limit_retries == 2
    assert settings.maximum_retry_after_seconds == 30
    assert settings.refresh_deadline_seconds == 600

    with pytest.raises(RuntimeError, match="NWS_FORM6_REQUEST_INTERVAL_SECONDS"):
        RefreshJobSettings.from_env(
            {
                **base,
                "NWS_FORM6_API_KEY": "secret",
                "NWS_FORM6_REQUEST_INTERVAL_SECONDS": "1.99",
            }
        )
