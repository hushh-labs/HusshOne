from app.market_release import get_market_release, load_market_release


def test_kirkland_release_has_sixty_unique_reviewed_public_association_candidates() -> None:
    release = get_market_release()

    assert release.release_id == "us-wa-kirkland-public-association-2026-08-13"
    assert release.market_id == "us-wa-kirkland-public-association"
    assert release.model_version == "nws-v2.3.0-kirkland.2026-08-13"
    assert release.source_retrieved_at == "2026-08-13"
    assert len(release.candidates) == 60
    assert {candidate.person_id for candidate in release.candidates} == set(release.metadata)
    assert all(metadata.evidence_fact_count >= 4 for metadata in release.metadata.values())
    assert all(metadata.citations for metadata in release.metadata.values())


def test_same_domain_urls_do_not_count_as_independent_source_families() -> None:
    release = get_market_release()
    bluetooth = release.metadata["bootstrap_neville_meijers"]
    mps = release.metadata["bootstrap_michael_hsing"]

    assert len(bluetooth.citations) == 2
    assert bluetooth.source_family_count == 1
    assert bluetooth.revalidation_required is True
    assert mps.source_family_count == 2


def test_manifest_hashes_are_deterministic_and_public_safe() -> None:
    first = get_market_release()
    second = load_market_release()

    assert first.candidate_set_sha256 == second.candidate_set_sha256
    assert first.source_registry_sha256 == second.source_registry_sha256
    assert first.manifest_sha256 == second.manifest_sha256
    for candidate in first.candidates:
        assert "residence" not in candidate.location.label.casefold()
        assert "home" not in candidate.location.label.casefold()
