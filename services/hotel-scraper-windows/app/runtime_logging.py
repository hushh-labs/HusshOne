"""Persistent, process-safe application logging.

The application modules already log beneath the ``hotel_scraper`` logger
namespace.  Calling :func:`configure_logging` once from an entrypoint routes
that namespace to a UTF-8 rotating log file outside a packaged build.  The
function is intentionally safe to call more than once (for example when an
ASGI reload process starts) and does not configure the global/root logger.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional, Union

from app.config import user_data_dir


APP_LOGGER_NAME = "hotel_scraper"
DEFAULT_LOG_FILENAME = "husshone-hotel-scraper.log"
DEFAULT_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_BACKUP_COUNT = 10

_HANDLER_MARKER = "_husshone_runtime_log_handler"
_CONFIG_LOCK = threading.RLock()
_EXCEPTION_HOOKS_INSTALLED = False
_EXCEPTION_LOGGER: Optional[logging.Logger] = None
_ORIGINAL_SYS_EXCEPTHOOK = None
_ORIGINAL_THREADING_EXCEPTHOOK = None


PathLike = Union[str, os.PathLike[str]]


def _normalised_path(path: PathLike) -> str:
    """Return a comparison-safe absolute path on Windows and POSIX."""
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def get_log_path(
    log_dir: Optional[PathLike] = None,
    filename: str = DEFAULT_LOG_FILENAME,
) -> Path:
    """Return the persistent application log path, creating its directory.

    ``log_dir`` is optional primarily to make callers and tests able to choose
    a deliberate location.  In normal use logs live below the stable
    per-user runtime directory rather than a build or current-working folder.
    """
    if not filename or Path(filename).name != filename:
        raise ValueError("filename must be a non-empty file name, not a path")

    directory = Path(log_dir) if log_dir is not None else Path(user_data_dir()) / "logs"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / filename


def _managed_handlers(logger: logging.Logger) -> list[logging.Handler]:
    return [
        handler
        for handler in logger.handlers
        if getattr(handler, _HANDLER_MARKER, False)
    ]


def _close_and_remove(logger: logging.Logger, handler: logging.Handler) -> None:
    logger.removeHandler(handler)
    try:
        handler.close()
    except OSError:
        # A logging shutdown race should not stop the application from
        # configuring its remaining handler.
        pass


def configure_logging(
    *,
    level: Union[int, str] = logging.INFO,
    log_dir: Optional[PathLike] = None,
    filename: str = DEFAULT_LOG_FILENAME,
    max_bytes: int = DEFAULT_MAX_BYTES,
    backup_count: int = DEFAULT_BACKUP_COUNT,
) -> logging.Logger:
    """Configure persistent rotating logs for the application namespace.

    Repeated calls with the same target retain one handler.  A later call with
    a different target deliberately replaces only a handler created by this
    module; handlers installed by an embedding application are left alone.
    """
    if max_bytes <= 0:
        raise ValueError("max_bytes must be greater than zero")
    if backup_count < 0:
        raise ValueError("backup_count cannot be negative")

    log_path = get_log_path(log_dir=log_dir, filename=filename)
    target_path = _normalised_path(log_path)
    logger = logging.getLogger(APP_LOGGER_NAME)
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)-8s %(process)d %(threadName)s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )

    with _CONFIG_LOCK:
        matching: Optional[RotatingFileHandler] = None
        for handler in list(_managed_handlers(logger)):
            is_target = (
                isinstance(handler, RotatingFileHandler)
                and _normalised_path(handler.baseFilename) == target_path
            )
            if is_target and matching is None:
                matching = handler
                continue
            _close_and_remove(logger, handler)

        if matching is None:
            matching = RotatingFileHandler(
                log_path,
                maxBytes=max_bytes,
                backupCount=backup_count,
                encoding="utf-8",
                delay=True,
            )
            setattr(matching, _HANDLER_MARKER, True)
            logger.addHandler(matching)

        # Reapply the intended configuration in case a caller changed one of
        # the public handler attributes between idempotent setup calls.
        matching.setLevel(level)
        matching.setFormatter(formatter)
        matching.maxBytes = max_bytes
        matching.backupCount = backup_count
        setattr(matching, _HANDLER_MARKER, True)

        logger.setLevel(level)
        # Child loggers such as hotel_scraper.worker should reach this handler,
        # but not also be emitted by a root handler configured by Uvicorn.
        logger.propagate = False

    return logger


def install_exception_hooks(logger: Optional[logging.Logger] = None) -> None:
    """Log otherwise unhandled main-thread and worker-thread exceptions.

    This is opt-in so an embedding host can retain full control of exception
    presentation.  The original hooks still run after the exception is logged,
    and calling this helper again does not stack wrappers.
    """
    global _EXCEPTION_HOOKS_INSTALLED, _EXCEPTION_LOGGER
    global _ORIGINAL_SYS_EXCEPTHOOK, _ORIGINAL_THREADING_EXCEPTHOOK

    with _CONFIG_LOCK:
        _EXCEPTION_LOGGER = logger or logging.getLogger(APP_LOGGER_NAME)
        if _EXCEPTION_HOOKS_INSTALLED:
            return

        _ORIGINAL_SYS_EXCEPTHOOK = sys.excepthook

        def log_main_thread_exception(exc_type, exc_value, exc_traceback) -> None:
            if issubclass(exc_type, KeyboardInterrupt):
                _ORIGINAL_SYS_EXCEPTHOOK(exc_type, exc_value, exc_traceback)
                return
            (_EXCEPTION_LOGGER or logging.getLogger(APP_LOGGER_NAME)).critical(
                "Unhandled exception",
                exc_info=(exc_type, exc_value, exc_traceback),
            )
            _ORIGINAL_SYS_EXCEPTHOOK(exc_type, exc_value, exc_traceback)

        sys.excepthook = log_main_thread_exception

        if hasattr(threading, "excepthook"):
            _ORIGINAL_THREADING_EXCEPTHOOK = threading.excepthook

            def log_thread_exception(args) -> None:
                if issubclass(args.exc_type, (KeyboardInterrupt, SystemExit)):
                    _ORIGINAL_THREADING_EXCEPTHOOK(args)
                    return
                (_EXCEPTION_LOGGER or logging.getLogger(APP_LOGGER_NAME)).critical(
                    "Unhandled exception in thread %s",
                    args.thread.name if args.thread else "unknown",
                    exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
                )
                _ORIGINAL_THREADING_EXCEPTHOOK(args)

            threading.excepthook = log_thread_exception

        _EXCEPTION_HOOKS_INSTALLED = True
