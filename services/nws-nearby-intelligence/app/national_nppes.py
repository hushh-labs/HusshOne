"""Nationwide public-healthcare candidate adapter backed by CMS NPPES.

The source is a least-privilege projection view populated from the official National
Plan and Provider Enumeration System (NPPES).  This adapter uses only an active
provider's public professional identity, taxonomy, and practice *postal area*.
The NWS database role has no access to the underlying provider table, so street
addresses, telephone numbers, mailing addresses, and raw payloads are excluded
at both the database and application boundaries.

``psycopg`` is imported only when the production connection path is used.  The
module therefore remains importable in the lightweight, database-free test and
developer environments used by the NWS service.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from typing import Any

from app.market_release import BootstrapMetadata, SourceCitation
from app.nws_models import (
    GeoPoint,
    LocationAssociationKind,
    LocationGranularity,
    NearbyCandidate,
    NwsFeatureVector,
    ProfessionalLane,
    ProfileClass,
    PublicLocationAssociation,
    VerificationStatus,
)

NPPES_SOURCE_ID = "CMS_NPPES"
NPPES_REGISTRY_URL = "https://npiregistry.cms.hhs.gov/"
NPPES_MAX_QUERY_LIMIT = 2_000
NPPES_STATEMENT_TIMEOUT_MS = 8_000

Row = Mapping[str, Any]
RowQuery = Callable[[str, Mapping[str, object]], Sequence[Row]]
ConnectionFactory = Callable[[], AbstractContextManager[Any]]


@dataclass(frozen=True)
class NationalNppesResult:
    """One source's candidates, per-person evidence, and fan-out status."""

    candidates: tuple[NearbyCandidate, ...]
    metadata: dict[str, BootstrapMetadata]
    source_status: dict[str, object]


