from __future__ import annotations

import hmac
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from app.net_worth import NET_WORTH_MODEL_VERSION, NWS_SCALE_VERSION
from app.snapshots.contracts import (
    PublishedNetWorthProfile,
    PublishedNetWorthSnapshot,
    SnapshotContractError,
    SnapshotRepositoryStatus,
    parse_active_pointer,
    parse_public_snapshot,
    sha256_hex,
)
from app.snapshots.gcs_store import SnapshotGcsStore, SnapshotStoreError


class SnapshotUnavailableError(RuntimeError):
    def __init__(self, message: str, *, code: str = "SNAPSHOT_UNAVAILABLE") -> None:
        super().__init__(message)
        self.code = code


class NetWorthSnapshotRepository:
    """Read one generation-pinned, digest-verified active release."""

    def __init__(
        self,
        *,
        store: SnapshotGcsStore,
        prefix: str,
        expected_registry_sha256: str,
        max_age: timedelta,
        max_source_age: timedelta | None = None,
        validate_source_binding: Callable[[PublishedNetWorthSnapshot], None] | None = None,
        cache_ttl_seconds: float = 60,
        now: Callable[[], datetime] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        normalized_prefix = prefix.strip().strip("/")
        if not normalized_prefix or ".." in normalized_prefix.split("/"):
            raise ValueError("snapshot prefix is unsafe")
        if len(expected_registry_sha256) != 64 or any(
            character not in "0123456789abcdef" for character in expected_registry_sha256.casefold()
        ):
            raise ValueError("expected_registry_sha256 must be a SHA-256 digest")
        if not timedelta(minutes=1) <= max_age <= timedelta(days=30):
            raise ValueError("snapshot max age must be between one minute and 30 days")
        if not 0 <= cache_ttl_seconds <= 3_600:
            raise ValueError("cache_ttl_seconds must be in [0, 3600]")
        self._store = store
        self._prefix = normalized_prefix
        self._active_object = f"{normalized_prefix}/active.json"
        self._expected_registry_sha256 = expected_registry_sha256.casefold()
        self._max_age = max_age
        self._max_source_age = max_source_age or timedelta(days=30)
        if not timedelta(minutes=1) <= self._max_source_age <= timedelta(days=30):
            raise ValueError("source max age must be between one minute and 30 days")
        self._validate_source_binding = validate_source_binding
        self._cache_ttl_seconds = cache_ttl_seconds
        self._now = now or (lambda: datetime.now(UTC))
        self._monotonic = monotonic
        self._cache: tuple[float, PublishedNetWorthSnapshot, SnapshotRepositoryStatus] | None = None
        self._lock = threading.Lock()

    def load_active(self, *, force: bool = False) -> PublishedNetWorthSnapshot:
        now_monotonic = self._monotonic()
        with self._lock:
            if not force and self._cache is not None and self._cache[0] > now_monotonic:
                return self._cache[1]

        try:
            pointer_object = self._store.read(self._active_object)
            pointer = parse_active_pointer(pointer_object.body)
        except (SnapshotStoreError, SnapshotContractError) as exc:
            raise SnapshotUnavailableError(
                "active net-worth snapshot pointer is unavailable",
                code=getattr(exc, "code", "INVALID_ACTIVE_POINTER"),
            ) from exc

        expected_release_prefix = f"{self._prefix}/releases/"
        expected_release_object = f"{expected_release_prefix}{pointer.snapshot_id}.json"
        if pointer.snapshot_object != expected_release_object:
            raise SnapshotUnavailableError(
                "active pointer escaped the approved release prefix",
                code="INVALID_ACTIVE_POINTER",
            )
        if not hmac.compare_digest(
            pointer.source_registry_sha256,
            self._expected_registry_sha256,
        ):
            raise SnapshotUnavailableError(
                "active pointer used an unapproved source registry",
                code="SOURCE_REGISTRY_MISMATCH",
            )

        try:
            snapshot_object = self._store.read(
                pointer.snapshot_object,
                generation=int(pointer.snapshot_generation),
            )
        except SnapshotStoreError as exc:
            raise SnapshotUnavailableError(
                "active net-worth snapshot object is unavailable",
                code=exc.code,
            ) from exc
        digest = sha256_hex(snapshot_object.body)
        if not hmac.compare_digest(digest, pointer.snapshot_sha256):
            raise SnapshotUnavailableError(
                "active net-worth snapshot digest did not match its pointer",
                code="SNAPSHOT_DIGEST_MISMATCH",
            )
        try:
            snapshot = parse_public_snapshot(snapshot_object.body)
        except SnapshotContractError as exc:
            raise SnapshotUnavailableError(
                "active net-worth snapshot schema is invalid",
                code="SNAPSHOT_SCHEMA_INVALID",
            ) from exc
        if snapshot.snapshot_id != pointer.snapshot_id:
            raise SnapshotUnavailableError(
                "active pointer and snapshot IDs differ",
                code="SNAPSHOT_ID_MISMATCH",
            )
        if snapshot.generated_at != pointer.generated_at:
            raise SnapshotUnavailableError(
                "active pointer and snapshot generation times differ",
                code="SNAPSHOT_GENERATED_AT_MISMATCH",
            )
        if not hmac.compare_digest(
            snapshot.source_registry_sha256,
            self._expected_registry_sha256,
        ):
            raise SnapshotUnavailableError(
                "snapshot used an unapproved source registry",
                code="SOURCE_REGISTRY_MISMATCH",
            )
        if snapshot.model_version != NET_WORTH_MODEL_VERSION:
            raise SnapshotUnavailableError(
                "snapshot used an unsupported net-worth model",
                code="MODEL_VERSION_MISMATCH",
            )
        if snapshot.scale_version != NWS_SCALE_VERSION:
            raise SnapshotUnavailableError(
                "snapshot used an unsupported NWS scale",
                code="SCALE_VERSION_MISMATCH",
            )
        current = self._now().astimezone(UTC)
        age = current - snapshot.generated_at.astimezone(UTC)
        if age < timedelta(minutes=-5) or age > self._max_age:
            raise SnapshotUnavailableError(
                "active net-worth snapshot is stale or future-dated",
                code="SNAPSHOT_STALE",
            )
        source_age = current - snapshot.source.index_built_at.astimezone(UTC)
        if source_age < timedelta(minutes=-5) or source_age > self._max_source_age:
            raise SnapshotUnavailableError(
                "active net-worth source index is stale or future-dated",
                code="SOURCE_INDEX_STALE",
            )
        if self._validate_source_binding is not None:
            try:
                self._validate_source_binding(snapshot)
            except Exception as exc:
                raise SnapshotUnavailableError(
                    "snapshot source binding was rejected",
                    code="SOURCE_BINDING_REJECTED",
                ) from exc

        status = SnapshotRepositoryStatus(
            snapshot_id=snapshot.snapshot_id,
            snapshot_sha256=digest,
            generated_at=snapshot.generated_at,
            source_retrieved_at=snapshot.source.retrieved_at,
            source_index_built_at=snapshot.source.index_built_at,
            source_form_year=snapshot.source.form_year,
            source_partial=snapshot.source.partial,
            source_total_count=snapshot.source.total_count,
            evaluated_count=snapshot.source.evaluated_count,
            profile_count=len(snapshot.profiles),
            jurisdiction_count=len(snapshot.jurisdictions),
            truncated=snapshot.source.truncated,
        )
        with self._lock:
            self._cache = (
                now_monotonic + self._cache_ttl_seconds,
                snapshot,
                status,
            )
        return snapshot

    def status(self, *, force: bool = False) -> SnapshotRepositoryStatus:
        if force:
            self.load_active(force=True)
        with self._lock:
            if self._cache is None:
                raise SnapshotUnavailableError(
                    "net-worth snapshot has not been loaded",
                    code="SNAPSHOT_NOT_LOADED",
                )
            return self._cache[2]

    def profiles_for_jurisdiction(
        self,
        jurisdiction_id: str,
    ) -> tuple[PublishedNetWorthProfile, ...]:
        with self._lock:
            if self._cache is None:
                raise SnapshotUnavailableError(
                    "net-worth snapshot has not been loaded",
                    code="SNAPSHOT_NOT_LOADED",
                )
            snapshot = self._cache[1]
        return snapshot.profiles_for_jurisdiction(jurisdiction_id)
