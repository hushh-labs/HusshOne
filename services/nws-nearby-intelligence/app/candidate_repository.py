from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date
from typing import Protocol, Sequence

from app.demo_data import synthetic_candidates
from app.geospatial import haversine_km
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


@dataclass(frozen=True)
class CandidateSearchFilters:
    lanes: frozenset[ProfessionalLane] = frozenset()
    tags: frozenset[str] = frozenset()


class CandidateRepository(Protocol):
    backend_name: str

    def search(
        self,
        *,
        query_point: GeoPoint,
        max_radius_km: float,
        limit: int,
        filters: CandidateSearchFilters,
    ) -> list[NearbyCandidate]: ...


class CandidateRepositoryUnavailable(RuntimeError):
    pass


class InMemoryCandidateRepository:
    backend_name = "in-memory-demo"

    def __init__(self, candidates: Sequence[NearbyCandidate]) -> None:
        self._candidates = tuple(candidates)

    def search(
        self,
        *,
        query_point: GeoPoint,
        max_radius_km: float,
        limit: int,
        filters: CandidateSearchFilters,
    ) -> list[NearbyCandidate]:
        if limit <= 0:
            return []
        tags = {tag.casefold() for tag in filters.tags}
        matches = []
        for candidate in self._candidates:
            if filters.lanes and candidate.primary_lane not in filters.lanes:
                continue
            candidate_tags = {tag.casefold() for tag in candidate.tags}
            if tags and not tags.issubset(candidate_tags):
                continue
            distance = haversine_km(query_point, candidate.location.point)
            if distance <= max_radius_km:
                matches.append((distance, candidate.person_id, candidate))
        matches.sort(key=lambda row: (row[0], row[1]))
        return [row[2] for row in matches[:limit]]


