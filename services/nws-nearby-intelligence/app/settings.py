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
    data_mode: str
    release_reviewed_at: str

    @classmethod
    def from_environment(cls) -> Settings:
        environment = os.getenv("NWS_ENVIRONMENT", "development").strip().casefold()
        if environment not in {"development", "test", "production"}:
            raise RuntimeError("NWS_ENVIRONMENT must be development, test, or production")

        api_key = os.getenv("NWS_API_KEY", "local-development-only").strip()
        require_api_key = _read_bool("NWS_REQUIRE_API_KEY", True)
        if environment == "production" and require_api_key and api_key == "local-development-only":
            raise RuntimeError("NWS_API_KEY must be supplied in production")

        data_mode = os.getenv("NWS_DATA_MODE", "REVIEWED_PUBLIC_ASSOCIATION_RELEASE").strip()
        if data_mode != "REVIEWED_PUBLIC_ASSOCIATION_RELEASE":
            raise RuntimeError(
                "This release supports only REVIEWED_PUBLIC_ASSOCIATION_RELEASE data mode"
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
            service_version="2.5.0",
            model_version="nws-v2.3.0-kirkland.2026-08-13",
            data_mode=data_mode,
            release_reviewed_at="2026-08-13",
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_environment()
