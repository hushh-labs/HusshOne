from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import Counter
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from typing import Annotated, Literal, Protocol

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.bootstrap_data import BOOTSTRAP_CANDIDATES, BOOTSTRAP_METADATA
from app.collectors.registry import SourceOperation, SourceRegistry
from app.consumer_access import (
    AccessPolicyError,
    AccessRequest,
    AuditOutcome,
    AuditRequestId,
    AuthenticatedConsumer,
    ConsumerAccessRegistry,
    CoordinateConsent,
    CoordinateConsentVerifier,
    LocationMode,
    build_access_audit_event,
    build_denied_access_audit_event,
    generate_audit_request_id,
)
from app.coordinate_consent import (
    GcsConsentReceiptConsumer,
    SignedCoordinateConsentVerifier,
    issue_coordinate_consent_receipt,
)
from app.coverage import QueryResolution, resolve_coordinate_query, resolve_postal_query
from app.financial_context import public_financial_context_policy
from app.geospatial import haversine_km
from app.jurisdiction import get_public_jurisdiction_index
from app.market_release import BootstrapMetadata, get_market_release
from app.national_nppes import NationalNppesResult, NppesCandidateProvider
from app.national_sec import (
    NationalSecBatch,
    NationalSecProfessionalAdapter,
    NationalSecSourceError,
)
from app.nearby import discover_nearby_people
from app.nearby_policy import NearbyPolicyEngine
from app.net_worth import (
    NET_WORTH_MODEL_VERSION,
    NWS_SCALE_VERSION,
    BalanceSheetCoverage,
    ComponentKind,
    CoverageState,
    EstimateBasis,
    EstimateStatus,
    EvidenceDatePrecision,
    NetWorthEngine,
    NetWorthResult,
    NetWorthSubject,
    ProfileBasis,
)
from app.net_worth_v4 import (
    CoordinateConsentIssueRequest,
    CoordinateConsentReceipt,
    NetWorthV4ProjectionError,
    NetWorthV4Request,
    NetWorthV4Response,
    project_nearby_net_worth_v4,
)
from app.nws import COMPONENT_LABELS, GLOBAL_NWS_WEIGHTS
from app.nws_models import (
    NearbyCandidate,
    NearbyDiscoverySummary,
    NearbyRankedPerson,
    ProfessionalLane,
    ProfileClass,
)
from app.organization_discovery import (
    get_organization_anchor_release,
    public_association_context,
    validate_anchor_coverage,
)
from app.postal import get_us_postal_index, normalize_us_postal_code
from app.security import AccessContext, consumer_rate_limiter, require_api_access
from app.settings import get_settings
from app.snapshots.contracts import (
    PublishedNetWorthProfile,
    PublishedNetWorthSnapshot,
    SnapshotRepositoryStatus,
)
from app.snapshots.gcs_store import SnapshotGcsStore
from app.snapshots.repository import NetWorthSnapshotRepository, SnapshotUnavailableError
from app.us_boundary import get_us_boundary_index

logger = logging.getLogger("nws_nearby_intelligence")
_V4_ROUTE = "/v4/net-worth/discover"
_V4_CONSENT_ROUTE = "/v4/location-consent/receipt"


