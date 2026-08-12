from datetime import datetime, timezone

from app.collectors.artifact_store import LocalContentAddressedStore
from app.collectors.contracts import ArtifactManifest


def test_content_addressed_store(tmp_path) -> None:
    content = b"example"
    digest = LocalContentAddressedStore.digest(content)
    manifest = ArtifactManifest(
        source_id="test",
        requested_uri="https://example.invalid/file",
        final_uri="https://example.invalid/file",
        retrieved_at=datetime.now(timezone.utc),
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
    from pathlib import Path

    from app.collectors.registry import SourceRegistry

    path = Path(__file__).resolve().parents[1] / "config" / "sources.yaml"
    registry = SourceRegistry.from_yaml(path)
    assert len(registry.all()) >= 18
    assert registry.get("sec_edgar_ownership").base_reliability >= 0.95
    assert "private_residence" in registry.get("public_social_verified").forbidden_fact_types
