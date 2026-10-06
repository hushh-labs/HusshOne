import os
import hashlib
import json
from typing import Literal, Mapping, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


def user_data_dir() -> str:
    """Stable per-user folder for runtime data. Never inside dist/ (wiped on rebuild)."""
    base = os.getenv("LOCALAPPDATA") or os.path.expanduser("~/.husshone_hotel_scraper")
    path = os.path.join(base, "HusshOne-Hotel-Scraper")
    os.makedirs(path, exist_ok=True)
    return path


def _clean_optional(value: Optional[str]) -> Optional[str]:
    """Return a usable optional setting without treating whitespace as a value."""
    if value is None:
        return None
    value = str(value).strip()
    return value or None


class Settings(BaseSettings):
    APP_NAME: str = "HusshOne Hotel Scraper Control & Directory"
    APP_ENV: str = "development"
    PORT: int = 8080
    HOST: str = "127.0.0.1"

    # --- Database -------------------------------------------------------
    # "cloud"  -> live Cloud SQL (PostgreSQL) through the Cloud SQL Auth Proxy
    # "sqlite" -> local file, for development/tests only
    DB_BACKEND: Literal["cloud", "sqlite"] = "cloud"
    # Full SQLAlchemy URL override (takes precedence over the DB_* fields).
    # It is deliberately rejected for Cloud SQL unless the operator makes an
    # explicit, reviewed opt-in below: a URL can bypass the app-owned proxy
    # and its dedicated Google identity.
    DATABASE_URL: Optional[str] = None
    ALLOW_UNMANAGED_CLOUD_SQL_CONNECTION: bool = False
    DB_HOST: str = "127.0.0.1"
    DB_PORT: int = 5432
    DB_NAME: str = "hotel_scraper"
    DB_USER: str = "directories"
    # If unset, the password is read from Secret Manager at startup (never stored on disk).
    DB_PASSWORD: Optional[str] = None
    DB_PASSWORD_SECRET: str = "directories-db-password"
    # Hard limits apply to every PostgreSQL session created by this app.  They
    # keep a proxy/network incident from turning into an indefinitely hung
    # worker transaction.
    DB_STATEMENT_TIMEOUT_MS: int = 30_000
    DB_LOCK_TIMEOUT_MS: int = 5_000

    # --- GCP / Cloud SQL Auth Proxy ------------------------------------
    GCP_PROJECT: str = "hushh-tech-prod"
    GCP_REGION: str = "us-central1"
    CLOUD_SQL_INSTANCE: str = "hushh-directories-db"
    AUTO_START_PROXY: bool = True
    CLOUD_SQL_PROXY_PATH: Optional[str] = None
    # Keep the worker's Google login entirely separate from the interactive
    # developer gcloud profile.  The default is deliberately beneath this
    # application's LocalAppData folder, not %APPDATA%\\gcloud.
    #
    # The Cloud SQL Auth Proxy is launched with --gcloud-auth.  It reads the
    # selected account from this isolated config directory; it does not use a
    # service-account key or a globally discovered ADC file.
    GCP_GCLOUD_CONFIG_DIR: Optional[str] = None
    GCP_GCLOUD_CONFIG_NAME: Optional[str] = "husshone-scraper"
    GCP_GCLOUD_ACCOUNT: Optional[str] = "husshpuppy5@gmail.com"

    # --- Scraper --------------------------------------------------------
    SCRAPER_DELAY_SEC: float = 3.0
    MAPS_MAX_RESULTS: int = 50
    ZIP_MAX_DISTANCE_KM: float = 75.0
    ZIP_MAX_NEW_HOTELS: int = 40
    # A conservative cap that can be adjusted in the user-data .env without a
    # rebuild.  Set to 0 only when an operator deliberately wants no cap.
    DAILY_MAPS_CALL_CAP: int = 1_000
    CAPTCHA_BACKOFF_1_SEC: int = 300
    CAPTCHA_BACKOFF_2_SEC: int = 900
    CAPTCHA_BACKOFF_3_SEC: int = 3_600
    CHROME_RECYCLE_AFTER_ZIPS: int = 200
    CHROME_CLEAR_CACHE_ON_RECYCLE: bool = True
    # Parent-side watchdog: a wedged Playwright child is killed and restarted
    # after ten minutes without a response.
    SCRAPER_PROCESS_TIMEOUT_SEC: int = 600
    DB_OFFLINE_RETRY_SEC: int = 30
    # Terminal transport batches are retained locally for a short audit/replay
    # window; pending batches are never pruned.
    OUTBOX_RETENTION_DAYS: int = 14
    OUTBOX_PRUNE_INTERVAL_SEC: int = 3_600
    # Leave blank until an operator selects a known-good ZIP.  When configured,
    # the worker samples it periodically without writing its records.
    CANARY_ZIP: Optional[str] = None
    CANARY_INTERVAL_SEC: int = 10_800
    CANARY_MIN_RESULTS: int = 3
    # Read-only audit work is paged so it remains practical as the directory
    # grows. Set the interval to 0 only to disable it deliberately.
    DATA_QUALITY_AUDIT_INTERVAL_SEC: int = 86_400
    DATA_QUALITY_AUDIT_SCAN_LIMIT: int = 10_000
    DATA_QUALITY_AUDIT_FINDING_LIMIT: int = 100
    # False is fail-closed on Cloud SQL (it never acts as a production bypass).
    # SQLite development/test runs have their own explicit bypass.
    SCHEMA_GUARD_ENABLED: bool = True
    SCHEMA_GUARD_CACHE_SEC: int = 300
    # When the queue is empty, re-crawl ZIPs not scraped in this many days
    # (0 = off). Stale/dense refreshes are spread by DAILY_MAPS_CALL_CAP.
    REFRESH_AFTER_DAYS: int = 30
    # Pause this long after repeated scrape failures (e.g. Google captcha/blocking).
    FAILURE_COOLDOWN_SEC: int = 300
    WEBSITE_ENRICHMENT_ENABLED: bool = True
    WEBSITE_BROWSER_FALLBACK: bool = True
    WEBSITE_AUTONOMOUS: bool = True
    WEBSITE_DISCOVERY_BACKFILL: bool = True
    WEBSITE_BACKFILL_AUTO_START: bool = True
    WEBSITE_BACKFILL_REFRESH_SEC: int = 86400
    WEBSITE_MAX_PAGES: int = 4
    WEBSITE_TIMEOUT_SEC: int = 10
    WEBSITE_MAX_BYTES: int = 1_000_000
    WEBSITE_MAX_ATTEMPTS: int = 3
    WEBSITE_FILL_MISSING_FIELDS: bool = True
    WEBSITE_BACKFILL_BATCH_SIZE: int = 200
    WEBSITE_BACKFILL_MAX_PENDING: int = 100
    WEBSITE_JOBS_PER_CYCLE: int = 8
    WEBSITE_CYCLE_BUDGET_SEC: int = 45
    WEBSITE_BACKLOG_HIGH: int = 200
    WEBSITE_BACKLOG_LOW: int = 100
    WEBSITE_FETCH_CONCURRENCY: int = 2
    WEBSITE_MIN_FREE_RAM_GB: int = 4
    # Imported VM pipelines. Registry workers are started explicitly from the
    # dashboard; their desired state then survives restarts. No auto-DDL.
    VM_USE_IMPORTED_HOTEL_PIPELINE: bool = True
    VM_NODE_PATH: Optional[str] = None
    VM_MIN_FREE_DISK_GB: int = 20

    model_config = SettingsConfigDict(
        env_file=(".env", os.path.join(user_data_dir(), ".env")),
        extra="ignore",
    )


