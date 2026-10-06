"""Four local directory workers with isolated I/O and native registry identities.

Hotel work stays in the existing guarded browser/outbox worker. The other three
execute the imported repo workers in bounded-memory, below-normal processes.
No schema creation, licence impersonation or table merging is performed.
"""
import asyncio
from collections import deque
from contextlib import contextmanager
import json
import logging
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session
from sqlalchemy.engine import make_url

from app import database
from app.config import settings, runtime_state_dir
from app.vm_runtime import source_root, node_path

SERVICES = {"healthcare": "healthcare-directory", "ria": "ria-directory", "insurance": "insurance-directory"}
WRITE_TABLES = {"healthcare": ("providers", "zips", "ingest_runs"),
                "ria": ("firms", "advisers", "zips", "ingest_runs"),
                "insurance": ("producers", "zips", "state_progress")}
_engines, _engine_lock = {}, threading.RLock()
logger = logging.getLogger("hotel_scraper.directory_fleet")


def registry_engine(vertical):
    if vertical not in SERVICES or settings.DB_BACKEND != "cloud":
        raise database.DatabaseUnavailable("Registry directories require their existing Cloud SQL databases")
    # Reuse the app's owned proxy and dedicated identity; no independent proxy
    # or credentials from the desktop user's personal gcloud configuration.
    probe = database.get_readonly_db_session()
    probe.close()
    with _engine_lock:
        if vertical not in _engines:
            url = make_url(database._build_url()).set(database=vertical)
            engine = create_engine(url, pool_size=2, max_overflow=0, pool_pre_ping=True,
                connect_args={"connect_timeout": 8, "options": "-c statement_timeout=15000 -c lock_timeout=5000 -c search_path=public"})
            event.listen(engine, "connect", lambda *_: database._require_owned_cloud_sql_proxy())
            _engines[vertical] = engine
        return _engines[vertical]


def registry_session(vertical):
    db = Session(registry_engine(vertical))
    try:
        db.execute(text("SET TRANSACTION READ ONLY"))
        return db
    except Exception:
        db.close()
        raise


def expected_columns(vertical, root=None):
    schema = ((root or source_root()) / SERVICES[vertical] / "schema.sql").read_text(encoding="utf-8")
    expected = {}
    type_names = {"BIGSERIAL": "bigint", "BIGINT": "bigint", "INT": "integer", "TEXT": "text",
                  "DOUBLE PRECISION": "double precision", "TIMESTAMPTZ": "timestamp with time zone",
                  "DATE": "date", "BOOLEAN": "boolean", "JSONB": "jsonb", "geography": "USER-DEFINED"}
    for table, body in re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);", schema):
        if table not in WRITE_TABLES[vertical]:
            continue
        columns = {}
        for line in body.splitlines():
            match = re.match(r"\s*(\w+)\s+(DOUBLE PRECISION|TIMESTAMPTZ|BIGSERIAL|BIGINT|BOOLEAN|JSONB|geography|TEXT(?:\[\])?|CHAR\(\d+\)|NUMERIC\(\d+,\s*\d+\)|DATE|INT)(?=\s|,|\()", line)
            if match:
                name, kind = match.groups()
                columns[name] = "ARRAY" if kind == "TEXT[]" else "character" if kind.startswith("CHAR") else "numeric" if kind.startswith("NUMERIC") else type_names[kind]
        expected[table] = columns
    return expected


def unzip_directory():
    bundled = Path(getattr(sys, "_MEIPASS", "")) / "vm_runtime" / "unzip"
    if (bundled / "unzip.exe").is_file():
        return str(bundled)
    executable = shutil.which("unzip")
    if not executable and os.name == "nt":
        candidate = Path("C:/Program Files/Git/usr/bin/unzip.exe")
        executable = str(candidate) if candidate.is_file() else None
    if not executable:
        raise RuntimeError("The imported bulk pipelines require the bundled unzip utility")
    return str(Path(executable).parent)


