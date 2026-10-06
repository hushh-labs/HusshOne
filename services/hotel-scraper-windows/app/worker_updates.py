"""Immutable local worker releases; never overwrite a running executable.

Stage only developer-reviewed local code via the CLI, then apply from the
dashboard. Hashes detect incomplete/tampered staging, NOT publisher authenticity.
No remote download, arbitrary-code upload API, dependency or desktop update.
"""
import argparse
import asyncio
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import uuid

from fastapi import APIRouter, HTTPException, Request
from app.config import runtime_state_dir

router = APIRouter(prefix="/api/worker-updates", tags=["Live worker updates"])
_task = None
_state = {"state": "idle"}


def release_dir():
    root = Path(runtime_state_dir()) / "worker_releases"
    root.mkdir(parents=True, exist_ok=True)
    return root


@contextmanager
def state_db():
    db = sqlite3.connect(release_dir() / "releases.sqlite3", timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("CREATE TABLE IF NOT EXISTS pointers(kind TEXT PRIMARY KEY, release TEXT NOT NULL)")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def pointer(kind):
    with state_db() as db:
        row = db.execute("SELECT release FROM pointers WHERE kind=?", (kind,)).fetchone()
        return row[0] if row else None


def verify_release(release):
    if len(release) != 32 or any(c not in "0123456789abcdef" for c in release):
        raise RuntimeError("Invalid worker release identifier")
    root = release_dir() / release
    manifest = json.loads((root / "release.json").read_text(encoding="utf-8"))
    if not manifest.get("files"):
        raise RuntimeError("Empty worker release blocked")
    for relative, digest in manifest["files"].items():
        path = root / relative
        if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink():
            raise RuntimeError("Unsafe worker release path")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError("Worker release checksum mismatch; old version retained")
    return root


def active_root(fallback):
    release = pointer("active")
    return verify_release(release) if release else fallback


def stage(folder):
    from app.vm_runtime import bundled_source_root, node_path
    source = Path(folder).resolve()
    base = bundled_source_root()
    for required in ("local-worker.mjs", "query-guard.mjs", "hotel-local-bridge.mjs", "manifest.json",
                     "healthcare-directory/worker.mjs", "ria-directory/worker.mjs", "insurance-directory/worker.mjs"):
        if not (source / required).is_file():
            raise RuntimeError("Incomplete four-directory release")
    # Updating Node dependencies/runtime requires a desktop release. Never npm
    # install untrusted release metadata or execute installation hooks here.
    if json.loads((source / "package-lock.json").read_text(encoding='utf-8')) != json.loads((base / "package-lock.json").read_text(encoding='utf-8')):
        raise RuntimeError("Dependency changes require a desktop release")
    release = uuid.uuid4().hex
    root = release_dir() / release
    root.mkdir()
    files = {}
    for path in source.rglob("*"):
        relative = path.relative_to(source)
        if "node_modules" in relative.parts or path.is_dir():
            continue
        if path.is_symlink() or not path.resolve().is_relative_to(source):
            raise RuntimeError("Symlinked worker sources are not permitted")
        if path.suffix not in (".mjs", ".sql", ".json") or path.name == "release.json":
            continue
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        files[relative.as_posix()] = hashlib.sha256(target.read_bytes()).hexdigest()
    shutil.copytree(base / "node_modules", root / "node_modules")
    for path in root.rglob('*'):
        if path.is_file():
            files[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    # Parse without running candidate code or making any network/DB call.
    for path in root.rglob('*.mjs'):
        if 'node_modules' not in path.relative_to(root).parts:
            result = subprocess.run([node_path(), '--check', str(path)], capture_output=True, timeout=15,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if result.returncode:
                raise RuntimeError('Candidate worker has a syntax error; release was not staged')
    (root / "release.json").write_text(json.dumps({"files": files}), encoding="utf-8")
    verify_release(release)
    with state_db() as db:
        db.execute("INSERT OR REPLACE INTO pointers VALUES('pending',?)", (release,))
    return release


def activate(release):
    verify_release(release)
    with state_db() as db:
        prior = db.execute("SELECT release FROM pointers WHERE kind='active'").fetchone()
        if prior:
            db.execute("INSERT OR REPLACE INTO pointers VALUES('previous',?)", prior)
        db.execute("INSERT OR REPLACE INTO pointers VALUES('active',?)", (release,))
        db.execute("DELETE FROM pointers WHERE kind='pending' AND release=?", (release,))


async def apply_pending():
    global _state
    from app.directory_fleet import fleet, preflight
    from app.worker import worker_instance
    fleet.updating = True
    try:
        release = await asyncio.to_thread(pointer, "pending")
        if not release:
            raise RuntimeError("No staged worker release")
        root = await asyncio.to_thread(verify_release, release)
        running = list(fleet.desired)
        _state = {"state": "checking", "release": release}
        for vertical in running:
            await asyncio.to_thread(preflight, vertical, root)
        _state = {"state": "draining", "release": release,
                  "message": "Waiting for registry cycles; hotel mapping switches on its next batch; dashboard remains available"}
        # No forcible termination for updates. A long bulk ingest can defer the
        # update; it keeps processing normally until its source ledger commits.
        for process in list(fleet.processes.values()):
            if process.poll() is None:
                process.stdin.write("drain\n")
                process.stdin.flush()
        deadline = time.monotonic() + 1800
        while any(p.poll() is None for p in list(fleet.processes.values())):
            if time.monotonic() > deadline:
                raise RuntimeError("Update deferred: a registry cycle is still active; no job was killed")
            await asyncio.sleep(0.5)
        # Hotel mapping is a new child per ZIP. Existing mapping invocations use
        # the immutable previous directory, next invocation uses the new one.
        await asyncio.to_thread(activate, release)
        _state = {"state": "applied", "release": release,
                  "message": "Registry workers resume automatically; hotel mapping updates on its next batch",
                  "hotel_running": worker_instance.is_running}
    except Exception as exc:
        _state = {"state": "deferred", "message": str(exc) if isinstance(exc, RuntimeError) else "Update failed; previous release retained"}
    finally:
        fleet.updating = False


@router.get("")
def update_status():
    return {**_state, "pending": pointer("pending"), "active": pointer("active"),
            "scope": "Imported Node worker code only; Python/EXE/runtime updates still require restart"}


@router.post("/apply")
async def request_apply(request: Request):
    global _task
    if request.client and request.client.host not in ("127.0.0.1", "::1", "testclient"):
        raise HTTPException(403, "Worker updates are local-only")
    origin = request.headers.get("origin")
    if origin and origin != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "Cross-origin updates are not permitted")
    if _task and not _task.done():
        return {"state": "already_pending"}
    if not await asyncio.to_thread(pointer, "pending"):
        raise HTTPException(409, "No reviewed worker release staged")
    _task = asyncio.create_task(apply_pending())
    return {"state": "scheduled"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stage reviewed local Node worker sources; no remote code downloads")
    parser.add_argument("command", choices=["stage"])
    parser.add_argument("folder")
    args = parser.parse_args()
    print("Staged worker release:", stage(args.folder))
