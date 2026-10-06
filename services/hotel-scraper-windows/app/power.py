"""Small Windows execution-state guard for an active background worker."""
from __future__ import annotations

import ctypes
import logging
import os
import threading


logger = logging.getLogger("hotel_scraper.power")

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001


class WorkerWakeLock:
    """Prevent automatic system sleep only while the scraper is active."""

    def __init__(self):
        self._held = False
        self._lock = threading.RLock()

    def acquire(self) -> bool:
        with self._lock:
            if self._held:
                return True
            if os.name != "nt":
                self._held = True
                return True
            try:
                result = ctypes.windll.kernel32.SetThreadExecutionState(  # type: ignore[attr-defined]
                    ES_CONTINUOUS | ES_SYSTEM_REQUIRED
                )
                if not result:
                    logger.warning("Windows refused the active worker sleep-prevention request")
                    return False
                self._held = True
                return True
            except Exception as exc:
                logger.warning("Could not request Windows sleep prevention: %s", exc)
                return False

    def release(self) -> None:
        with self._lock:
            if not self._held:
                return
            if os.name == "nt":
                try:
                    ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)  # type: ignore[attr-defined]
                except Exception:
                    pass
            self._held = False


worker_wake_lock = WorkerWakeLock()
