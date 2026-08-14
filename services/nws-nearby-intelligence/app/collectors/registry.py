from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

from app.collectors.contracts import (
    AcquisitionMode,
    CandidateProposalMode,
    SourceContract,
    SourceTrustTier,
)

_RELIABILITY_BY_TIER = {
    SourceTrustTier.AUTHORITATIVE: 0.98,
    SourceTrustTier.PRIMARY: 0.88,
    SourceTrustTier.CORROBORATIVE: 0.72,
    SourceTrustTier.DISCOVERY_ONLY: 0.45,
}

_MANIFEST_SCHEMA_VERSION = 1
_SHA256_HEX_LENGTH = 64


class SourceRegistryIntegrityError(ValueError):
    """The reviewed source catalog did not match its deployment pins."""


class SourceBindingError(PermissionError):
    """A source is not authorised for the requested runtime operation."""


class SourceOperation(StrEnum):
    SNAPSHOT_PUBLISHER = "SNAPSHOT_PUBLISHER"
    QUERY = "QUERY"


@dataclass(frozen=True)
class SourceRegistryManifest:
    registry_id: str
    registry_version: int
    catalog_file: str
    catalog_sha256: str
    source_count: int
    review_status: str
    reviewed_at: str


@dataclass(frozen=True)
class SourceSnapshotBinding:
    """Immutable proof that one reviewed snapshot may serve one purpose."""

    source_id: str
    snapshot_id: str
    snapshot_sha256: str
    operation: SourceOperation
    purpose: str
    product: str
    registry_id: str
    registry_version: int
    registry_sha256: str


def _acquisition_mode(value: str) -> AcquisitionMode:
    normalized = value.casefold()
    if "snapshot" in normalized:
        return AcquisitionMode.SNAPSHOT
    if "dump" in normalized:
        return AcquisitionMode.INCREMENTAL_DUMP
    if any(
        token in normalized
        for token in ("bulk", "archive", "shapefile", "index", "table", "xml")
    ):
        return AcquisitionMode.BULK_FILE
    return AcquisitionMode.PUBLIC_PAGE


def _trust_tier(value: str) -> SourceTrustTier:
    normalized = value.casefold()
    if normalized.startswith("authoritative"):
        return SourceTrustTier.AUTHORITATIVE
    if normalized.startswith("primary"):
        return SourceTrustTier.PRIMARY
    if normalized.startswith("corroborative"):
        return SourceTrustTier.CORROBORATIVE
    if normalized.startswith("discovery"):
        return SourceTrustTier.DISCOVERY_ONLY
    raise ValueError(f"unsupported trust tier {value!r}")


def _metadata(source: Mapping[str, object]) -> dict[str, str]:
    """Retain review-relevant YAML settings instead of discarding them.

    The earlier loader kept only four display fields.  That made a source's
    publication boundary, terms-review note, and crawler scope invisible to
    an intake worker.  Contract fields are typed separately; the rest stays
    machine-readable metadata for an analyst/reviewer.
    """

    contract_keys = {
        "authority",
        "acquisition",
        "trust_tier",
        "base_reliability",
        "allowed_fact_types",
        "forbidden_fact_types",
        "source_family",
        "candidate_proposal_mode",
    }
    result: dict[str, str] = {}
    for key, value in source.items():
        if key in contract_keys:
            continue
        result[str(key)] = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    return result


def _candidate_proposal_mode(value: object) -> CandidateProposalMode:
    try:
        return CandidateProposalMode(str(value).strip().upper())
    except ValueError as exc:
        raise ValueError(f"unsupported candidate proposal mode {value!r}") from exc


def _require_sha256(value: object, *, field: str) -> str:
    digest = str(value).strip().casefold()
    if len(digest) != _SHA256_HEX_LENGTH or any(
        character not in "0123456789abcdef" for character in digest
    ):
        raise SourceRegistryIntegrityError(f"{field} must be a SHA-256 hex digest")
    return digest


def _metadata_value(contract: SourceContract, key: str) -> Any:
    value = contract.metadata.get(key)
    if value is None:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _string_set(value: object) -> frozenset[str]:
    if not isinstance(value, list):
        return frozenset()
    return frozenset(str(item).strip().upper() for item in value if str(item).strip())


