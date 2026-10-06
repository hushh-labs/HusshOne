"""Keeps the Cloud SQL Auth Proxy alive for 24/7 operation.

In managed Cloud SQL mode, an unknown listener on the DB port is refused rather
than trusted: it may be an interactive proxy using a personal Google identity.
Otherwise the proxy is launched hidden with the scraper's isolated gcloud
configuration and restarted if it ever dies. The watchdog is a single sleeping
thread: one cheap socket probe every 15 seconds.
"""
import atexit
import json
import logging
import os
import shutil
import socket
import subprocess
import threading
import time
from typing import Any, Mapping, Optional
from app.config import gcloud_config_dir, google_auth_environment, settings, user_data_dir

logger = logging.getLogger("hotel_scraper.proxy")

_proc: Optional[subprocess.Popen] = None
_stop = threading.Event()
_thread: Optional[threading.Thread] = None
_ensure_lock = threading.RLock()
_OWNER_MARKER_FILENAME = "cloud_sql_proxy_owner.json"


def _drain_proxy_output(proc: subprocess.Popen) -> None:
    """Route proxy diagnostics through the application's rotating log handler."""
    stream = proc.stdout
    if stream is None:
        return
    try:
        for line in iter(stream.readline, ""):
            if line:
                logger.info("cloud-sql-proxy: %s", line.rstrip())
    except Exception:
        # The process is routinely terminated during shutdown; no extra noise.
        pass


def requires_owned_proxy() -> bool:
    """Whether Cloud SQL connections must use this process's proxy.

    The secure default applies even when automatic proxy startup is disabled.
    Otherwise toggling ``AUTO_START_PROXY`` (or leaving a manual proxy on the
    port) would quietly reintroduce the operator's personal Google identity.
    An unmanaged connection is possible only through the explicit setting
    intended for a reviewed exceptional deployment.
    """
    return (
        settings.DB_BACKEND != "sqlite"
        and not settings.ALLOW_UNMANAGED_CLOUD_SQL_CONNECTION
    )


def _wanted() -> bool:
    return (
        requires_owned_proxy()
        and settings.AUTO_START_PROXY
        and not settings.DATABASE_URL
        and settings.DB_HOST in ("127.0.0.1", "localhost")
    )


def _port_open() -> bool:
    try:
        with socket.create_connection((settings.DB_HOST, settings.DB_PORT), timeout=0.5):
            return True
    except OSError:
        return False


def _find_binary() -> Optional[str]:
    candidates = [
        settings.CLOUD_SQL_PROXY_PATH,
        shutil.which("cloud-sql-proxy"),
        os.path.expanduser("~/.local/bin/cloud-sql-proxy.exe"),
        os.path.expanduser("~/.local/bin/cloud-sql-proxy"),
    ]
    return next((c for c in candidates if c and os.path.exists(c)), None)


def _connection_name() -> str:
    return f"{settings.GCP_PROJECT}:{settings.GCP_REGION}:{settings.CLOUD_SQL_INSTANCE}"


def _owner_marker_path() -> str:
    return os.path.join(user_data_dir(), _OWNER_MARKER_FILENAME)


def _read_owner_marker() -> Optional[dict[str, Any]]:
    try:
        with open(_owner_marker_path(), "r", encoding="utf-8") as handle:
            marker = json.load(handle)
        return marker if isinstance(marker, dict) else None
    except (OSError, ValueError, TypeError):
        return None


def _clear_owner_marker() -> None:
    try:
        os.remove(_owner_marker_path())
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("Could not remove stale Cloud SQL proxy ownership marker: %s", exc)


