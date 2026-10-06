from datetime import datetime, timezone
import sqlite3

import pytest

from app.outbox import LocalOutbox
from app.config import database_target
from app.recovery import RecoveryInspectionError, inspect_startup_recovery, startup_recovery_status
from app.run_journal import RunJournal


def test_recovery_report_finds_interrupted_runs_and_pending_outbox_without_mutating_them(tmp_path):
    journal = RunJournal(tmp_path / "journal.sqlite3")
    outbox = LocalOutbox(tmp_path / "outbox.sqlite3")
    journal.create_run(
        {"scraped_via": "chrome_google_maps"},
        run_id="interrupted-run",
        started_at=datetime(2026, 10, 5, 8, tzinfo=timezone.utc),
    )
    journal.create_run({"worker": "background"}, run_id="completed-run")
    journal.finish_run("completed-run")
    outbox.enqueue(
        "interrupted-run",
        "98033",
        [{"name": "North Star", "lat": 47.61, "lng": -122.2}],
        metadata={"state": "WA", "zip_lat": 47.61, "zip_lng": -122.2,
                  "database_target": database_target()},
        batch_id="interrupted-run:98033",
        created_at=datetime(2026, 10, 5, 8, 1, tzinfo=timezone.utc),
    )

    report = inspect_startup_recovery(
        journal_path=journal.path,
        outbox_path=outbox.path,
        now=datetime(2026, 10, 5, 9, tzinfo=timezone.utc),
    ).as_dict()

    assert report["generated_at"] == "2026-10-05T09:00:00.000000Z"
    assert report["safe_to_resume"] is True
    assert report["needs_operator_review"] is True
    assert report["recovery_mode"] == "replay_pending_outbox"
    assert report["journal"]["state"] == "ready"
    assert report["journal"]["unfinished_runs"] == [
        {"run_id": "interrupted-run", "started_at": "2026-10-05T08:00:00.000000Z"}
    ]
    assert report["outbox"]["pending_batch_count"] == 1
    assert report["outbox"]["pending_record_count"] == 1
    assert report["outbox"]["pending_batches"] == [
        {
            "batch_id": "interrupted-run:98033",
            "run_id": "interrupted-run",
            "zip_code": "98033",
            "created_at": "2026-10-05T08:01:00.000000Z",
            "record_count": 1,
        }
    ]
    assert {action["code"] for action in report["recommended_actions"]} == {
        "replay_pending_outbox",
        "review_interrupted_runs",
    }

    # Inspection did not acknowledge the remote write or hide the interrupted run.
    assert journal.get_run("interrupted-run")["status"] == "running"
    assert journal.get_run("interrupted-run")["finished_at"] is None
    assert outbox.get("interrupted-run:98033").status == "pending"


def test_missing_local_files_are_reported_as_clean_first_start_without_creating_them(tmp_path):
    journal_path = tmp_path / "missing-journal.sqlite3"
    outbox_path = tmp_path / "missing-outbox.sqlite3"

    report = startup_recovery_status(journal_path=journal_path, outbox_path=outbox_path)

    assert report["safe_to_resume"] is True
    assert report["recovery_mode"] == "ready"
    assert report["journal"]["state"] == "absent"
    assert report["outbox"]["state"] == "absent"
    assert not journal_path.exists()
    assert not outbox_path.exists()


def test_malformed_pending_payload_holds_remote_writes_without_changing_outbox(tmp_path):
    outbox = LocalOutbox(tmp_path / "outbox.sqlite3")
    outbox.enqueue(
        "run-a",
        "98033",
        [{"name": "A"}],
        batch_id="run-a:98033",
    )
    with sqlite3.connect(outbox.path) as conn:
        conn.execute(
            "UPDATE outbox_batches SET records_json = ? WHERE batch_id = ?",
            ("{not-json", "run-a:98033"),
        )

    report = inspect_startup_recovery(
        journal_path=tmp_path / "missing-journal.sqlite3", outbox_path=outbox.path
    ).as_dict()

    assert report["safe_to_resume"] is False
    assert report["recovery_mode"] == "hold_for_review"
    assert report["outbox"]["state"] == "corrupt"
    assert report["outbox"]["integrity_errors"][0]["batch_id"] == "run-a:98033"
    assert report["recommended_actions"][0]["code"] == "hold_outbox_writes"
    with sqlite3.connect(outbox.path) as conn:
        assert conn.execute(
            "SELECT status, records_json FROM outbox_batches WHERE batch_id = ?", ("run-a:98033",)
        ).fetchone() == ("pending", "{not-json")


def test_unreadable_schema_is_a_safe_failure_and_arguments_are_bounded(tmp_path):
    bad_journal = tmp_path / "not-a-journal.sqlite3"
    with sqlite3.connect(bad_journal) as conn:
        conn.execute("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)")

    report = inspect_startup_recovery(
        journal_path=bad_journal, outbox_path=tmp_path / "absent-outbox.sqlite3"
    ).as_dict()

    assert report["safe_to_resume"] is False
    assert report["journal"]["state"] == "unavailable"
    assert "expected local table" in report["journal"]["error"]
    with pytest.raises(RecoveryInspectionError):
        inspect_startup_recovery(journal_path=bad_journal, max_items=0)
