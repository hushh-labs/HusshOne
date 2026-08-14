"""Build and publish a deterministic, reviewed Florida Form 6 snapshot.

This module republishes the already-reviewed upstream artifact.  It is deliberately
not a filing crawler, and none of its upstream transports are used by request handlers.
"""

from __future__ import annotations

import csv
import hmac
import json
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Protocol, cast

from app.collectors.registry import SourceOperation, SourceRegistry
from app.florida_net_worth import (
    FloridaForm6Batch,
    FloridaForm6NetWorthAdapter,
    FloridaForm6Outcome,
    FloridaForm6Record,
    PublicJurisdiction,
    PublicJurisdictionKind,
)
from app.net_worth import (
    NET_WORTH_MODEL_VERSION,
    NWS_SCALE_VERSION,
    DeclaredNetWorthRange,
    EstimateStatus,
    EvidenceDatePrecision,
    EvidenceKind,
    EvidencePurpose,
    EvidenceRecord,
    NetWorthEngine,
    NetWorthSubject,
    ProfileBasis,
)
from app.snapshots.contracts import (
    ACTIVE_POINTER_SCHEMA_VERSION,
    SNAPSHOT_SCHEMA_VERSION,
    ActiveSnapshotPointer,
    PublishedJurisdiction,
    PublishedNetWorthProfile,
    PublishedNetWorthSnapshot,
    SnapshotConfidence,
    SnapshotSourceStatus,
    canonical_json_bytes,
    parse_active_pointer,
    parse_public_snapshot,
    sha256_hex,
)
from app.snapshots.gcs_store import GcsObject, SnapshotGcsStore, SnapshotStoreError

_FLORIDA_STATE_FIPS = "12"
_EXPECTED_FLORIDA_COUNTIES = 67
_SOURCE_PURPOSE = "FINANCIAL_EVIDENCE"
_SOURCE_PRODUCT = "NET_WORTH_V3"


class SnapshotBuildError(RuntimeError):
    def __init__(self, message: str, *, code: str = "SNAPSHOT_BUILD_FAILED") -> None:
        super().__init__(message)
        self.code = code


class Form6Adapter(Protocol):
    def discover(
        self,
        *,
        public_jurisdiction: PublicJurisdiction,
        limit: int = 100,
    ) -> FloridaForm6Batch: ...


@dataclass(frozen=True)
class FloridaCountyTarget:
    county_geoid: str
    county_name: str

    @property
    def jurisdiction_id(self) -> str:
        return f"US-FL-COUNTY-{self.county_geoid}"

    def published(self) -> PublishedJurisdiction:
        return PublishedJurisdiction(
            jurisdiction_id=self.jurisdiction_id,
            county_geoid=self.county_geoid,
            county_name=self.county_name,
            public_label=f"{self.county_name}, Florida",
        )


def default_county_index_path() -> Path:
    return Path(__file__).resolve().parents[2] / "data/geography/us/2020/zcta-primary-counties.tsv"


def load_florida_counties(path: str | Path | None = None) -> tuple[FloridaCountyTarget, ...]:
    """Return every canonical Florida county, unique and ordered by Census GEOID."""

    index_path = Path(path) if path is not None else default_county_index_path()
    try:
        with index_path.open("r", encoding="utf-8", newline="") as handle:
            rows = csv.DictReader(handle, delimiter="\t")
            counties = {
                (str(row["county_geoid"]), str(row["county_name"]).strip())
                for row in rows
                if str(row.get("county_geoid", "")).startswith(_FLORIDA_STATE_FIPS)
            }
    except (OSError, KeyError, csv.Error) as exc:
        raise SnapshotBuildError(
            "canonical Florida county index is unavailable",
            code="COUNTY_INDEX_INVALID",
        ) from exc
    targets = tuple(
        FloridaCountyTarget(county_geoid=geoid, county_name=name)
        for geoid, name in sorted(counties)
    )
    if (
        len(targets) != _EXPECTED_FLORIDA_COUNTIES
        or any(len(item.county_geoid) != 5 for item in targets)
        or any(not item.county_name.endswith(" County") for item in targets)
    ):
        raise SnapshotBuildError(
            "canonical Florida county index did not contain exactly 67 counties",
            code="COUNTY_INDEX_INVALID",
        )
    return targets