class NppesCandidateProvider:
    """Read candidates from the restricted ``nws_public_professionals`` view.

    ``row_query`` is the smallest test seam: it receives the exact SQL and
    parameters and returns mapping-shaped rows.  ``connection_factory`` is a
    second seam for exercising connection/cursor behavior.  Production callers
    normally provide only ``database_url``.
    """

    _RADIUS_QUERY = """
    SELECT p.npi,
           p.first_name,
           p.middle_name,
           p.last_name,
           p.credential,
           p.primary_taxonomy_code,
           p.primary_taxonomy_desc,
           p.city,
           p.state,
           p.zip,
           p.lat,
           p.lng,
           p.last_seen
      FROM public.nws_public_professionals p
     WHERE p.geog IS NOT NULL
       AND NULLIF(BTRIM(p.first_name), '') IS NOT NULL
       AND NULLIF(BTRIM(p.last_name), '') IS NOT NULL
       AND p.last_seen IS NOT NULL
       AND ST_DWithin(
             p.geog,
             ST_SetSRID(
               ST_MakePoint(%(longitude)s, %(latitude)s),
               4326
             )::geography,
             %(radius_meters)s
           )
     ORDER BY ST_Distance(
                p.geog,
                ST_SetSRID(
                  ST_MakePoint(%(longitude)s, %(latitude)s),
                  4326
                )::geography
              ),
              p.last_seen DESC,
              p.npi
     LIMIT %(limit)s
    """

    _POSTAL_QUERY = """
    SELECT p.npi,
           p.first_name,
           p.middle_name,
           p.last_name,
           p.credential,
           p.primary_taxonomy_code,
           p.primary_taxonomy_desc,
           p.city,
           p.state,
           p.zip,
           p.lat,
           p.lng,
           p.last_seen
      FROM public.nws_public_professionals p
     WHERE p.zip = %(postal_code)s
       AND p.geog IS NOT NULL
       AND NULLIF(BTRIM(p.first_name), '') IS NOT NULL
       AND NULLIF(BTRIM(p.last_name), '') IS NOT NULL
       AND p.last_seen IS NOT NULL
     ORDER BY p.last_seen DESC, p.npi
     LIMIT %(limit)s
    """

    def __init__(
        self,
        database_url: str | None = None,
        *,
        row_query: RowQuery | None = None,
        connection_factory: ConnectionFactory | None = None,
        clock: Callable[[], datetime] | None = None,
        statement_timeout_ms: int = NPPES_STATEMENT_TIMEOUT_MS,
        connect_timeout_seconds: int = 3,
    ) -> None:
        if row_query is not None and connection_factory is not None:
            raise ValueError("provide row_query or connection_factory, not both")
        self._database_url = (database_url or "").strip()
        self._row_query = row_query
        self._connection_factory = connection_factory
        self._clock = clock or (lambda: datetime.now(UTC))
        if not 500 <= statement_timeout_ms <= 30_000:
            raise ValueError("statement_timeout_ms must be between 500 and 30000")
        if not 1 <= connect_timeout_seconds <= 30:
            raise ValueError("connect_timeout_seconds must be between 1 and 30")
        self._statement_timeout_ms = statement_timeout_ms
        self._connect_timeout_seconds = connect_timeout_seconds

    def fetch(
        self,
        *,
        query_point: GeoPoint,
        radius_km: float,
        limit: int,
        postal_code: str | None = None,
    ) -> NationalNppesResult:
        """Return a fail-soft NPPES result for one national location query."""

        if not 0 < radius_km <= 500:
            raise ValueError("radius_km must be greater than 0 and at most 500")
        if not 1 <= limit <= NPPES_MAX_QUERY_LIMIT:
            raise ValueError(f"limit must be between 1 and {NPPES_MAX_QUERY_LIMIT}")

        normalized_postal = str(postal_code or "").strip()
        if postal_code is not None and not (
            len(normalized_postal) == 5 and normalized_postal.isdecimal()
        ):
            raise ValueError("postal_code must be a five-digit US ZIP")

        now = _as_utc(self._clock())
        if normalized_postal:
            query = self._POSTAL_QUERY
            query_mode = "POSTAL_CODE"
            params: dict[str, object] = {
                "postal_code": normalized_postal,
                "limit": limit,
            }
        else:
            query = self._RADIUS_QUERY
            query_mode = "COORDINATE_RADIUS"
            params = {
                "latitude": query_point.latitude,
                "longitude": query_point.longitude,
                "radius_meters": round(radius_km * 1000.0, 3),
                "limit": limit,
            }
        try:
            rows = list(self._execute(query, params))
        except Exception as exc:  # a source failure must not erase other national sources
            return NationalNppesResult(
                candidates=(),
                metadata={},
                source_status=_source_status(
                    status="UNAVAILABLE",
                    candidate_count=0,
                    rows_received=0,
                    rows_rejected=0,
                    source_as_of=None,
                    truncated=False,
                    queried_at=now,
                    query_mode=query_mode,
                    error_code=_safe_error_code(exc),
                ),
            )

        candidates: list[NearbyCandidate] = []
        metadata: dict[str, BootstrapMetadata] = {}
        source_times: list[datetime] = []
        rejected = 0
        for row in rows:
            try:
                candidate, candidate_metadata, source_time = _candidate_from_row(row, now=now)
            except (KeyError, TypeError, ValueError):
                rejected += 1
                continue
            if candidate.person_id in metadata:
                rejected += 1
                continue
            candidates.append(candidate)
            metadata[candidate.person_id] = candidate_metadata
            source_times.append(source_time)

        status = "OK" if candidates else "EMPTY"
        source_as_of = max(source_times).isoformat() if source_times else None
        return NationalNppesResult(
            candidates=tuple(candidates),
            metadata=metadata,
            source_status=_source_status(
                status=status,
                candidate_count=len(candidates),
                rows_received=len(rows),
                rows_rejected=rejected,
                source_as_of=source_as_of,
                truncated=len(rows) >= limit,
                queried_at=now,
                query_mode=query_mode,
                error_code=None,
            ),
        )

    def _execute(self, query: str, params: Mapping[str, object]) -> Sequence[Row]:
        if self._row_query is not None:
            return self._row_query(query, params)

        if self._connection_factory is not None:
            with self._connection_factory() as connection:
                connection.execute(
                    "SET LOCAL statement_timeout = %(timeout_ms)s",
                    {"timeout_ms": self._statement_timeout_ms},
                )
                return connection.execute(query, params).fetchall()

        if not self._database_url:
            raise RuntimeError("NPPES_DATABASE_URL_NOT_CONFIGURED")

        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:  # pragma: no cover - deployment configuration path
            raise RuntimeError("NPPES_PSYCOPG_NOT_INSTALLED") from exc

        with psycopg.connect(
            self._database_url,
            row_factory=dict_row,
            connect_timeout=self._connect_timeout_seconds,
            options=f"-c statement_timeout={self._statement_timeout_ms}",
        ) as connection:
            return connection.execute(query, params).fetchall()