class PayloadSizeLimitMiddleware:
    """Bound the actual ASGI body even when Content-Length is absent or dishonest."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = get_settings().max_request_bytes
        chunks: list[bytes] = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                await self.app(scope, receive, send)
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > limit:
                response = JSONResponse(
                    status_code=413,
                    content={
                        "detail": {
                            "code": "REQUEST_TOO_LARGE",
                            "message": "Request exceeds the size limit.",
                        }
                    },
                )
                await response(scope, receive, send)
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break

        body = b"".join(chunks)
        delivered = False

        async def replay_receive() -> dict[str, object]:
            nonlocal delivered
            if delivered:
                return {"type": "http.disconnect"}
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay_receive, send)  # type: ignore[arg-type]


class RequestSafetyMiddleware(BaseHTTPMiddleware):
    """Reject oversized bodies and log only route/status/latency—not request payloads."""

    async def dispatch(self, request: Request, call_next):  # type: ignore[no-untyped-def]
        settings = get_settings()
        # Caller correlation headers are untrusted and may accidentally contain
        # credentials or personal data.  Never echo or log them; every request
        # gets a server-minted opaque identifier.
        audit_request_id = generate_audit_request_id()
        request_id = audit_request_id.value
        request.state.request_id = request_id
        request.state.audit_request_id = audit_request_id
        started = time.perf_counter()
        response: Response | None = None
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > settings.max_request_bytes:
                    response = Response(
                        status_code=413,
                        content=json.dumps(
                            {
                                "detail": {
                                    "code": "REQUEST_TOO_LARGE",
                                    "message": "Request exceeds the size limit.",
                                }
                            }
                        ),
                        media_type="application/json",
                    )
            except ValueError:
                response = Response(
                    status_code=400,
                    content=json.dumps(
                        {
                            "detail": {
                                "code": "INVALID_CONTENT_LENGTH",
                                "message": "Invalid Content-Length header.",
                            }
                        }
                    ),
                    media_type="application/json",
                )

        if response is None:
            try:
                response = await call_next(request)
            except Exception:
                # Keep unexpected failures opaque while preserving the same
                # server-minted correlation ID and security headers as every
                # other response. Route-level accountability logging occurs
                # before a v4 error is re-raised.
                logger.error(
                    "request_failed request_id=%s method=%s path=%s",
                    request_id,
                    request.method,
                    request.url.path,
                )
                response = JSONResponse(
                    status_code=500,
                    content={
                        "detail": {
                            "code": "INTERNAL_ERROR",
                            "message": "The request could not be completed.",
                        }
                    },
                )
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Request-ID"] = request_id
        if hasattr(request.state, "rate_limit_remaining"):
            response.headers["X-RateLimit-Limit"] = str(
                getattr(
                    request.state,
                    "rate_limit_limit",
                    settings.rate_limit_per_minute,
                )
            )
            response.headers["X-RateLimit-Remaining"] = str(request.state.rate_limit_remaining)
            response.headers["X-RateLimit-Reset"] = str(request.state.rate_limit_reset_seconds)
        logger.info(
            "request_complete request_id=%s method=%s path=%s status=%s duration_ms=%s",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
        )
        return response


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    release = get_market_release()
    if release.model_version != settings.model_version:
        raise RuntimeError("Market release model version does not match service settings")
    anchor_release = get_organization_anchor_release()
    validate_anchor_coverage(
        anchor_release,
        market_id=release.market_id,
        organization_ids=(candidate.organization_id for candidate in BOOTSTRAP_CANDIDATES),
    )
    if settings.form6_source_enabled:
        repository = _net_worth_snapshot_repository()
        assert repository is not None
        try:
            repository.load_active(force=True)
        except SnapshotUnavailableError as exc:
            # Keep diagnostics reachable while every financial query and readiness probe
            # remains fail closed until a reviewed snapshot can be loaded.
            logger.error("net_worth_snapshot_preload_failed code=%s", exc.code)
    if settings.v4_enabled:
        # A malformed, unpinned, expired-only, or otherwise invalid registry is a
        # startup failure.  The v4 route never falls back to the shared legacy key.
        _consumer_access_registry()
    logger.info(
        "service_started environment=%s data_mode=%s candidate_count=%s",
        settings.environment,
        settings.data_mode,
        len(BOOTSTRAP_CANDIDATES),
    )
    yield


settings = get_settings()
app = FastAPI(
    title="NWS Nearby Intelligence API",
    version=settings.service_version,
    description=(
        "A privacy-safe API for discovering verified public or opted-in professionals through "
        "public institutional, civic, or professional associations. It never returns private "
        "residential locations or claims someone is physically near a query point."
    ),
    docs_url="/docs",
    redoc_url=None,
    openapi_url="/openapi.json",
    lifespan=lifespan,
)
app.add_middleware(PayloadSizeLimitMiddleware)
app.add_middleware(RequestSafetyMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-NWS-API-Key", "X-Request-ID"],
    expose_headers=[
        "Retry-After",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
        "X-Request-ID",
    ],
    max_age=600,
)


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    """Keep useful validation details without reflecting submitted values."""

    errors = [
        {key: value for key, value in error.items() if key in {"type", "loc", "msg"}}
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": errors})


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class HealthResponse(StrictModel):
    status: Literal["ok"]
    service: Literal["nws-nearby-intelligence"]
    version: str
    data_mode: str


class ReadyResponse(HealthResponse):
    candidate_count: int
    geography_record_count: int
    public_jurisdiction_record_count: int
    national_sources_enabled: bool
    form6_source_enabled: bool
    complete: Literal[False]
    model_version: str
    net_worth_model_version: str
    nws_scale_version: str
    net_worth_snapshot_id: str | None
    net_worth_snapshot_sha256: str | None
    net_worth_snapshot_generated_at: str | None
    v4_enabled: bool
    consumer_registry_version: int | None
    consumer_count: int


class QueryLocationInput(StrictModel):
    postal_code: str | None = Field(
        default=None,
        min_length=3,
        max_length=16,
        pattern=r"^[A-Z0-9][A-Z0-9 -]*[A-Z0-9]$",
    )
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    latitude: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    longitude: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)

    @field_validator("postal_code", "country_code", mode="before")
    @classmethod
    def normalize_location_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @model_validator(mode="after")
    def validate_location(self) -> QueryLocationInput:
        has_coordinates = self.latitude is not None or self.longitude is not None
        has_postal_code = self.postal_code is not None
        if has_coordinates and (self.latitude is None or self.longitude is None):
            raise ValueError("latitude and longitude must be supplied together")
        if not has_postal_code and not has_coordinates:
            raise ValueError("provide either postal_code or latitude/longitude")
        if has_postal_code and has_coordinates:
            raise ValueError("provide postal_code or latitude/longitude, not both")
        if has_postal_code and self.country_code in {None, "US"}:
            try:
                normalize_us_postal_code(self.postal_code or "")
            except ValueError as exc:
                raise ValueError("US postal_code must be five digits or ZIP+4") from exc
        return self


class NearbyFiltersInput(StrictModel):
    lanes: list[ProfessionalLane] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list, max_length=20)
    minimum_confidence_grade: Literal["A", "B", "C", "D"] = "B"

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, tags: list[str]) -> list[str]:
        """Keep tag filtering bounded, deterministic, and free of empty selectors."""

        normalized: list[str] = []
        seen: set[str] = set()
        for tag in tags:
            compact = " ".join(tag.strip().split()).casefold()
            if not compact:
                raise ValueError("filter tags cannot be empty")
            if len(compact) > 64:
                raise ValueError("filter tags cannot exceed 64 characters")
            if compact not in seen:
                normalized.append(compact)
                seen.add(compact)
        return normalized


class NearbyDiscoveryRequest(StrictModel):
    query: QueryLocationInput
    top_n: int = Field(default=100, ge=1, le=400)
    initial_radius_km: float = Field(
        default=20,
        gt=0,
        le=250,
        allow_inf_nan=False,
    )
    max_radius_km: float = Field(
        default=100,
        gt=0,
        le=500,
        allow_inf_nan=False,
    )
    auto_expand: bool = True
    diversity: bool = True
    filters: NearbyFiltersInput = Field(default_factory=NearbyFiltersInput)

    @model_validator(mode="after")
    def validate_radius(self) -> NearbyDiscoveryRequest:
        if self.max_radius_km < self.initial_radius_km:
            raise ValueError("max_radius_km must be >= initial_radius_km")
        return self


class NetWorthQueryLocationInput(QueryLocationInput):
    """Strict v3 location form without changing the published v2 coercion contract."""

    latitude: float | None = Field(
        default=None,
        ge=-90,
        le=90,
        strict=True,
        allow_inf_nan=False,
    )
    longitude: float | None = Field(
        default=None,
        ge=-180,
        le=180,
        strict=True,
        allow_inf_nan=False,
    )


class NearbyNetWorthRequest(StrictModel):
    """A net-worth query has no professional-score filters or diversification knobs."""

    query: NetWorthQueryLocationInput
    top_n: int = Field(default=100, ge=1, le=200, strict=True)
    initial_radius_km: float = Field(
        default=20,
        gt=0,
        le=250,
        strict=True,
        allow_inf_nan=False,
    )
    max_radius_km: float = Field(
        default=100,
        gt=0,
        le=500,
        strict=True,
        allow_inf_nan=False,
    )
    auto_expand: bool = Field(default=True, strict=True)

    @model_validator(mode="after")
    def validate_radius(self) -> NearbyNetWorthRequest:
        if self.max_radius_km < self.initial_radius_km:
            raise ValueError("max_radius_km must be >= initial_radius_km")
        return self


class NetWorthQueryResponse(StrictModel):
    label: str
    mode: Literal["POSTAL_CODE", "COARSE_COORDINATE"]
    postal_code: str | None = None
    country_code: str | None = None
    approximate: bool


class NetWorthCoverageResponse(StrictModel):
    status: Literal["COVERED", "NOT_COVERED", "LOCATION_UNRESOLVED"]
    reason_code: str
    market_label: str | None = None
    country_code: str | None = None
    complete: Literal[False]
    message: str


class NetWorthSnapshotResponse(StrictModel):
    score_kind: Literal["NET_WORTH_SCORE"]
    scale_version: str
    model_version: str
    complete: Literal[False]
    as_of: str
    semantics: str


class NetWorthFinancialCoverageResponse(StrictModel):
    status: Literal[
        "AVAILABLE",
        "PARTIAL",
        "FINANCIAL_COVERAGE_INSUFFICIENT",
        "NOT_SEARCHED",
    ]
    candidate_count: int = Field(ge=0)
    discovered_count: int = Field(ge=0)
    evaluated_count: int = Field(ge=0)
    unevaluated_count: int = Field(ge=0)
    scored_count: int = Field(ge=0)
    insufficient_evidence_count: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_counts(self) -> NetWorthFinancialCoverageResponse:
        if self.candidate_count != self.discovered_count:
            raise ValueError("candidate_count must equal discovered_count")
        if self.discovered_count != self.evaluated_count + self.unevaluated_count:
            raise ValueError("discovered_count must equal evaluated plus unevaluated")
        if self.evaluated_count != self.scored_count + self.insufficient_evidence_count:
            raise ValueError("evaluated_count must equal scored plus insufficient")
        return self


class NetWorthResultSetResponse(StrictModel):
    status: Literal["TARGET_MET", "PARTIAL", "EMPTY", "NOT_SEARCHED"]
    requested_count: int = Field(ge=0)
    returned_count: int = Field(ge=0)
    shortfall_count: int = Field(ge=0)
    target_satisfied: bool
    reasons: list[str]


class NetWorthSearchResponse(StrictModel):
    performed: bool
    scope: Literal["NOT_SEARCHED", "ASSOCIATION_RADIUS", "PUBLIC_JURISDICTION"]
    expanded: bool
    expansion_steps_km: list[float]
    initial_radius_km: float = Field(ge=0)
    effective_radius_km: float = Field(ge=0)
    maximum_radius_km: float = Field(ge=0)
    maximum_radius_reached: bool


class NetWorthSourceStatusResponse(StrictModel):
    source: str
    purpose: Literal["CANDIDATE_DISCOVERY", "FINANCIAL_EVIDENCE"]
    status: Literal["OK", "EMPTY", "UNAVAILABLE", "NOT_QUERIED"]
    as_of: str | None = None
    reason_code: str | None = None


class NetWorthPersonResponse(StrictModel):
    id: str
    name: str
    headline: str
    organization: str | None = None


class NetWorthDistributionResponse(StrictModel):
    status: Literal["AVAILABLE", "PARTIAL_ESTIMATE"]
    currency: Literal["USD"]
    p10_usd: int
    median_usd: int
    p90_usd: int
    method: Literal["MONTE_CARLO", "DECLARED_TOTAL_SIMULATION"]
    as_of: str = Field(pattern=r"^\d{4}(?:-\d{2}-\d{2})?$")


class NetWorthScoreResponse(StrictModel):
    status: Literal["AVAILABLE"]
    value: int = Field(ge=0, le=100)
    scale_version: str


class NetWorthConfidenceResponse(StrictModel):
    score: float = Field(ge=0, le=1)
    grade: Literal["A", "B", "C", "D", "E"]
    coverage: float = Field(ge=0, le=1)


class NetWorthComponentResponse(StrictModel):
    status: Literal[
        "SUPPORTED",
        "MODELED_RANGE",
        "INCLUDED_IN_DECLARED_TOTAL",
        "UNKNOWN",
        "NOT_PROVIDED",
        "NOT_APPLICABLE",
    ]
    low_usd: int | None = None
    most_likely_usd: int | None = None
    high_usd: int | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)


class NetWorthComponentsResponse(StrictModel):
    cash_and_near_cash: NetWorthComponentResponse
    public_securities: NetWorthComponentResponse
    private_business_equity: NetWorthComponentResponse
    real_estate_equity: NetWorthComponentResponse
    other_assets: NetWorthComponentResponse
    liabilities: NetWorthComponentResponse


class NetWorthLiquidWealthResponse(StrictModel):
    status: Literal["AVAILABLE", "UNKNOWN"]
    currency: Literal["USD"]
    p10_usd: int | None = None
    median_usd: int | None = None
    p90_usd: int | None = None


class NetWorthLocationRelationshipResponse(StrictModel):
    label: str
    association_kind: str
    granularity: str
    approximate_distance_band: str
    note: str


class NetWorthCitationResponse(StrictModel):
    publisher: str
    title: str
    url: str
    fact_types: list[str]
    source_date: str = Field(pattern=r"^\d{4}(?:-\d{2}-\d{2})?$")
    retrieved_at: str


class NearbyNetWorthResultResponse(StrictModel):
    rank: int = Field(ge=1)
    person: NetWorthPersonResponse
    profile_status: Literal["VERIFIED", "PARTIALLY_OBSERVABLE"]
    estimated_net_worth: NetWorthDistributionResponse
    nws: NetWorthScoreResponse
    confidence: NetWorthConfidenceResponse
    components: NetWorthComponentsResponse
    liquid_wealth: NetWorthLiquidWealthResponse
    liquidity_score: int | None = Field(default=None, ge=0, le=100)
    location_relationship: NetWorthLocationRelationshipResponse
    last_financial_update: str = Field(pattern=r"^\d{4}(?:-\d{2}-\d{2})?$")
    financial_update_precision: Literal["DAY", "YEAR"]
    sources: list[NetWorthCitationResponse] = Field(min_length=1, max_length=20)


class NearbyNetWorthResponse(StrictModel):
    query: NetWorthQueryResponse
    coverage: NetWorthCoverageResponse
    snapshot: NetWorthSnapshotResponse
    financial_coverage: NetWorthFinancialCoverageResponse
    result_set: NetWorthResultSetResponse
    search: NetWorthSearchResponse
    source_status: list[NetWorthSourceStatusResponse]
    generated_at: str
    results: list[NearbyNetWorthResultResponse]


_CONFIDENCE_THRESHOLDS = {"A": 0.85, "B": 0.70, "C": 0.55, "D": 0.0}
_KIRKLAND_BACKEND = "reviewed-public-association-release"
_NATIONAL_BACKEND = "national-public-association-index"
_MAX_NPPES_EXPANSION_ATTEMPTS = 2
_NPPES_EXPANSION_BUDGET_SECONDS = 12.0
_COORDINATE_JURISDICTION_ZCTA_MAX_KM = 10.0
_PROFESSIONAL_SCORE_KIND = "PROFESSIONAL_NETWORK_PROVISIONAL"
_DISTANCE_BANDS: tuple[tuple[str, float | None], ...] = (
    ("within 2 km", 2.0),
    ("2–5 km", 5.0),
    ("5–10 km", 10.0),
    ("10–25 km", 25.0),
    ("25–50 km", 50.0),
    ("50–100 km", 100.0),
    ("100–250 km", 250.0),
    ("250–500 km", None),
)


@dataclass(frozen=True)
class NationalCandidateBatch:
    candidates: tuple[NearbyCandidate, ...]
    metadata: dict[str, BootstrapMetadata]
    source_status: tuple[dict[str, object], ...]


@dataclass(frozen=True)
class NetWorthCandidatePool:
    candidates: tuple[NearbyCandidate, ...]
    source_status: tuple[dict[str, object], ...]
    expansion_steps_km: tuple[float, ...]
    effective_radius_km: float


class NearbyNetWorthProvider(Protocol):
    """Financial-ledger boundary; candidate discovery never manufactures a ledger."""

    def estimate(self, candidate: NearbyCandidate, *, as_of_date: date) -> NetWorthResult: ...

    def source_status(self) -> dict[str, object]: ...


class FailClosedNetWorthProvider:
    """Default until an approved, attributable asset-and-liability provider is wired."""

    def __init__(self) -> None:
        self._engine = NetWorthEngine()

    def estimate(self, candidate: NearbyCandidate, *, as_of_date: date) -> NetWorthResult:
        profile_basis = (
            ProfileBasis.OPTED_IN_VERIFIED
            if candidate.profile_class is ProfileClass.OPTED_IN
            else ProfileBasis.VERIFIED_PUBLIC_FINANCIAL_PROFILE
        )
        return self._engine.estimate(
            subject=NetWorthSubject(candidate.person_id, profile_basis),
            components=(),
            coverage=BalanceSheetCoverage(),
            as_of_date=as_of_date,
        )

    def source_status(self) -> dict[str, object]:
        return {
            "source": "NET_WORTH_LEDGER",
            "purpose": "FINANCIAL_EVIDENCE",
            "status": "EMPTY",
            "as_of": None,
            "reason_code": "NO_ELIGIBLE_FINANCIAL_LEDGER_CONFIGURED",
        }


@lru_cache(maxsize=1)
def _net_worth_provider() -> NearbyNetWorthProvider:
    return FailClosedNetWorthProvider()


@lru_cache(maxsize=1)
def _net_worth_source_registry() -> SourceRegistry:
    source_settings = get_settings()
    return SourceRegistry.from_verified_yaml(
        source_settings.source_registry_path,
        source_settings.source_registry_manifest_path,
        expected_registry_sha256=source_settings.source_registry_sha256,
        expected_registry_version=source_settings.source_registry_version,
    )


@lru_cache(maxsize=1)
def _consumer_access_registry() -> ConsumerAccessRegistry:
    consumer_settings = get_settings()
    if not consumer_settings.v4_enabled:
        raise RuntimeError("v4 consumer access is disabled")
    return ConsumerAccessRegistry.from_json_bytes(
        consumer_settings.consumer_registry_json.encode("utf-8"),
        expected_sha256=consumer_settings.consumer_registry_sha256,
    )


@lru_cache(maxsize=1)
def _consent_receipt_consumer() -> GcsConsentReceiptConsumer:
    bucket = get_settings().consent_receipt_bucket
    if not bucket:
        raise RuntimeError("coordinate consent receipt storage is not configured")
    return GcsConsentReceiptConsumer(
        store=SnapshotGcsStore(
            bucket=bucket,
            timeout_seconds=3,
            maximum_object_bytes=1_024,
        )
    )


def _validate_net_worth_snapshot_source(snapshot: PublishedNetWorthSnapshot) -> None:
    binding = _net_worth_source_registry().bind_reviewed_snapshot(
        snapshot.source.source_contract_id,
        snapshot_id=snapshot.source.source_snapshot_id,
        snapshot_sha256=snapshot.source.source_artifact_sha256,
        operation=SourceOperation.QUERY,
        purpose="FINANCIAL_EVIDENCE",
        product="NET_WORTH_V3",
    )
    if (
        snapshot.source_registry_id != binding.registry_id
        or snapshot.source_registry_version != binding.registry_version
        or snapshot.source_registry_sha256 != binding.registry_sha256
        or snapshot.model_version != NET_WORTH_MODEL_VERSION
        or snapshot.scale_version != NWS_SCALE_VERSION
    ):
        raise ValueError("snapshot release pins do not match the reviewed query contract")


@lru_cache(maxsize=1)
def _net_worth_snapshot_repository() -> NetWorthSnapshotRepository | None:
    source_settings = get_settings()
    if not source_settings.form6_source_enabled:
        return None
    return NetWorthSnapshotRepository(
        store=SnapshotGcsStore(bucket=source_settings.snapshot_bucket),
        prefix=source_settings.snapshot_prefix,
        expected_registry_sha256=source_settings.source_registry_sha256,
        max_age=timedelta(hours=source_settings.snapshot_max_age_hours),
        max_source_age=timedelta(hours=source_settings.snapshot_max_source_age_hours),
        validate_source_binding=_validate_net_worth_snapshot_source,
    )


@lru_cache(maxsize=1)
def _sec_provider() -> NationalSecProfessionalAdapter:
    source_settings = get_settings()
    _net_worth_source_registry().authorize_source_use(
        "sec_section16_professional_associations",
        operation=SourceOperation.QUERY,
        purpose="CANDIDATE_DISCOVERY",
        product="NWS_CANDIDATE_QUERY_V1",
    )
    return NationalSecProfessionalAdapter(
        base_url=source_settings.sec_api_base_url,
        bearer_token=source_settings.sec_api_key,
        timeout_seconds=source_settings.sec_timeout_seconds,
        location_decimals=source_settings.query_location_decimals,
    )


@lru_cache(maxsize=1)
def _nppes_provider() -> NppesCandidateProvider:
    source_settings = get_settings()
    _net_worth_source_registry().authorize_source_use(
        "cms_nppes_public_professionals",
        operation=SourceOperation.QUERY,
        purpose="CANDIDATE_DISCOVERY",
        product="NWS_CANDIDATE_QUERY_V1",
    )
    from psycopg.conninfo import make_conninfo

    return NppesCandidateProvider(
        database_url=make_conninfo(
            host=source_settings.nppes_db_host,
            port=source_settings.nppes_db_port,
            dbname=source_settings.nppes_db_name,
            user=source_settings.nppes_db_user,
            password=source_settings.nppes_db_password,
        ),
        statement_timeout_ms=source_settings.nppes_statement_timeout_ms,
        connect_timeout_seconds=2,
    )


def _nppes_expansion_radii(*, initial_radius_km: float, max_radius_km: float) -> tuple[float, ...]:
    """Use the same bounded radius progression as the public ranking path."""

    radius = initial_radius_km
    radii = [radius]
    while radius < max_radius_km:
        expanded = min(max_radius_km, radius * 1.75)
        if expanded == radius:
            break
        radii.append(expanded)
        radius = expanded
    if len(radii) <= _MAX_NPPES_EXPANSION_ATTEMPTS:
        return tuple(radii)
    # Preserve early local expansion and always retain the caller's maximum radius.
    return tuple([*radii[: _MAX_NPPES_EXPANSION_ATTEMPTS - 1], max_radius_km])


def _merge_nppes_results(
    results: list[NationalNppesResult],
    *,
    postal_code: str,
    requested_target: int,
    expansion_radii_km: list[float],
    eligible_candidate: Callable[[NearbyCandidate], bool],
    fallback_skipped_reason: str | None = None,
) -> NationalNppesResult:
    """Keep exact-ZIP candidates first and summarize every safe retrieval stage."""

    unique: dict[str, NearbyCandidate] = {}
    metadata: dict[str, BootstrapMetadata] = {}
    stages: list[dict[str, object]] = []
    source_as_of: list[str] = []
    queried_at: list[str] = []
    rows_received = 0
    rows_rejected = 0
    any_truncated = False
    successful_stage = False
    unavailable_stage = False

    for index, result in enumerate(results):
        stage = dict(result.source_status)
        stage["sequence"] = index + 1
        if index:
            stage["radius_km"] = round(expansion_radii_km[index - 1], 3)
        stages.append(stage)

        stage_status = str(stage.get("status", "UNAVAILABLE"))
        successful_stage = successful_stage or stage_status in {"OK", "EMPTY"}
        unavailable_stage = unavailable_stage or stage_status == "UNAVAILABLE"
        if isinstance(stage.get("source_as_of"), str):
            source_as_of.append(str(stage["source_as_of"]))
        if isinstance(stage.get("queried_at"), str):
            queried_at.append(str(stage["queried_at"]))
        stage_rows_received = stage.get("rows_received")
        stage_rows_rejected = stage.get("rows_rejected")
        if isinstance(stage_rows_received, int):
            rows_received += stage_rows_received
        if isinstance(stage_rows_rejected, int):
            rows_rejected += stage_rows_rejected
        any_truncated = any_truncated or bool(stage.get("truncated", False))

        for candidate in result.candidates:
            if candidate.person_id in unique:
                continue
            unique[candidate.person_id] = candidate
            candidate_metadata = result.metadata.get(candidate.person_id)
            if candidate_metadata is not None:
                metadata[candidate.person_id] = candidate_metadata

    exact_count = len(results[0].candidates)
    candidate_count = len(unique)
    target_eligible_candidate_count = sum(
        eligible_candidate(candidate) for candidate in unique.values()
    )
    fallback_triggered = bool(expansion_radii_km)
    aggregate_status = "OK" if candidate_count else "EMPTY" if successful_stage else "UNAVAILABLE"
    source_status: dict[str, object] = {
        "source": "CMS_NPPES",
        "status": aggregate_status,
        "scope": "US_ACTIVE_INDIVIDUAL_HEALTHCARE_PROFESSIONALS",
        "query_mode": ("POSTAL_THEN_RADIUS_EXPANSION" if fallback_triggered else "POSTAL_CODE"),
        "postal_code": postal_code,
        "candidate_count": candidate_count,
        "exact_postal_candidate_count": exact_count,
        "fallback_candidate_count": max(0, candidate_count - exact_count),
        "requested_candidate_target": requested_target,
        "target_eligible_candidate_count": target_eligible_candidate_count,
        "target_satisfied": target_eligible_candidate_count >= requested_target,
        "fallback_triggered": fallback_triggered,
        "expansion_radii_km": [round(radius, 3) for radius in expansion_radii_km],
        "rows_received": rows_received,
        "rows_rejected": rows_rejected,
        "source_as_of": max(source_as_of) if source_as_of else None,
        "queried_at": max(queried_at) if queried_at else None,
        "truncated": any_truncated,
        "location_granularity": "POSTAL_AREA",
        "score_status": "PROVISIONAL",
        "association_notice": (
            "Location is a public practice postal-area association, not a residence or "
            "claim of physical presence. Address and contact fields are excluded."
        ),
        "stages": stages,
    }
    if fallback_triggered:
        source_status["fallback_reason"] = "EXACT_POSTAL_BELOW_TARGET"
    elif fallback_skipped_reason is not None:
        source_status["fallback_skipped_reason"] = fallback_skipped_reason
    if unavailable_stage and successful_stage:
        source_status["degraded"] = True
    if aggregate_status == "UNAVAILABLE":
        source_status["error_code"] = "NPPES_QUERY_FAILED"

    return NationalNppesResult(tuple(unique.values()), metadata, source_status)


def _fetch_nppes_candidates(
    *,
    provider: NppesCandidateProvider,
    resolution: QueryResolution,
    request: NearbyDiscoveryRequest,
    candidate_limit: int,
    exhaust_radius: bool = False,
) -> NationalNppesResult:
    """Fetch NPPES with exact-ZIP priority and bounded sparse-ZIP expansion."""

    assert resolution.point is not None
    if resolution.query.get("mode") != "POSTAL_CODE":
        return provider.fetch(
            query_point=resolution.point,
            radius_km=request.max_radius_km,
            limit=candidate_limit,
        )

    postal_code = str(resolution.query["postal_code"])
    lane_filter = set(request.filters.lanes)
    tag_filter = {tag.casefold() for tag in request.filters.tags}

    def eligible_candidate(candidate: NearbyCandidate) -> bool:
        return (not lane_filter or candidate.primary_lane in lane_filter) and (
            not tag_filter or tag_filter.issubset({tag.casefold() for tag in candidate.tags})
        )

    exact = provider.fetch(
        query_point=resolution.point,
        radius_km=request.initial_radius_km,
        limit=candidate_limit,
        postal_code=postal_code,
    )
    exact_status = str(exact.source_status.get("status", "UNAVAILABLE"))
    if exhaust_radius:
        # Financial eligibility is known only after the ledger provider evaluates a person.
        # A dense exact ZIP must therefore not suppress retrieval of candidates elsewhere in
        # the caller-bounded radius. Fetch one bounded radius snapshot and let the financial
        # route evaluate progressively by distance.
        radius_km = request.max_radius_km if request.auto_expand else request.initial_radius_km
        fallback = provider.fetch(
            query_point=resolution.point,
            radius_km=radius_km,
            limit=candidate_limit,
        )
        return _merge_nppes_results(
            [exact, fallback],
            postal_code=postal_code,
            requested_target=request.top_n,
            expansion_radii_km=[radius_km],
            eligible_candidate=eligible_candidate,
        )
    if sum(eligible_candidate(candidate) for candidate in exact.candidates) >= request.top_n:
        return _merge_nppes_results(
            [exact],
            postal_code=postal_code,
            requested_target=request.top_n,
            expansion_radii_km=[],
            eligible_candidate=eligible_candidate,
            fallback_skipped_reason="EXACT_POSTAL_TARGET_SATISFIED",
        )
    if not request.auto_expand:
        return _merge_nppes_results(
            [exact],
            postal_code=postal_code,
            requested_target=request.top_n,
            expansion_radii_km=[],
            eligible_candidate=eligible_candidate,
            fallback_skipped_reason="AUTO_EXPAND_DISABLED",
        )
    if exact_status == "UNAVAILABLE":
        return _merge_nppes_results(
            [exact],
            postal_code=postal_code,
            requested_target=request.top_n,
            expansion_radii_km=[],
            eligible_candidate=eligible_candidate,
            fallback_skipped_reason="EXACT_POSTAL_UNAVAILABLE",
        )

    results = [exact]
    attempted_radii: list[float] = []
    unique_ids = {
        candidate.person_id for candidate in exact.candidates if eligible_candidate(candidate)
    }
    expansion_started = time.monotonic()
    for radius_km in _nppes_expansion_radii(
        initial_radius_km=request.initial_radius_km,
        max_radius_km=request.max_radius_km,
    ):
        if time.monotonic() - expansion_started >= _NPPES_EXPANSION_BUDGET_SECONDS:
            break
        fallback = provider.fetch(
            query_point=resolution.point,
            radius_km=radius_km,
            limit=candidate_limit,
        )
        results.append(fallback)
        attempted_radii.append(radius_km)
        unique_ids.update(
            candidate.person_id
            for candidate in fallback.candidates
            if eligible_candidate(candidate)
        )
        if len(unique_ids) >= request.top_n:
            break
        if fallback.source_status.get("status") == "UNAVAILABLE":
            break

    return _merge_nppes_results(
        results,
        postal_code=postal_code,
        requested_target=request.top_n,
        expansion_radii_km=attempted_radii,
        eligible_candidate=eligible_candidate,
    )


def _fetch_national_candidates(
    *,
    resolution: QueryResolution,
    request: NearbyDiscoveryRequest,
    exhaust_radius: bool = False,
) -> NationalCandidateBatch:
    """Fan out to authoritative US registries and retain only public-safe facts."""

    assert resolution.point is not None
    source_settings = get_settings()
    nppes_future: Future[NationalNppesResult] | None = None
    sec_future: Future[NationalSecBatch] | None = None
    candidate_limit = min(2_000, max(200, request.top_n * 5))
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="nws-national") as pool:
        if source_settings.nppes_source_enabled:
            nppes_future = pool.submit(
                _fetch_nppes_candidates,
                provider=_nppes_provider(),
                resolution=resolution,
                request=request,
                candidate_limit=candidate_limit,
                exhaust_radius=exhaust_radius,
            )
        if source_settings.sec_source_enabled:
            sec_future = pool.submit(
                _sec_provider().discover,
                query_point=resolution.point,
                radius_km=request.max_radius_km,
                limit=min(100, candidate_limit),
            )

    candidates: list[NearbyCandidate] = []
    metadata: dict[str, BootstrapMetadata] = {}
    source_status: list[dict[str, object]] = []

    if nppes_future is not None:
        nppes = nppes_future.result()
        candidates.extend(nppes.candidates)
        metadata.update(nppes.metadata)
        source_status.append(dict(nppes.source_status))

    if sec_future is not None:
        try:
            sec = sec_future.result()
        except NationalSecSourceError:
            source_status.append(
                {
                    "source": "SEC_SECTION16",
                    "status": "UNAVAILABLE",
                    "error_code": "SEC_PROFESSIONAL_SOURCE_UNAVAILABLE",
                }
            )
        else:
            candidates.extend(sec.candidates)
            metadata.update(sec.metadata)
            source_status.append(
                {
                    "source": "SEC_SECTION16",
                    "status": "OK" if sec.candidates else "EMPTY",
                    **asdict(sec.source_status),
                    "association_notice": (
                        "Location is an issuer public-office association, not a residence or "
                        "claim of physical presence. Financial position values are excluded."
                    ),
                }
            )

    # Stable IDs make cross-source collisions explicit. Never let a later source silently
    # overwrite a candidate while retaining another source's evidence.
    unique: dict[str, NearbyCandidate] = {}
    for candidate in candidates:
        unique.setdefault(candidate.person_id, candidate)
    unique_metadata = {
        person_id: metadata[person_id] for person_id in unique if person_id in metadata
    }
    return NationalCandidateBatch(tuple(unique.values()), unique_metadata, tuple(source_status))


def _resolve_query(query: QueryLocationInput) -> QueryResolution:
    if query.postal_code is not None:
        return resolve_postal_query(
            postal_code=query.postal_code,
            country_code=query.country_code,
        )
    assert query.latitude is not None and query.longitude is not None
    return resolve_coordinate_query(
        latitude=query.latitude,
        longitude=query.longitude,
        country_code=query.country_code,
        decimals=get_settings().query_location_decimals,
    )


def _net_worth_candidate_pool(
    *,
    resolution: QueryResolution,
    request: NearbyNetWorthRequest,
) -> NetWorthCandidatePool:
    """Select the location-eligible pool without using a professional or wealth score."""

    assert resolution.point is not None
    backend = resolution.coverage.get("candidate_backend")
    source_status: tuple[dict[str, object], ...]
    if backend == _KIRKLAND_BACKEND:
        candidates = BOOTSTRAP_CANDIDATES
        source_status = (
            {
                "source": "REVIEWED_KIRKLAND_PUBLIC_ASSOCIATIONS",
                "status": "OK" if candidates else "EMPTY",
                "source_as_of": get_settings().release_reviewed_at,
            },
        )
    elif backend == _NATIONAL_BACKEND:
        source_settings = get_settings()
        if not source_settings.national_sources_enabled:
            raise HTTPException(
                status_code=503,
                detail={"code": "NATIONAL_CANDIDATE_BACKEND_UNAVAILABLE"},
            )
        compatibility_request = NearbyDiscoveryRequest(
            query=request.query,
            top_n=request.top_n,
            initial_radius_km=request.initial_radius_km,
            max_radius_km=request.max_radius_km,
            auto_expand=request.auto_expand,
            diversity=False,
            filters=NearbyFiltersInput(minimum_confidence_grade="D"),
        )
        batch = _fetch_national_candidates(
            resolution=resolution,
            request=compatibility_request,
            exhaust_radius=True,
        )
        source_status = batch.source_status
        if not any(item.get("status") in {"OK", "EMPTY"} for item in source_status):
            raise HTTPException(
                status_code=503,
                detail={"code": "NATIONAL_CANDIDATE_BACKEND_UNAVAILABLE"},
            )
        candidates = batch.candidates
    else:
        raise HTTPException(status_code=503, detail={"code": "UNKNOWN_CANDIDATE_BACKEND"})

    policy = NearbyPolicyEngine()
    eligible = [
        candidate for candidate in candidates if policy.authorize_candidate(candidate).allowed
    ]
    distances = {
        candidate.person_id: haversine_km(resolution.point, candidate.location.point)
        for candidate in eligible
    }
    retrieval_radius = request.max_radius_km if request.auto_expand else request.initial_radius_km
    in_radius = [
        candidate for candidate in eligible if distances[candidate.person_id] <= retrieval_radius
    ]
    # Pool order is only deterministic plumbing. Financial results are sorted later solely by
    # the financial estimate and documented tie breakers.
    in_radius.sort(key=lambda item: (distances[item.person_id], item.person_id))
    return NetWorthCandidatePool(
        candidates=tuple(in_radius),
        source_status=source_status,
        expansion_steps_km=(round(request.initial_radius_km, 3),),
        effective_radius_km=round(request.initial_radius_km, 3),
    )


def _net_worth_expansion_radii(request: NearbyNetWorthRequest) -> tuple[float, ...]:
    radii = [request.initial_radius_km]
    if not request.auto_expand:
        return tuple(radii)
    while radii[-1] < request.max_radius_km:
        expanded = min(request.max_radius_km, radii[-1] * 1.75)
        if expanded == radii[-1]:
            break
        radii.append(expanded)
    return tuple(radii)


def _net_worth_public_query(resolution: QueryResolution) -> dict[str, object]:
    query = resolution.query
    country_resolution = query.get("country_resolution")
    location_resolution = query.get("location_resolution")
    resolved_country = (
        country_resolution.get("country_code") if isinstance(country_resolution, dict) else None
    )
    return {
        "label": str(query.get("label") or "Query area"),
        "mode": str(query.get("mode") or "POSTAL_CODE"),
        "postal_code": (
            str(query["postal_code"]) if isinstance(query.get("postal_code"), str) else None
        ),
        "country_code": (
            query.get("country_code")
            or query.get("country_code_hint")
            or resolved_country
            or resolution.coverage.get("country_code")
        ),
        "approximate": bool(
            query.get("mode") == "COARSE_COORDINATE"
            or (
                isinstance(location_resolution, dict)
                and location_resolution.get("approximate") is True
            )
        ),
    }


def _net_worth_public_coverage(resolution: QueryResolution) -> dict[str, object]:
    coverage = resolution.coverage
    return {
        "status": coverage["status"],
        "reason_code": str(coverage.get("reason_code") or "UNKNOWN"),
        "market_label": (
            str(coverage["market_label"]) if isinstance(coverage.get("market_label"), str) else None
        ),
        "country_code": coverage.get("country_code"),
        "complete": False,
        "message": str(coverage.get("message") or "Coverage is unavailable."),
    }


def _curate_net_worth_source_status(
    source_status: Sequence[dict[str, object]],
) -> list[dict[str, object]]:
    curated: list[dict[str, object]] = []
    for source in source_status:
        candidate_status = str(source.get("status") or "UNAVAILABLE")
        status = (
            candidate_status
            if candidate_status in {"OK", "EMPTY", "UNAVAILABLE"}
            else "UNAVAILABLE"
        )
        as_of = next(
            (
                str(value)
                for value in (
                    source.get("source_as_of"),
                    source.get("index_built_at"),
                    source.get("queried_at"),
                )
                if isinstance(value, str) and value
            ),
            None,
        )
        curated.append(
            {
                "source": str(source.get("source") or source.get("source_id") or "UNKNOWN"),
                "purpose": "CANDIDATE_DISCOVERY",
                "status": status,
                "as_of": as_of,
                "reason_code": (
                    str(source["error_code"]) if isinstance(source.get("error_code"), str) else None
                ),
            }
        )
    return curated


_NET_WORTH_COMPONENT_KEYS: dict[ComponentKind, str] = {
    ComponentKind.CASH_AND_NEAR_CASH: "cash_and_near_cash",
    ComponentKind.PUBLIC_SECURITIES: "public_securities",
    ComponentKind.PRIVATE_BUSINESS_EQUITY: "private_business_equity",
    ComponentKind.REAL_ESTATE_EQUITY: "real_estate_equity",
    ComponentKind.OTHER_SUPPORTED_ASSETS: "other_assets",
    ComponentKind.LIABILITY: "liabilities",
}


def _empty_component_for_coverage(state: CoverageState) -> dict[str, object]:
    status = {
        CoverageState.NOT_APPLICABLE: "NOT_APPLICABLE",
        CoverageState.NOT_PROVIDED: "NOT_PROVIDED",
    }.get(state, "UNKNOWN")
    return {
        "status": status,
        "low_usd": None,
        "most_likely_usd": None,
        "high_usd": None,
        "confidence": None,
    }


def _serialize_net_worth_components(result: NetWorthResult) -> dict[str, object]:
    if result.valuation_basis is EstimateBasis.DECLARED_TOTAL:
        included = {
            "status": "INCLUDED_IN_DECLARED_TOTAL",
            "low_usd": None,
            "most_likely_usd": None,
            "high_usd": None,
            "confidence": None,
        }
        return {key: dict(included) for key in _NET_WORTH_COMPONENT_KEYS.values()}

    grouped = {
        kind: [component for component in result.components if component.kind is kind]
        for kind in _NET_WORTH_COMPONENT_KEYS
    }
    serialized: dict[str, object] = {}
    for kind, key in _NET_WORTH_COMPONENT_KEYS.items():
        components = grouped[kind]
        if not components:
            serialized[key] = _empty_component_for_coverage(
                result.component_coverage.state_for(kind)
            )
            continue
        serialized[key] = {
            "status": (
                "MODELED_RANGE"
                if any(
                    component.basis is EstimateBasis.EXPLICIT_MODEL_ASSUMPTION
                    for component in components
                )
                else "SUPPORTED"
            ),
            "low_usd": round(sum(component.amount.low_usd for component in components)),
            "most_likely_usd": round(
                sum(component.amount.most_likely_usd for component in components)
            ),
            "high_usd": round(sum(component.amount.high_usd for component in components)),
            "confidence": round(min(component.confidence for component in components), 4),
        }
    return serialized


def _serialize_net_worth_citations(result: NetWorthResult) -> list[dict[str, object]]:
    citations: list[dict[str, object]] = []
    seen: set[str] = set()
    evidence_records = [
        evidence for component in result.components for evidence in component.evidence
    ]
    if result.declared_total is not None:
        evidence_records.append(result.declared_total.evidence)
    for evidence in evidence_records:
        if evidence.evidence_id in seen:
            continue
        seen.add(evidence.evidence_id)
        citations.append(
            {
                "publisher": evidence.source_authority,
                "title": evidence.kind.value.replace("_", " ").title(),
                "url": evidence.source_uri,
                "fact_types": [evidence.kind.value, evidence.purpose.value],
                "source_date": (
                    str(evidence.source_date.year)
                    if evidence.source_date_precision is EvidenceDatePrecision.YEAR
                    else evidence.source_date.isoformat()
                ),
                "retrieved_at": evidence.retrieved_at.isoformat(),
            }
        )
    return citations


def _net_worth_update_precision(result: NetWorthResult) -> EvidenceDatePrecision:
    """Use the precision of evidence that establishes the latest public update."""

    if result.last_financial_update is None:
        return EvidenceDatePrecision.DAY
    evidence_records = [
        evidence for component in result.components for evidence in component.evidence
    ]
    if result.declared_total is not None:
        evidence_records.append(result.declared_total.evidence)
    newest_records = [
        evidence
        for evidence in evidence_records
        if evidence.source_date == result.last_financial_update
    ]
    if newest_records and all(
        evidence.source_date_precision is EvidenceDatePrecision.YEAR for evidence in newest_records
    ):
        return EvidenceDatePrecision.YEAR
    return EvidenceDatePrecision.DAY


def _publishable_net_worth(result: NetWorthResult, candidate: NearbyCandidate) -> bool:
    return bool(
        result.subject_id == candidate.person_id
        and result.status in {EstimateStatus.AVAILABLE, EstimateStatus.PARTIAL_ESTIMATE}
        and result.net_worth is not None
        and result.nws is not None
        and result.confidence is not None
        and result.last_financial_update is not None
    )


def _serialize_net_worth_result(
    *,
    rank: int,
    candidate: NearbyCandidate,
    estimate: NetWorthResult,
    query_point,  # type: ignore[no-untyped-def]
) -> dict[str, object]:
    assert estimate.net_worth is not None
    assert estimate.nws is not None
    assert estimate.confidence is not None
    assert estimate.last_financial_update is not None
    liquid = estimate.liquid_wealth
    status = (
        "PARTIAL_ESTIMATE" if estimate.status is EstimateStatus.PARTIAL_ESTIMATE else "AVAILABLE"
    )
    method = (
        "DECLARED_TOTAL_SIMULATION"
        if estimate.valuation_basis is EstimateBasis.DECLARED_TOTAL
        else "MONTE_CARLO"
    )
    citations = _serialize_net_worth_citations(estimate)
    update_precision = _net_worth_update_precision(estimate).value
    public_update = (
        str(estimate.last_financial_update.year)
        if update_precision == "YEAR"
        else estimate.last_financial_update.isoformat()
    )
    return {
        "rank": rank,
        "person": {
            "id": candidate.person_id,
            "name": candidate.display_name,
            "headline": candidate.headline,
            "organization": candidate.organization_name,
        },
        "profile_status": (
            "PARTIALLY_OBSERVABLE"
            if estimate.status is EstimateStatus.PARTIAL_ESTIMATE
            else "VERIFIED"
        ),
        "estimated_net_worth": {
            "status": status,
            "currency": "USD",
            "p10_usd": round(estimate.net_worth.p10_usd),
            "median_usd": round(estimate.net_worth.median_usd),
            "p90_usd": round(estimate.net_worth.p90_usd),
            "method": method,
            "as_of": public_update,
        },
        "nws": {
            "status": "AVAILABLE",
            "value": estimate.nws.score,
            "scale_version": estimate.nws.scale_version,
        },
        "confidence": {
            "score": estimate.confidence.score,
            "grade": estimate.confidence.grade,
            "coverage": estimate.confidence.coverage,
        },
        "components": _serialize_net_worth_components(estimate),
        "liquid_wealth": {
            "status": "AVAILABLE" if liquid is not None else "UNKNOWN",
            "currency": "USD",
            "p10_usd": round(liquid.p10_usd) if liquid is not None else None,
            "median_usd": round(liquid.median_usd) if liquid is not None else None,
            "p90_usd": round(liquid.p90_usd) if liquid is not None else None,
        },
        # A liquid-dollar distribution is not itself a calibrated liquidity score.
        "liquidity_score": None,
        "location_relationship": {
            "label": candidate.location.label,
            "association_kind": candidate.location.kind.value,
            "granularity": candidate.location.granularity.value,
            "approximate_distance_band": _distance_band(
                haversine_km(query_point, candidate.location.point)
            ),
            "note": (
                "Distance is to a public professional or opt-in association, never a "
                "residence or claim of physical presence."
            ),
        },
        "last_financial_update": public_update,
        "financial_update_precision": update_precision,
        "sources": citations,
    }


@dataclass(frozen=True)
class FloridaSnapshotProfiles:
    county_name: str
    county_overlap_fraction: float
    status: SnapshotRepositoryStatus | None
    profiles: tuple[PublishedNetWorthProfile, ...]
    matching_profile_count: int


def _snapshot_unavailable(exc: SnapshotUnavailableError) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "code": "NET_WORTH_SNAPSHOT_UNAVAILABLE",
            "reason_code": exc.code,
        },
    )


def _require_current_snapshot(status: SnapshotRepositoryStatus, *, now: datetime) -> None:
    current = now.astimezone(UTC)
    source_settings = get_settings()
    age = current - status.generated_at.astimezone(UTC)
    maximum_age = timedelta(hours=source_settings.snapshot_max_age_hours)
    if age < timedelta(minutes=-5) or age > maximum_age:
        raise _snapshot_unavailable(
            SnapshotUnavailableError(
                "active net-worth snapshot is stale or future-dated",
                code="SNAPSHOT_STALE",
            )
        )
    source_age = current - status.source_index_built_at.astimezone(UTC)
    maximum_source_age = timedelta(hours=source_settings.snapshot_max_source_age_hours)
    if source_age < timedelta(minutes=-5) or source_age > maximum_source_age:
        raise _snapshot_unavailable(
            SnapshotUnavailableError(
                "active net-worth source index is stale or future-dated",
                code="SOURCE_INDEX_STALE",
            )
        )


def _florida_financial_profiles(
    *,
    resolution: QueryResolution,
    request: NearbyNetWorthRequest,
    generated_at: datetime,
) -> FloridaSnapshotProfiles | None:
    """Resolve Florida geography against the preloaded reviewed snapshot only."""

    postal_code = resolution.query.get("postal_code")
    if not isinstance(postal_code, str):
        if resolution.query.get("mode") != "COARSE_COORDINATE" or resolution.point is None:
            return None
        nearest = get_us_postal_index().nearest(
            resolution.point,
            max_distance_km=_COORDINATE_JURISDICTION_ZCTA_MAX_KM,
        )
        if nearest is None:
            return None
        postal_code = nearest[0].postal_code
    try:
        jurisdiction = get_public_jurisdiction_index().resolve(postal_code)
    except (KeyError, ValueError):
        return None
    if jurisdiction.state_fips != "12":
        return None

    repository = _net_worth_snapshot_repository()
    if repository is None:
        return FloridaSnapshotProfiles(
            county_name=jurisdiction.county_name,
            county_overlap_fraction=jurisdiction.overlap_fraction,
            status=None,
            profiles=(),
            matching_profile_count=0,
        )

    jurisdiction_id = f"US-FL-COUNTY-{jurisdiction.county_geoid}"
    try:
        status = repository.status()
        _require_current_snapshot(status, now=generated_at)
        matching_profiles = repository.profiles_for_jurisdiction(jurisdiction_id)
    except SnapshotUnavailableError as exc:
        raise _snapshot_unavailable(exc) from exc
    return FloridaSnapshotProfiles(
        county_name=jurisdiction.county_name,
        county_overlap_fraction=jurisdiction.overlap_fraction,
        status=status,
        profiles=matching_profiles[: request.top_n],
        matching_profile_count=len(matching_profiles),
    )


def _florida_source_status(
    *,
    selection: FloridaSnapshotProfiles,
) -> list[dict[str, object]]:
    reason_code: str | None
    if selection.status is None:
        status = "UNAVAILABLE"
        as_of = None
        reason_code = "FLORIDA_FORM_6_SNAPSHOT_NOT_CONFIGURED"
    else:
        status = "OK" if selection.matching_profile_count else "EMPTY"
        as_of = selection.status.source_index_built_at.isoformat()
        reason_code = None
        if selection.status.source_partial:
            reason_code = "SOURCE_INDEX_PARTIAL"

    return [
        {
            "source": "FLORIDA_FORM_6_PUBLIC_FILERS",
            "purpose": "CANDIDATE_DISCOVERY",
            "status": status,
            "as_of": as_of,
            "reason_code": reason_code,
        },
        {
            "source": "FLORIDA_FORM_6_DECLARED_TOTALS",
            "purpose": "FINANCIAL_EVIDENCE",
            "status": status,
            "as_of": as_of,
            "reason_code": reason_code,
        },
    ]


def _serialize_florida_snapshot_profile(
    *,
    rank: int,
    profile: PublishedNetWorthProfile,
    status: SnapshotRepositoryStatus,
    county_name: str,
    county_overlap_fraction: float,
) -> dict[str, object]:
    included_component = {
        "status": "INCLUDED_IN_DECLARED_TOTAL",
        "low_usd": None,
        "most_likely_usd": None,
        "high_usd": None,
        "confidence": None,
    }
    return {
        "rank": rank,
        "person": {
            "id": profile.subject_id,
            "name": profile.name,
            "headline": profile.headline,
            "organization": None,
        },
        "profile_status": "VERIFIED",
        "estimated_net_worth": {
            "status": "AVAILABLE",
            "currency": "USD",
            "p10_usd": profile.p10_usd,
            "median_usd": profile.median_usd,
            "p90_usd": profile.p90_usd,
            "method": profile.method,
            "as_of": str(profile.form_year),
        },
        "nws": {
            "status": "AVAILABLE",
            "value": profile.nws,
            "scale_version": NWS_SCALE_VERSION,
        },
        "confidence": {
            "score": profile.confidence.score,
            "grade": profile.confidence.grade,
            "coverage": profile.confidence.coverage,
        },
        "components": {key: dict(included_component) for key in _NET_WORTH_COMPONENT_KEYS.values()},
        "liquid_wealth": {
            "status": "UNKNOWN",
            "currency": "USD",
            "p10_usd": None,
            "median_usd": None,
            "p90_usd": None,
        },
        "liquidity_score": None,
        "location_relationship": {
            "label": f"{county_name} public service jurisdiction",
            "association_kind": "PUBLIC_SERVICE_JURISDICTION",
            "granularity": "REGION",
            "approximate_distance_band": "public jurisdiction match",
            "note": (
                "The postal query maps to its primary Census county by largest overlap "
                f"({county_overlap_fraction:.1%}). This is a public-office association, "
                "not a residence or physical-presence claim."
            ),
        },
        "last_financial_update": str(profile.form_year),
        "financial_update_precision": "YEAR",
        "sources": [
            {
                "publisher": "Florida Commission on Ethics",
                "title": "Florida Form 6 sworn whole net worth declaration",
                "url": profile.source_url,
                "fact_types": [
                    "STATE_WHOLE_NET_WORTH_DISCLOSURE",
                    "DECLARED_NET_WORTH_TOTAL",
                ],
                "source_date": str(profile.form_year),
                "retrieved_at": status.source_retrieved_at.isoformat(),
            }
        ],
    }


def _florida_net_worth_response(
    *,
    common: dict[str, object],
    resolution: QueryResolution,
    request: NearbyNetWorthRequest,
    selection: FloridaSnapshotProfiles,
) -> NearbyNetWorthResponse:
    discovered_count = selection.matching_profile_count
    evaluated_count = discovered_count
    unevaluated_count = 0
    scored_count = discovered_count
    insufficient_evidence_count = 0
    returned_count = len(selection.profiles)
    shortfall_count = max(0, request.top_n - returned_count)
    if returned_count >= request.top_n:
        result_status = "TARGET_MET"
        reasons: list[str] = []
    elif returned_count:
        result_status = "PARTIAL"
        reasons = ["PUBLIC_DECLARATION_POOL_BELOW_TARGET"]
    else:
        result_status = "EMPTY"
        reasons = ["FINANCIAL_COVERAGE_INSUFFICIENT"]
        if selection.status is None:
            reasons.append("FINANCIAL_SOURCE_UNAVAILABLE")
        else:
            reasons.append("NO_ELIGIBLE_PUBLIC_DECLARATIONS")
    if selection.status is not None and selection.status.source_partial:
        reasons.append("SOURCE_INDEX_PARTIAL")
    if selection.status is not None and selection.status.truncated:
        reasons.append("SOURCE_RESULT_TRUNCATED")

    coverage = {
        "status": "COVERED",
        "reason_code": "FLORIDA_PUBLIC_FORM_6_JURISDICTION",
        "market_label": f"{selection.county_name} public Form 6 jurisdiction",
        "country_code": "US",
        "complete": False,
        "message": (
            "The query is matched through a nearby Census ZCTA to its approximate primary "
            "public county jurisdiction for sworn Florida Form 6 declarations."
            if resolution.query.get("mode") == "COARSE_COORDINATE"
            else "The postal query is matched to its approximate primary public county "
            "jurisdiction for sworn Florida Form 6 declarations."
        ),
    }
    results = [
        _serialize_florida_snapshot_profile(
            rank=index + 1,
            profile=profile,
            status=selection.status,
            county_name=selection.county_name,
            county_overlap_fraction=selection.county_overlap_fraction,
        )
        for index, profile in enumerate(selection.profiles)
        if selection.status is not None
    ]
    return NearbyNetWorthResponse.model_validate(
        {
            **common,
            "coverage": coverage,
            "financial_coverage": {
                "status": (
                    "FINANCIAL_COVERAGE_INSUFFICIENT"
                    if returned_count == 0
                    else "PARTIAL"
                    if (
                        returned_count < request.top_n
                        or (selection.status is not None and selection.status.source_partial)
                        or (selection.status is not None and selection.status.truncated)
                    )
                    else "AVAILABLE"
                ),
                "candidate_count": discovered_count,
                "discovered_count": discovered_count,
                "evaluated_count": evaluated_count,
                "unevaluated_count": unevaluated_count,
                "scored_count": scored_count,
                "insufficient_evidence_count": insufficient_evidence_count,
            },
            "result_set": {
                "status": result_status,
                "requested_count": request.top_n,
                "returned_count": returned_count,
                "shortfall_count": shortfall_count,
                "target_satisfied": returned_count >= request.top_n,
                "reasons": list(dict.fromkeys(reasons)),
            },
            "search": {
                "performed": True,
                "scope": "PUBLIC_JURISDICTION",
                "expanded": False,
                "expansion_steps_km": [],
                "initial_radius_km": request.initial_radius_km,
                "effective_radius_km": 0,
                "maximum_radius_km": request.max_radius_km,
                "maximum_radius_reached": False,
            },
            "source_status": _florida_source_status(selection=selection),
            "results": results,
        }
    )


def _serialize_result(item, metadata_by_id) -> dict[str, object]:  # type: ignore[no-untyped-def]
    metadata = metadata_by_id[item.candidate.person_id]
    association_as_of = item.candidate.location.as_of_date.isoformat()
    source_observations = [
        citation.retrieved_at for citation in metadata.citations if citation.retrieved_at.strip()
    ]
    return {
        "rank": item.rank,
        "person_id": item.candidate.person_id,
        "display_name": item.candidate.display_name,
        "headline": item.candidate.headline,
        "organization": item.candidate.organization_name,
        "lane": item.candidate.primary_lane.value,
        "global_nws": item.score.global_nws,
        "nearby_rank_score": item.score.nearby_rank_score,
        "score_status": metadata.score_status,
        "score_kind": _PROFESSIONAL_SCORE_KIND,
        "ranking_basis": (
            "SOURCE_AUTHORITY_RECENCY_ROLE_AND_DISTANCE"
            if metadata.score_status == "SOURCE_VERIFIED_UNSCORED"
            else "PROVISIONAL_NWS_MODEL"
        ),
        "confidence": {
            "score": item.score.confidence,
            "grade": item.score.confidence_grade,
        },
        "public_location": {
            "label": item.candidate.location.label,
            "association_kind": item.candidate.location.kind.value,
            "granularity": item.candidate.location.granularity.value,
            "approximate_distance_band": _distance_band(item.score.distance_km),
            "note": (
                "Distance is to a public professional or institutional association, never a "
                "residence."
            ),
        },
        "public_association_context": public_association_context(item.candidate.location.kind),
        "score_breakdown": _serialize_breakdown(item.score),
        "reasons": list(item.score.reasons),
        "warnings": list(item.score.warnings),
        "tags": list(item.candidate.tags),
        "revalidation_required": metadata.revalidation_required,
        "freshness": {
            "status": (
                "REVALIDATION_REQUIRED"
                if metadata.revalidation_required
                else "CURRENT_AS_PUBLISHED"
            ),
            "association_as_of": association_as_of,
            "latest_source_observation": (
                max(source_observations) if source_observations else association_as_of
            ),
        },
        "financial_evidence": {
            "status": "NOT_PROFILED",
            "personal_financial_strength": "NOT_PROVIDED",
            "used_for_ranking": False,
        },
        "evidence": {
            "citation_count": len(metadata.citations),
            "source_family_count": metadata.source_family_count,
            "evidence_fact_count": metadata.evidence_fact_count,
            "independent_source_families": metadata.source_family_count >= 2,
            "review_flags": list(metadata.review_flags),
        },
        "sources": [
            {
                "publisher": citation.publisher,
                "title": citation.title,
                "url": citation.url,
                "fact_types": list(citation.fact_types),
                "retrieved_at": citation.retrieved_at,
            }
            for citation in metadata.citations
        ],
        "model_version": item.score.model_version,
    }


def _serialize_breakdown(score) -> dict[str, object]:  # type: ignore[no-untyped-def]
    """Publish how the score was reached, not only what it is.

    The seven components were always computed and never returned, so the number
    arrived with four sentences of prose and no arithmetic behind it. A reader
    could not tell a strong profile from a well-sourced one.

    Weights come from the scoring module rather than being restated here, so a
    re-weighting cannot leave a stale explanation behind. Contributions are
    published because the weighted sum alone does not reproduce the score —
    coverage and integrity adjust it afterwards, and both are shown.
    """
    components = score.components.as_dict()
    return {
        "components": [
            {
                "key": name,
                "label": COMPONENT_LABELS[name],
                "value": round(value, 4),
                "weight": GLOBAL_NWS_WEIGHTS[name],
                "contribution": round(GLOBAL_NWS_WEIGHTS[name] * value, 4),
            }
            for name, value in sorted(
                components.items(), key=lambda item: -GLOBAL_NWS_WEIGHTS[item[0]]
            )
        ],
        # Scores rise with corroboration: a thinly evidenced profile is held
        # back rather than trusted, so this is part of the answer to "why".
        "evidence_count": score.evidence_count,
        "coverage_multiplier": score.coverage_multiplier,
        # Discount applied for promotional, self-published, or single-source
        # evidence patterns. Zero for a clean profile.
        "integrity_penalty": score.integrity_penalty,
        "local_relevance": score.local_relevance,
        "method": (
            "Each component is scored 0-1, multiplied by its weight and summed, with a "
            "balance term that stops a single strong signal carrying a profile. That total "
            "is scaled by evidence coverage and reduced by any integrity penalty. The "
            "nearby rank is 90% of this score plus 10% for association strength to the "
            "queried place. This release uses conservative public-role taxonomy priors, not "
            "a completed observed regional graph."
        ),
    }


def _distance_band(distance_km: float) -> str:
    for label, upper_bound_km in _DISTANCE_BANDS:
        if upper_bound_km is None or distance_km < upper_bound_km:
            return label
    raise AssertionError("distance band table must have an unbounded final entry")


def _distance_band_counts(results: Sequence[NearbyRankedPerson]) -> list[dict[str, object]]:
    """Aggregate only the same coarse distance bands already safe for each result."""

    counts = Counter(_distance_band(item.score.distance_km) for item in results)
    return [
        {"band": label, "count": counts[label]} for label, _ in _DISTANCE_BANDS if counts[label]
    ]


def _aggregate_source_health(
    source_status: Sequence[dict[str, object]],
    *,
    mode: str,
) -> dict[str, object]:
    """Give clients one bounded health state without hiding per-source disclosure."""

    if not source_status:
        return {
            "status": "NOT_QUERIED",
            "mode": mode,
            "queried_source_count": 0,
            "successful_sources": [],
            "empty_sources": [],
            "unavailable_sources": [],
            "partial_sources": [],
            "stale_sources": [],
            "reasons": [],
        }

    successful: list[str] = []
    empty: list[str] = []
    unavailable: list[str] = []
    partial: list[str] = []
    stale: list[str] = []
    stage_degraded: list[str] = []
    for source in source_status:
        source_id = str(source.get("source") or source.get("source_id") or "UNKNOWN")
        status = str(source.get("status") or "UNAVAILABLE")
        if status in {"OK", "EMPTY"}:
            successful.append(source_id)
        if status == "EMPTY":
            empty.append(source_id)
        if status == "UNAVAILABLE":
            unavailable.append(source_id)
        if source.get("index_partial") is True:
            partial.append(source_id)
        if source.get("index_stale") is True:
            stale.append(source_id)
        if source.get("degraded") is True:
            stage_degraded.append(source_id)

    reasons: list[str] = []
    if unavailable:
        reasons.append("SOURCE_UNAVAILABLE")
    if partial:
        reasons.append("SOURCE_INDEX_PARTIAL")
    if stale:
        reasons.append("SOURCE_INDEX_STALE")
    if stage_degraded:
        reasons.append("SOURCE_STAGE_DEGRADED")
    degraded = bool(reasons)
    health_status = (
        "UNAVAILABLE"
        if len(unavailable) == len(source_status)
        else "DEGRADED"
        if degraded
        else "HEALTHY"
    )
    return {
        "status": health_status,
        "mode": mode,
        "queried_source_count": len(source_status),
        "successful_sources": sorted(set(successful)),
        "empty_sources": sorted(set(empty)),
        "unavailable_sources": sorted(set(unavailable)),
        "partial_sources": sorted(set(partial)),
        "stale_sources": sorted(set(stale)),
        "reasons": reasons,
    }


def _search_accountability(
    request: NearbyDiscoveryRequest,
    summary: NearbyDiscoverySummary,
    results: Sequence[NearbyRankedPerson],
) -> dict[str, object]:
    maximum_radius_reached = summary.effective_radius_km >= round(request.max_radius_km, 3) - 0.001
    return {
        "performed": True,
        "scope": "FINAL_RANKING_RADIUS",
        "auto_expand": request.auto_expand,
        "expanded": len(summary.expansion_steps) > 1,
        "expansion_steps_km": list(summary.expansion_steps),
        "initial_radius_km": request.initial_radius_km,
        "effective_radius_km": summary.effective_radius_km,
        "maximum_radius_km": request.max_radius_km,
        "maximum_radius_reached": maximum_radius_reached,
        "returned_by_distance_band": _distance_band_counts(results),
    }


def _uncovered_search_accountability(request: NearbyDiscoveryRequest) -> dict[str, object]:
    return {
        "performed": False,
        "scope": "FINAL_RANKING_RADIUS",
        "auto_expand": request.auto_expand,
        "expanded": False,
        "expansion_steps_km": [],
        "initial_radius_km": request.initial_radius_km,
        "effective_radius_km": 0,
        "maximum_radius_km": request.max_radius_km,
        "maximum_radius_reached": False,
        "returned_by_distance_band": [],
    }


def _result_set_accountability(
    *,
    request: NearbyDiscoveryRequest,
    summary: NearbyDiscoverySummary,
    source_candidate_count: int,
    filtered_candidate_count: int,
    backend: object,
    source_status: Sequence[dict[str, object]],
    source_health: dict[str, object],
) -> dict[str, object]:
    returned_count = summary.returned_count
    shortfall_count = max(0, request.top_n - returned_count)
    target_satisfied = shortfall_count == 0
    status = "TARGET_MET" if target_satisfied else "EMPTY" if returned_count == 0 else "PARTIAL"
    reasons: list[str] = []
    if not target_satisfied:
        if source_health["status"] == "DEGRADED":
            reasons.append("SOURCE_DEGRADED")
        if not request.auto_expand:
            reasons.append("AUTO_EXPAND_DISABLED")
        if filtered_candidate_count < source_candidate_count:
            reasons.append("FILTERS_REDUCED_POOL")
        if summary.eligible_candidate_count < summary.candidate_pool_size:
            reasons.append("POLICY_REDUCED_POOL")
        if summary.confidence_eligible_candidate_count < summary.eligible_candidate_count:
            reasons.append("CONFIDENCE_REDUCED_POOL")
        if (
            request.auto_expand
            and summary.effective_radius_km >= round(request.max_radius_km, 3) - 0.001
        ):
            reasons.append("MAX_RADIUS_REACHED")
        if any(source.get("target_satisfied") is False for source in source_status):
            reasons.append("SOURCE_TARGET_NOT_MET")
        if source_candidate_count < request.top_n:
            reasons.append(
                "SOURCE_SPARSE" if backend == _NATIONAL_BACKEND else "REVIEWED_POOL_EXHAUSTED"
            )
        if not reasons:
            reasons.append("ELIGIBLE_POOL_EXHAUSTED")

    return {
        "status": status,
        "requested_count": request.top_n,
        "returned_count": returned_count,
        "shortfall_count": shortfall_count,
        "target_satisfied": target_satisfied,
        "reasons": reasons,
    }


def _uncovered_result_set_accountability(
    request: NearbyDiscoveryRequest,
    coverage: dict[str, object],
) -> dict[str, object]:
    return {
        "status": "NOT_SEARCHED",
        "requested_count": request.top_n,
        "returned_count": 0,
        "shortfall_count": request.top_n,
        "target_satisfied": False,
        "reasons": [str(coverage["reason_code"])],
    }


def _uncovered_summary(
    request: NearbyDiscoveryRequest, coverage: dict[str, object]
) -> dict[str, object]:
    """Make a normal coverage miss observable without pretending a ranking ran."""

    return {
        "requested_top_n": request.top_n,
        "verified_seed_candidate_count": 0,
        "reviewed_public_association_candidate_count": 0,
        "returned_count": 0,
        "initial_radius_km": request.initial_radius_km,
        "effective_radius_km": 0,
        "maximum_radius_km": request.max_radius_km,
        "minimum_confidence_grade": request.filters.minimum_confidence_grade,
        "diversity_applied": False,
        "coverage_status": coverage["status"],
        "search_performed": False,
        "candidate_backend": "none-outside-approved-coverage",
        "graph_mode": "not-queried",
        "data_freshness": coverage["message"],
    }


def _base_response(
    *,
    resolution: QueryResolution,
    settings,  # type: ignore[no-untyped-def]
) -> dict[str, object]:
    release = get_market_release()
    anchor_release = get_organization_anchor_release()
    # Kirkland metadata is valid only for the curated Kirkland backend. Coverage
    # misses and unresolved locations must not inherit Kirkland release/anchor IDs.
    national = resolution.coverage.get("candidate_backend") != _KIRKLAND_BACKEND
    return {
        "query": resolution.query,
        "coverage": resolution.coverage,
        "snapshot": {
            "data_mode": settings.data_mode if national else "REVIEWED_PUBLIC_ASSOCIATION_RELEASE",
            "score_status": "PROVISIONAL",
            "score_kind": _PROFESSIONAL_SCORE_KIND,
            "complete": False,
            "model_version": (
                settings.national_model_version if national else settings.model_version
            ),
            **(
                {"policy_reviewed_at": settings.national_policy_reviewed_at}
                if national
                else {
                    "verified_at": settings.release_reviewed_at,
                    "reviewed_at": settings.release_reviewed_at,
                }
            ),
            "semantics": (
                (
                    "Live request over the latest published public-professional source snapshots; "
                    "not live physical tracking or a residence claim."
                )
                if national
                else (
                    "Immutable reviewed Kirkland public-association release; not live physical "
                    "tracking or a residence claim."
                )
            ),
        },
        "release": (
            {
                "release_id": "us-national-public-professional-live-snapshot",
                "market_id": "us-national-public-association",
                "model_version": settings.national_model_version,
                "source_policy_version": "us-national-public-professional-v1",
                "geography_source": "U.S. Census Bureau 2025 Gazetteer",
                "geography_record_count": 33_791,
                "complete": False,
            }
            if national
            else {
                "release_id": release.release_id,
                "market_id": release.market_id,
                "model_version": release.model_version,
                "source_retrieved_at": release.source_retrieved_at,
                "source_policy_version": release.source_policy_version,
                "candidate_set_sha256": release.candidate_set_sha256,
                "source_registry_sha256": release.source_registry_sha256,
                "manifest_sha256": release.manifest_sha256,
            }
        ),
        "discovery": (
            {
                "mode": "AUTHORITATIVE_PUBLIC_REGISTRY_FANOUT",
                "automatic_candidate_publication": True,
                "publication_rule": (
                    "Stable registry identifier plus source-specific identity, role/practice, "
                    "location, freshness, and privacy gates."
                ),
                "market_census_complete": False,
            }
            if national
            else anchor_release.api_summary()
        ),
        "financial_context": public_financial_context_policy(),
        "score_definition": (
            "NWS estimates public professional network strength and opportunity access. It is not "
            "financial net worth, and nearby means a public professional, institutional, civic, or "
            "opt-in association—not physical presence or a private home."
        ),
        "generated_at": datetime.now(UTC).isoformat(),
    }


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    settings = get_settings()
    return HealthResponse(
        status="ok",
        service="nws-nearby-intelligence",
        version=settings.service_version,
        data_mode=settings.data_mode,
    )


@app.get("/ready", response_model=ReadyResponse)
def ready() -> ReadyResponse:
    settings = get_settings()
    if not BOOTSTRAP_CANDIDATES:
        raise HTTPException(status_code=503, detail={"code": "NO_APPROVED_CANDIDATES"})
    geography_record_count = len(get_us_postal_index())
    get_us_boundary_index()  # digest/header validation is the readiness condition
    public_jurisdiction_record_count = len(get_public_jurisdiction_index())
    snapshot_status: SnapshotRepositoryStatus | None = None
    if settings.form6_source_enabled:
        repository = _net_worth_snapshot_repository()
        assert repository is not None
        try:
            repository.load_active(force=True)
            snapshot_status = repository.status()
        except SnapshotUnavailableError as exc:
            raise _snapshot_unavailable(exc) from exc
    consumer_registry = _consumer_access_registry() if settings.v4_enabled else None
    return ReadyResponse(
        status="ok",
        service="nws-nearby-intelligence",
        version=settings.service_version,
        data_mode=settings.data_mode,
        candidate_count=len(BOOTSTRAP_CANDIDATES),
        geography_record_count=geography_record_count,
        public_jurisdiction_record_count=public_jurisdiction_record_count,
        national_sources_enabled=settings.national_sources_enabled,
        form6_source_enabled=settings.form6_source_enabled,
        complete=False,
        model_version=(
            settings.national_model_version
            if settings.national_sources_enabled
            else settings.model_version
        ),
        net_worth_model_version=NET_WORTH_MODEL_VERSION,
        nws_scale_version=NWS_SCALE_VERSION,
        net_worth_snapshot_id=(
            snapshot_status.snapshot_id if snapshot_status is not None else None
        ),
        net_worth_snapshot_sha256=(
            snapshot_status.snapshot_sha256 if snapshot_status is not None else None
        ),
        net_worth_snapshot_generated_at=(
            snapshot_status.generated_at.isoformat() if snapshot_status is not None else None
        ),
        v4_enabled=settings.v4_enabled,
        consumer_registry_version=(
            consumer_registry.registry_version if consumer_registry is not None else None
        ),
        consumer_count=(len(consumer_registry.consumers) if consumer_registry is not None else 0),
    )


@app.post(
    "/v3/nearby-net-worth/discover",
    response_model=NearbyNetWorthResponse,
)
def discover_net_worth(
    request: NearbyNetWorthRequest,
    _: Annotated[AccessContext, Depends(require_api_access)],
) -> NearbyNetWorthResponse:
    return _discover_net_worth(request)


def _discover_net_worth(request: NearbyNetWorthRequest) -> NearbyNetWorthResponse:
    """Rank only evidence-eligible net-worth estimates within a public location pool."""

    generated_at = datetime.now(UTC)
    as_of_date = generated_at.date()
    resolution = _resolve_query(request.query)
    common: dict[str, object] = {
        "query": _net_worth_public_query(resolution),
        "coverage": _net_worth_public_coverage(resolution),
        "snapshot": {
            "score_kind": "NET_WORTH_SCORE",
            "scale_version": NWS_SCALE_VERSION,
            "model_version": NET_WORTH_MODEL_VERSION,
            "complete": False,
            "as_of": as_of_date.isoformat(),
            "semantics": (
                "NWS is a fixed national log-scale representation of estimated total net "
                "worth. Confidence is separate, and location only determines candidate "
                "eligibility."
            ),
        },
        "generated_at": generated_at.isoformat(),
    }

    if not resolution.is_covered:
        reason_code = str(resolution.coverage.get("reason_code") or "LOCATION_NOT_COVERED")
        return NearbyNetWorthResponse.model_validate(
            {
                **common,
                "financial_coverage": {
                    "status": "NOT_SEARCHED",
                    "candidate_count": 0,
                    "discovered_count": 0,
                    "evaluated_count": 0,
                    "unevaluated_count": 0,
                    "scored_count": 0,
                    "insufficient_evidence_count": 0,
                },
                "result_set": {
                    "status": "NOT_SEARCHED",
                    "requested_count": request.top_n,
                    "returned_count": 0,
                    "shortfall_count": request.top_n,
                    "target_satisfied": False,
                    "reasons": [reason_code],
                },
                "search": {
                    "performed": False,
                    "scope": "NOT_SEARCHED",
                    "expanded": False,
                    "expansion_steps_km": [],
                    "initial_radius_km": request.initial_radius_km,
                    "effective_radius_km": 0,
                    "maximum_radius_km": request.max_radius_km,
                    "maximum_radius_reached": False,
                },
                "source_status": [
                    {
                        "source": "PUBLIC_ASSOCIATION_CANDIDATES",
                        "purpose": "CANDIDATE_DISCOVERY",
                        "status": "NOT_QUERIED",
                        "as_of": None,
                        "reason_code": reason_code,
                    },
                    {
                        "source": "NET_WORTH_LEDGER",
                        "purpose": "FINANCIAL_EVIDENCE",
                        "status": "NOT_QUERIED",
                        "as_of": None,
                        "reason_code": reason_code,
                    },
                ],
                "results": [],
            }
        )

    assert resolution.point is not None
    florida = _florida_financial_profiles(
        resolution=resolution,
        request=request,
        generated_at=generated_at,
    )
    if florida is not None:
        return _florida_net_worth_response(
            common=common,
            resolution=resolution,
            request=request,
            selection=florida,
        )

    pool = _net_worth_candidate_pool(resolution=resolution, request=request)
    provider = _net_worth_provider()
    candidate_distances = {
        candidate.person_id: haversine_km(resolution.point, candidate.location.point)
        for candidate in pool.candidates
    }
    evaluated_by_id: dict[str, tuple[NearbyCandidate, NetWorthResult]] = {}
    expansion_steps: list[float] = []
    effective_radius = request.initial_radius_km
    for radius in _net_worth_expansion_radii(request):
        effective_radius = radius
        expansion_steps.append(radius)
        for candidate in pool.candidates:
            if (
                candidate.person_id not in evaluated_by_id
                and candidate_distances[candidate.person_id] <= radius
            ):
                evaluated_by_id[candidate.person_id] = (
                    candidate,
                    provider.estimate(candidate, as_of_date=as_of_date),
                )
        if (
            sum(
                _publishable_net_worth(estimate, candidate)
                for candidate, estimate in evaluated_by_id.values()
            )
            >= request.top_n
        ):
            break

    evaluated = list(evaluated_by_id.values())
    financially_available = [
        (candidate, estimate)
        for candidate, estimate in evaluated
        if _publishable_net_worth(estimate, candidate)
    ]
    financially_available.sort(
        key=lambda item: (
            -item[1].net_worth.median_usd,  # type: ignore[union-attr]
            -item[1].net_worth.p10_usd,  # type: ignore[union-attr]
            -item[1].confidence.coverage,  # type: ignore[union-attr]
            -item[1].last_financial_update.toordinal(),  # type: ignore[union-attr]
            -item[0].location.confidence,
            item[0].person_id,
        )
    )
    selected = financially_available[: request.top_n]
    candidate_count = len(pool.candidates)
    evaluated_count = len(evaluated)
    unevaluated_count = candidate_count - evaluated_count
    scored_count = len(financially_available)
    insufficient_count = evaluated_count - scored_count
    returned_count = len(selected)
    shortfall_count = max(0, request.top_n - returned_count)
    maximum_radius_reached = effective_radius >= round(request.max_radius_km, 3) - 0.001

    if scored_count == 0:
        financial_status = "FINANCIAL_COVERAGE_INSUFFICIENT"
    elif insufficient_count == 0:
        financial_status = "AVAILABLE"
    else:
        financial_status = "PARTIAL"

    reasons: list[str] = []
    if scored_count == 0:
        reasons.append("FINANCIAL_COVERAGE_INSUFFICIENT")
    elif insufficient_count:
        reasons.append("FINANCIAL_EVIDENCE_PARTIAL")
    if candidate_count == 0:
        reasons.append("NO_LOCATION_CANDIDATES")
    elif candidate_count < request.top_n:
        reasons.append("LOCATION_CANDIDATE_POOL_BELOW_TARGET")
    if maximum_radius_reached and returned_count < request.top_n:
        reasons.append("MAX_RADIUS_REACHED")

    if returned_count >= request.top_n:
        result_status = "TARGET_MET"
        reasons = []
    elif returned_count:
        result_status = "PARTIAL"
    else:
        result_status = "EMPTY"

    provider_status = provider.source_status()
    source_status = [
        *_curate_net_worth_source_status(pool.source_status),
        provider_status,
    ]
    results = [
        _serialize_net_worth_result(
            rank=index + 1,
            candidate=candidate,
            estimate=estimate,
            query_point=resolution.point,
        )
        for index, (candidate, estimate) in enumerate(selected)
    ]
    return NearbyNetWorthResponse.model_validate(
        {
            **common,
            "financial_coverage": {
                "status": financial_status,
                "candidate_count": candidate_count,
                "discovered_count": candidate_count,
                "evaluated_count": evaluated_count,
                "unevaluated_count": unevaluated_count,
                "scored_count": scored_count,
                "insufficient_evidence_count": insufficient_count,
            },
            "result_set": {
                "status": result_status,
                "requested_count": request.top_n,
                "returned_count": returned_count,
                "shortfall_count": shortfall_count,
                "target_satisfied": returned_count >= request.top_n,
                "reasons": list(dict.fromkeys(reasons)),
            },
            "search": {
                "performed": True,
                "scope": "ASSOCIATION_RADIUS",
                "expanded": len(expansion_steps) > 1,
                "expansion_steps_km": [round(radius, 3) for radius in expansion_steps],
                "initial_radius_km": request.initial_radius_km,
                "effective_radius_km": round(effective_radius, 3),
                "maximum_radius_km": request.max_radius_km,
                "maximum_radius_reached": maximum_radius_reached,
            },
            "source_status": source_status,
            "results": results,
        }
    )


def _v4_radius_km(request: NetWorthV4Request) -> float:
    miles = request.selection.maximum_radius_miles
    return min(500.0, round((miles * 1.609344) if miles is not None else 500.0, 6))


def _v4_legacy_request(request: NetWorthV4Request) -> NearbyNetWorthRequest:
    maximum_radius_km = _v4_radius_km(request)
    strict_radius = request.selection.geography_mode == "strict-radius"
    initial_radius_km = maximum_radius_km if strict_radius else min(16.09344, maximum_radius_km)
    return NearbyNetWorthRequest(
        query=NetWorthQueryLocationInput.model_validate(request.query.model_dump(mode="python")),
        # Evaluate the largest public result window before applying v4 evidence
        # filters. The public response is still capped at the caller's requested
        # 100/150/200 count.
        top_n=200,
        initial_radius_km=initial_radius_km,
        max_radius_km=maximum_radius_km,
        auto_expand=not strict_radius,
    )


def _access_policy_http_error(exc: AccessPolicyError) -> HTTPException:
    headers = (
        {"Retry-After": str(exc.retry_after_seconds)}
        if exc.retry_after_seconds is not None
        else None
    )
    return HTTPException(
        status_code=exc.http_status,
        detail=exc.http_detail(),
        headers=headers,
    )


def _server_audit_request_id(request: Request) -> AuditRequestId:
    value = getattr(request.state, "audit_request_id", None)
    if isinstance(value, AuditRequestId):
        return value
    # Defensive fallback for direct ASGI/unit invocation outside the normal
    # middleware chain. It still never trusts caller input.
    return generate_audit_request_id()


def _log_v4_audit(
    *,
    access,  # type: ignore[no-untyped-def]
    request_id: AuditRequestId,
    outcome: AuditOutcome,
    status_code: int,
    result_count: int | None,
    upstream: NearbyNetWorthResponse | None = None,
) -> None:
    settings = get_settings()
    snapshot_id: str | None = None
    snapshot_sha256: str | None = None
    used_florida_snapshot = bool(
        upstream is not None
        and any(
            source.source == "FLORIDA_FORM_6_DECLARED_TOTALS"
            and source.status in {"OK", "EMPTY"}
            for source in upstream.source_status
        )
    )
    if settings.form6_source_enabled and used_florida_snapshot:
        repository = _net_worth_snapshot_repository()
        if repository is not None:
            try:
                status = repository.status()
            except SnapshotUnavailableError:
                pass
            else:
                snapshot_id = status.snapshot_id
                snapshot_sha256 = status.snapshot_sha256
    event = build_access_audit_event(
        access,
        request_id=request_id,
        outcome=outcome,
        status_code=status_code,
        result_count=result_count,
        snapshot_id=snapshot_id,
        snapshot_sha256=snapshot_sha256,
        model_version=NET_WORTH_MODEL_VERSION,
    )
    logger.info("consumer_access_audit %s", json.dumps(event, sort_keys=True))


@app.post(
    _V4_CONSENT_ROUTE,
    response_model=CoordinateConsentReceipt,
)
def issue_v4_coordinate_consent(
    request: CoordinateConsentIssueRequest,
    http_request: Request,
    x_nws_api_key: Annotated[
        str | None,
        Header(alias="X-NWS-API-Key"),
    ] = None,
) -> CoordinateConsentReceipt:
    """Mint a short-lived receipt after a trusted BFF records user consent."""

    settings = get_settings()
    if not settings.v4_enabled:
        raise HTTPException(
            status_code=503,
            detail={"code": "V4_NOT_ENABLED", "message": "The v4 contract is not enabled."},
        )
    registry = _consumer_access_registry()
    now = datetime.now(UTC)
    audit_request_id = _server_audit_request_id(http_request)
    principal: AuthenticatedConsumer | None = None
    try:
        principal = registry.authenticate(x_nws_api_key or "", now=now)
        if principal.project_id != request.project_id:
            raise AccessPolicyError(
                code="PROJECT_CONTEXT_MISMATCH",
                message="The caller project does not match the authenticated consumer.",
                http_status=403,
            )
        policy = next(
            (
                candidate
                for candidate in registry.consumers
                if candidate.consumer_id == principal.consumer_id
            ),
            None,
        )
        grant = next(
            (
                candidate
                for candidate in (policy.grants if policy is not None else ())
                if candidate.route == _V4_ROUTE and candidate.purpose == request.purpose_id
            ),
            None,
        )
        if grant is None:
            raise AccessPolicyError(
                code="ROUTE_PURPOSE_NOT_ALLOWED",
                message="This consumer is not approved for the requested operation.",
                http_status=403,
            )
        try:
            limit_result = consumer_rate_limiter.consume(
                key=(
                    "nws-coordinate-consent:v1:"
                    + hashlib.sha256(principal.consumer_id.encode()).hexdigest()
                ),
                limit=grant.requests_per_minute,
                window_seconds=60,
            )
        except Exception as exc:
            raise AccessPolicyError(
                code="RATE_LIMIT_BACKEND_UNAVAILABLE",
                message="Consumer quota verification is temporarily unavailable.",
                http_status=503,
            ) from exc
        if not limit_result.allowed:
            raise AccessPolicyError(
                code="RATE_LIMITED",
                message="The consumer request limit has been reached.",
                http_status=429,
                retry_after_seconds=limit_result.reset_after_seconds,
            )
    except AccessPolicyError as exc:
        denied_event = build_denied_access_audit_event(
            registry=registry,
            request_id=audit_request_id,
            error=exc,
            route=_V4_CONSENT_ROUTE,
            principal=principal,
            purpose=request.purpose_id,
        )
        logger.warning("consumer_access_audit %s", json.dumps(denied_event, sort_keys=True))
        raise _access_policy_http_error(exc) from exc

    http_request.state.rate_limit_remaining = limit_result.remaining
    http_request.state.rate_limit_reset_seconds = limit_result.reset_after_seconds
    http_request.state.rate_limit_limit = grant.requests_per_minute
    expires_at = now + timedelta(seconds=min(900, grant.coordinate_consent_max_age_seconds))
    receipt_id = issue_coordinate_consent_receipt(
        api_key=x_nws_api_key or "",
        consumer_id=principal.consumer_id,
        project_id=principal.project_id,
        route=_V4_ROUTE,
        purpose=request.purpose_id,
        audit_actor=request.audit_actor,
        issued_at=now,
        expires_at=expires_at,
    )
    actor_reference = (
        "actor_"
        + hashlib.sha256(f"{principal.project_id}\x00{request.audit_actor}".encode()).hexdigest()[
            :16
        ]
    )
    logger.info(
        "coordinate_consent_issued %s",
        json.dumps(
            {
                "actor_reference": actor_reference,
                "consumer_id": principal.consumer_id,
                "expires_at": expires_at.isoformat(),
                "project_id": principal.project_id,
                "purpose": request.purpose_id,
                "request_id": audit_request_id.value,
                "scope": request.scope,
            },
            sort_keys=True,
        ),
    )
    return CoordinateConsentReceipt(
        receipt_id=receipt_id,
        purpose_id=request.purpose_id,
        audit_actor=request.audit_actor,
        scope=request.scope,
        issued_at=now,
        expires_at=expires_at,
    )


@app.post(
    _V4_ROUTE,
    response_model=NetWorthV4Response,
)
def discover_net_worth_v4(
    request: NetWorthV4Request,
    http_request: Request,
    x_nws_api_key: Annotated[
        str | None,
        Header(alias="X-NWS-API-Key"),
    ] = None,
) -> NetWorthV4Response:
    """Apply project policy and a stricter public-safe view over the v3 snapshot."""

    settings = get_settings()
    if not settings.v4_enabled:
        raise HTTPException(
            status_code=503,
            detail={"code": "V4_NOT_ENABLED", "message": "The v4 contract is not enabled."},
        )
    registry = _consumer_access_registry()
    now = datetime.now(UTC)
    audit_request_id = _server_audit_request_id(http_request)
    principal: AuthenticatedConsumer | None = None
    location_mode = (
        LocationMode.COORDINATES if request.query.uses_coordinates else LocationMode.POSTAL_CODE
    )
    audit_actor_reference = (
        "actor_"
        + hashlib.sha256(
            (
                request.caller_context.project_id + "\x00" + request.caller_context.audit_actor
            ).encode("utf-8")
        ).hexdigest()[:16]
    )
    try:
        principal = registry.authenticate(x_nws_api_key or "", now=now)
        if principal.project_id != request.caller_context.project_id:
            raise AccessPolicyError(
                code="PROJECT_CONTEXT_MISMATCH",
                message="The caller project does not match the authenticated consumer.",
                http_status=403,
            )
        if (
            request.caller_context.authorization_scope != "PUBLIC_SAFE"
            or request.caller_context.requested_data_tier != "PUBLIC_SAFE"
        ):
            raise AccessPolicyError(
                code="DATA_TIER_NOT_AVAILABLE",
                message="This route serves only the public-safe data tier.",
                http_status=403,
            )

        consent: CoordinateConsent | None = None
        consent_verifier: CoordinateConsentVerifier | None = None
        if request.coordinate_consent is not None:
            if now > request.coordinate_consent.expires_at.astimezone(UTC):
                raise AccessPolicyError(
                    code="COORDINATE_CONSENT_EXPIRED",
                    message="A fresh location-consent receipt is required.",
                    http_status=403,
                )
            consent = CoordinateConsent(receipt_id=request.coordinate_consent.receipt_id)
            consent_verifier = SignedCoordinateConsentVerifier(
                api_key=x_nws_api_key or "",
                expected_audit_actor=request.coordinate_consent.audit_actor,
                expected_issued_at=request.coordinate_consent.issued_at,
                expected_expires_at=request.coordinate_consent.expires_at,
                receipt_consumer=_consent_receipt_consumer(),
            )
        access = registry.authorize(
            principal,
            AccessRequest(
                route=_V4_ROUTE,
                purpose=request.caller_context.purpose_id,
                top_n=request.selection.count,
                max_radius_km=_v4_radius_km(request),
                location_mode=location_mode,
                actor_reference=audit_actor_reference,
                coordinate_consent=consent,
            ),
            rate_limiter=consumer_rate_limiter,
            consent_verifier=consent_verifier,
            now=now,
        )
    except AccessPolicyError as exc:
        denied_event = build_denied_access_audit_event(
            registry=registry,
            request_id=audit_request_id,
            error=exc,
            route=_V4_ROUTE,
            principal=principal,
            purpose=request.caller_context.purpose_id,
            location_mode=location_mode,
        )
        logger.warning("consumer_access_audit %s", json.dumps(denied_event, sort_keys=True))
        raise _access_policy_http_error(exc) from exc

    http_request.state.rate_limit_remaining = access.rate_limit_remaining
    http_request.state.rate_limit_reset_seconds = access.rate_limit_reset_after_seconds
    http_request.state.rate_limit_limit = access.requests_per_minute
    upstream: NearbyNetWorthResponse | None = None
    try:
        upstream = _discover_net_worth(_v4_legacy_request(request))
        projected = project_nearby_net_worth_v4(
            upstream.model_dump(mode="json"),
            request,
        )
    except NetWorthV4ProjectionError as exc:
        _log_v4_audit(
            access=access,
            request_id=audit_request_id,
            outcome=AuditOutcome.ERROR,
            status_code=409,
            result_count=None,
            upstream=upstream,
        )
        raise HTTPException(
            status_code=409,
            detail={
                "code": "V4_REQUEST_CANNOT_BE_SATISFIED",
                "message": "The active public snapshot cannot satisfy this request.",
            },
        ) from exc
    except HTTPException as exc:
        _log_v4_audit(
            access=access,
            request_id=audit_request_id,
            outcome=AuditOutcome.ERROR,
            status_code=exc.status_code,
            result_count=None,
            upstream=upstream,
        )
        raise
    except Exception:
        _log_v4_audit(
            access=access,
            request_id=audit_request_id,
            outcome=AuditOutcome.ERROR,
            status_code=500,
            result_count=None,
            upstream=upstream,
        )
        raise

    _log_v4_audit(
        access=access,
        request_id=audit_request_id,
        outcome=(AuditOutcome.SUCCESS if projected.results else AuditOutcome.EMPTY),
        status_code=200,
        result_count=len(projected.results),
        upstream=upstream,
    )
    return projected


@app.post("/v2/nearby-network/discover")
def discover_network(
    request: NearbyDiscoveryRequest,
    _: Annotated[AccessContext, Depends(require_api_access)],
) -> dict[str, object]:
    """Return reviewed public-professional results; clients never submit people."""

    resolution = _resolve_query(request.query)
    settings = get_settings()
    response = _base_response(resolution=resolution, settings=settings)
    if not resolution.is_covered:
        response["summary"] = _uncovered_summary(request, resolution.coverage)
        response["result_set"] = _uncovered_result_set_accountability(
            request,
            resolution.coverage,
        )
        response["search"] = _uncovered_search_accountability(request)
        response["source_health"] = _aggregate_source_health((), mode="NOT_QUERIED")
        response["results"] = []
        return response

    assert resolution.point is not None
    backend = resolution.coverage.get("candidate_backend")
    if backend == _NATIONAL_BACKEND:
        if not settings.national_sources_enabled:
            raise HTTPException(
                status_code=503,
                detail={"code": "NATIONAL_CANDIDATE_BACKEND_UNAVAILABLE"},
            )
        batch = _fetch_national_candidates(resolution=resolution, request=request)
        response["source_status"] = list(batch.source_status)
        source_status = batch.source_status
        available_sources = [
            source for source in batch.source_status if source.get("status") in {"OK", "EMPTY"}
        ]
        if not available_sources:
            raise HTTPException(
                status_code=503,
                detail={"code": "NATIONAL_CANDIDATE_BACKEND_UNAVAILABLE"},
            )
        metadata_by_id = batch.metadata
        source_candidates = batch.candidates
        candidate_backend = "national-sec-nppes-public-professional-snapshot"
        graph_mode = "authoritative-registry-role-taxonomy-proxy"
        data_freshness = (
            "Live request over SEC Section 16 and CMS NPPES source snapshots; inspect "
            "source_status for each source watermark and degradation state."
        )
        model_version = settings.national_model_version
        source_health_mode = "LIVE_PUBLIC_SOURCE_SNAPSHOTS"
    elif backend == _KIRKLAND_BACKEND:
        metadata_by_id = BOOTSTRAP_METADATA
        source_candidates = BOOTSTRAP_CANDIDATES
        candidate_backend = _KIRKLAND_BACKEND
        graph_mode = "role-taxonomy-proxy"
        data_freshness = (
            "Versioned reviewed public-association release; a regional graph is not yet populated."
        )
        model_version = settings.model_version
        source_status = ()
        source_health_mode = "REVIEWED_RELEASE"
    else:
        raise HTTPException(status_code=503, detail={"code": "UNKNOWN_CANDIDATE_BACKEND"})

    lane_filter = set(request.filters.lanes)
    tag_filter = {tag.casefold() for tag in request.filters.tags}
    candidates = [
        candidate
        for candidate in source_candidates
        if (not lane_filter or candidate.primary_lane in lane_filter)
        and (not tag_filter or tag_filter.issubset({tag.casefold() for tag in candidate.tags}))
    ]
    results, summary = discover_nearby_people(
        candidates,
        query_point=resolution.point,
        top_n=request.top_n,
        initial_radius_km=request.initial_radius_km,
        max_radius_km=request.max_radius_km,
        auto_expand=request.auto_expand,
        diversity=request.diversity,
        minimum_confidence=_CONFIDENCE_THRESHOLDS[request.filters.minimum_confidence_grade],
        model_version=model_version,
    )
    response["summary"] = {
        "requested_top_n": request.top_n,
        "verified_seed_candidate_count": len(candidates),
        "reviewed_public_association_candidate_count": (
            len(candidates) if backend == _KIRKLAND_BACKEND else 0
        ),
        "public_registry_candidate_count": (len(candidates) if backend == _NATIONAL_BACKEND else 0),
        "returned_count": summary.returned_count,
        "initial_radius_km": request.initial_radius_km,
        "effective_radius_km": summary.effective_radius_km,
        "maximum_radius_km": request.max_radius_km,
        "minimum_confidence_grade": request.filters.minimum_confidence_grade,
        "diversity_applied": summary.diversity_applied,
        "coverage_status": resolution.coverage["status"],
        "search_performed": True,
        "candidate_backend": candidate_backend,
        "graph_mode": graph_mode,
        "data_freshness": data_freshness,
    }
    source_health = _aggregate_source_health(source_status, mode=source_health_mode)
    response["source_health"] = source_health
    response["search"] = _search_accountability(request, summary, results)
    response["result_set"] = _result_set_accountability(
        request=request,
        summary=summary,
        source_candidate_count=len(source_candidates),
        filtered_candidate_count=len(candidates),
        backend=backend,
        source_status=source_status,
        source_health=source_health,
    )
    response["results"] = [_serialize_result(item, metadata_by_id) for item in results]
    return response
