import os
import sys
import time
import shutil
import logging
import subprocess
import threading
from typing import Optional
from sqlalchemy import create_engine, text, event
from sqlalchemy.engine import URL, Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker, Session
from app.config import (
    gcloud_account,
    gcloud_config_dir,
    google_auth_environment,
    settings,
    user_data_dir,
)
from app.models import Base

logger = logging.getLogger("hotel_scraper.db")

engine: Optional[Engine] = None
SessionLocal = None
_init_lock = threading.Lock()
_last_init_attempt = 0.0

# Live connection health, surfaced to the dashboard.
db_state = {"backend": None, "connected": False, "error": None, "checked_at": None}
# Kept separate from connection health so a reachable but drifted production
# schema remains visible while writes are fail-closed.
schema_state = {"checked_at": None, "compatible": None, "diagnostics": []}
_schema_lock = threading.Lock()

# This application only ever adds/updates directory data and ZIP progress.  A
# database role is the real boundary in production, but keep a second, local
# boundary as well: a future code change cannot accidentally issue destructive
# SQL through this application's PostgreSQL engine.  The matcher deliberately
# ignores quoted text so a harmless value such as a hotel name is not blocked.
_PROHIBITED_PRODUCTION_SQL = frozenset({
    "alter", "create", "delete", "drop", "grant", "revoke", "truncate", "vacuum",
})


class DatabaseUnavailable(Exception):
    pass


class SchemaIncompatible(DatabaseUnavailable):
    """A reachable database whose write contract has drifted.

    Keeping this separate from a connection outage lets callers fail closed
    with an actionable response without incorrectly reporting it as a Maps or
    proxy failure.
    """


class ProductionMutationBlocked(RuntimeError):
    """This application attempted a destructive production SQL operation."""


def contains_prohibited_production_sql(statement: object) -> bool:
    """Return whether SQL contains a destructive keyword outside literals.

    This is a defense-in-depth application guard, not a replacement for the
    restricted Cloud SQL role documented for deployment.  It intentionally
    catches mutating CTEs too (``WITH ... DELETE ...``), not merely statements
    beginning with ``DELETE``.
    """
    if not isinstance(statement, str):
        return False
    token = []
    quote = None
    i = 0
    while i < len(statement):
        char = statement[i]
        if quote:
            if char == quote:
                # SQL escapes quote characters by doubling them.
                if i + 1 < len(statement) and statement[i + 1] == quote:
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if char in ("'", '"'):
            if token:
                if "".join(token).lower() in _PROHIBITED_PRODUCTION_SQL:
                    return True
                token.clear()
            quote = char
            i += 1
            continue
        # Underscores and dollar signs are valid unquoted identifier
        # characters in PostgreSQL. Treating ``hotels_delete`` as the keyword
        # ``DELETE`` made harmless report aliases fail closed even though no
        # destructive statement was present.
        if char.isalpha() or char.isdigit() or char in ("_", "$"):
            token.append(char)
        elif token:
            if "".join(token).lower() in _PROHIBITED_PRODUCTION_SQL:
                return True
            token.clear()
        i += 1
    return bool(token and "".join(token).lower() in _PROHIBITED_PRODUCTION_SQL)


def _install_production_write_firewall(target_engine: Engine) -> None:
    """Reject DDL/destructive statements before they reach Cloud SQL."""
    @event.listens_for(target_engine, "before_cursor_execute")
    def _block_destructive_sql(conn, cursor, statement, parameters, context, executemany):
        if contains_prohibited_production_sql(statement):
            raise ProductionMutationBlocked(
                "Destructive SQL is blocked by the HusshOne production write firewall"
            )


def _require_owned_cloud_sql_proxy() -> None:
    """Fail closed unless the current process owns the Cloud SQL proxy.

    A local PostgreSQL listener does not prove which Google identity created
    the tunnel.  This check is deliberately shared by connection health,
    dashboard sessions, schema reads, and the worker's direct engine use via
    the engine-level ``do_connect`` hook below.
    """
    from app import cloud_proxy

    if not cloud_proxy.requires_owned_proxy():
        return
    if cloud_proxy.ensure_proxy():
        return
    message = (
        "The app-owned Cloud SQL proxy is not ready; refusing to use an "
        "unverified local listener or non-dedicated Google credentials"
    )
    db_state.update(backend="postgresql", connected=False, error=message, checked_at=time.time())
    raise DatabaseUnavailable(message)


def _install_owned_proxy_connection_guard(target_engine: Engine) -> None:
    """Apply the proxy identity boundary to every PostgreSQL connection.

    Some safe read paths and the advisory-lock code use ``engine.connect``
    directly. ``do_connect`` runs before SQLAlchemy opens the DBAPI socket, so
    those paths cannot quietly bypass the session-level checks.
    """
    @event.listens_for(target_engine, "do_connect")
    def _block_unverified_proxy(dialect, conn_rec, cargs, cparams):
        _require_owned_cloud_sql_proxy()