def preflight(vertical, root=None):
    if vertical not in SERVICES:
        raise ValueError("Unknown registry directory")
    node_path()
    if not ((root or source_root()) / "node_modules" / "pg" / "package.json").is_file():
        raise RuntimeError("Imported VM dependencies are missing; run the fleet dependency installer")
    if vertical in ("healthcare", "ria"):
        unzip_directory()
        if shutil.disk_usage(runtime_state_dir()).free < max(1, settings.VM_MIN_FREE_DISK_GB) * 1024**3:
            raise RuntimeError("Bulk registry ingest requires more free disk space")
    expected = expected_columns(vertical, root)
    if set(expected) != set(WRITE_TABLES[vertical]):
        raise RuntimeError("Imported schema contract could not be read; writes blocked")
    engine = registry_engine(vertical)
    diagnostics = []
    with engine.connect() as connection:
        transaction = connection.begin()
        connection.execute(text("SET TRANSACTION READ ONLY"))
        inspector = inspect(connection)
        for table, expected_types in expected.items():
            if not inspector.has_table(table, schema="public"):
                diagnostics.append(f"Missing table: {vertical}.{table}")
                continue
            column_rows = list(connection.execute(text(
                "SELECT column_name,data_type,udt_name,is_generated,generation_expression,character_maximum_length,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=:table"), {"table": table}).mappings())
            actual = {row["column_name"]: row["data_type"] for row in column_rows}
            for column, kind in expected_types.items():
                if actual.get(column) != kind:
                    diagnostics.append(f"Schema mismatch: {vertical}.{table}.{column}")
            for row in column_rows:
                if row['column_name'] == 'geog':
                    expression = (row['generation_expression'] or '').lower()
                    if row['udt_name'] != 'geography' or row['is_generated'] != 'ALWAYS' or not all(s in expression for s in ('st_makepoint', 'lat', 'lng', '4326')):
                        diagnostics.append(f"Generated geography mismatch: {vertical}.{table}")
                if row['column_name'] not in expected_types and row['is_nullable'] == 'NO' and row['column_default'] is None and row['is_generated'] != 'ALWAYS':
                    diagnostics.append(f"Unexpected required column: {vertical}.{table}.{row['column_name']}")
            granted = connection.execute(text("SELECT has_table_privilege(current_user,:table,'SELECT')"), {"table": "public." + table}).scalar()
            if not granted:
                diagnostics.append(f"No SELECT permission: {vertical}.{table}")
            if table != "zips":
                granted = connection.execute(text("SELECT has_table_privilege(current_user,:table,'INSERT') AND has_table_privilege(current_user,:table,'UPDATE')"),
                                             {"table": "public." + table}).scalar()
                if not granted:
                    diagnostics.append(f"No INSERT/UPDATE permission: {vertical}.{table}")
                if 'id' in expected_types:
                    sequence_grant = connection.execute(text("SELECT has_sequence_privilege(current_user,pg_get_serial_sequence(:table,'id'),'USAGE')"), {"table": "public." + table}).scalar()
                    if not sequence_grant:
                        diagnostics.append(f"No identity sequence permission: {vertical}.{table}")
        keys = {"healthcare": {"providers": ["npi"]}, "ria": {"firms": ["crd"], "advisers": ["crd"]},
                "insurance": {"producers": ["source_state", "license_no"]}}[vertical]
        for table, key in keys.items():
            if inspector.has_table(table, schema="public"):
                unique = [set(inspector.get_pk_constraint(table, schema="public").get("constrained_columns") or [])]
                unique += [set(item["column_names"]) for item in inspector.get_unique_constraints(table, schema="public")]
                if set(key) not in unique:
                    diagnostics.append(f"Missing native identity constraint: {vertical}.{table}")
        transaction.rollback()
    if diagnostics:
        raise RuntimeError("; ".join(diagnostics[:8]))
    return {"ready": True, "vertical": vertical, "database": vertical, "tables": list(expected)}


