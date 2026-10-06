from app.power import WorkerWakeLock


def test_non_windows_wake_lock_is_a_safe_noop(monkeypatch):
    # The implementation is deliberately testable without a Windows kernel.
    import app.power as power

    monkeypatch.setattr(power.os, "name", "posix")
    lock = WorkerWakeLock()
    assert lock.acquire()
    lock.release()
