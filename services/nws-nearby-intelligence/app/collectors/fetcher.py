from __future__ import annotations

import hashlib
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock

from app.collectors.contracts import ArtifactManifest, SourceContract


class FetchError(RuntimeError):
    pass


@dataclass(frozen=True)
class FetchScope:
    """Allowlist for a reviewed organization anchor's public pages.

    It is intentionally supplied by an anchor, rather than a broad source
    type.  ``official_company_pages`` is useful for many organizations but it
    must not grant a worker permission to follow an arbitrary redirect or to
    crawl unrelated paths on an organization domain.
    """

    allowed_hosts: frozenset[str]
    allowed_path_prefixes: frozenset[str]
    maximum_content_bytes: int = 1_048_576
    allowed_content_types: frozenset[str] = frozenset(
        {
            "text/html",
            "application/xhtml+xml",
            "application/json",
            "application/xml",
            "text/xml",
            "application/pdf",
        }
    )

    def __post_init__(self) -> None:
        if not self.allowed_hosts:
            raise ValueError("fetch scope needs at least one allowed host")
        if not self.allowed_path_prefixes:
            raise ValueError("fetch scope needs at least one approved path prefix")
        if self.maximum_content_bytes <= 0:
            raise ValueError("maximum_content_bytes must be positive")
        if any(not host.strip() or "/" in host for host in self.allowed_hosts):
            raise ValueError("allowed hosts must be host names")
        if any(
            not prefix.startswith("/") or "?" in prefix or "#" in prefix
            for prefix in self.allowed_path_prefixes
        ):
            raise ValueError("approved path prefixes must be absolute paths")

    def permits_uri(self, uri: str) -> bool:
        parsed = urllib.parse.urlsplit(uri)
        host = (parsed.hostname or "").casefold()
        if parsed.scheme != "https" or not host:
            return False
        allowed_hosts = {item.casefold() for item in self.allowed_hosts}
        if host not in allowed_hosts:
            return False
        path = parsed.path or "/"
        return any(self._path_is_approved(path, prefix) for prefix in self.allowed_path_prefixes)

    @staticmethod
    def _path_is_approved(path: str, prefix: str) -> bool:
        if prefix == "/":
            return True
        if prefix.endswith("/"):
            return path.startswith(prefix)
        return path == prefix or path.startswith(f"{prefix}/")

    def permits_content_type(self, content_type: str | None) -> bool:
        if not content_type:
            return False
        normalized = content_type.split(";", 1)[0].strip().casefold()
        return normalized in self.allowed_content_types


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

    def fetch(self, uri: str, *, scope: FetchScope | None = None) -> tuple[bytes, ArtifactManifest]:
        if not uri.startswith(("https://", "http://")):
            raise FetchError("only HTTP(S) acquisition is supported")
        if scope is not None and not scope.permits_uri(uri):
            raise FetchError("requested URI is outside the approved organization anchor scope")
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
                final_uri = response.geturl()
                if scope is not None and not scope.permits_uri(final_uri):
                    raise FetchError("redirect left the approved organization anchor scope")
                content_type = response.headers.get("Content-Type")
                if scope is not None and not scope.permits_content_type(content_type):
                    raise FetchError("response content type is outside the approved scope")
                declared_length = response.headers.get("Content-Length")
                if scope is not None and declared_length:
                    try:
                        if int(declared_length) > scope.maximum_content_bytes:
                            raise FetchError("response exceeds the approved content-size limit")
                    except ValueError:
                        raise FetchError("response has an invalid Content-Length header") from None
                read_limit = (scope.maximum_content_bytes + 1) if scope is not None else None
                content = response.read(read_limit)
                if scope is not None and len(content) > scope.maximum_content_bytes:
                    raise FetchError("response exceeds the approved content-size limit")
                digest = hashlib.sha256(content).hexdigest()
                manifest = ArtifactManifest(
                    source_id=self.contract.source_id,
                    requested_uri=uri,
                    final_uri=final_uri,
                    retrieved_at=datetime.now(UTC),
                    status_code=response.status,
                    content_type=content_type,
                    content_length=len(content),
                    sha256=digest,
                    etag=response.headers.get("ETag"),
                    last_modified=response.headers.get("Last-Modified"),
                )
                return content, manifest
        except (urllib.error.URLError, TimeoutError) as exc:
            raise FetchError(str(exc)) from exc