def get_sqlite_db_path() -> str:
    """Local SQLite file (dev/tests). Frozen builds keep it in the user data dir, never in dist/."""
    if getattr(sys, "frozen", False):
        base_dir = user_data_dir()
    else:
        base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    os.makedirs(base_dir, exist_ok=True)
    return os.path.join(base_dir, "hotel_scraper_local.db").replace("\\", "/")


def _no_window_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _fetch_password_from_secret_manager() -> Optional[str]:
    """Read the DB secret through the scraper's isolated gcloud identity.

    The subprocess environment deliberately cannot inherit the Windows
    user's global Application Default Credentials.  A missing private login
    is an authentication failure, never a reason to try another account.
    """
    gcloud = shutil.which("gcloud")
    if not gcloud:
        return None
    command = [gcloud]
    account = gcloud_account()
    if account:
        command.append(f"--account={account}")
    command.extend([
        "secrets", "versions", "access", "latest",
        f"--secret={settings.DB_PASSWORD_SECRET}", f"--project={settings.GCP_PROJECT}",
    ])
    try:
        res = subprocess.run(
            command,
            capture_output=True, text=True, timeout=30, creationflags=_no_window_flags(),
            env=google_auth_environment(),
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
        logger.warning("Secret Manager lookup failed: %s", res.stderr.strip()[:200])
    except Exception as e:
        logger.warning("Secret Manager lookup error: %s", e)
    return None


def _build_url():
    if settings.DATABASE_URL:
        url_scheme = str(settings.DATABASE_URL).split(":", 1)[0].lower()
        if settings.DB_BACKEND == "sqlite" and not url_scheme.startswith("sqlite"):
            raise DatabaseUnavailable(
                "DB_BACKEND=sqlite cannot use a non-SQLite DATABASE_URL"
            )
        if (
            settings.DB_BACKEND == "cloud"
            and not settings.ALLOW_UNMANAGED_CLOUD_SQL_CONNECTION
        ):
            raise DatabaseUnavailable(
                "DATABASE_URL is disabled in managed Cloud SQL mode because it bypasses "
                "the app-owned proxy and dedicated Google identity"
            )
        if settings.DB_BACKEND == "cloud" and not url_scheme.startswith("postgresql"):
            raise DatabaseUnavailable(
                "DB_BACKEND=cloud requires a PostgreSQL DATABASE_URL when an unmanaged "
                "connection has been explicitly approved"
            )
        return settings.DATABASE_URL
    if settings.DB_BACKEND == "sqlite":
        return f"sqlite:///{get_sqlite_db_path()}"
    password = settings.DB_PASSWORD or _fetch_password_from_secret_manager()
    if not password:
        raise DatabaseUnavailable(
            "No database password available. Set DB_PASSWORD in "
            f"{os.path.join(user_data_dir(), '.env')} or sign in with `gcloud auth login` "
            f"using the scraper's isolated gcloud config ({gcloud_config_dir()})."
        )
    return URL.create(
        "postgresql+psycopg2", username=settings.DB_USER, password=password,
        host=settings.DB_HOST, port=settings.DB_PORT, database=settings.DB_NAME,
    )


def is_sqlite() -> bool:
    return engine is not None and engine.dialect.name == "sqlite"


def init_db() -> Optional[Engine]:
    """Creates the engine (lazy, no network round-trip). Never creates/alters PostgreSQL tables."""
    global engine, SessionLocal, _last_init_attempt
    if settings.DB_BACKEND == "cloud" and (os.getenv("HUSSHONE_TEST_MODE") or os.getenv("PYTEST_CURRENT_TEST")):
        raise DatabaseUnavailable("Cloud SQL connections are forbidden in tests")
    with _init_lock:
        if engine is not None:
            return engine
        _last_init_attempt = time.time()
        try:
            url = _build_url()
        except DatabaseUnavailable as e:
            db_state.update(backend=settings.DB_BACKEND, connected=False, error=str(e))
            logger.error(str(e))
            return None

        is_pg = str(url).startswith("postgresql")
        if is_pg:
            engine = create_engine(
                url, pool_size=3, max_overflow=2, pool_pre_ping=True, pool_recycle=1800,
                executemany_mode="values_plus_batch",
                connect_args={
                    "connect_timeout": 8, "keepalives": 1, "keepalives_idle": 60,
                    "keepalives_interval": 20, "keepalives_count": 3,
                    "application_name": "husshone-hotel-scraper",
                    "options": (
                        f"-c statement_timeout={settings.DB_STATEMENT_TIMEOUT_MS} "
                        f"-c lock_timeout={settings.DB_LOCK_TIMEOUT_MS}"
                    ),
                },
            )
            _install_production_write_firewall(engine)
            _install_owned_proxy_connection_guard(engine)
        else:
            engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

            @event.listens_for(engine, "connect")
            def _sqlite_pragmas(dbapi_connection, _):
                cur = dbapi_connection.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA busy_timeout=30000")
                cur.close()

            Base.metadata.create_all(bind=engine)

        SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)
        db_state.update(backend="postgresql" if is_pg else "sqlite", connected=False, error=None)
        return engine


