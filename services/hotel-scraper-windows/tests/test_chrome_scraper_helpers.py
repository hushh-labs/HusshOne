from app.chrome_scraper import _BrowserProcess, _canonical_maps_url, _extract_cid, _is_explicit_empty


def test_cid_url_is_normalized_without_losing_identity():
    url = "https://www.google.com/maps/place/Example?foo=1&cid=123456789"
    cid = _extract_cid(url)
    assert cid == "123456789"
    assert _canonical_maps_url(cid, url) == "https://www.google.com/maps?cid=123456789"


def test_google_feature_pair_is_converted_to_canonical_decimal_cid():
    url = "https://www.google.com/maps/place/Example/data=!4m2!3m1!1s0x1234:0x112210f47de98115"
    cid = _extract_cid(url)
    assert cid == str(int("112210f47de98115", 16))
    assert _canonical_maps_url(cid, url) == f"https://www.google.com/maps?cid={cid}"


def test_url_encoded_google_feature_pair_is_also_supported():
    assert _extract_cid("https://www.google.com/maps/place/Example/0x1234%3A0x10") == "16"


def test_only_explicit_maps_empty_copy_is_treated_as_empty():
    assert _is_explicit_empty("No results found for this search")
    assert not _is_explicit_empty("Loading map results")
    assert not _is_explicit_empty("Can't find the setting you need? Try help.")


def test_profile_lock_cleanup_refuses_when_profile_may_be_in_use(monkeypatch, tmp_path):
    lock = tmp_path / "SingletonLock"
    lock.write_text("active", encoding="utf-8")
    processor = _BrowserProcess()
    monkeypatch.setattr(processor, "_profile_in_use_by_chrome", lambda profile: True)
    monkeypatch.setattr("app.chrome_scraper.CHROME_PROFILE_DIR", str(tmp_path))

    processor._clear_stale_profile_locks()

    assert lock.exists()


def test_profile_lock_cleanup_removes_confirmed_stale_lock(monkeypatch, tmp_path):
    lock = tmp_path / "SingletonLock"
    lock.write_text("stale", encoding="utf-8")
    processor = _BrowserProcess()
    monkeypatch.setattr(processor, "_profile_in_use_by_chrome", lambda profile: False)
    monkeypatch.setattr("app.chrome_scraper.CHROME_PROFILE_DIR", str(tmp_path))

    processor._clear_stale_profile_locks()

    assert not lock.exists()


def test_orphan_cleanup_targets_only_verified_headless_profile_chrome(monkeypatch, tmp_path):
    processor = _BrowserProcess()
    killed = []

    def profile_pids(profile, *, headless_only=False):
        assert profile == tmp_path
        return [101, 202] if headless_only else []

    monkeypatch.setattr(processor, "_profile_chrome_pids", profile_pids)
    monkeypatch.setattr(processor, "_kill_verified_pid", lambda pid: killed.append(pid))

    processor._terminate_orphaned_headless_profile_chrome(tmp_path)

    assert killed == [101, 202]
