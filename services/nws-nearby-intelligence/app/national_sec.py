"""Bounded Section 16 professional-candidate adapter for nationwide NWS discovery.

The upstream service also carries securities and position values. This module is a
one-way policy boundary: it requests the source's non-financial professional ordering,
whitelists only public role/issuer-office facts, and never retains financial, contact,
street-address, or response-coordinate fields in candidate metadata.
"""

from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from app.geospatial import quantize_location
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

_MILES_PER_KM = 0.621371192237334
_MAX_SOURCE_RESULTS = 100
_MAX_RESPONSE_BYTES = 5_000_000
_SEC_DATASET_URL = (
    "https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets"
)
_ENTITY_MARKERS = re.compile(
    r"\b(?:LLC|L\.L\.C|LP|L\.P|INC|CORP|CORPORATION|COMPANY|LTD|LIMITED|"
    r"GMBH|N\.V|B\.V|S\.A|A/S|TRUST|FUND|FUNDS|PARTNERS|PARTNERSHIP|"
    r"HOLDINGS?|CAPITAL|VENTURES?|GROUP|MANAGEMENT|ADVISORS?|ASSOCIATES|"
    r"AG|PLC|SPV|BANCORP|BANCSHARES)\b",
    re.IGNORECASE,
)


class NationalSecSourceError(RuntimeError):
    """The professional source was unavailable or violated its declared contract."""


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


class UrllibJsonTransport:
    """Small stdlib transport that never forwards the bearer token through redirects."""

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
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            raise NationalSecSourceError("SEC professional source request failed") from exc
        if len(payload) > _MAX_RESPONSE_BYTES:
            raise NationalSecSourceError("SEC professional source response exceeded size limit")
        try:
            decoded = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise NationalSecSourceError("SEC professional source returned invalid JSON") from exc
        if not isinstance(decoded, dict):
            raise NationalSecSourceError("SEC professional source returned a non-object payload")
        return cast(Mapping[str, object], decoded)


@dataclass(frozen=True)
class NationalSecSourceStatus:
    source_id: str
    ranking_mode: str
    index_built_at: str | None
    index_partial: bool
    index_stale: bool | None
    raw_candidate_count: int
    upstream_total: int | None
    truncated: bool
    accepted_candidate_count: int
    rejected_entity_count: int
    rejected_owner_only_count: int
    rejected_invalid_count: int
    cache_hit: bool = False


@dataclass(frozen=True)
class NationalSecBatch:
    candidates: tuple[NearbyCandidate, ...]
    metadata: Mapping[str, BootstrapMetadata]
    source_status: NationalSecSourceStatus


def _compact(value: object, *, maximum: int = 240) -> str:
    return " ".join(str(value or "").split())[:maximum]


def _cik(value: object) -> str | None:
    normalized = _compact(value, maximum=32).lstrip("0")
    if not normalized or not normalized.isdigit():
        return None
    return normalized


def _looks_like_entity(name: str) -> bool:
    return bool(_ENTITY_MARKERS.search(name))


