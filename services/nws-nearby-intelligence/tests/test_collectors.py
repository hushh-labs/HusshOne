import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
import yaml

from app.collectors.artifact_store import LocalContentAddressedStore
from app.collectors.contracts import ArtifactManifest, CandidateProposalMode
from app.collectors.fetcher import FetchError, FetchScope, _assert_public_resolution
from app.collectors.registry import (
    SourceBindingError,
    SourceOperation,
    SourceRegistry,
    SourceRegistryIntegrityError,
)

_CONFIG_DIR = Path(__file__).resolve().parents[1] / "config"
_CATALOG = _CONFIG_DIR / "sources.yaml"
_MANIFEST = _CONFIG_DIR / "source-registry-manifest.json"


def _manifest() -> dict[str, object]:
    value = json.loads(_MANIFEST.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def _verified_registry() -> SourceRegistry:
    manifest = _manifest()
    return SourceRegistry.from_verified_yaml(
        _CATALOG,
        _MANIFEST,
        expected_registry_sha256=str(manifest["catalog_sha256"]),
        expected_registry_version=int(manifest["registry_version"]),
    )


def test_content_addressed_store(tmp_path) -> None:
    content = b"example"
    digest = LocalContentAddressedStore.digest(content)
    manifest = ArtifactManifest(
        source_id="test",
        requested_uri="https://example.invalid/file",
        final_uri="https://example.invalid/file",
        retrieved_at=datetime.now(UTC),
        status_code=200,
        content_type="text/plain",
        content_length=len(content),
        sha256=digest,
    )
    path = LocalContentAddressedStore(tmp_path).put(
        source_id="test", content=content, manifest=manifest
    )
    assert path.read_bytes() == content


def test_source_registry_loads_machine_readable_catalog() -> None:
    registry = SourceRegistry.from_yaml(_CATALOG)
    assert len(registry.all()) >= 23
    assert registry.get("sec_edgar_ownership").base_reliability >= 0.95
    assert "private_residence" in registry.get("public_social_verified").forbidden_fact_types
    assert registry.get("sec_form_d").candidate_proposal_mode is (
        CandidateProposalMode.DISCOVERY_ONLY
    )
    assert registry.get("official_company_pages").candidate_proposal_mode is (
        CandidateProposalMode.REVIEW_REQUIRED
    )
    assert registry.get("sec_form_d").source_family == "sec.gov"
    assert "policy" in registry.get("sec_form_d").metadata


def test_verified_registry_binds_only_the_reviewed_florida_snapshot() -> None:
    registry = _verified_registry()
    snapshot = yaml.safe_load(_CATALOG.read_text(encoding="utf-8"))["sources"][
        "florida_form_6"
    ]["active_snapshot"]

    binding = registry.bind_reviewed_snapshot(
        "florida_form_6",
        snapshot_id=snapshot["snapshot_id"],
        snapshot_sha256=snapshot["sha256"],
        operation=SourceOperation.QUERY,
        purpose="FINANCIAL_EVIDENCE",
        product="NET_WORTH_V3",
    )

    assert registry.verified is True
    assert binding.registry_version == 3
    assert binding.operation is SourceOperation.QUERY
    assert binding.snapshot_sha256 == snapshot["sha256"]

    with pytest.raises(SourceBindingError, match="active reviewed release"):
        registry.bind_reviewed_snapshot(
            "florida_form_6",
            snapshot_id=snapshot["snapshot_id"],
            snapshot_sha256="0" * 64,
            operation=SourceOperation.SNAPSHOT_PUBLISHER,
            purpose="FINANCIAL_EVIDENCE",
            product="NET_WORTH_V3",
        )


def test_registry_integrity_and_unverified_binding_fail_closed(tmp_path: Path) -> None:
    manifest = _manifest()
    tampered = tmp_path / "sources.yaml"
    tampered.write_bytes(_CATALOG.read_bytes() + b"\n# unreviewed mutation\n")

    with pytest.raises(SourceRegistryIntegrityError, match="deployment SHA-256"):
        SourceRegistry.from_verified_yaml(
            tampered,
            _MANIFEST,
            expected_registry_sha256=str(manifest["catalog_sha256"]),
            expected_registry_version=int(manifest["registry_version"]),
        )
    with pytest.raises(SourceRegistryIntegrityError, match="version"):
        SourceRegistry.from_verified_yaml(
            _CATALOG,
            _MANIFEST,
            expected_registry_sha256=str(manifest["catalog_sha256"]),
            expected_registry_version=999,
        )

    unverified = SourceRegistry.from_yaml(_CATALOG)
    with pytest.raises(SourceRegistryIntegrityError, match="verified source registry"):
        unverified.bind_reviewed_snapshot(
            "florida_form_6",
            snapshot_id="florida-form6-2025-20260811T184624Z-partial",
            snapshot_sha256="0" * 64,
            operation=SourceOperation.QUERY,
            purpose="FINANCIAL_EVIDENCE",
            product="NET_WORTH_V3",
        )


def test_florida_source_kill_switch_blocks_publisher_and_query(tmp_path: Path) -> None:
    payload = yaml.safe_load(_CATALOG.read_text(encoding="utf-8"))
    payload["sources"]["florida_form_6"]["kill_switch"] = True
    catalog = tmp_path / "sources.yaml"
    catalog.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    digest = hashlib.sha256(catalog.read_bytes()).hexdigest()
    manifest_payload = _manifest()
    manifest_payload["catalog_sha256"] = digest
    manifest_path = tmp_path / "source-registry-manifest.json"
    manifest_path.write_text(json.dumps(manifest_payload), encoding="utf-8")
    registry = SourceRegistry.from_verified_yaml(
        catalog,
        manifest_path,
        expected_registry_sha256=digest,
        expected_registry_version=3,
    )
    snapshot = payload["sources"]["florida_form_6"]["active_snapshot"]

    for operation in (SourceOperation.SNAPSHOT_PUBLISHER, SourceOperation.QUERY):
        with pytest.raises(SourceBindingError, match="kill switch is engaged"):
            registry.bind_reviewed_snapshot(
                "florida_form_6",
                snapshot_id=snapshot["snapshot_id"],
                snapshot_sha256=snapshot["sha256"],
                operation=operation,
                purpose="FINANCIAL_EVIDENCE",
                product="NET_WORTH_V3",
            )


def test_fetch_scope_blocks_redirects_and_unreviewed_paths_before_fetch() -> None:
    scope = FetchScope(
        allowed_hosts=frozenset({"example.org", "www.example.org"}),
        allowed_path_prefixes=frozenset({"/leadership/", "/about"}),
        maximum_content_bytes=100,
    )
    assert scope.permits_uri("https://www.example.org/leadership/team")
    assert scope.permits_uri("https://example.org/about")
    assert not scope.permits_uri("https://example.org/about-unreviewed")
    assert not scope.permits_uri("https://example.org/contact")
    assert not scope.permits_uri("https://other.example.org/leadership/team")
    assert not scope.permits_uri("http://example.org/leadership/team")
    assert scope.permits_content_type("text/html; charset=utf-8")
    assert not scope.permits_content_type("image/png")


def test_fetch_scope_rejects_non_public_literal_hosts() -> None:
    scope = FetchScope(
        allowed_hosts=frozenset({"127.0.0.1", "169.254.169.254"}),
        allowed_path_prefixes=frozenset({"/"}),
    )
    assert not scope.permits_uri("https://127.0.0.1/private")
    assert not scope.permits_uri("https://169.254.169.254/computeMetadata/v1/")


def test_dns_rebinding_to_private_address_fails_closed() -> None:
    def private_resolution(_host: str, _port: int) -> set[str]:
        return {"203.0.113.5", "10.10.0.4"}

    try:
        _assert_public_resolution("https://source.example/report", private_resolution)
    except FetchError as exc:
        assert "non-public" in str(exc)
    else:  # pragma: no cover - explicit assertion keeps this dependency-free
        raise AssertionError("private DNS resolution should be rejected")
