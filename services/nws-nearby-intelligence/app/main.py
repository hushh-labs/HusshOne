from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.bootstrap_data import BOOTSTRAP_CANDIDATES, BOOTSTRAP_METADATA
from app.coverage import QueryResolution, resolve_coordinate_query, resolve_postal_query
from app.financial_context import public_financial_context_policy
from app.market_release import BootstrapMetadata, get_market_release
from app.national_nppes import NationalNppesResult, NppesCandidateProvider
from app.national_sec import (
    NationalSecBatch,
    NationalSecProfessionalAdapter,
    NationalSecSourceError,
)
from app.nearby import discover_nearby_people
from app.nws import COMPONENT_LABELS, GLOBAL_NWS_WEIGHTS
from app.nws_models import NearbyCandidate, ProfessionalLane
from app.organization_discovery import (
    get_organization_anchor_release,
    public_association_context,
    validate_anchor_coverage,
)
from app.postal import get_us_postal_index, normalize_us_postal_code
from app.security import AccessContext, require_api_access
from app.settings import get_settings
from app.us_boundary import get_us_boundary_index

logger = logging.getLogger("nws_nearby_intelligence")


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
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > settings.max_request_bytes:
                    return Response(
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
                return Response(
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

        started = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Request-ID"] = request.headers.get("X-Request-ID", "generated")[:128]
        if hasattr(request.state, "rate_limit_remaining"):
            response.headers["X-RateLimit-Limit"] = str(settings.rate_limit_per_minute)
            response.headers["X-RateLimit-Remaining"] = str(request.state.rate_limit_remaining)
            response.headers["X-RateLimit-Reset"] = str(request.state.rate_limit_reset_seconds)
        logger.info(
            "request_complete method=%s path=%s status=%s duration_ms=%s",
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
    national_sources_enabled: bool
    complete: Literal[False]
    model_version: str


class QueryLocationInput(StrictModel):
    postal_code: str | None = Field(
        default=None,
        min_length=3,
        max_length=16,
        pattern=r"^[A-Z0-9][A-Z0-9 -]*[A-Z0-9]$",
    )
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)

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
        if has_postal_code and self.country_code is None:
            try:
                normalize_us_postal_code(self.postal_code or "")
            except ValueError as exc:
                raise ValueError(
                    "country_code is required unless postal_code is a US ZIP or ZIP+4"
                ) from exc
        return self


class NearbyFiltersInput(StrictModel):
    lanes: list[ProfessionalLane] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list, max_length=20)
    minimum_confidence_grade: Literal["A", "B", "C", "D"] = "B"


class NearbyDiscoveryRequest(StrictModel):
    query: QueryLocationInput
    top_n: int = Field(default=100, ge=1, le=400)
    initial_radius_km: float = Field(default=20, gt=0, le=250)
    max_radius_km: float = Field(default=100, gt=0, le=500)
    auto_expand: bool = True
    diversity: bool = True
    filters: NearbyFiltersInput = Field(default_factory=NearbyFiltersInput)

    @model_validator(mode="after")
    def validate_radius(self) -> NearbyDiscoveryRequest:
        if self.max_radius_km < self.initial_radius_km:
            raise ValueError("max_radius_km must be >= initial_radius_km")
        return self


_CONFIDENCE_THRESHOLDS = {"A": 0.85, "B": 0.70, "C": 0.55, "D": 0.0}
_KIRKLAND_BACKEND = "reviewed-public-association-release"
_NATIONAL_BACKEND = "national-public-association-index"
_MAX_NPPES_EXPANSION_ATTEMPTS = 2
_NPPES_EXPANSION_BUDGET_SECONDS = 12.0


@dataclass(frozen=True)
class NationalCandidateBatch:
    candidates: tuple[NearbyCandidate, ...]
    metadata: dict[str, BootstrapMetadata]
    source_status: tuple[dict[str, object], ...]


@lru_cache(maxsize=1)
def _sec_provider() -> NationalSecProfessionalAdapter:
    source_settings = get_settings()
    return NationalSecProfessionalAdapter(
        base_url=source_settings.sec_api_base_url,
        bearer_token=source_settings.sec_api_key,
        timeout_seconds=source_settings.sec_timeout_seconds,
        location_decimals=source_settings.query_location_decimals,
    )


@lru_cache(maxsize=1)
def _nppes_provider() -> NppesCandidateProvider:
    source_settings = get_settings()
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


def _serialize_result(item, metadata_by_id) -> dict[str, object]:  # type: ignore[no-untyped-def]
    metadata = metadata_by_id[item.candidate.person_id]
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
    if distance_km < 2:
        return "within 2 km"
    if distance_km < 5:
        return "2–5 km"
    if distance_km < 10:
        return "5–10 km"
    if distance_km < 25:
        return "10–25 km"
    if distance_km < 50:
        return "25–50 km"
    if distance_km < 100:
        return "50–100 km"
    if distance_km < 250:
        return "100–250 km"
    return "250–500 km"


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
    return ReadyResponse(
        status="ok",
        service="nws-nearby-intelligence",
        version=settings.service_version,
        data_mode=settings.data_mode,
        candidate_count=len(BOOTSTRAP_CANDIDATES),
        geography_record_count=geography_record_count,
        national_sources_enabled=settings.national_sources_enabled,
        complete=False,
        model_version=(
            settings.national_model_version
            if settings.national_sources_enabled
            else settings.model_version
        ),
    )


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
    elif backend == _KIRKLAND_BACKEND:
        metadata_by_id = BOOTSTRAP_METADATA
        source_candidates = BOOTSTRAP_CANDIDATES
        candidate_backend = _KIRKLAND_BACKEND
        graph_mode = "role-taxonomy-proxy"
        data_freshness = (
            "Versioned reviewed public-association release; a regional graph is not yet populated."
        )
        model_version = settings.model_version
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
    response["results"] = [_serialize_result(item, metadata_by_id) for item in results]
    return response
