from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


def _read_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _read_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name, str(default)).strip().casefold()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean")


@dataclass(frozen=True)
class Settings:
    environment: str
    api_key: str
    require_api_key: bool
    rate_limit_per_minute: int
    max_request_bytes: int
    query_location_decimals: int
    service_version: str
    model_version: str
    national_model_version: str
    data_mode: str
    release_reviewed_at: str
    national_policy_reviewed_at: str
    national_sources_enabled: bool
    sec_source_enabled: bool
    sec_api_base_url: str
    sec_api_key: str
    sec_timeout_seconds: int
    form6_source_enabled: bool
    snapshot_bucket: str
    snapshot_prefix: str
    snapshot_max_age_hours: int
    snapshot_max_source_age_hours: int
    source_registry_path: str
    source_registry_manifest_path: str
    source_registry_sha256: str
    source_registry_version: int
    nppes_source_enabled: bool
    nppes_db_host: str
    nppes_db_port: int
    nppes_db_name: str
    nppes_db_user: str
    nppes_db_password: str
    nppes_statement_timeout_ms: int

    @classmethod
    def from_environment(cls) -> Settings:
        environment = os.getenv("NWS_ENVIRONMENT", "development").strip().casefold()
        if environment not in {"development", "test", "production"}:
            raise RuntimeError("NWS_ENVIRONMENT must be development, test, or production")

        api_key = os.getenv("NWS_API_KEY", "local-development-only").strip()
        require_api_key = _read_bool("NWS_REQUIRE_API_KEY", True)
        if environment == "production" and require_api_key:
            if len(api_key) < 32 or api_key == "local-development-only":
                raise RuntimeError(
                    "NWS_API_KEY must be a non-development secret of at least 32 characters"
                )

        data_mode = os.getenv("NWS_DATA_MODE", "NATIONAL_PUBLIC_PROFESSIONAL_SNAPSHOT").strip()
        if data_mode not in {
            "REVIEWED_PUBLIC_ASSOCIATION_RELEASE",
            "NATIONAL_PUBLIC_PROFESSIONAL_SNAPSHOT",
        }:
            raise RuntimeError(
                "NWS_DATA_MODE must be REVIEWED_PUBLIC_ASSOCIATION_RELEASE or "
                "NATIONAL_PUBLIC_PROFESSIONAL_SNAPSHOT"
            )

        national_sources_enabled = _read_bool(
            "NWS_NATIONAL_SOURCES_ENABLED", environment == "production"
        )
        sec_source_enabled = _read_bool("NWS_SEC_SOURCE_ENABLED", national_sources_enabled)
        nppes_source_enabled = _read_bool("NWS_NPPES_SOURCE_ENABLED", national_sources_enabled)
        sec_api_key = os.getenv("NWS_SEC_API_KEY", "").strip()
        form6_source_enabled = _read_bool("NWS_FORM6_SOURCE_ENABLED", False)
        snapshot_bucket = os.getenv("NWS_SNAPSHOT_BUCKET", "").strip()
        snapshot_prefix = (
            os.getenv("NWS_SNAPSHOT_PREFIX", "published/net-worth-v1.0.0").strip().strip("/")
        )
        source_registry_path = os.getenv(
            "NWS_SOURCE_REGISTRY_PATH", "/app/config/sources.yaml"
        ).strip()
        source_registry_manifest_path = os.getenv(
            "NWS_SOURCE_REGISTRY_MANIFEST_PATH",
            "/app/config/source-registry-manifest.json",
        ).strip()
        source_registry_sha256 = os.getenv("NWS_SOURCE_REGISTRY_SHA256", "").strip().casefold()
        source_registry_version = _read_int(
            "NWS_SOURCE_REGISTRY_VERSION", 3, minimum=1, maximum=1_000_000
        )
        nppes_db_password = os.getenv("NWS_NPPES_DB_PASSWORD", "").strip()
        if environment == "production" and national_sources_enabled:
            if sec_source_enabled and not sec_api_key:
                raise RuntimeError(
                    "NWS_SEC_API_KEY must be supplied when the SEC source is enabled"
                )
            if nppes_source_enabled and not nppes_db_password:
                raise RuntimeError(
                    "NWS_NPPES_DB_PASSWORD must be supplied when the NPPES source is enabled"
                )
        if form6_source_enabled:
            if not snapshot_bucket or snapshot_bucket.startswith("gs://") or "/" in snapshot_bucket:
                raise RuntimeError(
                    "NWS_SNAPSHOT_BUCKET must be an unqualified bucket name when the "
                    "Florida Form 6 snapshot is enabled"
                )
            if (
                not snapshot_prefix
                or ".." in snapshot_prefix.split("/")
                or snapshot_prefix.startswith(".")
            ):
                raise RuntimeError(
                    "NWS_SNAPSHOT_PREFIX must be a safe object prefix when the Florida "
                    "Form 6 snapshot is enabled"
                )
            if not source_registry_path or not source_registry_manifest_path:
                raise RuntimeError(
                    "NWS_SOURCE_REGISTRY_PATH and NWS_SOURCE_REGISTRY_MANIFEST_PATH "
                    "must be supplied when the Florida Form 6 snapshot is enabled"
                )
            if len(source_registry_sha256) != 64 or any(
                character not in "0123456789abcdef" for character in source_registry_sha256
            ):
                raise RuntimeError(
                    "NWS_SOURCE_REGISTRY_SHA256 must be a SHA-256 hex digest when the "
                    "Florida Form 6 snapshot is enabled"
                )

        return cls(
            environment=environment,
            api_key=api_key,
            require_api_key=require_api_key,
            rate_limit_per_minute=_read_int(
                "NWS_RATE_LIMIT_PER_MINUTE", 60, minimum=1, maximum=10_000
            ),
            max_request_bytes=_read_int(
                "NWS_MAX_REQUEST_BYTES", 32_768, minimum=1_024, maximum=1_048_576
            ),
            query_location_decimals=_read_int(
                "NWS_QUERY_LOCATION_DECIMALS", 2, minimum=0, maximum=4
            ),
            service_version="3.2.0",
            model_version="nws-v2.3.0-kirkland.2026-08-13",
            national_model_version="nws-v3.0.0-us-public-professional.2026-08-14",
            data_mode=data_mode,
            release_reviewed_at="2026-08-13",
            national_policy_reviewed_at="2026-08-14",
            national_sources_enabled=national_sources_enabled,
            sec_source_enabled=sec_source_enabled,
            sec_api_base_url=os.getenv(
                "NWS_SEC_API_BASE_URL",
                "https://insider-holdings-api-fro3hygenq-uc.a.run.app",
            )
            .strip()
            .rstrip("/"),
            sec_api_key=sec_api_key,
            sec_timeout_seconds=_read_int("NWS_SEC_TIMEOUT_SECONDS", 8, minimum=1, maximum=30),
            form6_source_enabled=form6_source_enabled,
            snapshot_bucket=snapshot_bucket,
            snapshot_prefix=snapshot_prefix,
            snapshot_max_age_hours=_read_int(
                "NWS_SNAPSHOT_MAX_AGE_HOURS", 24, minimum=1, maximum=720
            ),
            snapshot_max_source_age_hours=_read_int(
                "NWS_SNAPSHOT_MAX_SOURCE_AGE_HOURS", 720, minimum=1, maximum=720
            ),
            source_registry_path=source_registry_path,
            source_registry_manifest_path=source_registry_manifest_path,
            source_registry_sha256=source_registry_sha256,
            source_registry_version=source_registry_version,
            nppes_source_enabled=nppes_source_enabled,
            nppes_db_host=os.getenv(
                "NWS_NPPES_DB_HOST",
                "/cloudsql/hushh-tech-prod:us-central1:hushh-directories-db",
            ).strip(),
            nppes_db_port=_read_int("NWS_NPPES_DB_PORT", 5432, minimum=1, maximum=65535),
            nppes_db_name=os.getenv("NWS_NPPES_DB_NAME", "healthcare").strip(),
            nppes_db_user=os.getenv("NWS_NPPES_DB_USER", "nws_nearby_ro").strip(),
            nppes_db_password=nppes_db_password,
            nppes_statement_timeout_ms=_read_int(
                "NWS_NPPES_STATEMENT_TIMEOUT_MS", 4_000, minimum=500, maximum=30_000
            ),
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_environment()
