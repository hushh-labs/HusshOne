from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any


class EventType(StrEnum):
    SOURCE_ARTIFACT_DISCOVERED = "SOURCE_ARTIFACT_DISCOVERED"
    SOURCE_ARTIFACT_VERIFIED = "SOURCE_ARTIFACT_VERIFIED"
    FILING_PARSED = "FILING_PARSED"
    EVIDENCE_CREATED = "EVIDENCE_CREATED"
    ENTITY_MATCH_PROPOSED = "ENTITY_MATCH_PROPOSED"
    ENTITY_MATCH_APPROVED = "ENTITY_MATCH_APPROVED"
    ASSET_ESTIMATE_CHANGED = "ASSET_ESTIMATE_CHANGED"
    VALUATION_RECOMPUTE_REQUESTED = "VALUATION_RECOMPUTE_REQUESTED"
    VALUATION_COMPLETED = "VALUATION_COMPLETED"
    RANK_RUN_REQUESTED = "RANK_RUN_REQUESTED"
    RANK_RUN_COMPLETED = "RANK_RUN_COMPLETED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    PUBLICATION_APPROVED = "PUBLICATION_APPROVED"
    PUBLIC_PROFILE_DISCOVERED = "PUBLIC_PROFILE_DISCOVERED"
    PUBLIC_LOCATION_ASSOCIATION_CHANGED = "PUBLIC_LOCATION_ASSOCIATION_CHANGED"
    PROFESSIONAL_EDGE_CREATED = "PROFESSIONAL_EDGE_CREATED"
    GRAPH_SNAPSHOT_REQUESTED = "GRAPH_SNAPSHOT_REQUESTED"
    GRAPH_SNAPSHOT_COMPLETED = "GRAPH_SNAPSHOT_COMPLETED"
    NWS_RECOMPUTE_REQUESTED = "NWS_RECOMPUTE_REQUESTED"
    NWS_SCORE_COMPLETED = "NWS_SCORE_COMPLETED"
    NEARBY_QUERY_EXECUTED = "NEARBY_QUERY_EXECUTED"
    PROFILE_SUPPRESSED = "PROFILE_SUPPRESSED"


@dataclass(frozen=True)
class DomainEvent:
    event_id: str
    event_type: EventType
    aggregate_type: str
    aggregate_id: str
    occurred_at: datetime
    schema_version: int
    payload: dict[str, Any]
    idempotency_key: str

    @staticmethod
    def create(
        *,
        event_type: EventType,
        aggregate_type: str,
        aggregate_id: str,
        payload: dict[str, Any],
        source_version: str,
        schema_version: int = 1,
    ) -> "DomainEvent":
        canonical = json.dumps(
            {
                "event_type": event_type.value,
                "aggregate_type": aggregate_type,
                "aggregate_id": aggregate_id,
                "payload": payload,
                "source_version": source_version,
            },
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        return DomainEvent(
            event_id=f"evt_{digest[:24]}",
            event_type=event_type,
            aggregate_type=aggregate_type,
            aggregate_id=aggregate_id,
            occurred_at=datetime.now(timezone.utc),
            schema_version=schema_version,
            payload=payload,
            idempotency_key=digest,
        )

    def to_json(self) -> str:
        data = asdict(self)
        data["event_type"] = self.event_type.value
        data["occurred_at"] = self.occurred_at.isoformat()
        return json.dumps(data, sort_keys=True, separators=(",", ":"))
