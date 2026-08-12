from __future__ import annotations

import hashlib
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock

from app.collectors.contracts import ArtifactManifest, SourceContract


class FetchError(RuntimeError):
    pass


@dataclass
class TokenBucket:
    rate_per_second: float
    burst: float = 1.0

    def __post_init__(self) -> None:
        if self.rate_per_second <= 0 or self.burst <= 0:
            raise ValueError("rate and burst must be positive")
        self._tokens = self.burst
        self._updated = time.monotonic()
        self._lock = Lock()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                elapsed = now - self._updated
                self._tokens = min(self.burst, self._tokens + elapsed * self.rate_per_second)
                self._updated = now
                if self._tokens >= 1:
                    self._tokens -= 1
                    return
                sleep_for = (1 - self._tokens) / self.rate_per_second
            time.sleep(max(0.001, sleep_for))


class ControlledPublicFetcher:
    """Simple reference fetcher with declared identity, robots checks and throttling.

    It intentionally has no authentication bypass, CAPTCHA handling, proxy rotation or
    anti-bot evasion. Source-specific production collectors should preserve those invariants.
    """

    def __init__(self, contract: SourceContract, *, timeout_seconds: int = 30) -> None:
        self.contract = contract
        self.timeout_seconds = timeout_seconds
        self.limiter = TokenBucket(contract.requests_per_second, burst=1.0)
        self._robots: dict[str, urllib.robotparser.RobotFileParser] = {}

    def _robots_allowed(self, uri: str) -> bool:
        if not self.contract.obey_robots_txt:
            return True
        parsed = urllib.parse.urlparse(uri)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self._robots:
            parser = urllib.robotparser.RobotFileParser()
            parser.set_url(f"{origin}/robots.txt")
            try:
                parser.read()
            except Exception:
                # Fail closed for public-page crawlers; bulk-file contracts can disable this check.
                return False
            self._robots[origin] = parser
        return self._robots[origin].can_fetch(self.contract.user_agent, uri)

    def fetch(self, uri: str) -> tuple[bytes, ArtifactManifest]:
        if not uri.startswith(("https://", "http://")):
            raise FetchError("only HTTP(S) acquisition is supported")
        if not self._robots_allowed(uri):
            raise FetchError("robots policy does not permit this fetch")
        self.limiter.acquire()
        request = urllib.request.Request(
            uri,
            headers={
                "User-Agent": self.contract.user_agent,
                "Accept-Encoding": "identity",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                content = response.read()
                digest = hashlib.sha256(content).hexdigest()
                manifest = ArtifactManifest(
                    source_id=self.contract.source_id,
                    requested_uri=uri,
                    final_uri=response.geturl(),
                    retrieved_at=datetime.now(timezone.utc),
                    status_code=response.status,
                    content_type=response.headers.get("Content-Type"),
                    content_length=len(content),
                    sha256=digest,
                    etag=response.headers.get("ETag"),
                    last_modified=response.headers.get("Last-Modified"),
                )
                return content, manifest
        except (urllib.error.URLError, TimeoutError) as exc:
            raise FetchError(str(exc)) from exc
