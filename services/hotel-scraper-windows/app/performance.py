"""Live resource profiles; changing modes never cancels a database transaction."""
import asyncio
import os
from pathlib import Path
import sqlite3
from fastapi import APIRouter, HTTPException, Request
from app.config import settings, runtime_state_dir
from app.resource_budget import available_memory_bytes

MODES = ('training', 'balanced', 'throughput')
router = APIRouter(prefix='/api/performance', tags=['Resource profiles'])


def restore_mode():
    path = Path(runtime_state_dir()) / 'performance.sqlite3'
    if not path.exists():
        return
    with sqlite3.connect(path) as db:
        row = db.execute('SELECT mode FROM profile WHERE id=1').fetchone()
    if row and row[0] in MODES:
        settings.SCRAPER_PERFORMANCE_MODE = row[0]


def set_mode(mode):
    if mode not in MODES:
        raise ValueError('Unknown performance mode')
    with sqlite3.connect(Path(runtime_state_dir()) / 'performance.sqlite3') as db:
        db.execute('PRAGMA synchronous=FULL')
        db.execute('CREATE TABLE IF NOT EXISTS profile(id INTEGER PRIMARY KEY, mode TEXT NOT NULL)')
        db.execute('INSERT OR REPLACE INTO profile VALUES(1,?)', (mode,))
    settings.SCRAPER_PERFORMANCE_MODE = mode


def collector_limit(active=0):
    mode = settings.SCRAPER_PERFORMANCE_MODE
    cap = 1 if mode == 'training' else max(1, min(2, settings.WEBSITE_FETCH_CONCURRENCY)) if mode == 'balanced' else min(32, max(1, settings.WEBSITE_FULL_CONCURRENCY), max(2, os.cpu_count() or 2))
    free = available_memory_bytes()
    if free is None:
        return min(cap, 1)
    reserve = max(4, settings.WEBSITE_MIN_FREE_RAM_GB) * 1024**3
    # Budget ~1 GiB per additional renderer; existing jobs may finish rather
    # than being killed when the profile is reduced or free memory drops.
    headroom = max(0, int((free - reserve) / 1024**3))
    return min(cap, active + headroom)


def status():
    free = available_memory_bytes()
    return {'mode': settings.SCRAPER_PERFORMANCE_MODE, 'collector_limit_now': collector_limit(),
            'logical_cpus': os.cpu_count(), 'free_ram_gib': round(free / 1024**3, 1) if free else None,
            'writes': 'guarded, serial application', 'maps': 'one rate-limited browser; never starved by website backlog'}


@router.get('')
def get_profile():
    return status()


@router.post('/{mode}')
async def change_profile(mode: str, request: Request):
    from app.directory_fleet import require_local_control
    require_local_control(request)
    if mode not in MODES:
        raise HTTPException(422, 'Choose training, balanced or throughput')
    await asyncio.to_thread(set_mode, mode)
    from app.directory_fleet import fleet
    for process in list(fleet.processes.values()):
        if process.poll() is None:
            try:
                process.stdin.write('profile:' + mode + '\n')
                process.stdin.flush()
            except (OSError, ValueError):
                pass  # Supervisor restart inherits the persisted mode.
    return {**status(), 'message': 'New work uses this profile immediately; in-flight jobs finish safely'}