settings = Settings()


def database_target() -> dict:
    """Non-secret identity for durable batches; credentials are never persisted."""
    if settings.DB_BACKEND == "sqlite":
        identity = {"url": settings.DATABASE_URL or "default-sqlite"}
    elif settings.DATABASE_URL:
        from sqlalchemy.engine import make_url
        url = make_url(settings.DATABASE_URL)
        identity = {"host": url.host, "port": url.port, "database": url.database}
    else:
        identity = {"project": settings.GCP_PROJECT, "region": settings.GCP_REGION,
                    "instance": settings.CLOUD_SQL_INSTANCE, "database": settings.DB_NAME}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    return {"version": 1, "backend": settings.DB_BACKEND, "fingerprint": digest}


def runtime_state_dir() -> str:
    # Retain the existing production audit trail. Local development gets a
    # separate spool per SQLite target, even outside pytest.
    root = user_data_dir()
    if settings.DB_BACKEND == "sqlite":
        root = os.path.join(root, "development", database_target()["fingerprint"][:24])
    os.makedirs(root, exist_ok=True)
    return root


def gcloud_config_dir() -> str:
    """Return the worker-only Cloud SDK config directory.

    ``CLOUDSDK_CONFIG`` is intentionally set for every subprocess that can
    authenticate to Google.  This prevents a scheduled worker from falling
    back to the Windows user's regular ``gcloud`` profile.
    """
    configured = _clean_optional(settings.GCP_GCLOUD_CONFIG_DIR)
    raw_path = configured or os.path.join(user_data_dir(), "gcloud")
    return os.path.abspath(os.path.expandvars(os.path.expanduser(raw_path)))