def _parse_source_time(value: object, *, field: str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise SnapshotBuildError(
                f"reviewed source omitted valid {field}", code="SOURCE_CONTRACT_VIOLATION"
            ) from exc
    else:
        raise SnapshotBuildError(
            f"reviewed source omitted {field}", code="SOURCE_CONTRACT_VIOLATION"
        )
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise SnapshotBuildError(
            f"reviewed source returned timezone-free {field}",
            code="SOURCE_CONTRACT_VIOLATION",
        )
    return parsed.astimezone(UTC)


def _required_status_text(status: object, field: str) -> str:
    value = getattr(status, field, None)
    if not isinstance(value, str) or not value.strip():
        raise SnapshotBuildError(
            f"reviewed source omitted {field}", code="SOURCE_CONTRACT_VIOLATION"
        )
    return value.strip()


def _required_status_int(status: object, field: str) -> int:
    value = getattr(status, field, None)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SnapshotBuildError(
            f"reviewed source omitted {field}", code="SOURCE_CONTRACT_VIOLATION"
        )
    return value


@dataclass
class _ProfileAccumulator:
    record: FloridaForm6Record
    jurisdiction_ids: set[str]

    def add(self, record: FloridaForm6Record, jurisdiction_id: str) -> None:
        comparable = (
            record.name,
            record.declared_net_worth_usd,
            tuple(record.public_offices),
            record.form_year,
            record.filing_url,
        )
        original = (
            self.record.name,
            self.record.declared_net_worth_usd,
            tuple(self.record.public_offices),
            self.record.form_year,
            self.record.filing_url,
        )
        if comparable != original:
            raise SnapshotBuildError(
                "reviewed source returned conflicting records for one filing",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        self.jurisdiction_ids.add(jurisdiction_id)


class FloridaForm6SnapshotBuilder:
    """Evaluate the reviewed partial artifact against all 67 public counties."""

    def __init__(
        self,
        *,
        adapter: Form6Adapter,
        registry: SourceRegistry,
        county_index_path: str | Path | None = None,
        max_records_per_jurisdiction: int = 1_000,
        engine: NetWorthEngine | None = None,
        now: Callable[[], datetime] | None = None,
        deadline_monotonic: float | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if not 1 <= max_records_per_jurisdiction <= 1_000:
            raise ValueError("max_records_per_jurisdiction must be in [1, 1000]")
        self._adapter = adapter
        self._registry = registry
        self._county_index_path = county_index_path
        self._max_records_per_jurisdiction = max_records_per_jurisdiction
        self._engine = engine or NetWorthEngine(simulation_count=1_000)
        if self._engine.model_version != NET_WORTH_MODEL_VERSION:
            raise ValueError("snapshot publisher requires the production model version")
        self._now = now or (lambda: datetime.now(UTC))
        if deadline_monotonic is not None and (
            not math.isfinite(deadline_monotonic) or deadline_monotonic <= monotonic()
        ):
            raise ValueError("deadline_monotonic must be a future monotonic timestamp")
        self._deadline_monotonic = deadline_monotonic
        self._monotonic = monotonic

    def _check_deadline(self) -> None:
        if self._deadline_monotonic is not None and self._monotonic() >= self._deadline_monotonic:
            raise SnapshotBuildError(
                "Florida Form 6 refresh deadline was exceeded",
                code="REFRESH_DEADLINE_EXCEEDED",
            )

    def build(self) -> PublishedNetWorthSnapshot:
        self._check_deadline()
        counties = load_florida_counties(self._county_index_path)
        accumulated: dict[str, _ProfileAccumulator] = {}
        source_identity: tuple[object, ...] | None = None
        source_status: object | None = None
        any_query_truncated = False

        for county in counties:
            self._check_deadline()
            batch = self._adapter.discover(
                public_jurisdiction=PublicJurisdiction(
                    kind=PublicJurisdictionKind.OFFICE,
                    token=county.county_name,
                ),
                limit=self._max_records_per_jurisdiction,
            )
            self._check_deadline()
            if batch.outcome is FloridaForm6Outcome.UNAVAILABLE:
                raise SnapshotBuildError(
                    f"reviewed source was unavailable for {county.county_geoid}",
                    code=batch.source_status.error_code or "SOURCE_UNAVAILABLE",
                )
            status = batch.source_status
            identity = (
                _required_status_text(status, "source_snapshot_id"),
                _required_status_text(status, "source_artifact_sha256").casefold(),
                _required_status_text(status, "source_retrieved_at"),
                _required_status_text(status, "index_built_at"),
                _required_status_int(status, "index_form_year"),
                getattr(status, "index_partial", None),
                _required_status_int(status, "filings_seen"),
                _required_status_int(status, "declarations_indexed"),
            )
            if source_identity is None:
                source_identity = identity
                source_status = status
            elif identity != source_identity:
                raise SnapshotBuildError(
                    "reviewed source changed while counties were evaluated",
                    code="SOURCE_CONTRACT_VIOLATION",
                )
            if identity[5] is not True:
                raise SnapshotBuildError(
                    "publisher expected the reviewed partial upstream snapshot",
                    code="SOURCE_BINDING_REJECTED",
                )
            any_query_truncated = any_query_truncated or status.truncated
            for record in batch.records:
                current = accumulated.get(record.subject_id)
                if current is None:
                    accumulated[record.subject_id] = _ProfileAccumulator(
                        record=record,
                        jurisdiction_ids={county.jurisdiction_id},
                    )
                else:
                    current.add(record, county.jurisdiction_id)

        if source_identity is None or source_status is None:
            raise SnapshotBuildError("no Florida counties were evaluated")
        if not accumulated:
            raise SnapshotBuildError(
                "reviewed source produced no county-associated declarations",
                code="SOURCE_CONTRACT_VIOLATION",
            )

        self._check_deadline()
        source_snapshot_id = str(source_identity[0])
        source_sha256 = str(source_identity[1])
        binding = self._registry.bind_reviewed_snapshot(
            "florida_form_6",
            snapshot_id=source_snapshot_id,
            snapshot_sha256=source_sha256,
            operation=SourceOperation.SNAPSHOT_PUBLISHER,
            purpose=_SOURCE_PURPOSE,
            product=_SOURCE_PRODUCT,
        )
        self._validate_reviewed_metadata(source_identity)
        source_retrieved_at = _parse_source_time(source_identity[2], field="source_retrieved_at")
        index_built_at = _parse_source_time(source_identity[3], field="index_built_at")
        generated_at = self._now().astimezone(UTC)
        if generated_at < source_retrieved_at:
            raise SnapshotBuildError(
                "snapshot generation preceded source retrieval",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        form_year = cast(int, source_identity[4])
        profiles = tuple(
            sorted(
                (
                    self._build_profile(item, retrieved_at=source_retrieved_at)
                    for item in accumulated.values()
                ),
                key=lambda item: (-item.median_usd, item.subject_id),
            )
        )
        total_count = cast(int, source_identity[7])
        if len(profiles) > total_count:
            raise SnapshotBuildError(
                "county evaluation exceeded reviewed source total",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        self._check_deadline()
        source = SnapshotSourceStatus(
            source_snapshot_id=source_snapshot_id,
            source_artifact_sha256=source_sha256,
            retrieved_at=source_retrieved_at,
            index_built_at=index_built_at,
            form_year=form_year,
            partial=True,
            total_count=total_count,
            evaluated_count=len(profiles),
            published_profile_count=len(profiles),
            truncated=any_query_truncated or len(profiles) < total_count,
        )
        jurisdictions = tuple(county.published() for county in counties)
        identity_payload: dict[str, object] = {
            "generated_at": generated_at.isoformat(),
            "source_registry_sha256": binding.registry_sha256,
            "source_registry_id": binding.registry_id,
            "source_registry_version": binding.registry_version,
            "model_version": self._engine.model_version,
            "scale_version": NWS_SCALE_VERSION,
            "source": source.model_dump(mode="json"),
            "jurisdictions": [item.model_dump(mode="json") for item in jurisdictions],
            "profiles": [item.model_dump(mode="json") for item in profiles],
        }
        snapshot_id = f"nwsnw_{sha256_hex(canonical_json_bytes(identity_payload))[:24]}"
        return PublishedNetWorthSnapshot(
            snapshot_id=snapshot_id,
            generated_at=generated_at,
            source_registry_sha256=binding.registry_sha256,
            source_registry_id=binding.registry_id,
            source_registry_version=binding.registry_version,
            model_version=NET_WORTH_MODEL_VERSION,
            scale_version=NWS_SCALE_VERSION,
            source=source,
            jurisdictions=jurisdictions,
            profiles=profiles,
        )

    def _validate_reviewed_metadata(self, identity: tuple[object, ...]) -> None:
        raw = self._registry.get("florida_form_6").metadata.get("active_snapshot")
        try:
            reviewed = json.loads(raw or "null")
        except json.JSONDecodeError as exc:
            raise SnapshotBuildError(
                "reviewed snapshot metadata was invalid",
                code="SOURCE_BINDING_REJECTED",
            ) from exc
        if not isinstance(reviewed, dict):
            raise SnapshotBuildError(
                "reviewed snapshot metadata was missing",
                code="SOURCE_BINDING_REJECTED",
            )
        expected = (
            str(reviewed.get("built_at", "")),
            reviewed.get("form_year"),
            reviewed.get("partial"),
            reviewed.get("filings_seen"),
            reviewed.get("declarations_indexed"),
        )
        supplied = (identity[3], identity[4], identity[5], identity[6], identity[7])
        if expected != supplied:
            raise SnapshotBuildError(
                "source index metadata did not match the reviewed artifact",
                code="SOURCE_BINDING_REJECTED",
            )

    def _build_profile(
        self,
        item: _ProfileAccumulator,
        *,
        retrieved_at: datetime,
    ) -> PublishedNetWorthProfile:
        record = item.record
        declared_amount = float(record.declared_net_worth_usd)
        source_date = date(record.form_year, 1, 1)
        result = self._engine.estimate_declared_total(
            subject=NetWorthSubject(
                subject_id=record.subject_id,
                profile_basis=ProfileBasis.VERIFIED_PUBLIC_FINANCIAL_PROFILE,
            ),
            declared_total=DeclaredNetWorthRange(
                low_usd=declared_amount,
                most_likely_usd=declared_amount,
                high_usd=declared_amount,
            ),
            evidence=EvidenceRecord(
                evidence_id=f"{record.subject_id}:declared-total",
                kind=EvidenceKind.STATE_WHOLE_NET_WORTH_DISCLOSURE,
                purpose=EvidencePurpose.DECLARED_NET_WORTH_TOTAL,
                source_authority=record.provenance.source_authority,
                source_uri=record.filing_url,
                source_date=source_date,
                retrieved_at=retrieved_at,
                quality=0.98,
                source_date_precision=EvidenceDatePrecision.YEAR,
            ),
            as_of_date=retrieved_at.date(),
        )
        if (
            result.status is not EstimateStatus.AVAILABLE
            or result.net_worth is None
            or result.nws is None
            or result.confidence is None
        ):
            raise SnapshotBuildError("declared total engine failed closed")
        offices = tuple(sorted(set(record.public_offices), key=lambda value: value.casefold()))
        median = round(result.net_worth.median_usd)
        return PublishedNetWorthProfile(
            subject_id=record.subject_id,
            name=record.name,
            headline=offices[0],
            public_offices=offices,
            jurisdiction_ids=tuple(sorted(item.jurisdiction_ids)),
            form_year=record.form_year,
            declared_net_worth_usd=median,
            p10_usd=round(result.net_worth.p10_usd),
            median_usd=median,
            p90_usd=round(result.net_worth.p90_usd),
            nws=result.nws.score,
            confidence=SnapshotConfidence(
                score=result.confidence.score,
                grade=result.confidence.grade,  # type: ignore[arg-type]
                coverage=result.confidence.coverage,
            ),
        )


@dataclass(frozen=True)
class SnapshotPublication:
    snapshot_id: str
    snapshot_object: str
    snapshot_generation: int
    snapshot_sha256: str
    active_object: str
    active_generation: int


class SnapshotReleasePublisher:
    """Write an immutable release, then atomically advance its active pointer."""

    def __init__(
        self,
        *,
        store: SnapshotGcsStore,
        prefix: str,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        normalized = prefix.strip().strip("/")
        if not normalized or ".." in normalized.split("/"):
            raise ValueError("snapshot prefix is unsafe")
        self._store = store
        self._prefix = normalized
        self._now = now or (lambda: datetime.now(UTC))

    def publish(self, snapshot: PublishedNetWorthSnapshot) -> SnapshotPublication:
        snapshot_bytes = canonical_json_bytes(snapshot)
        # Round-trip the exact stored bytes before any write; this also applies the
        # recursive privacy-key allowlist.
        parse_public_snapshot(snapshot_bytes)
        snapshot_sha256 = sha256_hex(snapshot_bytes)
        release_name = f"{self._prefix}/releases/{snapshot.snapshot_id}.json"
        release = self._write_immutable_or_match(release_name, snapshot_bytes)

        active_name = f"{self._prefix}/active.json"
        active_generation = 0
        current_pointer: ActiveSnapshotPointer | None = None
        try:
            current = self._store.read(active_name)
            active_generation = current.generation
            current_pointer = parse_active_pointer(current.body)
        except SnapshotStoreError as exc:
            if exc.code != "OBJECT_NOT_FOUND":
                raise

        if (
            current_pointer is not None
            and current_pointer.snapshot_id == snapshot.snapshot_id
            and hmac.compare_digest(current_pointer.snapshot_sha256, snapshot_sha256)
            and current_pointer.snapshot_generation == str(release.generation)
        ):
            return SnapshotPublication(
                snapshot_id=snapshot.snapshot_id,
                snapshot_object=release_name,
                snapshot_generation=release.generation,
                snapshot_sha256=snapshot_sha256,
                active_object=active_name,
                active_generation=active_generation,
            )

        if current_pointer is not None:
            if current_pointer.generated_at > snapshot.generated_at:
                raise SnapshotBuildError(
                    "active snapshot is newer than the candidate release",
                    code="SNAPSHOT_ROLLBACK_REJECTED",
                )
            if current_pointer.generated_at == snapshot.generated_at:
                raise SnapshotBuildError(
                    "a different snapshot already exists for this generation time",
                    code="SNAPSHOT_GENERATION_CONFLICT",
                )

        published_at = self._now().astimezone(UTC)
        if published_at < snapshot.generated_at:
            raise SnapshotBuildError("publication cannot precede generation")
        pointer = ActiveSnapshotPointer(
            schema_version=ACTIVE_POINTER_SCHEMA_VERSION,
            snapshot_id=snapshot.snapshot_id,
            snapshot_object=release_name,
            snapshot_generation=str(release.generation),
            snapshot_sha256=snapshot_sha256,
            snapshot_schema_version=SNAPSHOT_SCHEMA_VERSION,
            source_registry_sha256=snapshot.source_registry_sha256,
            generated_at=snapshot.generated_at,
            published_at=published_at,
        )
        pointer_object = self._store.write(
            active_name,
            canonical_json_bytes(pointer),
            if_generation_match=active_generation,
        )
        return SnapshotPublication(
            snapshot_id=snapshot.snapshot_id,
            snapshot_object=release_name,
            snapshot_generation=release.generation,
            snapshot_sha256=snapshot_sha256,
            active_object=active_name,
            active_generation=pointer_object.generation,
        )

    def _write_immutable_or_match(self, name: str, body: bytes) -> GcsObject:
        try:
            return self._store.write(name, body, if_generation_match=0)
        except SnapshotStoreError as exc:
            if exc.code != "GENERATION_PRECONDITION_FAILED":
                raise
        existing = self._store.read(name)
        if not hmac.compare_digest(sha256_hex(existing.body), sha256_hex(body)):
            raise SnapshotStoreError(
                "immutable snapshot ID already contained different bytes",
                code="IMMUTABLE_RELEASE_CONFLICT",
            )
        return existing


def production_adapter(
    *,
    base_url: str,
    bearer_token: str,
    timeout_seconds: float,
    minimum_request_interval_seconds: float = 2.1,
    max_rate_limit_retries: int = 2,
    maximum_retry_after_seconds: float = 30.0,
    deadline_monotonic: float | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> FloridaForm6NetWorthAdapter:
    return FloridaForm6NetWorthAdapter(
        base_url=base_url,
        bearer_token=bearer_token,
        timeout_seconds=timeout_seconds,
        cache_ttl_seconds=0,
        page_size=100,
        max_pages=10,
        minimum_request_interval_seconds=minimum_request_interval_seconds,
        max_rate_limit_retries=max_rate_limit_retries,
        maximum_retry_after_seconds=maximum_retry_after_seconds,
        deadline_monotonic=deadline_monotonic,
        clock=clock,
        sleep=sleep,
    )
