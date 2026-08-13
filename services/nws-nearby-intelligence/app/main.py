from __future__ import annotations

import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.middleware.base import BaseHTTPMiddleware

from app.bootstrap_data import BOOTSTRAP_CANDIDATES, BOOTSTRAP_METADATA
from app.coverage import QueryResolution, resolve_coordinate_query, resolve_postal_query
from app.market_release import get_market_release
from app.nearby import discover_nearby_people
from app.nws import COMPONENT_LABELS, GLOBAL_NWS_WEIGHTS
from app.nws_models import ProfessionalLane
from app.security import AccessContext, require_api_access
from app.settings import get_settings

logger = logging.getLogger("nws_nearby_intelligence")


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


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class HealthResponse(StrictModel):
    status: Literal["ok"]
    service: Literal["nws-nearby-intelligence"]
    version: str
    data_mode: str


class ReadyResponse(HealthResponse):
    candidate_count: int
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
        if has_postal_code and self.country_code is None and self.postal_code != "98033":
            raise ValueError(
                "country_code is required with postal_code except for legacy US postal code 98033"
            )
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


def _serialize_result(item) -> dict[str, object]:  # type: ignore[no-untyped-def]
    metadata = BOOTSTRAP_METADATA[item.candidate.person_id]
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
        "model_version": get_settings().model_version,
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
    return "50–100 km"


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
    return ReadyResponse(
        status="ok",
        service="nws-nearby-intelligence",
        version=settings.service_version,
        data_mode=settings.data_mode,
        candidate_count=len(BOOTSTRAP_CANDIDATES),
        complete=False,
        model_version=settings.model_version,
    )


@app.post("/v2/nearby-network/discover")
def discover_network(
    request: NearbyDiscoveryRequest,
    _: Annotated[AccessContext, Depends(require_api_access)],
) -> dict[str, object]:
    """Return reviewed public-professional results; clients never submit people."""

    resolution = _resolve_query(request.query)
    settings = get_settings()
    release = get_market_release()
    response: dict[str, object] = {
        "query": resolution.query,
        "coverage": resolution.coverage,
        "snapshot": {
            "data_mode": settings.data_mode,
            "score_status": "PROVISIONAL",
            "complete": False,
            "model_version": settings.model_version,
            # verified_at is retained for older clients; reviewed_at is the
            # precise name for a curated market-release review date.
            "verified_at": settings.release_reviewed_at,
            "reviewed_at": settings.release_reviewed_at,
        },
        "release": {
            "release_id": release.release_id,
            "market_id": release.market_id,
            "model_version": release.model_version,
            "source_retrieved_at": release.source_retrieved_at,
            "source_policy_version": release.source_policy_version,
            "candidate_set_sha256": release.candidate_set_sha256,
            "source_registry_sha256": release.source_registry_sha256,
            "manifest_sha256": release.manifest_sha256,
        },
        "score_definition": (
            "NWS estimates public professional network strength and opportunity access. It is not "
            "financial net worth, and nearby means a public professional, institutional, civic, or "
            "opt-in association—not physical presence or a private home."
        ),
        "generated_at": datetime.now(UTC).isoformat(),
    }
    if not resolution.is_covered:
        response["summary"] = _uncovered_summary(request, resolution.coverage)
        response["results"] = []
        return response

    assert resolution.point is not None
    lane_filter = set(request.filters.lanes)
    tag_filter = {tag.casefold() for tag in request.filters.tags}
    candidates = [
        candidate
        for candidate in BOOTSTRAP_CANDIDATES
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
    )
    response["summary"] = {
        "requested_top_n": request.top_n,
        "verified_seed_candidate_count": len(candidates),
        "reviewed_public_association_candidate_count": len(candidates),
        "returned_count": summary.returned_count,
        "initial_radius_km": request.initial_radius_km,
        "effective_radius_km": summary.effective_radius_km,
        "maximum_radius_km": request.max_radius_km,
        "minimum_confidence_grade": request.filters.minimum_confidence_grade,
        "diversity_applied": summary.diversity_applied,
        "coverage_status": resolution.coverage["status"],
        "search_performed": True,
        "candidate_backend": "reviewed-public-association-release",
        "graph_mode": "role-taxonomy-proxy",
        "data_freshness": (
            "Versioned reviewed public-association release; a regional graph and production "
            "PostGIS index are not yet populated."
        ),
    }
    response["results"] = [_serialize_result(item) for item in results]
    return response
