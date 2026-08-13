from datetime import UTC, datetime

from app.collectors.artifact_store import LocalContentAddressedStore
from app.collectors.contracts import ArtifactManifest, CandidateProposalMode
from app.collectors.fetcher import FetchScope


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
    from pathlib import Path

    from app.collectors.registry import SourceRegistry

    path = Path(__file__).resolve().parents[1] / "config" / "sources.yaml"
    registry = SourceRegistry.from_yaml(path)
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