class SourceRegistry:
    def __init__(
        self,
        contracts: list[SourceContract],
        *,
        manifest: SourceRegistryManifest | None = None,
    ) -> None:
        if len({contract.source_id for contract in contracts}) != len(contracts):
            raise ValueError("source IDs must be unique")
        self._contracts = {contract.source_id: contract for contract in contracts}
        self._manifest = manifest

    @classmethod
    def from_yaml(
        cls,
        path: str | Path,
        *,
        user_agent: str = "Hushh-NWSResearchBot/3.0 security@hushh.ai",
    ) -> SourceRegistry:
        """Load an unverified catalog for local authoring and unit tests only.

        Runtime publishers and query services must use :meth:`from_verified_yaml`;
        snapshot binding deliberately fails for registries loaded through this method.
        """

        payload = yaml.safe_load(Path(path).read_bytes())
        return cls._from_payload(payload, user_agent=user_agent)

    @classmethod
    def from_verified_yaml(
        cls,
        path: str | Path,
        manifest_path: str | Path,
        *,
        expected_registry_sha256: str,
        expected_registry_version: int,
        user_agent: str = "Hushh-NWSResearchBot/3.0 security@hushh.ai",
    ) -> SourceRegistry:
        """Load a reviewed catalog only when manifest and deployment pins agree.

        Both expected values are required caller-owned deployment pins. This prevents
        replacing the catalog and its adjacent manifest together from silently
        authorising a source in either the snapshot publisher or the query service.
        """

        catalog_path = Path(path)
        raw_catalog = catalog_path.read_bytes()
        actual_sha256 = hashlib.sha256(raw_catalog).hexdigest()
        expected_sha256 = _require_sha256(
            expected_registry_sha256, field="expected_registry_sha256"
        )
        if not hmac.compare_digest(actual_sha256, expected_sha256):
            raise SourceRegistryIntegrityError("source catalog did not match deployment SHA-256")

        try:
            raw_manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise SourceRegistryIntegrityError("source registry manifest is unreadable") from exc
        if not isinstance(raw_manifest, dict):
            raise SourceRegistryIntegrityError("source registry manifest must be an object")
        if raw_manifest.get("schema_version") != _MANIFEST_SCHEMA_VERSION:
            raise SourceRegistryIntegrityError("unsupported source registry manifest schema")

        manifest = SourceRegistryManifest(
            registry_id=str(raw_manifest.get("registry_id", "")).strip(),
            registry_version=int(raw_manifest.get("registry_version", -1)),
            catalog_file=str(raw_manifest.get("catalog_file", "")).strip(),
            catalog_sha256=_require_sha256(
                raw_manifest.get("catalog_sha256"), field="manifest catalog_sha256"
            ),
            source_count=int(raw_manifest.get("source_count", -1)),
            review_status=str(raw_manifest.get("review_status", "")).strip().upper(),
            reviewed_at=str(raw_manifest.get("reviewed_at", "")).strip(),
        )
        if not manifest.registry_id or not manifest.reviewed_at:
            raise SourceRegistryIntegrityError("source registry review metadata is incomplete")
        if manifest.review_status != "APPROVED":
            raise SourceRegistryIntegrityError("source registry is not approved")
        if manifest.catalog_file != catalog_path.name:
            raise SourceRegistryIntegrityError("manifest catalog filename mismatch")
        if not hmac.compare_digest(manifest.catalog_sha256, actual_sha256):
            raise SourceRegistryIntegrityError("manifest catalog SHA-256 mismatch")
        if manifest.registry_version != expected_registry_version:
            raise SourceRegistryIntegrityError(
                "source registry version did not match deployment pin"
            )

        payload = yaml.safe_load(raw_catalog)
        if not isinstance(payload, dict):
            raise SourceRegistryIntegrityError("source YAML must be an object")
        if payload.get("registry_id") != manifest.registry_id:
            raise SourceRegistryIntegrityError("source registry ID mismatch")
        if payload.get("version") != manifest.registry_version:
            raise SourceRegistryIntegrityError("catalog and manifest versions differ")

        registry = cls._from_payload(payload, user_agent=user_agent, manifest=manifest)
        if len(registry.all()) != manifest.source_count:
            raise SourceRegistryIntegrityError("source count did not match reviewed manifest")
        return registry

    @classmethod
    def _from_payload(
        cls,
        payload: object,
        *,
        user_agent: str,
        manifest: SourceRegistryManifest | None = None,
    ) -> SourceRegistry:
        if not isinstance(payload, dict) or not isinstance(payload.get("sources"), dict):
            raise ValueError("source YAML must contain a sources mapping")

        contracts: list[SourceContract] = []
        for source_id, raw in payload["sources"].items():
            if not isinstance(raw, dict):
                raise ValueError(f"source {source_id!r} must be a mapping")
            tier = _trust_tier(str(raw.get("trust_tier", "discovery_only")))
            crawl_policy = raw.get("crawl_policy") or {}
            if not isinstance(crawl_policy, dict):
                crawl_policy = {}
            requests_per_second = float(crawl_policy.get("requests_per_second", 1.0))
            obey_robots = bool(crawl_policy.get("obey_robots_txt", True))
            contracts.append(
                SourceContract(
                    source_id=str(source_id),
                    authority=str(raw.get("authority", source_id)),
                    acquisition_mode=_acquisition_mode(str(raw.get("acquisition", "public_page"))),
                    trust_tier=tier,
                    base_reliability=float(
                        raw.get("base_reliability", _RELIABILITY_BY_TIER[tier])
                    ),
                    allowed_fact_types=frozenset(
                        str(item) for item in raw.get("allowed_fact_types", ())
                    ),
                    forbidden_fact_types=frozenset(
                        str(item) for item in raw.get("forbidden_fact_types", ())
                    ),
                    requests_per_second=requests_per_second,
                    obey_robots_txt=obey_robots,
                    user_agent=user_agent,
                    source_family=str(raw.get("source_family", source_id)),
                    candidate_proposal_mode=_candidate_proposal_mode(
                        raw.get("candidate_proposal_mode", "REVIEW_REQUIRED")
                    ),
                    metadata=_metadata(raw),
                )
            )
        return cls(contracts, manifest=manifest)

    def get(self, source_id: str) -> SourceContract:
        try:
            return self._contracts[source_id]
        except KeyError as exc:
            raise KeyError(f"unknown source {source_id!r}") from exc

    def all(self) -> tuple[SourceContract, ...]:
        return tuple(self._contracts[key] for key in sorted(self._contracts))

    @property
    def verified(self) -> bool:
        return self._manifest is not None

    def bind_reviewed_snapshot(
        self,
        source_id: str,
        *,
        snapshot_id: str,
        snapshot_sha256: str,
        operation: SourceOperation,
        purpose: str,
        product: str,
    ) -> SourceSnapshotBinding:
        """Fail closed unless a reviewed snapshot is enabled for this exact use."""

        manifest = self._manifest
        if manifest is None:
            raise SourceRegistryIntegrityError(
                "snapshot binding requires a verified source registry"
            )
        contract = self.get(source_id)
        if _metadata_value(contract, "enabled") is not True:
            raise SourceBindingError(f"source {source_id!r} is disabled")
        if _metadata_value(contract, "kill_switch") is not False:
            raise SourceBindingError(f"source {source_id!r} kill switch is engaged")
        if str(_metadata_value(contract, "publication_mode")).upper() != (
            "REVIEWED_SNAPSHOT_ONLY"
        ):
            raise SourceBindingError(f"source {source_id!r} is not snapshot-only")

        allowed_operations = _string_set(_metadata_value(contract, "allowed_operations"))
        if operation.value not in allowed_operations:
            raise SourceBindingError(
                f"source {source_id!r} does not permit {operation.value}"
            )
        normalized_purpose = purpose.strip().upper()
        if normalized_purpose not in _string_set(
            _metadata_value(contract, "allowed_purposes")
        ):
            raise SourceBindingError(f"source {source_id!r} does not permit this purpose")
        normalized_product = product.strip().upper()
        if normalized_product not in _string_set(
            _metadata_value(contract, "allowed_products")
        ):
            raise SourceBindingError(f"source {source_id!r} does not permit this product")

        active_snapshot = _metadata_value(contract, "active_snapshot")
        if not isinstance(active_snapshot, dict):
            raise SourceBindingError(f"source {source_id!r} has no reviewed snapshot")
        reviewed_id = str(active_snapshot.get("snapshot_id", "")).strip()
        reviewed_sha256 = _require_sha256(
            active_snapshot.get("sha256"), field="active snapshot sha256"
        )
        supplied_sha256 = _require_sha256(snapshot_sha256, field="snapshot_sha256")
        if reviewed_id != snapshot_id.strip() or not hmac.compare_digest(
            reviewed_sha256, supplied_sha256
        ):
            raise SourceBindingError("snapshot did not match the active reviewed release")
        if str(active_snapshot.get("review_status", "")).strip().upper() != "APPROVED":
            raise SourceBindingError("active snapshot is not approved")

        return SourceSnapshotBinding(
            source_id=source_id,
            snapshot_id=reviewed_id,
            snapshot_sha256=reviewed_sha256,
            operation=operation,
            purpose=normalized_purpose,
            product=normalized_product,
            registry_id=manifest.registry_id,
            registry_version=manifest.registry_version,
            registry_sha256=manifest.catalog_sha256,
        )
