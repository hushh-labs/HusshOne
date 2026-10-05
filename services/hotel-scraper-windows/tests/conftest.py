"""Isolate all test state before collection imports any application module."""
import os
import tempfile

_root = tempfile.mkdtemp(prefix="husshone-isolated-tests-")
os.environ["LOCALAPPDATA"] = _root
os.environ["DB_BACKEND"] = "sqlite"
os.environ["DATABASE_URL"] = "sqlite:///" + _root.replace("\\", "/") + "/tests.db"
os.environ["AUTO_START_PROXY"] = "false"
os.environ["HUSSHONE_TEST_MODE"] = "1"
