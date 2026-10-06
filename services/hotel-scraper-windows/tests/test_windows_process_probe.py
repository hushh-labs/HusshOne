import ctypes
import os
from types import SimpleNamespace
import pytest
from app import cloud_proxy as proxy


class Function:
    def __init__(self, fn):
        self.fn = fn
    def __call__(self, *args):
        return self.fn(*args)


@pytest.mark.skipif(os.name != "nt", reason="Windows API")
@pytest.mark.parametrize("error,expected", [(87, False), (5, None), (123, None)])
def test_failed_open_preserves_uncertainty(error, expected, monkeypatch):
    kernel = SimpleNamespace(OpenProcess=Function(lambda *args: 0),
        GetExitCodeProcess=Function(lambda *args: pytest.fail("No handle")),
        CloseHandle=Function(lambda *args: pytest.fail("No handle")))
    monkeypatch.setattr(ctypes, "WinDLL", lambda *a, **kw: kernel)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: error)
    monkeypatch.setattr(proxy.os, "kill", lambda *a: pytest.fail("Must never call os.kill on Windows"))
    assert proxy._process_exists(123) is expected


@pytest.mark.skipif(os.name != "nt", reason="Windows API")
@pytest.mark.parametrize("exit_code,expected", [(259, True), (0, False)])
def test_query_only_handle_is_closed(exit_code, expected, monkeypatch):
    calls = []
    def opened(access, inherit, pid):
        assert access == 0x1000 and inherit is False and pid == 123
        return 456
    def queried(handle, code):
        code._obj.value = exit_code
        return True
    kernel = SimpleNamespace(OpenProcess=Function(opened), GetExitCodeProcess=Function(queried),
        CloseHandle=Function(lambda handle: calls.append(handle)))
    monkeypatch.setattr(ctypes, "WinDLL", lambda *a, **kw: kernel)
    assert proxy._process_exists(123) is expected
    assert calls == [456]


@pytest.mark.skipif(os.name != "nt", reason="Windows API")
def test_real_current_process_remains_alive():
    assert proxy._process_exists(os.getpid()) is True
    assert proxy._process_exists(0xFFFFFFFF) is False
    assert proxy._process_exists(os.getpid()) is True


@pytest.mark.parametrize("pid", [0, -1, True, "123", 2**40])
def test_invalid_pids_never_reach_os(pid, monkeypatch):
    monkeypatch.setattr(proxy.os, "kill", lambda *a: pytest.fail("Invalid PID"))
    assert proxy._process_exists(pid) is False