def worker_environment(vertical):
    url = make_url(database._build_url()).set(database=vertical)
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(("PG", "NPPES_", "SEC_", "INSURANCE_", "SOCRATA_", "GMAIL_", "GOOGLE_", "CLOUDSDK_")) or key in ("DATABASE_URL", "PLACES_API_KEY", "NODE_OPTIONS"):
            env.pop(key, None)
    inputs = Path(runtime_state_dir()) / "directory_fleet" / vertical / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    env.update(PGHOST=str(url.host), PGPORT=str(url.port), PGDATABASE=vertical,
               PGUSER=str(url.username), PGPASSWORD=str(url.password), PGPOOL_MAX="2",
               NPPES_DOWNLOAD_DIR=str(inputs), SEC_DOWNLOAD_DIR=str(inputs), OUTPUT_DIR=str(inputs.parent),
               NPPES_BATCH_SIZE="250", SOCRATA_PAGE_SIZE="1000", INSURANCE_STATES="WA,CA,TX,FL,NY")
    if vertical in ("healthcare", "ria"):
        env["PATH"] = unzip_directory() + os.pathsep + env.get("PATH", "")
    return env


class DirectoryFleet:
    def __init__(self):
        self.tasks, self.processes, self.states = {}, {}, {}
        self.logs = {vertical: deque(maxlen=30) for vertical in SERVICES}
        self.desired = set()
        self.updating = False
        self.control_locks = {vertical: asyncio.Lock() for vertical in SERVICES}
        self._path = None

    @contextmanager
    def _state_db(self):
        path = Path(runtime_state_dir()) / "directory_fleet.sqlite3"
        connection = sqlite3.connect(path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("CREATE TABLE IF NOT EXISTS desired_workers(vertical TEXT PRIMARY KEY, enabled INTEGER NOT NULL)")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def persist(self, vertical, enabled):
        with self._state_db() as connection:
            connection.execute("INSERT OR REPLACE INTO desired_workers VALUES(?,?)", (vertical, int(enabled)))

    async def resume(self):
        if os.getenv("HUSSHONE_TEST_MODE") or settings.DB_BACKEND != "cloud":
            return
        def read():
            with self._state_db() as connection:
                return [row[0] for row in connection.execute("SELECT vertical FROM desired_workers WHERE enabled=1")]
        for vertical in await asyncio.to_thread(read):
            if vertical in SERVICES:
                self.desired.add(vertical)
                self.tasks[vertical] = asyncio.create_task(self.run(vertical))

    async def start(self, vertical):
        if vertical not in SERVICES:
            raise ValueError("Unknown registry directory")
        async with self.control_locks[vertical]:
            if vertical in self.tasks and not self.tasks[vertical].done():
                return
            await asyncio.to_thread(preflight, vertical)
            await asyncio.to_thread(self.persist, vertical, True)
            self.desired.add(vertical)
            self.tasks[vertical] = asyncio.create_task(self.run(vertical))

    async def stop(self, vertical, remember=True):
        async with self.control_locks[vertical]:
            self.desired.discard(vertical)
            if remember:
                await asyncio.to_thread(self.persist, vertical, False)
            process = self.processes.get(vertical)
            if process:
                await asyncio.to_thread(self.kill, process)
            task = self.tasks.get(vertical)
            if task:
                await asyncio.gather(task, return_exceptions=True)
            self.states[vertical] = {"state": "stopped"}

    @staticmethod
    def kill(process):
        if process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                           timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    def consume(self, vertical, process, password):
        for line in process.stdout:
            # Never expose raw database errors, URLs or source payloads in UI.
            try:
                item = json.loads(line)
                event_name = str(item.get("event", "worker.output"))[:100]
                entry = {"event": event_name, "at": time.time()}
                for key in ("rowsSeen", "rowsUpserted", "upserted", "state", "waitMs", "kind", "via"):
                    if isinstance(item.get(key), (str, int, float, bool)):
                        entry[key] = item[key]
                self.logs[vertical].append(entry)
                self.states[vertical] = {"state": "degraded" if "error" in event_name else "running", "last_event": entry}
                logger.info("Imported %s pipeline: %s", vertical, event_name)
            except (ValueError, TypeError):
                pass
        return process.wait()

    async def run(self, vertical):
        failures = 0
        while vertical in self.desired:
            while self.updating and vertical in self.desired:
                await asyncio.sleep(0.2)
            if vertical not in self.desired:
                break
            process = None
            try:
                self.states[vertical] = {"state": "checking"}
                await asyncio.to_thread(preflight, vertical)
                env = await asyncio.to_thread(worker_environment, vertical)
                if vertical not in self.desired or self.updating:
                    continue
                process = await asyncio.to_thread(subprocess.Popen,
                    [node_path(), "--max-old-space-size=256", str(source_root() / "local-worker.mjs"), vertical],
                    cwd=str(source_root()), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace",
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0))
                self.processes[vertical] = process
                if vertical not in self.desired:
                    await asyncio.to_thread(self.kill, process)
                    break
                code = await asyncio.to_thread(self.consume, vertical, process, env["PGPASSWORD"])
                if code:
                    raise RuntimeError("Imported worker exited; resumable retry scheduled")
                failures = 0
            except Exception as exc:
                failures += 1
                # Schema and platform errors are safe to expose; no credentials.
                reason = str(exc)[:400] if isinstance(exc, RuntimeError) else "Directory database or runtime unavailable"
                self.states[vertical] = {"state": "retrying", "reason": reason}
            finally:
                if process and process.poll() is None:
                    await asyncio.to_thread(self.kill, process)
                self.processes.pop(vertical, None)
            delay = min(300, 15 * 2**min(failures, 4))
            for _ in range(delay):
                if vertical not in self.desired:
                    break
                await asyncio.sleep(1)

    def status(self):
        from app.worker import worker_instance
        hotel = worker_instance.get_status()
        return {"hotel": {"state": "running" if hotel["is_running"] else "stopped", "database": settings.DB_NAME,
                          "source": "imported hotel VM pipeline + local Chrome", "places_api": False},
                **{v: {**self.states.get(v, {"state": "stopped"}), "database": v, "service": SERVICES[v],
                       "desired_running": v in self.desired, "events": list(self.logs[v])[-5:]} for v in SERVICES}}