def ensure_engine() -> Optional[Engine]:
    """Returns the engine, retrying initialisation (e.g. password lookup) at most every 30s."""
    if settings.DB_BACKEND == "cloud" and (os.getenv("HUSSHONE_TEST_MODE") or os.getenv("PYTEST_CURRENT_TEST")):
        raise DatabaseUnavailable("Cloud SQL connections are forbidden in tests")
    if engine is not None:
        return engine
    if time.time() - _last_init_attempt < 30:
        return None
    return init_db()


def check_connection() -> bool:
    """Round-trips `SELECT 1` and records the result in db_state."""
    eng = ensure_engine()
    if eng is None:
        return False
    try:
        _require_owned_cloud_sql_proxy()
        with eng.connect() as conn:
            conn.execute(text("SELECT 1"))
        db_state.update(connected=True, error=None, checked_at=time.time())
        return True
    except Exception as e:
        db_state.update(connected=False, error=str(e).splitlines()[0][:200], checked_at=time.time())
        return False


def check_schema_compatible(force: bool = False) -> bool:
    """Compare Cloud SQL's catalog with the approved read-only contract.

    SQLite is a development/test backend and deliberately bypasses this gate.
    Any inspection failure is treated as incompatible so production writes fail
    closed while dashboard reads remain available.
    """
    eng = ensure_engine()
    if eng is None:
        return False
    if eng.dialect.name == "sqlite":
        schema_state.update(checked_at=time.time(), compatible=True, diagnostics=[])
        return True
    if not settings.SCHEMA_GUARD_ENABLED:
        # A production writer must never gain a configuration escape hatch
        # around its contract. SQLite remains the explicit development bypass.
        schema_state.update(checked_at=time.time(), compatible=False, diagnostics=[{
            "code": "guard_disabled", "message": "Schema guard is disabled; production writes are blocked", "severity": "error",
        }])
        return False

    checked_at = schema_state.get("checked_at") or 0.0
    if not force and schema_state.get("compatible") is not None and time.time() - checked_at < settings.SCHEMA_GUARD_CACHE_SEC:
        return bool(schema_state["compatible"])

    with _schema_lock:
        checked_at = schema_state.get("checked_at") or 0.0
        if not force and schema_state.get("compatible") is not None and time.time() - checked_at < settings.SCHEMA_GUARD_CACHE_SEC:
            return bool(schema_state["compatible"])
        from app.schema_guard import compare_schema

        result = compare_schema(eng)
        schema_state.update(
            checked_at=time.time(),
            compatible=result.compatible,
            diagnostics=[diagnostic.as_dict() for diagnostic in result.diagnostics],
        )
        return result.compatible


def assert_write_safe() -> None:
    """Fail closed before *any* application mutation.

    Worker writes are not the only mutations this process can make: queue and
    retry controls also change ``zips``. They must obey the same live schema
    contract so drift can never be bypassed through the dashboard.
    """
    if ensure_engine() is None or not check_connection():
        raise DatabaseUnavailable(db_state.get("error") or "Database is unreachable")
    if check_schema_compatible():
        return
    diagnostics = schema_state.get("diagnostics") or []
    first = diagnostics[0] if diagnostics else None
    if isinstance(first, dict):
        reason = first.get("message") or first.get("code")
    else:
        reason = str(first) if first else None
    raise SchemaIncompatible(reason or "Production schema does not match the approved write contract")


def get_db():
    db = get_readonly_db_session()
    try:
        yield db
    finally:
        db.close()


def get_db_session() -> Session:
    if ensure_engine() is None:
        raise DatabaseUnavailable(db_state.get("error") or "Database not configured")
    _require_owned_cloud_sql_proxy()
    return SessionLocal()


def get_readonly_db_session() -> Session:
    """Open a dashboard/report session that Cloud SQL itself treats as read-only.

    The endpoints using this helper never need to mutate data.  Setting the
    transaction flag makes an accidental future write fail in PostgreSQL even
    before the application-level firewall has a chance to help.
    """
    db = get_db_session()
    if engine is not None and engine.dialect.name == "postgresql":
        try:
            db.execute(text("SET TRANSACTION READ ONLY"))
        except Exception:
            db.close()
            raise
    return db


def is_database_exception(exc: BaseException) -> bool:
    """Failures that must not be counted as Maps/scrape failures."""
    return isinstance(exc, (DatabaseUnavailable, SQLAlchemyError, OSError, ConnectionError, TimeoutError))