def _windows_process_details(pid: int) -> Optional[dict[str, str]]:
    """Read only the details needed to safely identify a recorded child.

    There is no portable stdlib API for Windows process command lines. The
    command is entirely generated from a validated integer PID and uses
    ``-NoProfile`` so the caller's PowerShell profile cannot affect it.
    Failure is intentionally indistinguishable from an unknown process: the
    caller will leave the port blocked rather than terminate anything.
    """
    if os.name != "nt" or not isinstance(pid, int) or pid <= 0:
        return None
    command = (
        "$p = Get-CimInstance -ClassName Win32_Process "
        f"-Filter 'ProcessId = {pid}'; "
        "if ($null -ne $p) { "
        "[pscustomobject]@{"
        "ProcessId=[int]$p.ProcessId; "
        "CreationDate=[string]$p.CreationDate; "
        "ExecutablePath=[string]$p.ExecutablePath; "
        "CommandLine=[string]$p.CommandLine"
        "} | ConvertTo-Json -Compress }"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        raw = json.loads(result.stdout)
        if not isinstance(raw, Mapping) or int(raw.get("ProcessId") or 0) != pid:
            return None
        return {
            "creation_date": str(raw.get("CreationDate") or ""),
            "executable_path": str(raw.get("ExecutablePath") or ""),
            "command_line": str(raw.get("CommandLine") or ""),
        }
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return None


def _process_exists(pid: int) -> Optional[bool]:
    """Return whether a PID exists, preserving uncertainty as ``None``."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or pid > 0xFFFFFFFF:
        return False
    if os.name == "nt":
        return _windows_process_exists(pid)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None


def _windows_process_exists(pid: int) -> Optional[bool]:
    """Query only; os.kill(pid, 0) is not a safe Windows liveness probe."""
    import ctypes
    from ctypes import wintypes
    try:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION only
        if not handle:
            # ERROR_INVALID_PARAMETER means no such process; access denied or
            # other failures are uncertain, never authority to kill a proxy.
            return False if ctypes.get_last_error() == 87 else None
        try:
            code = wintypes.DWORD()
            if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
                return None
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel.CloseHandle(handle)
    except (OSError, SystemError):
        return None


def _write_owner_marker(proc: subprocess.Popen, binary: str, connection_name: str) -> None:
    """Persist enough evidence to reclaim only a verified orphan on restart."""
    pid = getattr(proc, "pid", None)
    if not isinstance(pid, int) or pid <= 0:
        return
    details = _windows_process_details(pid)
    parent_pid = os.getpid()
    parent_details = _windows_process_details(parent_pid)
    if (
        not details
        or not details["creation_date"]
        or not parent_details
        or not parent_details["creation_date"]
    ):
        # Without the immutable process start time, PID reuse makes automated
        # cleanup unsafe. The app will instead fail closed and ask for review.
        logger.warning("Could not record Cloud SQL proxy ownership; stale proxy recovery will fail closed")
        return
    marker = {
        "version": 1,
        "pid": pid,
        "creation_date": details["creation_date"],
        "parent_pid": parent_pid,
        "parent_creation_date": parent_details["creation_date"],
        "executable": os.path.normcase(os.path.abspath(binary)),
        "connection_name": connection_name,
        "host": settings.DB_HOST,
        "port": int(settings.DB_PORT),
    }
    path = _owner_marker_path()
    temporary_path = f"{path}.{pid}.tmp"
    try:
        with open(temporary_path, "w", encoding="utf-8") as handle:
            json.dump(marker, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except OSError as exc:
        logger.warning("Could not record Cloud SQL proxy ownership: %s", exc)
        try:
            os.remove(temporary_path)
        except OSError:
            pass


def _marker_matches_recorded_proxy(marker: Mapping[str, Any], details: Mapping[str, str]) -> bool:
    """Require PID, start time, executable, target, and launch args to match."""
    try:
        marker_port = int(marker.get("port"))
    except (TypeError, ValueError):
        return False
    executable = str(marker.get("executable") or "")
    actual_executable = str(details.get("executable_path") or "")
    command_line = str(details.get("command_line") or "").lower()
    expected = (
        str(marker.get("connection_name") or "") == _connection_name()
        and str(marker.get("host") or "") == settings.DB_HOST
        and marker_port == int(settings.DB_PORT)
        and executable
        and actual_executable
        and os.path.normcase(os.path.abspath(actual_executable)) == executable
        and str(marker.get("creation_date") or "") == str(details.get("creation_date") or "")
    )
    if not expected:
        return False
    required_tokens = (
        str(marker["connection_name"]).lower(),
        "--gcloud-auth",
        "--address",
        str(marker["host"]).lower(),
        "--port",
        str(marker_port),
    )
    return all(token in command_line for token in required_tokens)


def _recover_recorded_orphan() -> bool:
    """Terminate only a strongly validated prior app proxy.

    An unknown listener is never killed. If the marker, PID start time,
    executable, connection target, or arguments disagree, recovery stops and
    the normal fail-closed port guard remains in effect.
    """
    marker = _read_owner_marker()
    if marker is None:
        return False
    try:
        pid = int(marker.get("pid"))
        parent_pid = int(marker.get("parent_pid"))
    except (TypeError, ValueError):
        _clear_owner_marker()
        return False
    parent_details = _windows_process_details(parent_pid)
    if parent_details:
        parent_creation = str(parent_details.get("creation_date") or "")
        if not parent_creation:
            logger.warning(
                "Could not read recorded Cloud SQL proxy parent PID %s start time; leaving listener untrusted",
                parent_pid,
            )
            return False
        if str(marker.get("parent_creation_date") or "") == parent_creation:
            # Another instance is still alive and owns this child. It may
            # share the same local port, but this process must never kill its
            # proxy.
            logger.info("Cloud SQL proxy PID %s is still owned by live app PID %s", pid, parent_pid)
            return False
    if parent_details is None and _process_exists(parent_pid) is not False:
        logger.warning(
            "Could not prove recorded Cloud SQL proxy parent PID %s is gone; leaving listener untrusted",
            parent_pid,
        )
        return False
    details = _windows_process_details(pid)
    if details is None:
        logger.warning("Could not validate recorded Cloud SQL proxy PID %s; leaving listener untrusted", pid)
        return False
    if not _marker_matches_recorded_proxy(marker, details):
        logger.error("Recorded Cloud SQL proxy PID %s does not match its ownership marker; not terminating it", pid)
        _clear_owner_marker()
        return False
    try:
        result = subprocess.run(
            ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.error("Could not stop verified stale Cloud SQL proxy PID %s: %s", pid, exc)
        return False
    if result.returncode != 0:
        logger.error("Could not stop verified stale Cloud SQL proxy PID %s: %s", pid, result.stderr.strip()[:200])
        return False
    deadline = time.monotonic() + 5
    while _port_open() and time.monotonic() < deadline:
        time.sleep(0.2)
    if _port_open():
        logger.error("Verified stale Cloud SQL proxy PID %s did not release port %s", pid, settings.DB_PORT)
        return False
    _clear_owner_marker()
    logger.warning("Recovered from an abrupt shutdown by replacing stale app-owned Cloud SQL proxy PID %s", pid)
    return True


def ensure_proxy() -> bool:
    global _proc
    # ``ensure_proxy`` is called by the watchdog and by every attempted
    # database connection.  Serialising the inspect/start sequence prevents
    # two callers from launching competing proxies for the same local port.
    with _ensure_lock:
        if _proc is not None and _proc.poll() is not None:
            _clear_owner_marker()
            _proc = None

        port_open = _port_open()
        if port_open:
            # A proxy started by a prior interactive gcloud session may be
            # using a personal account.  In managed mode we only trust the
            # process launched with this app's private CLOUDSDK_CONFIG and
            # --gcloud-auth. Refusing an unknown listener is safer than
            # silently routing production writes through it after a restart.
            if _proc is not None and _proc.poll() is None:
                return True
            if requires_owned_proxy():
                # A normal crash can leave our child process alive. Only a
                # marker verified against the exact prior process grants us
                # authority to stop it; an arbitrary port listener is never
                # terminated automatically.
                if _recover_recorded_orphan():
                    port_open = _port_open()
                if not port_open:
                    # The old app proxy was safely reclaimed. Continue below
                    # and launch a fresh child with the current private login.
                    pass
                else:
                    logger.error(
                        "Cloud SQL port %s is occupied by an unowned proxy; refusing "
                        "to use credentials outside the scraper's isolated gcloud config (%s)",
                        settings.DB_PORT,
                        gcloud_config_dir(),
                    )
                    return False
            else:
                return True

        if not _wanted():
            if requires_owned_proxy():
                logger.error(
                    "No app-owned Cloud SQL proxy is available. Enable AUTO_START_PROXY "
                    "with a local DB host, or explicitly review an unmanaged connection."
                )
            return False

        binary = _find_binary()
        if not binary:
            logger.error("cloud-sql-proxy not found; set CLOUD_SQL_PROXY_PATH")
            return False
        if _proc is not None and _proc.poll() is None:
            return False  # starting up
        conn_name = _connection_name()
        logger.info("Starting Cloud SQL Auth Proxy for %s using the isolated gcloud profile", conn_name)
        _proc = subprocess.Popen(
            [
                binary,
                conn_name,
                "--address", settings.DB_HOST,
                "--port", str(settings.DB_PORT),
                "--gcloud-auth",
            ],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            text=True, bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            env=google_auth_environment(),
        )
        _write_owner_marker(_proc, binary, conn_name)
        threading.Thread(
            target=_drain_proxy_output,
            args=(_proc,),
            name="cloud-sql-proxy-output",
            daemon=True,
        ).start()
        return False


def _loop():
    while not _stop.is_set():
        try:
            ensure_proxy()
        except Exception as e:
            logger.warning("proxy watchdog error: %s", e)
        _stop.wait(15)


def start_watchdog():
    global _thread
    if not _wanted() or (_thread and _thread.is_alive()):
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="proxy-watchdog", daemon=True)
    _thread.start()


def stop_proxy():
    global _proc
    _stop.set()
    with _ensure_lock:
        if _proc is None or _proc.poll() is not None:
            return
        _proc.terminate()
        try:
            _proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # Retain the marker: a later process may reclaim only this
            # verified child after its recorded parent has exited.
            logger.warning("Cloud SQL proxy did not exit cleanly; ownership marker retained for safe recovery")
            return
        _clear_owner_marker()
        _proc = None


atexit.register(stop_proxy)
