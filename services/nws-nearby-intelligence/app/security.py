from __future__ import annotations

import hashlib
import hmac
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from threading import Lock

from fastapi import Header, HTTPException, Request, status

from app.consumer_access import RateLimitResult
from app.settings import Settings, get_settings


@dataclass(frozen=True)
class AccessContext:
    key_fingerprint: str
    client_ip: str
    rate_limit_remaining: int
    rate_limit_reset_seconds: int


class SlidingWindowRateLimiter:
    """Per-instance limiter. A gateway limit remains the production scale-out boundary."""

    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(
        self, identity: str, *, limit: int, now: float | None = None
    ) -> tuple[bool, int, int]:
        now = time.monotonic() if now is None else now
        cutoff = now - 60.0
        with self._lock:
            bucket = self._events[identity]
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= limit:
                reset = max(1, int(61 - (now - bucket[0])))
                return False, 0, reset
            bucket.append(now)
            return True, max(0, limit - len(bucket)), 60


rate_limiter = SlidingWindowRateLimiter()


class ConsumerRateLimiterAdapter:
    """Adapter for the v4 consumer-policy interface.

    This remains process-local and is deliberately identified as such in the
    v4 response disclosures and runbook.  It is a migration guard, not a claim
    of distributed quota enforcement.
    """

    def consume(
        self,
        *,
        key: str,
        limit: int,
        window_seconds: int,
    ) -> RateLimitResult:
        if window_seconds != 60:
            raise RuntimeError("the in-process limiter supports only a 60-second window")
        allowed, remaining, reset = rate_limiter.check(key, limit=limit)
        return RateLimitResult(
            allowed=allowed,
            remaining=remaining,
            reset_after_seconds=reset,
        )


consumer_rate_limiter = ConsumerRateLimiterAdapter()


def _client_ip(request: Request) -> str:
    # Do not trust a caller-controlled X-Forwarded-For header for rate-limit identity.
    return request.client.host if request.client else "unknown"


def _fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def require_api_access(
    request: Request,
    x_nws_api_key: str | None = Header(default=None, alias="X-NWS-API-Key"),
) -> AccessContext:
    settings: Settings = get_settings()
    supplied = x_nws_api_key or ""
    if settings.require_api_key and (
        not supplied or not settings.api_key or not hmac.compare_digest(supplied, settings.api_key)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "API_KEY_REQUIRED", "message": "A valid X-NWS-API-Key is required."},
        )

    key_fingerprint = _fingerprint(supplied if settings.require_api_key else "anonymous")
    client_ip = _client_ip(request)
    allowed, remaining, reset = rate_limiter.check(
        f"{key_fingerprint}:{client_ip}", limit=settings.rate_limit_per_minute
    )
    request.state.rate_limit_remaining = remaining
    request.state.rate_limit_reset_seconds = reset
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "RATE_LIMITED", "message": "Try again after the reset interval."},
            headers={"Retry-After": str(reset)},
        )
    return AccessContext(
        key_fingerprint=key_fingerprint,
        client_ip=client_ip,
        rate_limit_remaining=remaining,
        rate_limit_reset_seconds=reset,
    )
