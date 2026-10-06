import logging
import sys
import threading
from logging.handlers import RotatingFileHandler

import pytest

from app import runtime_logging


@pytest.fixture
def app_logger():
    """Keep global logger state from leaking into the rest of the test suite."""
    logger = logging.getLogger(runtime_logging.APP_LOGGER_NAME)
    old_handlers = list(logger.handlers)
    old_level = logger.level
    old_propagate = logger.propagate
    for handler in list(logger.handlers):
        logger.removeHandler(handler)

    try:
        yield logger
    finally:
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            handler.close()
        for handler in old_handlers:
            logger.addHandler(handler)
        logger.setLevel(old_level)
        logger.propagate = old_propagate


def _runtime_handlers(logger):
    return [
        handler
        for handler in logger.handlers
        if getattr(handler, runtime_logging._HANDLER_MARKER, False)
    ]


def test_configure_logging_writes_utf8_rotating_file(tmp_path, app_logger):
    logger = runtime_logging.configure_logging(
        log_dir=tmp_path / "runtime" / "logs",
        max_bytes=1024,
        backup_count=3,
    )

    handlers = _runtime_handlers(logger)
    assert len(handlers) == 1
    handler = handlers[0]
    assert isinstance(handler, RotatingFileHandler)
    assert handler.encoding.lower().replace("-", "") == "utf8"
    assert handler.maxBytes == 1024
    assert handler.backupCount == 3

    child_logger = logging.getLogger("hotel_scraper.worker")
    child_logger.warning("H\u00f4tel \u6771\u4eac is ready")
    handler.flush()

    log_path = tmp_path / "runtime" / "logs" / runtime_logging.DEFAULT_LOG_FILENAME
    assert "H\u00f4tel \u6771\u4eac is ready" in log_path.read_text(encoding="utf-8")


def test_configure_logging_is_idempotent_and_reconfigures_one_handler(tmp_path, app_logger):
    first = runtime_logging.configure_logging(log_dir=tmp_path, max_bytes=1024, backup_count=1)
    first_handler = _runtime_handlers(first)[0]
    second = runtime_logging.configure_logging(log_dir=tmp_path, max_bytes=2048, backup_count=2)

    handlers = _runtime_handlers(second)
    assert second is first
    assert handlers == [first_handler]
    assert first_handler.maxBytes == 2048
    assert first_handler.backupCount == 2

    logging.getLogger("hotel_scraper.worker").warning("write once")
    first_handler.flush()
    log_path = tmp_path / runtime_logging.DEFAULT_LOG_FILENAME
    assert log_path.read_text(encoding="utf-8").count("write once") == 1


def test_configure_logging_rotates(tmp_path, app_logger):
    logger = runtime_logging.configure_logging(log_dir=tmp_path, max_bytes=100, backup_count=2)
    handler = _runtime_handlers(logger)[0]
    for index in range(8):
        logger.warning("rotation message %s %s", index, "x" * 80)
    handler.flush()

    log_path = tmp_path / runtime_logging.DEFAULT_LOG_FILENAME
    assert log_path.exists()
    assert (tmp_path / f"{runtime_logging.DEFAULT_LOG_FILENAME}.1").exists()


def test_install_exception_hooks_logs_and_does_not_stack(tmp_path, app_logger, monkeypatch):
    logger = runtime_logging.configure_logging(log_dir=tmp_path)
    handler = _runtime_handlers(logger)[0]
    original_calls = []

    def original_sys_hook(exc_type, exc_value, exc_traceback):
        original_calls.append(exc_type)

    monkeypatch.setattr(sys, "excepthook", original_sys_hook)
    monkeypatch.setattr(runtime_logging, "_EXCEPTION_HOOKS_INSTALLED", False)
    monkeypatch.setattr(runtime_logging, "_EXCEPTION_LOGGER", None)
    monkeypatch.setattr(runtime_logging, "_ORIGINAL_SYS_EXCEPTHOOK", None)
    monkeypatch.setattr(runtime_logging, "_ORIGINAL_THREADING_EXCEPTHOOK", None)
    if hasattr(threading, "excepthook"):
        monkeypatch.setattr(threading, "excepthook", lambda args: None)

    runtime_logging.install_exception_hooks(logger)
    installed_hook = sys.excepthook
    runtime_logging.install_exception_hooks(logger)
    assert sys.excepthook is installed_hook

    try:
        raise ValueError("expected test failure")
    except ValueError:
        sys.excepthook(*sys.exc_info())
    handler.flush()

    assert original_calls == [ValueError]
    assert "Unhandled exception" in (tmp_path / runtime_logging.DEFAULT_LOG_FILENAME).read_text(encoding="utf-8")
    assert "ValueError: expected test failure" in (tmp_path / runtime_logging.DEFAULT_LOG_FILENAME).read_text(encoding="utf-8")