class PostgresCandidateRepository:
    """PostGIS-backed approved candidate retrieval.

    `psycopg` is imported lazily so the pure-logic test suite remains lightweight. The query
    deliberately reads approved public-professional locations and the latest approved feature
    snapshot. It never queries a private residential location.
    """

    backend_name = "postgres-postgis"

    _QUERY = """
    WITH current_location AS (
        SELECT DISTINCT ON (l.subject_id)
               l.subject_id,
               l.label,
               l.association_kind,
               l.granularity,
               ST_Y(l.public_point) AS latitude,
               ST_X(l.public_point) AS longitude,
               l.confidence AS location_confidence,
               l.source_count,
               l.as_of_date
          FROM public_location_association l
         WHERE l.publication_allowed = true
           AND l.review = 'APPROVED'
           AND (l.valid_to IS NULL OR l.valid_to >= current_date)
           AND ST_DWithin(
                 l.public_point::geography,
                 ST_SetSRID(ST_MakePoint(%(longitude)s, %(latitude)s), 4326)::geography,
                 %(radius_meters)s
               )
         ORDER BY l.subject_id, l.confidence DESC, l.as_of_date DESC
    ),
    current_features AS (
        SELECT DISTINCT ON (f.subject_id)
               f.subject_id, f.primary_lane, f.features, f.as_of_date
          FROM nws_feature_snapshot f
         ORDER BY f.subject_id, f.as_of_date DESC
    ),
    current_score AS (
        SELECT DISTINCT ON (n.subject_id)
               n.subject_id, n.global_nws, n.confidence, n.as_of_date
          FROM nws_score_snapshot n
         WHERE n.publication_allowed = true
           AND n.review = 'APPROVED'
         ORDER BY n.subject_id, n.as_of_date DESC
    ),
    current_role AS (
        SELECT DISTINCT ON (r.subject_id)
               r.subject_id, r.organization_id, o.legal_name AS organization_name
          FROM public_role r
          JOIN organization o ON o.organization_id = r.organization_id
         WHERE r.end_date IS NULL OR r.end_date >= current_date
         ORDER BY r.subject_id, r.start_date DESC NULLS LAST
    )
    SELECT p.subject_id,
           p.display_name,
           COALESCE(p.headline, p.public_figure_reason, 'Public professional') AS headline,
           p.profile_class,
           p.verification,
           COALESCE(f.primary_lane, p.primary_lane, 'GENERAL') AS primary_lane,
           r.organization_id,
           r.organization_name,
           gm.community_id AS graph_community_id,
           l.label,
           l.association_kind,
           l.granularity,
           l.latitude,
           l.longitude,
           l.location_confidence,
           l.source_count,
           l.as_of_date AS location_as_of_date,
           f.features,
           p.public_profile_url,
           COALESCE(p.tags, ARRAY[]::text[]) AS tags,
           s.global_nws AS stored_global_nws
      FROM public_person p
      JOIN current_location l ON l.subject_id = p.subject_id
      JOIN current_features f ON f.subject_id = p.subject_id
      JOIN current_score s ON s.subject_id = p.subject_id
 LEFT JOIN current_role r ON r.subject_id = p.subject_id
 LEFT JOIN LATERAL (
           SELECT g.community_id
             FROM graph_person_metric g
             JOIN graph_snapshot gs ON gs.graph_snapshot_id = g.graph_snapshot_id
            WHERE g.subject_id = p.subject_id
              AND gs.status = 'COMPLETED'
            ORDER BY gs.as_of_date DESC
            LIMIT 1
           ) gm ON true
     WHERE p.verification = 'VERIFIED'
       AND p.profile_class IN ('PUBLIC_FIGURE', 'PUBLIC_PROFESSIONAL', 'OPTED_IN')
       AND p.publication_allowed = true
       AND p.suppression_status = 'ACTIVE'
       {lane_clause}
     ORDER BY s.global_nws DESC, s.confidence DESC, p.subject_id
     LIMIT %(limit)s
    """

    def __init__(self, database_url: str) -> None:
        if not database_url.strip():
            raise ValueError("database_url is required")
        self.database_url = database_url

    def search(
        self,
        *,
        query_point: GeoPoint,
        max_radius_km: float,
        limit: int,
        filters: CandidateSearchFilters,
    ) -> list[NearbyCandidate]:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:  # pragma: no cover - deployment configuration path
            raise CandidateRepositoryUnavailable(
                "Install the postgres extra: pip install -e '.[postgres]'"
            ) from exc

        lane_clause = ""
        params: dict[str, object] = {
            "latitude": query_point.latitude,
            "longitude": query_point.longitude,
            "radius_meters": max_radius_km * 1000.0,
            "limit": limit,
        }
        if filters.lanes:
            lane_clause = "AND COALESCE(f.primary_lane, p.primary_lane, 'GENERAL') = ANY(%(lanes)s)"
            params["lanes"] = [lane.value for lane in sorted(filters.lanes, key=lambda item: item.value)]

        query = self._QUERY.format(lane_clause=lane_clause)
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            rows = connection.execute(query, params).fetchall()

        candidates: list[NearbyCandidate] = []
        requested_tags = {tag.casefold() for tag in filters.tags}
        for row in rows:
            tags = tuple(str(tag) for tag in (row["tags"] or ()))
            if requested_tags and not requested_tags.issubset({tag.casefold() for tag in tags}):
                continue
            feature_payload = dict(row["features"])
            candidates.append(
                NearbyCandidate(
                    person_id=str(row["subject_id"]),
                    display_name=str(row["display_name"]),
                    headline=str(row["headline"]),
                    profile_class=ProfileClass(str(row["profile_class"])),
                    verification_status=VerificationStatus(str(row["verification"])),
                    primary_lane=ProfessionalLane(str(row["primary_lane"])),
                    organization_id=(
                        str(row["organization_id"]) if row["organization_id"] else None
                    ),
                    organization_name=(
                        str(row["organization_name"]) if row["organization_name"] else None
                    ),
                    graph_community_id=(
                        str(row["graph_community_id"]) if row["graph_community_id"] else None
                    ),
                    location=PublicLocationAssociation(
                        label=str(row["label"]),
                        point=GeoPoint(float(row["latitude"]), float(row["longitude"])),
                        kind=LocationAssociationKind(str(row["association_kind"])),
                        granularity=LocationGranularity(str(row["granularity"])),
                        confidence=float(row["location_confidence"]),
                        source_count=int(row["source_count"]),
                        as_of_date=(
                            row["location_as_of_date"]
                            if isinstance(row["location_as_of_date"], date)
                            else date.fromisoformat(str(row["location_as_of_date"]))
                        ),
                    ),
                    features=NwsFeatureVector(**feature_payload),
                    public_profile_url=(
                        str(row["public_profile_url"]) if row["public_profile_url"] else None
                    ),
                    tags=tags,
                )
            )
        return candidates


class UnavailableCandidateRepository:
    backend_name = "unavailable"

    def search(self, **_: object) -> list[NearbyCandidate]:
        raise CandidateRepositoryUnavailable(
            "No candidate backend is configured. Set NWS_CANDIDATE_BACKEND=demo for the "
            "synthetic reference dataset or NWS_CANDIDATE_BACKEND=postgres with DATABASE_URL."
        )


def build_candidate_repository_from_env() -> CandidateRepository:
    backend = os.getenv("NWS_CANDIDATE_BACKEND", "demo").strip().casefold()
    if backend == "demo":
        count = int(os.getenv("NWS_DEMO_CANDIDATE_COUNT", "520"))
        return InMemoryCandidateRepository(synthetic_candidates(count=count))
    if backend == "postgres":
        database_url = os.getenv("DATABASE_URL", "")
        if not database_url:
            return UnavailableCandidateRepository()
        return PostgresCandidateRepository(database_url)
    return UnavailableCandidateRepository()