fleet = DirectoryFleet()
router = APIRouter(prefix="/api/directory-fleet", tags=["Imported VM fleet"])


@router.get("")
async def fleet_status():
    return fleet.status()


@router.post("/{vertical}/start")
async def start_directory(vertical: str, request: Request):
    require_local_control(request)
    if vertical == "hotel":
        from app.worker import worker_instance
        await worker_instance.start()
        return {"status": "started", "vertical": vertical}
    if vertical not in SERVICES:
        raise HTTPException(404, "Unknown directory")
    try:
        await fleet.start(vertical)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)[:400]) from None
    except Exception:
        raise HTTPException(503, "Directory database preflight failed; no worker started") from None
    return {"status": "started", "vertical": vertical}


@router.post("/{vertical}/stop")
async def stop_directory(vertical: str, request: Request):
    require_local_control(request)
    if vertical == "hotel":
        from app.worker import worker_instance
        await worker_instance.stop()
    elif vertical in SERVICES:
        await fleet.stop(vertical)
    else:
        raise HTTPException(404, "Unknown directory")
    return {"status": "stopped", "vertical": vertical}


def require_local_control(request):
    if request.client and request.client.host not in ('127.0.0.1', '::1', 'testclient'):
        raise HTTPException(403, 'Directory worker controls are local-only')
    origin = request.headers.get('origin')
    if origin and origin != str(request.base_url).rstrip('/'):
        raise HTTPException(403, 'Cross-origin worker controls are not permitted')