def _candidate_from_row(
    row: Row, *, now: datetime
) -> tuple[NearbyCandidate, BootstrapMetadata, datetime]:
    npi = str(row["npi"] or "").strip()
    if not (len(npi) == 10 and npi.isdecimal()):
        raise ValueError("invalid NPI")

    name_parts = [row.get("first_name"), row.get("middle_name"), row.get("last_name")]
    display_name = _display_text(" ".join(str(part or "").strip() for part in name_parts))
    if not display_name:
        raise ValueError("provider needs a public display name")

    latitude = float(row["lat"])
    longitude = float(row["lng"])
    point = GeoPoint(latitude, longitude)
    source_time = _coerce_datetime(row["last_seen"])
    source_date = source_time.date()
    age_days = max(0, (now.date() - source_date).days)

    city = _display_text(str(row.get("city") or ""))
    state = str(row.get("state") or "").strip().upper()
    postal_code = str(row.get("zip") or "").strip()[:5]
    if not city or len(state) != 2 or len(postal_code) != 5 or not postal_code.isdecimal():
        raise ValueError("provider needs a public practice postal area")

    credential = str(row.get("credential") or "").strip().upper()
    taxonomy_code = str(row.get("primary_taxonomy_code") or "").strip().upper()
    taxonomy = _display_text(str(row.get("primary_taxonomy_desc") or ""))
    professional_label = taxonomy or "Healthcare professional"
    headline = f"{credential} · {professional_label}" if credential else professional_label
    profile_url = f"{NPPES_REGISTRY_URL}provider-view/{npi}"

    fact_types = [
        "identity",
        "active_registry_status",
        "public_practice_postal_area",
        "source_freshness",
    ]
    if taxonomy_code or taxonomy:
        fact_types.append("professional_taxonomy")

    citation = SourceCitation(
        publisher="Centers for Medicare & Medicaid Services",
        title="National Plan and Provider Enumeration System public provider record",
        url=profile_url,
        fact_types=tuple(fact_types),
        retrieved_at=source_time.isoformat(),
    )
    review_flags = (
        "SOURCE_VERIFIED_PROVISIONAL",
        "SINGLE_SOURCE_FAMILY",
        "POSTAL_CENTROID_ASSOCIATION",
        "NO_OBSERVED_GRAPH",
        "NO_FINANCIAL_INPUTS",
    )

    candidate = NearbyCandidate(
        person_id=f"nppes:{npi}",
        display_name=display_name,
        headline=headline,
        profile_class=ProfileClass.PUBLIC_PROFESSIONAL,
        verification_status=VerificationStatus.VERIFIED,
        primary_lane=ProfessionalLane.KNOWLEDGE,
        organization_id=None,
        organization_name=None,
        graph_community_id=None,
        location=PublicLocationAssociation(
            label=f"{city}, {state} {postal_code} public practice area",
            point=point,
            kind=LocationAssociationKind.SELF_PUBLISHED_PROFESSIONAL,
            granularity=LocationGranularity.POSTAL_AREA,
            confidence=0.78,
            source_count=1,
            as_of_date=source_date,
        ),
        features=_registry_features(
            age_days=age_days,
            has_professional_taxonomy=bool(taxonomy_code or taxonomy),
            evidence_count=len(fact_types),
        ),
        public_profile_url=profile_url,
        tags=tuple(
            item
            for item in (
                "nppes",
                "healthcare",
                "public-healthcare-professional",
                taxonomy_code.casefold() if taxonomy_code else None,
            )
            if item
        ),
    )
    return (
        candidate,
        BootstrapMetadata(
            score_status="PROVISIONAL",
            revalidation_required=age_days > 90,
            citations=(citation,),
            source_family_count=1,
            evidence_fact_count=len(fact_types),
            review_flags=review_flags,
        ),
        source_time,
    )


