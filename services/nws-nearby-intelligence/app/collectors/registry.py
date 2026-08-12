from __future__ import annotations

import json
from pathlib import Path
from typing import Mapping

import yaml

from app.collectors.contracts import AcquisitionMode, SourceContract, SourceTrustTier


_RELIABILITY_BY_TIER = {
    SourceTrustTier.AUTHORITATIVE: 0.98,
    SourceTrustTier.PRIMARY: 0.88,
    SourceTrustTier.CORROBORATIVE: 0.72,
    SourceTrustTier.DISCOVERY_ONLY: 0.45,
}


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
    result: dict[str, str] = {}
    for key in ("cadence", "purpose", "policy", "enabled"):
        if key in source:
            value = source[key]
            result[key] = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    return result


class SourceRegistry:
    def __init__(self, contracts: list[SourceContract]) -> None:
        if len({contract.source_id for contract in contracts}) != len(contracts):
            raise ValueError("source IDs must be unique")
        self._contracts = {contract.source_id: contract for contract in contracts}

    @classmethod
    def from_yaml(
        cls,
        path: str | Path,
        *,
        user_agent: str = "NWSResearchBot/2.1 contact@example.invalid",
    ) -> "SourceRegistry":
        payload = yaml.safe_load(Path(path).read_text())
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
                    metadata=_metadata(raw),
                )
            )
        return cls(contracts)

    def get(self, source_id: str) -> SourceContract:
        try:
            return self._contracts[source_id]
        except KeyError as exc:
            raise KeyError(f"unknown source {source_id!r}") from exc

    def all(self) -> tuple[SourceContract, ...]:
        return tuple(self._contracts[key] for key in sorted(self._contracts))
