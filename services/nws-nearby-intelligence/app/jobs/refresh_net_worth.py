"""Cloud Run Job entrypoint for the reviewed Form 6 snapshot publisher."""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime

from app.collectors.registry import SourceRegistry
from app.snapshots.form6_refresh import (
    FloridaForm6SnapshotBuilder,
    Form6Adapter,
    SnapshotBuildError,
    SnapshotPublication,
    SnapshotReleasePublisher,
    production_adapter,
)
from app.snapshots.gcs_store import SnapshotGcsStore


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _bounded_int(env: Mapping[str, str], name: str, default: int, low: int, high: int) -> int:
    raw = env.get(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not low <= value <= high:
        raise RuntimeError(f"{name} must be in [{low}, {high}]")
    return value


def _bounded_float(
    env: Mapping[str, str], name: str, default: float, low: float, high: float
) -> float:
    raw = env.get(name, str(default)).strip()
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be numeric") from exc
    if not low <= value <= high:
        raise RuntimeError(f"{name} must be in [{low}, {high}]")
    return value


@dataclass(frozen=True)
class RefreshJobSettings:
    snapshot_bucket: str
    snapshot_prefix: str
    source_registry_path: str
    source_registry_manifest_path: str
    source_registry_sha256: str
    source_registry_version: int
    form6_api_base_url: str
    form6_api_key: str
    form6_timeout_seconds: float
    max_records_per_jurisdiction: int
    request_interval_seconds: float
    max_rate_limit_retries: int
    maximum_retry_after_seconds: float
    refresh_deadline_seconds: float

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> RefreshJobSettings:
        values = os.environ if env is None else env
        bucket = _required(values, "NWS_SNAPSHOT_BUCKET")
        prefix = values.get("NWS_SNAPSHOT_PREFIX", "published/net-worth-v1.0.0").strip().strip("/")
        if not prefix or ".." in prefix.split("/"):
            raise RuntimeError("NWS_SNAPSHOT_PREFIX is unsafe")
        registry_sha256 = _required(values, "NWS_SOURCE_REGISTRY_SHA256").casefold()
        if len(registry_sha256) != 64 or any(
            character not in "0123456789abcdef" for character in registry_sha256
        ):
            raise RuntimeError("NWS_SOURCE_REGISTRY_SHA256 must be lowercase SHA-256 hex")
        return cls(
            snapshot_bucket=bucket,
            snapshot_prefix=prefix,
            source_registry_path=_required(values, "NWS_SOURCE_REGISTRY_PATH"),
            source_registry_manifest_path=_required(values, "NWS_SOURCE_REGISTRY_MANIFEST_PATH"),
            source_registry_sha256=registry_sha256,
            source_registry_version=_bounded_int(
                values, "NWS_SOURCE_REGISTRY_VERSION", 3, 1, 1_000_000
            ),
            form6_api_base_url=_required(values, "NWS_FORM6_API_BASE_URL"),
            form6_api_key=_required(values, "NWS_FORM6_API_KEY"),
            form6_timeout_seconds=_bounded_float(values, "NWS_FORM6_TIMEOUT_SECONDS", 8, 0.1, 30),
            max_records_per_jurisdiction=_bounded_int(
                values,
                "NWS_SNAPSHOT_MAX_RECORDS_PER_JURISDICTION",
                1_000,
                1,
                1_000,
            ),
            request_interval_seconds=_bounded_float(
                values,
                "NWS_FORM6_REQUEST_INTERVAL_SECONDS",
                2.1,
                2.0,
                60.0,
            ),
            max_rate_limit_retries=_bounded_int(
                values,
                "NWS_FORM6_MAX_RATE_LIMIT_RETRIES",
                2,
                0,
                5,
            ),
            maximum_retry_after_seconds=_bounded_float(
                values,
                "NWS_FORM6_MAX_RETRY_AFTER_SECONDS",
                30.0,
                1.0,
                300.0,
            ),
            refresh_deadline_seconds=_bounded_float(
                values,
                "NWS_FORM6_REFRESH_DEADLINE_SECONDS",
                600.0,
                180.0,
                3_600.0,
            ),
        )


def run_job(
    settings: RefreshJobSettings,
    *,
    adapter: Form6Adapter | None = None,
    store: SnapshotGcsStore | None = None,
    now: Callable[[], datetime] | None = None,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> SnapshotPublication:
    clock = now or (lambda: datetime.now(UTC))
    deadline_monotonic = monotonic() + settings.refresh_deadline_seconds

    def require_time_remaining() -> None:
        if monotonic() >= deadline_monotonic:
            raise SnapshotBuildError(
                "Florida Form 6 refresh deadline was exceeded",
                code="REFRESH_DEADLINE_EXCEEDED",
            )

    require_time_remaining()
    registry = SourceRegistry.from_verified_yaml(
        settings.source_registry_path,
        settings.source_registry_manifest_path,
        expected_registry_sha256=settings.source_registry_sha256,
        expected_registry_version=settings.source_registry_version,
    )
    source = adapter or production_adapter(
        base_url=settings.form6_api_base_url,
        bearer_token=settings.form6_api_key,
        timeout_seconds=settings.form6_timeout_seconds,
        minimum_request_interval_seconds=settings.request_interval_seconds,
        max_rate_limit_retries=settings.max_rate_limit_retries,
        maximum_retry_after_seconds=settings.maximum_retry_after_seconds,
        deadline_monotonic=deadline_monotonic,
        clock=monotonic,
        sleep=sleep,
    )
    destination = store or SnapshotGcsStore(bucket=settings.snapshot_bucket)
    require_time_remaining()
    snapshot = FloridaForm6SnapshotBuilder(
        adapter=source,
        registry=registry,
        max_records_per_jurisdiction=settings.max_records_per_jurisdiction,
        now=clock,
        deadline_monotonic=deadline_monotonic,
        monotonic=monotonic,
    ).build()
    require_time_remaining()
    publication = SnapshotReleasePublisher(
        store=destination,
        prefix=settings.snapshot_prefix,
        now=clock,
    ).publish(snapshot)
    require_time_remaining()
    return publication


def main() -> int:
    publication = run_job(RefreshJobSettings.from_env())
    print(
        json.dumps(
            {
                "ok": True,
                "snapshot_id": publication.snapshot_id,
                "snapshot_object": publication.snapshot_object,
                "snapshot_generation": str(publication.snapshot_generation),
                "snapshot_sha256": publication.snapshot_sha256,
                "active_object": publication.active_object,
                "active_generation": str(publication.active_generation),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
