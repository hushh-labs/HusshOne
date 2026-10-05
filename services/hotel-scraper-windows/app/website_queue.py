"""Target-bound durable website jobs. Fetched evidence survives DB outages."""
import hashlib
import json
import sqlite3
import time
from pathlib import Path
from contextlib import contextmanager

from app.config import database_target, runtime_state_dir, settings
from app.outbox import require_matching_target


class WebsiteQueue:
    def __init__(self, path=None):
        self.path = Path(path) if path else Path(runtime_state_dir()) / "website_jobs.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS website_jobs (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
                result TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL)""")

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

    def enqueue(self, record, run_id, target):
        require_matching_target({"database_target": target})
        if not record.get("website"):
            return
        # A new Maps observation can refresh a completed website; replay of
        # the same observation cannot duplicate or reset a job.
        payload = {"record": record, "run_id": run_id, "database_target": target}
        key = hashlib.sha256(json.dumps([target, record["dedup_key"], record["website"],
                                       record.get("raw", {}).get("scraped_at")], sort_keys=True).encode()).hexdigest()
        with self.connect() as c:
            c.execute("INSERT OR IGNORE INTO website_jobs(id,payload,updated_at) VALUES(?,?,?)",
                      (key, json.dumps(payload), time.time()))

    def next_job(self):
        with self.connect() as c:
            row = c.execute("SELECT * FROM website_jobs WHERE state IN ('pending','retry','fetched') AND next_attempt<=? ORDER BY updated_at,id LIMIT 1", (time.time(),)).fetchone()
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

    def finish(self, job_id, state="applied"):
        if state not in ("applied", "skipped"):
            raise ValueError("Invalid terminal website state")
        with self.connect() as c:
            c.execute("UPDATE website_jobs SET state=?,updated_at=? WHERE id=?", (state, time.time(), job_id))

    def counts(self):
        with self.connect() as c:
            return dict(c.execute("SELECT state,count(*) FROM website_jobs GROUP BY state").fetchall())
