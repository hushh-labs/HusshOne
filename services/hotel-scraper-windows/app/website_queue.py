"""Target-bound durable website jobs. Fetched evidence survives DB outages."""
import hashlib
import json
import sqlite3
import time
import uuid
from pathlib import Path
from contextlib import contextmanager

from app.config import database_target, runtime_state_dir, settings
from app.outbox import require_matching_target


class WebsiteQueue:
    def __init__(self, path=None):
        self.path = Path(path) if path else Path(runtime_state_dir()) / "website_jobs.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            # Worker startup and dashboard polling can open this file together.
            # Serialize additive local schema upgrades before inspecting columns.
            c.execute("BEGIN IMMEDIATE")
            c.execute("""CREATE TABLE IF NOT EXISTS website_jobs (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
                result TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL)""")
            c.execute("""CREATE TABLE IF NOT EXISTS website_backfill_runs (
                target TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL,
                cursor INTEGER NOT NULL DEFAULT 0, ceiling INTEGER NOT NULL,
                scanned INTEGER NOT NULL DEFAULT 0, missing_website INTEGER NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL)""")
            if "filled_count" not in {row["name"] for row in c.execute("PRAGMA table_info(website_jobs)")}:
                c.execute("ALTER TABLE website_jobs ADD COLUMN filled_count INTEGER NOT NULL DEFAULT 0")
            c.execute("CREATE INDEX IF NOT EXISTS website_jobs_backfill ON website_jobs(json_extract(payload,'$.backfill_id'),state,filled_count)")
            c.execute("CREATE INDEX IF NOT EXISTS website_jobs_due ON website_jobs(state,next_attempt,updated_at,id)")

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=FULL")
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c.close()

    def enqueue(self, record, run_id, target, *, fill_missing=False, backfill_id=None):
        require_matching_target({"database_target": target})
        if not record.get("website"):
            return
        # A new Maps observation can refresh a completed website; replay of
        # the same observation cannot duplicate or reset a job.
        payload = {"record": record, "run_id": run_id, "database_target": target,
                   "fill_missing": bool(fill_missing), "backfill_id": backfill_id}
        identity = [target, record["dedup_key"], record["website"], record.get("raw", {}).get("scraped_at")]
        if fill_missing or backfill_id:
            identity.extend([bool(fill_missing), backfill_id])
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        with self.connect() as c:
            c.execute("INSERT OR IGNORE INTO website_jobs(id,payload,updated_at) VALUES(?,?,?)",
                      (key, json.dumps(payload), time.time()))

    def next_job(self):
        with self.connect() as c:
            row = c.execute("""SELECT * FROM website_jobs WHERE state IN ('pending','retry','fetched') AND next_attempt<=?
                AND (? OR json_extract(payload,'$.backfill_id') IS NULL)
                AND NOT EXISTS (SELECT 1 FROM website_backfill_runs b
                    WHERE b.run_id=json_extract(website_jobs.payload,'$.backfill_id') AND b.state LIKE 'paused%')
                ORDER BY updated_at,id LIMIT 1""", (time.time(), settings.WEBSITE_FILL_MISSING_FIELDS)).fetchone()
        if row is None:
            return None
        job = dict(row)
        job["payload"] = json.loads(job["payload"])
        job["result"] = json.loads(job["result"]) if job["result"] else None
        require_matching_target(job["payload"])
        return job

    def save_result(self, job, result):
        require_matching_target(job["payload"])
        attempts = job["attempts"] + 1
        retry = result["status"] == "retry" and attempts < max(1, settings.WEBSITE_MAX_ATTEMPTS)
        if result["status"] == "retry" and not retry:
            result = {**result, "status": "failed"}
        with self.connect() as c:
            c.execute("UPDATE website_jobs SET result=?,state=?,attempts=?,next_attempt=?,updated_at=? WHERE id=?",
                      (json.dumps(result), "retry" if retry else "fetched", attempts,
                       time.time() + min(86400, 300 * 2 ** min(attempts - 1, 8)) if retry else 0,
                       time.time(), job["id"]))
        return not retry

    def finish(self, job_id, state="applied", filled_fields=None):
        if state not in ("applied", "skipped"):
            raise ValueError("Invalid terminal website state")
        with self.connect() as c:
            c.execute("UPDATE website_jobs SET state=?,updated_at=?,filled_count=?,result=json_set(COALESCE(result,'{}'),'$.applied_fields',json(?)) WHERE id=?",
                      (state, time.time(), len(filled_fields or []), json.dumps(filled_fields or []), job_id))

    def counts(self):
        with self.connect() as c:
            return dict(c.execute("SELECT state,count(*) FROM website_jobs GROUP BY state").fetchall())

    def backfill_status(self):
        with self.connect() as c:
            row = c.execute("SELECT * FROM website_backfill_runs WHERE target=?", (database_target()["fingerprint"],)).fetchone()
            if not row:
                return {"state": "not_started", "jobs": {}}
            status = dict(row)
            status["jobs"] = dict(c.execute("SELECT state,count(*) FROM website_jobs WHERE json_extract(payload,'$.backfill_id')=? GROUP BY state", (status["run_id"],)).fetchall())
            status["filled_fields"] = c.execute("SELECT COALESCE(sum(filled_count),0) FROM website_jobs WHERE json_extract(payload,'$.backfill_id')=?", (status["run_id"],)).fetchone()[0]
        if status["state"] == "draining" and not any(status["jobs"].get(s) for s in ("pending", "retry", "fetched")):
            status["state"] = "completed"
        return status

    def start_backfill(self, ceiling):
        # Idempotent start/resume; retain the original snapshot and cursor.
        with self.connect() as c:
            c.execute("BEGIN IMMEDIATE")
            status = self.backfill_status()
            if status["state"] in ("running", "draining"):
                return status
            if status["state"] in ("paused", "paused_draining"):
                c.execute("UPDATE website_backfill_runs SET state=?,updated_at=? WHERE target=?",
                          ("draining" if status["state"] == "paused_draining" else "running", time.time(), database_target()["fingerprint"]))
            else:
                c.execute("INSERT OR REPLACE INTO website_backfill_runs(target,run_id,state,ceiling,updated_at) VALUES(?,?,'running',?,?)",
                          (database_target()["fingerprint"], "website-backfill-" + uuid.uuid4().hex, int(ceiling), time.time()))
        return self.backfill_status()

    def pause_backfill(self):
        with self.connect() as c:
            c.execute("UPDATE website_backfill_runs SET state=CASE state WHEN 'running' THEN 'paused' WHEN 'draining' THEN 'paused_draining' ELSE state END,updated_at=? WHERE target=?",
                      (time.time(), database_target()["fingerprint"]))
        return self.backfill_status()

    def checkpoint_backfill(self, run_id, cursor, scanned, missing_website, exhausted=False):
        with self.connect() as c:
            c.execute("UPDATE website_backfill_runs SET cursor=?,scanned=scanned+?,missing_website=missing_website+?,state=CASE WHEN ? AND state='running' THEN 'draining' WHEN ? AND state='paused' THEN 'paused_draining' ELSE state END,updated_at=? WHERE target=? AND run_id=?",
                      (cursor, scanned, missing_website, exhausted, exhausted, time.time(), database_target()["fingerprint"], run_id))
