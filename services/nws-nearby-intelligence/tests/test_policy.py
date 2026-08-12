from datetime import date, datetime, timezone

import pytest

from app.domain.models import (
    Evidence,
    EvidenceKind,
    EvidenceUse,
    PublicFigureStatus,
    Subject,
    SubjectType,
)
from app.policy import PolicyEngine


def evidence(kind: EvidenceKind, subject_type: SubjectType, uses: set[EvidenceUse]) -> Evidence:
    return Evidence(
        evidence_id="e1",
        subject_id="s1",
        subject_type=subject_type,
        kind=kind,
        allowed_uses=frozenset(uses),
        source_authority="test",
        source_uri="https://example.invalid",
        source_date=date(2026, 8, 1),
        retrieved_at=datetime(2026, 8, 2, tzinfo=timezone.utc),
        artifact_sha256="a" * 64,
        reliability=0.9,
    )


def test_private_person_named_wealth_is_blocked() -> None:
    engine = PolicyEngine()
    decision = engine.authorize_evidence(
        evidence(EvidenceKind.PUBLIC_WEB, SubjectType.PRIVATE_PERSON, {EvidenceUse.WEALTH}),
        EvidenceUse.WEALTH,
    )
    assert not decision.allowed


def test_public_social_never_creates_wealth_amount() -> None:
    engine = PolicyEngine()
    decision = engine.authorize_evidence(
        evidence(EvidenceKind.PUBLIC_SOCIAL, SubjectType.PUBLIC_FIGURE, {EvidenceUse.WEALTH}),
        EvidenceUse.WEALTH,
    )
    assert not decision.allowed


def test_verified_public_figure_is_allowed_for_named_output() -> None:
    engine = PolicyEngine()
    subject = Subject(
        subject_id="public-1",
        subject_type=SubjectType.PUBLIC_FIGURE,
        display_name="Example Founder",
        public_figure_status=PublicFigureStatus.VERIFIED,
    )
    assert engine.authorize_subject_for_named_wealth(subject).allowed