def _registry_features(
    *, age_days: int, has_professional_taxonomy: bool, evidence_count: int
) -> NwsFeatureVector:
    """Map only facts the registry supports; all network/wealth signals stay zero."""

    freshness = round(max(0.35, 1.0 - min(age_days, 365) / 365.0), 4)
    return NwsFeatureVector(
        pagerank_percentile=0.0,
        kcore_percentile=0.0,
        bridging_percentile=0.0,
        cross_sector_percentile=0.0,
        role_authority_percentile=0.40 if has_professional_taxonomy else 0.32,
        institution_strength_percentile=0.0,
        founder_board_percentile=0.0,
        outcome_track_record_percentile=0.0,
        knowledge_creation_percentile=0.0,
        civic_leadership_percentile=0.0,
        capital_access_percentile=0.0,
        trusted_reach_percentile=0.0,
        verified_social_reach_percentile=0.0,
        freshness=freshness,
        source_quality=0.99,
        source_diversity=0.26,
        identity_confidence=0.98,
        evidence_count=evidence_count,
        suspicious_pattern_ratio=0.0,
        self_published_source_ratio=0.0,
        dominant_source_ratio=1.0,
    )


def _source_status(
    *,
    status: str,
    candidate_count: int,
    rows_received: int,
    rows_rejected: int,
    source_as_of: str | None,
    truncated: bool,
    queried_at: datetime,
    query_mode: str,
    error_code: str | None,
) -> dict[str, object]:
    result: dict[str, object] = {
        "source": NPPES_SOURCE_ID,
        "status": status,
        "scope": "US_ACTIVE_INDIVIDUAL_HEALTHCARE_PROFESSIONALS",
        "candidate_count": candidate_count,
        "rows_received": rows_received,
        "rows_rejected": rows_rejected,
        "source_as_of": source_as_of,
        "queried_at": queried_at.isoformat(),
        "query_mode": query_mode,
        "truncated": truncated,
        "location_granularity": LocationGranularity.POSTAL_AREA.value,
        "score_status": "PROVISIONAL",
        "association_notice": (
            "Location is an NPPES public practice postal area, not a residence or a claim "
            "of physical presence."
        ),
    }
    if error_code:
        result["error_code"] = error_code
    return result


def _safe_error_code(exc: Exception) -> str:
    message = str(exc)
    if message in {"NPPES_DATABASE_URL_NOT_CONFIGURED", "NPPES_PSYCOPG_NOT_INSTALLED"}:
        return message
    return "NPPES_QUERY_FAILED"


def _coerce_datetime(value: object) -> datetime:
    if isinstance(value, datetime):
        return _as_utc(value)
    if isinstance(value, date):
        return datetime.combine(value, time.min, tzinfo=UTC)
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return _as_utc(parsed)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _display_text(value: str) -> str:
    compact = " ".join(value.strip().split())
    return compact.title() if compact.isupper() else compact
