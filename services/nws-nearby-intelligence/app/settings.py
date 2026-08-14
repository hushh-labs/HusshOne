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
    form6_api_base_url: str
    form6_api_key: str
    form6_timeout_seconds: int
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
        form6_api_key = os.getenv("NWS_FORM6_API_KEY", "").strip()
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
        if environment == "production" and form6_source_enabled and not form6_api_key:
            raise RuntimeError(
                "NWS_FORM6_API_KEY must be supplied when the Florida Form 6 source is enabled"
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
            service_version="3.1.0",
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
            form6_api_base_url=os.getenv(
                "NWS_FORM6_API_BASE_URL",
                "https://insider-holdings-api-fro3hygenq-uc.a.run.app",
            )
            .strip()
            .rstrip("/"),
            form6_api_key=form6_api_key,
            form6_timeout_seconds=_read_int(
                "NWS_FORM6_TIMEOUT_SECONDS", 8, minimum=1, maximum=30
            ),
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