def gcloud_account() -> Optional[str]:
    """Dedicated account to select in the isolated gcloud configuration."""
    return _clean_optional(settings.GCP_GCLOUD_ACCOUNT)


def gcloud_config_name() -> Optional[str]:
    """Named configuration selected within the private Cloud SDK directory."""
    return _clean_optional(settings.GCP_GCLOUD_CONFIG_NAME)


def google_auth_environment(base_env: Optional[Mapping[str, str]] = None) -> dict[str, str]:
    """Build a subprocess environment that cannot inherit personal Google ADC.

    Cloud SQL Proxy's ``--gcloud-auth`` mode uses the Cloud SDK credentials in
    ``CLOUDSDK_CONFIG``.  Removing ``GOOGLE_APPLICATION_CREDENTIALS`` is
    intentional: an inherited service-account key or user ADC file must never
    silently become the scraper's production identity.
    """
    env = dict(os.environ if base_env is None else base_env)
    env["CLOUDSDK_CONFIG"] = gcloud_config_dir()
    # gcloud gives these values precedence over the active account stored in
    # the selected configuration.  Do not let an interactive shell inject a
    # token, credential file, or service-account impersonation into a worker
    # that was explicitly configured to use the dedicated Gmail account.
    for key in (
        "GOOGLE_APPLICATION_CREDENTIALS",
        "CLOUDSDK_AUTH_ACCESS_TOKEN",
        "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
        "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
        "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
        "CLOUDSDK_AUTH_DISABLE_CREDENTIALS",
    ):
        env.pop(key, None)
    # Avoid an interactive shell's account override winning over the worker's
    # configured account.  If no account is configured, gcloud selects the
    # active account from the isolated configuration only.
    env.pop("CLOUDSDK_CORE_ACCOUNT", None)
    env.pop("CLOUDSDK_ACTIVE_CONFIG_NAME", None)
    config_name = gcloud_config_name()
    if config_name:
        env["CLOUDSDK_ACTIVE_CONFIG_NAME"] = config_name
    # Pin the project as well as the identity.  The proxy connection name and
    # Secret Manager command include an explicit project, but keeping the SDK
    # context aligned makes a parent shell's project override harmless.
    env.pop("CLOUDSDK_CORE_PROJECT", None)
    env["CLOUDSDK_CORE_PROJECT"] = settings.GCP_PROJECT
    account = gcloud_account()
    if account:
        env["CLOUDSDK_CORE_ACCOUNT"] = account
    return env
