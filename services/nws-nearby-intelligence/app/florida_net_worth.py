"""Bounded adapter for sworn whole-net-worth declarations in Florida Form 6.

This module is deliberately separate from the SEC holdings adapter.  A Section 16
position is one security interest and must never be promoted to a person's total net
worth.  Florida Form 6 is different: the filer declares one whole net-worth amount.

The adapter is also a privacy boundary.  Its output allowlist contains the declaration,
the filer's public name and office/jurisdiction, the form year, and official filing
provenance.  Unknown upstream fields (including schedules, addresses, and contacts) are
never copied into an output object.
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from enum import StrEnum
from typing import Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

_CANONICAL_SOURCE_HOST = "insider-holdings-api-fro3hygenq-uc.a.run.app"
_OFFICIAL_DISCLOSURE_HOST = "disclosure.floridaethics.gov"
_OFFICIAL_SEARCH_URL = "https://disclosure.floridaethics.gov/PublicSearch/Filings"
_MAX_RESPONSE_BYTES = 5_000_000
_MAX_TEXT_LENGTH = 240
_MAX_DECLARED_NET_WORTH_USD = Decimal("1000000000000000")
_FILING_PATH = re.compile(r"^/api/Report/RenderPdf/(?P<filing_id>[1-9][0-9]*)/False$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
_STREET_ADDRESS = re.compile(
    r"^\s*\d{1,7}\s+.+\b(?:street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|"
    r"lane|ln\.?|boulevard|blvd\.?|highway|hwy\.?)\b",
    re.IGNORECASE,
)


class FloridaForm6Outcome(StrEnum):
    """The three public source outcomes; empty is not an availability failure."""

    OK = "OK"
    EMPTY = "EMPTY"
    UNAVAILABLE = "UNAVAILABLE"


class PublicJurisdictionKind(StrEnum):
    COUNTY = "COUNTY"
    CITY = "CITY"
    OFFICE = "OFFICE"


@dataclass(frozen=True)
class PublicJurisdiction:
    """A route-resolved public service jurisdiction, never a personal coordinate."""

    kind: PublicJurisdictionKind
    token: str

    def __post_init__(self) -> None:
        try:
            token = _public_text(self.token, field="public_jurisdiction", maximum=120)
        except FloridaForm6SourceError as exc:
            raise ValueError("public_jurisdiction must be safe public text") from exc
        if len(token) < 2:
            raise ValueError("public_jurisdiction must contain at least two characters")
        object.__setattr__(self, "token", token)


@dataclass(frozen=True)
class FloridaForm6Provenance:
    source_id: str
    source_authority: str
    source_url: str
    filing_url: str
    declaration_scope: str


@dataclass(frozen=True)
class FloridaForm6Record:
    """Strict public allowlist for one sworn whole-net-worth declaration."""

    subject_id: str
    name: str
    declared_net_worth_usd: Decimal
    public_offices: tuple[str, ...]
    public_jurisdiction: PublicJurisdiction
    form_year: int
    filing_url: str
    provenance: FloridaForm6Provenance


@dataclass(frozen=True)
class FloridaForm6SourceStatus:
    source_id: str = "florida_form_6"
    source_snapshot_id: str | None = None
    source_artifact_sha256: str | None = None
    source_retrieved_at: str | None = None
    index_built_at: str | None = None
    index_form_year: int | None = None
    index_partial: bool | None = None
    filings_seen: int | None = None
    declarations_indexed: int | None = None
    unreadable_filings: int | None = None
    upstream_total: int | None = None
    requested_limit: int = 0
    pages_fetched: int = 0
    accepted_record_count: int = 0
    truncated: bool = False
    cache_hit: bool = False
    error_code: str | None = None


@dataclass(frozen=True)
class FloridaForm6Batch:
    outcome: FloridaForm6Outcome
    records: tuple[FloridaForm6Record, ...]
    source_status: FloridaForm6SourceStatus


class FloridaForm6SourceError(RuntimeError):
    """The source was unavailable or violated the declared whole-net-worth contract."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "SOURCE_UNAVAILABLE",
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retry_after_seconds = retry_after_seconds