def _roles(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    allowed = {"officer": "Officer", "director": "Director", "tenpercentowner": "TenPercentOwner"}
    normalized = {
        allowed[item.casefold()]
        for raw in value
        if (item := _compact(raw, maximum=64)) and item.casefold() in allowed
    }
    return tuple(role for role in ("Officer", "Director", "TenPercentOwner") if role in normalized)


def _parse_date(value: object) -> date | None:
    try:
        return date.fromisoformat(_compact(value, maximum=10))
    except ValueError:
        return None


def _freshness(as_of: date, today: date) -> float:
    age_days = max(0, (today - as_of).days)
    return round(max(0.50, 1.0 - min(age_days, 1460) / 2920), 4)


def _role_authority(roles: tuple[str, ...]) -> float:
    if "Officer" in roles and "Director" in roles:
        return 0.88
    if "Officer" in roles:
        return 0.82
    return 0.76


def _features(roles: tuple[str, ...], *, filing_as_of: date, today: date) -> NwsFeatureVector:
    authority = _role_authority(roles)
    is_director = "Director" in roles
    return NwsFeatureVector(
        # This source supplies a public role edge, not a measured national graph.
        pagerank_percentile=0.0,
        kcore_percentile=0.0,
        bridging_percentile=0.0,
        cross_sector_percentile=0.0,
        role_authority_percentile=authority,
        institution_strength_percentile=0.60,
        founder_board_percentile=0.70 if is_director else 0.35,
        outcome_track_record_percentile=0.0,
        knowledge_creation_percentile=0.0,
        civic_leadership_percentile=0.0,
        # Holdings, position value, and 10% ownership never become NWS inputs.
        capital_access_percentile=0.0,
        trusted_reach_percentile=0.0,
        verified_social_reach_percentile=0.0,
        freshness=_freshness(filing_as_of, today),
        source_quality=0.96,
        source_diversity=0.50,
        identity_confidence=0.90,
        evidence_count=4,
        suspicious_pattern_ratio=0.0,
        self_published_source_ratio=0.0,
        dominant_source_ratio=1.0,
    )


class NationalSecProfessionalAdapter:
    """Fetch and map a short-lived, public-safe SEC professional candidate batch."""

    def __init__(
        self,
        *,
        base_url: str,
        bearer_token: str,
        transport: JsonTransport | None = None,
        cache_ttl_seconds: float = 30.0,
        timeout_seconds: float = 5.0,
        location_decimals: int = 2,
        clock: Callable[[], float] = time.monotonic,
        today: Callable[[], date] = date.today,
    ) -> None:
        parsed = urlsplit(base_url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("base_url must be an absolute HTTPS URL")
        token = bearer_token.strip()
        if not token:
            raise ValueError("bearer_token is required")
        if cache_ttl_seconds < 0:
            raise ValueError("cache_ttl_seconds cannot be negative")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if not 0 <= location_decimals <= 4:
            raise ValueError("location_decimals must be between 0 and 4")
        self._base_url = base_url.rstrip("/")
        self._bearer_token = token
        self._transport = transport or UrllibJsonTransport()
        self._cache_ttl_seconds = cache_ttl_seconds
        self._timeout_seconds = timeout_seconds
        self._location_decimals = location_decimals
        self._clock = clock
        self._today = today
        self._cache: dict[tuple[float, float, float, int], tuple[float, NationalSecBatch]] = {}
        self._cache_lock = threading.Lock()

    def discover(
        self,
        *,
        query_point: GeoPoint,
        radius_km: float,
        limit: int = _MAX_SOURCE_RESULTS,
    ) -> NationalSecBatch:
        if radius_km <= 0:
            raise ValueError("radius_km must be positive")
        if limit <= 0:
            raise ValueError("limit must be positive")
        source_limit = min(limit, _MAX_SOURCE_RESULTS)
        coarse = quantize_location(query_point, decimals=self._location_decimals)
        radius_mi = round(radius_km * _MILES_PER_KM, 3)
        key = (coarse.latitude, coarse.longitude, radius_mi, source_limit)
        now = self._clock()

        with self._cache_lock:
            cached = self._cache.get(key)
            if cached and cached[0] > now:
                return self._with_cache_hit(cached[1])
            if cached:
                self._cache.pop(key, None)

        params = urlencode(
            {
                "lat": coarse.latitude,
                "lng": coarse.longitude,
                "radiusMi": radius_mi,
                "limit": source_limit,
                "offset": 0,
                "stream": "json",
                "subjectType": "person",
                "ranking": "professional",
            }
        )
        payload = self._transport.get_json(
            f"{self._base_url}/v1/around?{params}",
            headers={"Authorization": f"Bearer {self._bearer_token}", "Accept": "application/json"},
            timeout_seconds=self._timeout_seconds,
        )
        batch = self._map_payload(payload)

        if self._cache_ttl_seconds > 0:
            with self._cache_lock:
                expired = [cache_key for cache_key, item in self._cache.items() if item[0] <= now]
                for cache_key in expired:
                    self._cache.pop(cache_key, None)
                if len(self._cache) >= 256:
                    oldest = min(self._cache, key=lambda cache_key: self._cache[cache_key][0])
                    self._cache.pop(oldest, None)
                self._cache[key] = (now + self._cache_ttl_seconds, batch)
        return batch

    @staticmethod
    def _with_cache_hit(batch: NationalSecBatch) -> NationalSecBatch:
        status = batch.source_status
        return NationalSecBatch(
            candidates=batch.candidates,
            metadata=batch.metadata,
            source_status=NationalSecSourceStatus(
                **{
                    **status.__dict__,
                    "cache_hit": True,
                }
            ),
        )

    def _map_payload(self, payload: Mapping[str, object]) -> NationalSecBatch:
        if payload.get("ok") is not True:
            raise NationalSecSourceError("SEC professional source returned an unsuccessful payload")
        ranking = payload.get("ranking")
        if not isinstance(ranking, Mapping) or ranking.get("mode") != "professional":
            raise NationalSecSourceError(
                "SEC professional source did not confirm professional ranking"
            )
        if ranking.get("relationshipScope") != "selected_position":
            raise NationalSecSourceError(
                "SEC professional source did not scope roles to the selected issuer position"
            )
        excluded = ranking.get("excludes")
        if not isinstance(excluded, list) or not {
            "disclosed_value",
            "market_value",
        }.issubset({_compact(value) for value in excluded}):
            raise NationalSecSourceError("SEC professional ranking did not exclude financial value")

        holders = payload.get("holders")
        if not isinstance(holders, list):
            raise NationalSecSourceError("SEC professional source omitted its candidate list")
        index = payload.get("index") if isinstance(payload.get("index"), Mapping) else {}
        index = cast(Mapping[str, object], index)
        if index.get("built") is False:
            raise NationalSecSourceError("SEC professional source index is not built")
        index_built_at = _compact(index.get("builtAt"), maximum=64) or None
        index_partial = bool(index.get("partial", False))
        index_stale_raw = index.get("stale")
        index_stale = index_stale_raw if isinstance(index_stale_raw, bool) else None
        upstream_total_raw = payload.get("total")
        upstream_total = (
            upstream_total_raw
            if isinstance(upstream_total_raw, int) and upstream_total_raw >= 0
            else None
        )
        truncated = bool(payload.get("hasMore")) or (
            upstream_total is not None and upstream_total > len(holders)
        )
        revalidation_required = index_partial or index_stale is True

        candidates: list[NearbyCandidate] = []
        metadata: dict[str, BootstrapMetadata] = {}
        rejected_entity = 0
        rejected_owner_only = 0
        rejected_invalid = 0

        for raw in holders:
            if not isinstance(raw, Mapping):
                rejected_invalid += 1
                continue
            mapped, reason = self._map_holder(
                cast(Mapping[str, object], raw),
                revalidation_required=revalidation_required,
            )
            if mapped is None:
                if reason == "entity":
                    rejected_entity += 1
                elif reason == "owner_only":
                    rejected_owner_only += 1
                else:
                    rejected_invalid += 1
                continue
            candidate, item_metadata = mapped
            if candidate.person_id in metadata:
                continue
            candidates.append(candidate)
            metadata[candidate.person_id] = item_metadata

        return NationalSecBatch(
            candidates=tuple(candidates),
            metadata=metadata,
            source_status=NationalSecSourceStatus(
                source_id="sec_section16_professional",
                ranking_mode="professional",
                index_built_at=index_built_at,
                index_partial=index_partial,
                index_stale=index_stale,
                raw_candidate_count=len(holders),
                upstream_total=upstream_total,
                truncated=truncated,
                accepted_candidate_count=len(candidates),
                rejected_entity_count=rejected_entity,
                rejected_owner_only_count=rejected_owner_only,
                rejected_invalid_count=rejected_invalid,
            ),
        )

    def _map_holder(
        self,
        raw: Mapping[str, object],
        *,
        revalidation_required: bool,
    ) -> tuple[tuple[NearbyCandidate, BootstrapMetadata] | None, str | None]:
        name = _compact(raw.get("name"))
        if not name:
            return None, "invalid"
        if raw.get("subjectType") == "entity" or _looks_like_entity(name):
            return None, "entity"
        roles = _roles(raw.get("roles"))
        if "Officer" not in roles and "Director" not in roles:
            return None, "owner_only"

        person_cik = _cik(raw.get("cik"))
        issuer = raw.get("issuer")
        professional = raw.get("professional")
        if (
            not person_cik
            or not isinstance(issuer, Mapping)
            or not isinstance(professional, Mapping)
        ):
            return None, "invalid"
        issuer = cast(Mapping[str, object], issuer)
        professional = cast(Mapping[str, object], professional)
        issuer_cik = _cik(issuer.get("cik"))
        issuer_name = _compact(issuer.get("name"))
        filing_as_of = _parse_date(professional.get("filingAsOf"))
        office = professional.get("issuerOffice")
        if (
            not issuer_cik
            or not issuer_name
            or filing_as_of is None
            or not isinstance(office, Mapping)
        ):
            return None, "invalid"
        office = cast(Mapping[str, object], office)
        latitude = office.get("latitude")
        longitude = office.get("longitude")
        if (
            isinstance(latitude, bool)
            or not isinstance(latitude, (int, float, str))
            or isinstance(longitude, bool)
            or not isinstance(longitude, (int, float, str))
        ):
            return None, "invalid"
        try:
            source_point = GeoPoint(float(latitude), float(longitude))
        except (TypeError, ValueError):
            return None, "invalid"
        # Retain only a coarse point in the NWS candidate. The source's exact issuer-office
        # coordinate is useful for its own ordering but is not part of this adapter's output.
        point = quantize_location(source_point, decimals=2)

        city = _compact(issuer.get("city"), maximum=120)
        state = _compact(issuer.get("state"), maximum=32)
        if not city or not state:
            return None, "invalid"
        precision = _compact(office.get("geoPrecision"), maximum=64).casefold()
        granularity = (
            LocationGranularity.POSTAL_AREA
            if precision == "zip_centroid"
            else LocationGranularity.CITY
        )
        location_confidence = 0.76 if granularity is LocationGranularity.POSTAL_AREA else 0.86
        title = _compact(raw.get("title"), maximum=160)
        role_label = " and ".join(role for role in roles if role != "TenPercentOwner")
        headline = title or f"SEC-reported {role_label} at {issuer_name}"
        lane = ProfessionalLane.BUILDER if "Officer" in roles else ProfessionalLane.CONNECTOR
        person_id = f"sec-reporting-owner:{person_cik}"
        profile_url = (
            f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={person_cik}&type=4"
        )
        today = self._today()

        candidate = NearbyCandidate(
            person_id=person_id,
            display_name=name,
            headline=headline,
            profile_class=ProfileClass.PUBLIC_PROFESSIONAL,
            verification_status=VerificationStatus.VERIFIED,
            primary_lane=lane,
            organization_id=f"sec-issuer:{issuer_cik}",
            organization_name=issuer_name,
            graph_community_id=f"sec-issuer:{issuer_cik}",
            location=PublicLocationAssociation(
                label=f"{issuer_name} public office association · {city}, {state}",
                point=point,
                kind=LocationAssociationKind.CURRENT_ORGANIZATION_OFFICE,
                granularity=granularity,
                confidence=location_confidence,
                source_count=2,
                as_of_date=filing_as_of,
            ),
            features=_features(roles, filing_as_of=filing_as_of, today=today),
            public_profile_url=profile_url,
            tags=(
                "sec-section-16",
                "public-company",
                *(("officer",) if "Officer" in roles else ()),
                *(("director",) if "Director" in roles else ()),
            ),
        )
        item_metadata = BootstrapMetadata(
            score_status="PROVISIONAL",
            revalidation_required=(revalidation_required or (today - filing_as_of).days > 365),
            citations=(
                SourceCitation(
                    publisher="U.S. Securities and Exchange Commission",
                    title="Section 16 reporting-owner public professional record",
                    url=profile_url,
                    fact_types=("identity", "current_role", "organization_identity"),
                    retrieved_at=filing_as_of.isoformat(),
                ),
                SourceCitation(
                    publisher="U.S. Securities and Exchange Commission",
                    title="SEC Insider Transactions Data Sets",
                    url=_SEC_DATASET_URL,
                    fact_types=("public_association", "source_provenance"),
                    retrieved_at=filing_as_of.isoformat(),
                ),
            ),
            source_family_count=1,
            evidence_fact_count=5,
            review_flags=(
                "AUTHORITATIVE_PUBLIC_REGISTRY_POLICY_VALIDATED",
                "SINGLE_SOURCE_FAMILY",
                "NO_FINANCIAL_INPUTS",
                "ISSUER_OFFICE_ASSOCIATION_NOT_PERSON_LOCATION",
            ),
        )
        return (candidate, item_metadata), None
