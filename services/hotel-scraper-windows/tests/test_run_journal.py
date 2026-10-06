from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest

from app.run_journal import (
    RunAlreadyFinishedError,
    RunClosedError,
    RunJournal,
    RunNotFoundError,
)


@pytest.fixture
def journal(tmp_path):
    return RunJournal(tmp_path / "run_journal.sqlite3")


def test_run_lifecycle_is_durable_and_finish_is_idempotent(journal):
    started_at = datetime(2026, 10, 5, 8, 30, tzinfo=timezone.utc)
    run_id = journal.create_run(
        {"scraped_via": "chrome_google_maps", "worker": "local"},
        run_id="canary-20261005",
        started_at=started_at,
    )

    created = journal.get_run(run_id)
    assert created == {
        "run_id": "canary-20261005",
        "started_at": "2026-10-05T08:30:00.000000Z",
        "finished_at": None,
        "status": "running",
        "metadata": {"scraped_via": "chrome_google_maps", "worker": "local"},
        "error": None,
    }

    # A fresh object sees the same on-disk journal, as it would after restart.
    reopened = RunJournal(journal.path)
    finished = reopened.finish_run(
        run_id,
        metadata_patch={"hotels_added": 2},
        finished_at=datetime(2026, 10, 5, 8, 31, tzinfo=timezone.utc),
    )
    assert finished["status"] == "completed"
    assert finished["metadata"] == {
        "scraped_via": "chrome_google_maps",
        "worker": "local",
        "hotels_added": 2,
    }
    assert finished["finished_at"] == "2026-10-05T08:31:00.000000Z"

    # Retrying the same finalisation is safe; a conflicting history is not.
    assert reopened.finish_run(run_id)["status"] == "completed"
    with pytest.raises(RunAlreadyFinishedError):
        reopened.finish_run(run_id, status="failed")


def test_hotel_changes_snapshot_before_and_after_values(journal):
    run_id = journal.create_run({"scraped_via": "chrome_google_maps"})
    inserted_after = {"id": 101, "name": "North Star Hotel", "rating": 4.2}
    journal.record_hotel_insert(
        run_id,
        hotel_id=101,
        dedup_key="north star hotel|c23p5p",
        cid="1234567890",
        after=inserted_after,
    )
    # The journal must not retain a mutable reference owned by the worker.
    inserted_after["name"] = "changed in memory"

    before = {"id": 102, "name": "Existing Inn", "rating": 3.9, "phone": None}
    after = {"id": 102, "name": "Existing Inn", "rating": 4.1, "phone": "+1 555 0100"}
    journal.record_hotel_touch(
        run_id,
        hotel_id=102,
        dedup_key="existing inn|c23p5q",
        before=before,
        after=after,
    )

    changes = journal.hotel_changes_for_run(run_id)
    assert [change["operation"] for change in changes] == ["inserted", "touched"]
    assert changes[0]["before"] is None
    assert changes[0]["after"]["name"] == "North Star Hotel"
    assert changes[0]["cid"] == "1234567890"
    assert changes[1]["before"]["rating"] == 3.9
    assert changes[1]["after"]["rating"] == 4.1
    assert journal.hotel_changes_for_run(run_id, operation="inserted") == [changes[0]]


def test_zip_quarantine_and_run_day_report(journal):
    run_id = journal.create_run({"scraped_via": "chrome_google_maps"})
    journal.record_zip_outcome(
        run_id,
        "98033",
        "success",
        evidence={"maps_outcome": "results"},
        hotels_seen=12,
        hotels_new=3,
    )
    journal.quarantine_zip(
        run_id,
        "98034",
        outcome="suspicious",
        reason="0 Maps results without an explicit no-results page",
        evidence={"maps_outcome": "selector_failure", "screenshot": "local-path"},
        hotels_seen=0,
        hotels_new=0,
    )
    journal.finish_run(run_id)

    # Daily reports can be appended after finalisation by a separate reporter.
    journal.record_report_row(
        run_id,
        {"zips_processed": 2, "quarantined": 1},
        day="2026-10-05",
        kind="daily_summary",
    )

    outcomes = journal.zip_outcomes_for_run(run_id)
    assert [(row["zip_code"], row["quarantined"]) for row in outcomes] == [
        ("98033", False),
        ("98034", True),
    ]
    assert outcomes[1]["reason"].startswith("0 Maps results")
    assert journal.zip_outcomes_for_run(run_id, quarantined=True) == [outcomes[1]]

    run_report = journal.run_report(run_id)
    assert run_report["counts"] == {
        "hotels_inserted": 0,
        "hotels_touched": 0,
        "zip_outcomes": 2,
        "quarantined_zips": 1,
        "report_rows": 1,
    }
    day_report = journal.daily_report("2026-10-05")
    assert day_report["counts"]["report_rows"] == 1
    assert day_report["report_rows"][0]["payload"] == {"zips_processed": 2, "quarantined": 1}


def test_unknown_or_closed_runs_cannot_gain_scrape_mutations(journal):
    with pytest.raises(RunNotFoundError):
        journal.record_hotel_insert("missing-run", after={"name": "Nope"})

    run_id = journal.create_run()
    journal.finish_run(run_id)
    with pytest.raises(RunClosedError):
        journal.record_zip_outcome(run_id, "98033", "success")
    with pytest.raises(ValueError, match="five-digit"):
        journal.record_zip_outcome(run_id, "not-a-zip", "success")


def test_one_journal_instance_serializes_concurrent_worker_writes(journal):
    run_id = journal.create_run()

    def record(index):
        return journal.record_hotel_insert(
            run_id,
            hotel_id=index,
            after={"id": index, "name": f"Hotel {index}"},
        )

    with ThreadPoolExecutor(max_workers=8) as executor:
        change_ids = list(executor.map(record, range(16)))

    assert len(set(change_ids)) == 16
    assert len(journal.changes_for_run(run_id)) == 16
