from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Protocol


class SnapshotStoreError(RuntimeError):
    def __init__(self, message: str, *, code: str = "SNAPSHOT_STORE_ERROR") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class HttpResult:
    status: int
    body: bytes
    headers: dict[str, str]


class HttpTransport(Protocol):
    def request(
        self,
        *,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout_seconds: float,
    ) -> HttpResult: ...


class TokenProvider(Protocol):
    def token(self) -> str: ...


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise SnapshotStoreError("snapshot storage redirect was rejected")


class UrllibTransport:
    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(_RejectRedirects())

    def request(
        self,
        *,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout_seconds: float,
    ) -> HttpResult:
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=timeout_seconds) as response:
                return HttpResult(
                    status=response.status,
                    body=response.read(),
                    headers={key.casefold(): value for key, value in response.headers.items()},
                )
        except urllib.error.HTTPError as exc:
            return HttpResult(
                status=exc.code,
                body=exc.read(),
                headers={key.casefold(): value for key, value in exc.headers.items()},
            )
        except (OSError, TimeoutError, urllib.error.URLError) as exc:
            raise SnapshotStoreError("snapshot storage request failed") from exc


class MetadataTokenProvider:
    """Short-lived service identity token; no key file or query-service secret."""

    _URI = (
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
    )

    def __init__(
        self,
        *,
        transport: HttpTransport | None = None,
        clock=time.monotonic,
    ) -> None:  # type: ignore[no-untyped-def]
        self._transport = transport or UrllibTransport()
        self._clock = clock
        self._cached: tuple[str, float] | None = None
        self._lock = threading.Lock()

    def token(self) -> str:
        now = self._clock()
        with self._lock:
            if self._cached is not None and self._cached[1] > now + 30:
                return self._cached[0]
            result = self._transport.request(
                method="GET",
                url=self._URI,
                headers={"Metadata-Flavor": "Google"},
                body=None,
                timeout_seconds=2,
            )
            if result.status != 200 or result.headers.get("metadata-flavor") != "Google":
                raise SnapshotStoreError("service identity token was unavailable")
            try:
                payload = json.loads(result.body)
                token = str(payload["access_token"]).strip()
                expires_in = int(payload["expires_in"])
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                raise SnapshotStoreError("service identity token response was invalid") from exc
            if not token or not 60 <= expires_in <= 86_400:
                raise SnapshotStoreError("service identity token response was invalid")
            self._cached = (token, now + expires_in)
            return token


@dataclass(frozen=True)
class GcsObject:
    name: str
    generation: int
    body: bytes


class SnapshotGcsStore:
    """Minimal GCS JSON API boundary with generation-safe writes."""

    def __init__(
        self,
        *,
        bucket: str,
        transport: HttpTransport | None = None,
        token_provider: TokenProvider | None = None,
        timeout_seconds: float = 10,
        maximum_object_bytes: int = 8 * 1024 * 1024,
    ) -> None:
        if not bucket or bucket.startswith("gs://") or "/" in bucket:
            raise ValueError("bucket must be an unqualified Cloud Storage bucket name")
        if not 0 < timeout_seconds <= 30:
            raise ValueError("timeout_seconds must be in (0, 30]")
        if not 1_024 <= maximum_object_bytes <= 32 * 1024 * 1024:
            raise ValueError("maximum_object_bytes is outside the supported bound")
        self.bucket = bucket
        self._transport = transport or UrllibTransport()
        self._token_provider = token_provider or MetadataTokenProvider()
        self._timeout_seconds = timeout_seconds
        self._maximum_object_bytes = maximum_object_bytes

    @staticmethod
    def _validate_name(name: str) -> str:
        normalized = name.strip()
        if (
            not normalized
            or normalized.startswith(("/", "."))
            or ".." in normalized.split("/")
            or len(normalized.encode("utf-8")) > 1_024
        ):
            raise ValueError("Cloud Storage object name is unsafe")
        return normalized

    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token_provider.token()}"}

    def read(self, name: str, *, generation: int | None = None) -> GcsObject:
        name = self._validate_name(name)
        encoded_bucket = urllib.parse.quote(self.bucket, safe="")
        encoded_name = urllib.parse.quote(name, safe="")
        query: dict[str, str] = {"alt": "media"}
        if generation is not None:
            if generation <= 0:
                raise ValueError("generation must be positive")
            query["generation"] = str(generation)
        url = (
            f"https://storage.googleapis.com/download/storage/v1/b/{encoded_bucket}/o/"
            f"{encoded_name}?{urllib.parse.urlencode(query)}"
        )
        result = self._transport.request(
            method="GET",
            url=url,
            headers={**self._auth_headers(), "Accept-Encoding": "identity"},
            body=None,
            timeout_seconds=self._timeout_seconds,
        )
        if result.status == 404:
            raise SnapshotStoreError("snapshot object was not found", code="OBJECT_NOT_FOUND")
        if result.status != 200:
            raise SnapshotStoreError("snapshot object could not be read")
        if len(result.body) > self._maximum_object_bytes:
            raise SnapshotStoreError("snapshot object exceeded the read limit")
        try:
            resolved_generation = int(result.headers["x-goog-generation"])
        except (KeyError, ValueError) as exc:
            raise SnapshotStoreError("snapshot object omitted its generation") from exc
        if generation is not None and resolved_generation != generation:
            raise SnapshotStoreError("snapshot object generation changed")
        return GcsObject(name=name, generation=resolved_generation, body=result.body)

    def write(
        self,
        name: str,
        body: bytes,
        *,
        if_generation_match: int,
    ) -> GcsObject:
        name = self._validate_name(name)
        if if_generation_match < 0:
            raise ValueError("if_generation_match cannot be negative")
        if not body or len(body) > self._maximum_object_bytes:
            raise ValueError("snapshot write body is empty or too large")
        encoded_bucket = urllib.parse.quote(self.bucket, safe="")
        query = urllib.parse.urlencode(
            {
                "uploadType": "media",
                "name": name,
                "ifGenerationMatch": str(if_generation_match),
            }
        )
        result = self._transport.request(
            method="POST",
            url=f"https://storage.googleapis.com/upload/storage/v1/b/{encoded_bucket}/o?{query}",
            headers={
                **self._auth_headers(),
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": str(len(body)),
            },
            body=body,
            timeout_seconds=self._timeout_seconds,
        )
        if result.status in {409, 412}:
            raise SnapshotStoreError(
                "snapshot generation precondition failed",
                code="GENERATION_PRECONDITION_FAILED",
            )
        if result.status not in {200, 201}:
            raise SnapshotStoreError("snapshot object could not be written")
        try:
            payload = json.loads(result.body)
            generation = int(payload["generation"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise SnapshotStoreError("snapshot write response was invalid") from exc
        return GcsObject(name=name, generation=generation, body=body)