class JsonTransport(Protocol):
    def get_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> Mapping[str, object]: ...


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:  # noqa: ARG002
        return None


def _parse_retry_after(value: object) -> float | None:
    """Parse a 429 Retry-After value without trusting it as a sleep duration yet."""

    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    try:
        seconds = float(raw)
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(raw)
        except (TypeError, ValueError, OverflowError):
            return None
        if retry_at.tzinfo is None or retry_at.utcoffset() is None:
            return None
        seconds = (retry_at.astimezone(UTC) - datetime.now(UTC)).total_seconds()
    if not math.isfinite(seconds):
        return None
    return max(0.0, seconds)


class UrllibJsonTransport:
    """HTTPS JSON transport that never forwards bearer auth through a redirect."""

    def get_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> Mapping[str, object]:
        request = Request(url, headers=dict(headers), method="GET")
        try:
            with build_opener(_NoRedirects).open(request, timeout=timeout_seconds) as response:
                payload = response.read(_MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            if exc.code == 429:
                raise FloridaForm6SourceError(
                    "Florida Form 6 source rate limit was reached",
                    code="SOURCE_RATE_LIMITED",
                    retry_after_seconds=_parse_retry_after(
                        exc.headers.get("Retry-After") if exc.headers is not None else None
                    ),
                ) from exc
            raise FloridaForm6SourceError("Florida Form 6 source request failed") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise FloridaForm6SourceError("Florida Form 6 source request failed") from exc
        if len(payload) > _MAX_RESPONSE_BYTES:
            raise FloridaForm6SourceError("Florida Form 6 response exceeded size limit")
        try:
            decoded = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FloridaForm6SourceError("Florida Form 6 source returned invalid JSON") from exc
        if not isinstance(decoded, dict):
            raise FloridaForm6SourceError("Florida Form 6 source returned a non-object payload")
        return cast(Mapping[str, object], decoded)


@dataclass(frozen=True)
class _IndexSnapshot:
    source_snapshot_id: str
    source_artifact_sha256: str
    source_retrieved_at: str
    built_at: str
    form_year: int
    partial: bool
    filings_seen: int
    declarations_indexed: int
    unreadable: int


@dataclass(frozen=True)
class _MappedPage:
    records: tuple[FloridaForm6Record, ...]
    total: int
    returned: int
    index: _IndexSnapshot


def _public_text(value: object, *, field: str, maximum: int = _MAX_TEXT_LENGTH) -> str:
    if not isinstance(value, str):
        raise FloridaForm6SourceError(
            f"Florida Form 6 source omitted {field}", code="SOURCE_CONTRACT_VIOLATION"
        )
    if _CONTROL_CHARACTERS.search(value):
        raise FloridaForm6SourceError(
            f"Florida Form 6 source returned unsafe {field}",
            code="SOURCE_CONTRACT_VIOLATION",
        )
    compact = " ".join(value.split())
    if not compact or len(compact) > maximum:
        raise FloridaForm6SourceError(
            f"Florida Form 6 source returned invalid {field}",
            code="SOURCE_CONTRACT_VIOLATION",
        )
    return compact


def _nonnegative_int(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise FloridaForm6SourceError(
            f"Florida Form 6 source returned invalid {field}",
            code="SOURCE_CONTRACT_VIOLATION",
        )
    return value


def _parse_declared_net_worth(value: object) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise FloridaForm6SourceError(
            "Florida Form 6 source omitted numeric netWorth",
            code="SOURCE_CONTRACT_VIOLATION",
        )
    if isinstance(value, float) and not math.isfinite(value):
        raise FloridaForm6SourceError(
            "Florida Form 6 source returned non-finite netWorth",
            code="SOURCE_CONTRACT_VIOLATION",
        )
    try:
        amount = Decimal(str(value))
    except InvalidOperation as exc:
        raise FloridaForm6SourceError(
            "Florida Form 6 source returned invalid netWorth",
            code="SOURCE_CONTRACT_VIOLATION",
        ) from exc
    if not amount.is_finite() or abs(amount) > _MAX_DECLARED_NET_WORTH_USD:
        raise FloridaForm6SourceError(
            "Florida Form 6 source returned out-of-range netWorth",
            code="SOURCE_CONTRACT_VIOLATION",
        )
    return amount


def _filing_id(url: object) -> tuple[str, str]:
    filing_url = _public_text(url, field="filingUrl", maximum=500)
    parsed = urlsplit(filing_url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != _OFFICIAL_DISCLOSURE_HOST
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or parsed.query
        or parsed.fragment
    ):
        raise FloridaForm6SourceError(
            "Florida Form 6 source returned a non-official filingUrl",
            code="SOURCE_CONTRACT_VIOLATION",
        )
    match = _FILING_PATH.fullmatch(parsed.path)
    if match is None:
        raise FloridaForm6SourceError(
            "Florida Form 6 source returned an invalid filingUrl",
            code="SOURCE_CONTRACT_VIOLATION",
        )
    return filing_url, match.group("filing_id")


def _contains_token(value: str, token: str) -> bool:
    return token.casefold() in value.casefold()


class FloridaForm6NetWorthAdapter:
    """Fetch a bounded page set from the current Florida Form 6 source."""

    def __init__(
        self,
        *,
        base_url: str,
        bearer_token: str,
        transport: JsonTransport | None = None,
        timeout_seconds: float = 5.0,
        cache_ttl_seconds: float = 60.0,
        page_size: int = 50,
        max_pages: int = 2,
        allowed_hosts: frozenset[str] | None = None,
        minimum_request_interval_seconds: float = 0.0,
        max_rate_limit_retries: int = 0,
        maximum_retry_after_seconds: float = 30.0,
        deadline_monotonic: float | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        parsed = urlsplit(base_url)
        host_allowlist = allowed_hosts or frozenset({_CANONICAL_SOURCE_HOST})
        normalized_hosts = frozenset(host.casefold() for host in host_allowlist)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.hostname.casefold() not in normalized_hosts
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("base_url must be an allowlisted HTTPS origin")
        token = bearer_token.strip()
        if not token:
            raise ValueError("bearer_token is required")
        if timeout_seconds <= 0 or timeout_seconds > 30:
            raise ValueError("timeout_seconds must be in (0, 30]")
        if cache_ttl_seconds < 0 or cache_ttl_seconds > 3600:
            raise ValueError("cache_ttl_seconds must be in [0, 3600]")
        if not 1 <= page_size <= 100:
            raise ValueError("page_size must be between 1 and 100")
        if not 1 <= max_pages <= 10:
            raise ValueError("max_pages must be between 1 and 10")
        if (
            not math.isfinite(minimum_request_interval_seconds)
            or not 0 <= minimum_request_interval_seconds <= 60
        ):
            raise ValueError("minimum_request_interval_seconds must be in [0, 60]")
        if (
            isinstance(max_rate_limit_retries, bool)
            or not isinstance(max_rate_limit_retries, int)
            or not 0 <= max_rate_limit_retries <= 5
        ):
            raise ValueError("max_rate_limit_retries must be in [0, 5]")
        if (
            not math.isfinite(maximum_retry_after_seconds)
            or not 0 <= maximum_retry_after_seconds <= 300
        ):
            raise ValueError("maximum_retry_after_seconds must be in [0, 300]")
        if deadline_monotonic is not None and (
            not math.isfinite(deadline_monotonic) or deadline_monotonic <= clock()
        ):
            raise ValueError("deadline_monotonic must be a future monotonic timestamp")

        self._base_url = base_url.rstrip("/")
        self._bearer_token = token
        self._transport = transport or UrllibJsonTransport()
        self._timeout_seconds = timeout_seconds
        self._cache_ttl_seconds = cache_ttl_seconds
        self._page_size = page_size
        self._max_pages = max_pages
        self._max_results = page_size * max_pages
        self._minimum_request_interval_seconds = minimum_request_interval_seconds
        self._max_rate_limit_retries = max_rate_limit_retries
        self._maximum_retry_after_seconds = maximum_retry_after_seconds
        self._deadline_monotonic = deadline_monotonic
        self._clock = clock
        self._sleep = sleep
        self._next_request_at = 0.0
        self._request_lock = threading.Lock()
        self._cache: dict[
            tuple[PublicJurisdictionKind, str, int], tuple[float, FloridaForm6Batch]
        ] = {}
        self._cache_lock = threading.Lock()

    def discover(
        self,
        *,
        public_jurisdiction: PublicJurisdiction,
        limit: int = 100,
    ) -> FloridaForm6Batch:
        """Return sworn declarations associated with one resolved public jurisdiction.

        City tokens use the upstream ``office`` filter because the source has no separate
        city field.  No minimum amount is sent, so legitimate negative and zero
        declarations survive.
        """

        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ValueError("limit must be a positive integer")
        requested_limit = min(limit, self._max_results)
        cache_key = (
            public_jurisdiction.kind,
            public_jurisdiction.token.casefold(),
            requested_limit,
        )
        now = self._clock()
        with self._cache_lock:
            cached = self._cache.get(cache_key)
            if cached and cached[0] > now:
                return self._with_cache_hit(cached[1])
            if cached:
                self._cache.pop(cache_key, None)

        try:
            batch = self._fetch(
                public_jurisdiction=public_jurisdiction,
                requested_limit=requested_limit,
            )
        except FloridaForm6SourceError as exc:
            return FloridaForm6Batch(
                outcome=FloridaForm6Outcome.UNAVAILABLE,
                records=(),
                source_status=FloridaForm6SourceStatus(
                    requested_limit=requested_limit,
                    error_code=exc.code,
                ),
            )

        if self._cache_ttl_seconds > 0:
            with self._cache_lock:
                expired = [key for key, cached in self._cache.items() if cached[0] <= now]
                for key in expired:
                    self._cache.pop(key, None)
                if len(self._cache) >= 256:
                    oldest = min(self._cache, key=lambda key: self._cache[key][0])
                    self._cache.pop(oldest, None)
                self._cache[cache_key] = (now + self._cache_ttl_seconds, batch)
        return batch

    @staticmethod
    def _with_cache_hit(batch: FloridaForm6Batch) -> FloridaForm6Batch:
        status = batch.source_status
        return FloridaForm6Batch(
            outcome=batch.outcome,
            records=batch.records,
            source_status=FloridaForm6SourceStatus(**{**status.__dict__, "cache_hit": True}),
        )

    def _fetch(
        self,
        *,
        public_jurisdiction: PublicJurisdiction,
        requested_limit: int,
    ) -> FloridaForm6Batch:
        records: list[FloridaForm6Record] = []
        seen_ids: set[str] = set()
        expected_total: int | None = None
        expected_index: _IndexSnapshot | None = None
        offset = 0
        pages_fetched = 0

        for _ in range(self._max_pages):
            remaining = requested_limit - len(records)
            if remaining <= 0:
                break
            page_limit = min(self._page_size, remaining)
            query_field = (
                "county" if public_jurisdiction.kind is PublicJurisdictionKind.COUNTY else "office"
            )
            params = urlencode(
                {
                    query_field: public_jurisdiction.token,
                    "limit": page_limit,
                    "offset": offset,
                }
            )
            payload = self._get_json_with_rate_limit(f"{self._base_url}/v1/net-worth?{params}")
            page = self._map_page(
                payload,
                public_jurisdiction=public_jurisdiction,
                requested_page_size=page_limit,
            )
            pages_fetched += 1

            if expected_total is None:
                expected_total = page.total
                expected_index = page.index
            elif page.total != expected_total or page.index != expected_index:
                raise FloridaForm6SourceError(
                    "Florida Form 6 source changed during pagination",
                    code="SOURCE_CONTRACT_VIOLATION",
                )

            for record in page.records:
                if record.subject_id not in seen_ids:
                    records.append(record)
                    seen_ids.add(record.subject_id)
            offset += page.returned

            if page.returned == 0:
                if expected_total > offset:
                    raise FloridaForm6SourceError(
                        "Florida Form 6 source pagination ended early",
                        code="SOURCE_CONTRACT_VIOLATION",
                    )
                break
            if offset >= expected_total:
                break

        if expected_total is None or expected_index is None:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned no page",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        if expected_total > 0 and not records:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned no valid declarations",
                code="SOURCE_CONTRACT_VIOLATION",
            )

        truncated = expected_total > len(records) or requested_limit < expected_total
        status = FloridaForm6SourceStatus(
            source_snapshot_id=expected_index.source_snapshot_id,
            source_artifact_sha256=expected_index.source_artifact_sha256,
            source_retrieved_at=expected_index.source_retrieved_at,
            index_built_at=expected_index.built_at,
            index_form_year=expected_index.form_year,
            index_partial=expected_index.partial,
            filings_seen=expected_index.filings_seen,
            declarations_indexed=expected_index.declarations_indexed,
            unreadable_filings=expected_index.unreadable,
            upstream_total=expected_total,
            requested_limit=requested_limit,
            pages_fetched=pages_fetched,
            accepted_record_count=len(records),
            truncated=truncated,
        )
        return FloridaForm6Batch(
            outcome=(FloridaForm6Outcome.OK if records else FloridaForm6Outcome.EMPTY),
            records=tuple(records),
            source_status=status,
        )

    def _check_deadline(self, now: float | None = None) -> float:
        current = self._clock() if now is None else now
        if self._deadline_monotonic is not None and current >= self._deadline_monotonic:
            raise FloridaForm6SourceError(
                "Florida Form 6 refresh deadline was exceeded",
                code="REFRESH_DEADLINE_EXCEEDED",
            )
        return current

    def _sleep_before_request(self, seconds: float) -> None:
        if seconds <= 0:
            return
        current = self._check_deadline()
        if self._deadline_monotonic is not None and current + seconds >= self._deadline_monotonic:
            raise FloridaForm6SourceError(
                "Florida Form 6 refresh deadline would be exceeded",
                code="REFRESH_DEADLINE_EXCEEDED",
            )
        self._sleep(seconds)
        self._check_deadline()

    def _pace_request(self) -> float:
        with self._request_lock:
            current = self._check_deadline()
            self._sleep_before_request(max(0.0, self._next_request_at - current))
            request_started_at = self._check_deadline()
            self._next_request_at = request_started_at + self._minimum_request_interval_seconds
            return request_started_at

    def _request_timeout(self) -> float:
        current = self._check_deadline()
        if self._deadline_monotonic is None:
            return self._timeout_seconds
        remaining = self._deadline_monotonic - current
        if remaining <= 0:
            raise FloridaForm6SourceError(
                "Florida Form 6 refresh deadline was exceeded",
                code="REFRESH_DEADLINE_EXCEEDED",
            )
        return min(self._timeout_seconds, remaining)

    def _retry_delay(self, exc: FloridaForm6SourceError, retry_number: int) -> float:
        retry_after = exc.retry_after_seconds
        if retry_after is None:
            retry_after = max(1.0, self._minimum_request_interval_seconds) * (
                2 ** (retry_number - 1)
            )
        if (
            not math.isfinite(retry_after)
            or retry_after < 0
            or retry_after > self._maximum_retry_after_seconds
        ):
            raise FloridaForm6SourceError(
                "Florida Form 6 Retry-After exceeded the configured bound",
                code="RATE_LIMIT_RETRY_AFTER_EXCEEDED",
            ) from exc
        return retry_after

    def _get_json_with_rate_limit(self, url: str) -> Mapping[str, object]:
        retry_count = 0
        while True:
            self._pace_request()
            try:
                return self._transport.get_json(
                    url,
                    headers={
                        "Authorization": f"Bearer {self._bearer_token}",
                        "Accept": "application/json",
                    },
                    timeout_seconds=self._request_timeout(),
                )
            except FloridaForm6SourceError as exc:
                if exc.code != "SOURCE_RATE_LIMITED" or retry_count >= self._max_rate_limit_retries:
                    raise
                retry_count += 1
                self._sleep_before_request(self._retry_delay(exc, retry_count))
            except (TimeoutError, OSError) as exc:
                raise FloridaForm6SourceError("Florida Form 6 source request failed") from exc

    def _map_page(
        self,
        payload: Mapping[str, object],
        *,
        public_jurisdiction: PublicJurisdiction,
        requested_page_size: int,
    ) -> _MappedPage:
        self._validate_envelope(payload)
        total = _nonnegative_int(payload.get("total"), field="total")
        returned = _nonnegative_int(payload.get("returned"), field="returned")
        people = payload.get("people")
        if (
            not isinstance(people, list)
            or returned != len(people)
            or returned > requested_page_size
        ):
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned an invalid people page",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        if returned > total:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned inconsistent totals",
                code="SOURCE_CONTRACT_VIOLATION",
            )

        index = payload.get("index")
        if not isinstance(index, Mapping) or index.get("built") is not True:
            raise FloridaForm6SourceError(
                "Florida Form 6 source index is not built",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        if not isinstance(index.get("partial"), bool):
            raise FloridaForm6SourceError(
                "Florida Form 6 source omitted partial-index state",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        built_at = _public_text(index.get("builtAt"), field="index.builtAt", maximum=64)
        try:
            parsed_built_at = datetime.fromisoformat(built_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned invalid index.builtAt",
                code="SOURCE_CONTRACT_VIOLATION",
            ) from exc
        if parsed_built_at.tzinfo is None:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned timezone-free index.builtAt",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        if parsed_built_at > datetime.now(UTC) + timedelta(minutes=5):
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned future index.builtAt",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        source_snapshot_id = _public_text(
            index.get("sourceSnapshotId"), field="index.sourceSnapshotId", maximum=200
        )
        source_artifact_sha256 = _public_text(
            index.get("sourceArtifactSha256"),
            field="index.sourceArtifactSha256",
            maximum=64,
        )
        if _SHA256.fullmatch(source_artifact_sha256) is None:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned invalid index.sourceArtifactSha256",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        source_retrieved_at = _public_text(
            index.get("sourceRetrievedAt"), field="index.sourceRetrievedAt", maximum=64
        )
        try:
            parsed_retrieved_at = datetime.fromisoformat(source_retrieved_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned invalid index.sourceRetrievedAt",
                code="SOURCE_CONTRACT_VIOLATION",
            ) from exc
        if parsed_retrieved_at.tzinfo is None or parsed_retrieved_at > datetime.now(
            UTC
        ) + timedelta(minutes=5):
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned invalid index.sourceRetrievedAt",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        if parsed_retrieved_at < parsed_built_at - timedelta(days=1):
            raise FloridaForm6SourceError(
                "Florida Form 6 source retrieval predates its index build",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        form_year = _nonnegative_int(index.get("formYear"), field="index.formYear")
        if not 2000 <= form_year <= datetime.now(UTC).year:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned invalid form year",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        filings_seen = _nonnegative_int(index.get("filingsSeen"), field="index.filingsSeen")
        with_net_worth = _nonnegative_int(index.get("withNetWorth"), field="index.withNetWorth")
        unreadable = _nonnegative_int(index.get("unreadable"), field="index.unreadable")
        if with_net_worth > filings_seen or unreadable > filings_seen:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned impossible index counts",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        snapshot = _IndexSnapshot(
            source_snapshot_id=source_snapshot_id,
            source_artifact_sha256=source_artifact_sha256,
            source_retrieved_at=source_retrieved_at,
            built_at=built_at,
            form_year=form_year,
            partial=cast(bool, index["partial"]),
            filings_seen=filings_seen,
            declarations_indexed=with_net_worth,
            unreadable=unreadable,
        )

        mapped: list[FloridaForm6Record] = []
        for raw in people:
            if not isinstance(raw, Mapping):
                raise FloridaForm6SourceError(
                    "Florida Form 6 source returned a non-object record",
                    code="SOURCE_CONTRACT_VIOLATION",
                )
            mapped.append(
                self._map_record(
                    cast(Mapping[str, object], raw),
                    public_jurisdiction=public_jurisdiction,
                )
            )
        if any(record.form_year != form_year for record in mapped):
            raise FloridaForm6SourceError(
                "Florida Form 6 record year did not match the index",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        return _MappedPage(records=tuple(mapped), total=total, returned=returned, index=snapshot)

    @staticmethod
    def _validate_envelope(payload: Mapping[str, object]) -> None:
        if payload.get("ok") is not True:
            raise FloridaForm6SourceError("Florida Form 6 source returned unsuccessful payload")
        coverage = payload.get("coverage")
        disclosure = payload.get("disclosure")
        if (
            not isinstance(coverage, str)
            or "exact sworn net worth" not in coverage.casefold()
            or not isinstance(disclosure, str)
            or "bounded page-one sworn net-worth field" not in disclosure.casefold()
            or "raw filings" not in disclosure.casefold()
            or "asset, liability, and income schedules" not in disclosure.casefold()
            or "not retained or emitted" not in disclosure.casefold()
        ):
            raise FloridaForm6SourceError(
                "Florida Form 6 source did not confirm whole-declaration scope",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        attribution = payload.get("attribution")
        if not isinstance(attribution, Mapping):
            raise FloridaForm6SourceError(
                "Florida Form 6 source omitted attribution",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        source = attribution.get("source")
        source_url = attribution.get("sourceUrl")
        if (
            not isinstance(source, str)
            or not source.startswith("Florida Commission on Ethics")
            or source_url != _OFFICIAL_SEARCH_URL
        ):
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned invalid attribution",
                code="SOURCE_CONTRACT_VIOLATION",
            )

    @staticmethod
    def _map_record(
        raw: Mapping[str, object],
        *,
        public_jurisdiction: PublicJurisdiction,
    ) -> FloridaForm6Record:
        name = _public_text(raw.get("name"), field="name", maximum=200)
        amount = _parse_declared_net_worth(raw.get("netWorth"))
        form_year = _nonnegative_int(raw.get("formYear"), field="formYear")
        if not 2000 <= form_year <= 2100:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned invalid formYear",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        filing_url, filing_id = _filing_id(raw.get("filingUrl"))

        raw_offices = raw.get("offices")
        if not isinstance(raw_offices, list):
            raise FloridaForm6SourceError(
                "Florida Form 6 source omitted public offices",
                code="SOURCE_CONTRACT_VIOLATION",
            )
        offices: list[str] = []
        for raw_office in raw_offices:
            office = _public_text(raw_office, field="public office", maximum=200)
            if _STREET_ADDRESS.search(office) or "@" in office:
                raise FloridaForm6SourceError(
                    "Florida Form 6 source returned a non-public office value",
                    code="SOURCE_CONTRACT_VIOLATION",
                )
            if office not in offices:
                offices.append(office)
        if not offices:
            raise FloridaForm6SourceError(
                "Florida Form 6 source returned no public office",
                code="SOURCE_CONTRACT_VIOLATION",
            )

        if public_jurisdiction.kind is PublicJurisdictionKind.COUNTY:
            county = _public_text(raw.get("county"), field="public county", maximum=120)
            associated = _contains_token(county, public_jurisdiction.token)
        else:
            associated = any(
                _contains_token(office, public_jurisdiction.token) for office in offices
            )
        if not associated:
            raise FloridaForm6SourceError(
                "Florida Form 6 record did not match the requested public jurisdiction",
                code="SOURCE_CONTRACT_VIOLATION",
            )

        provenance = FloridaForm6Provenance(
            source_id="florida_form_6",
            source_authority="Florida Commission on Ethics",
            source_url=_OFFICIAL_SEARCH_URL,
            filing_url=filing_url,
            declaration_scope="SWORN_WHOLE_DECLARED_NET_WORTH",
        )
        return FloridaForm6Record(
            subject_id=f"florida-form6:{filing_id}",
            name=name,
            declared_net_worth_usd=amount,
            public_offices=tuple(offices),
            public_jurisdiction=public_jurisdiction,
            form_year=form_year,
            filing_url=filing_url,
            provenance=provenance,
        )
