from app.canary import assess_canary
from app.scrape_contract import ScrapeResult, ScrapeStatus


def test_canary_rejects_selector_failure_and_low_result_count():
    failed = assess_canary(ScrapeResult(ScrapeStatus.SELECTOR_FAILURE), 3)
    assert not failed.healthy

    low = assess_canary(ScrapeResult(ScrapeStatus.SUCCESS, [{"name": "one"}]), 3)
    assert not low.healthy


def test_canary_accepts_expected_result_count():
    assessment = assess_canary(ScrapeResult(ScrapeStatus.SUCCESS, [{}, {}, {}]), 3)
    assert assessment.healthy
