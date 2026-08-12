from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from enum import StrEnum


class MatchDisposition(StrEnum):
    MATCH = "MATCH"
    MANUAL_REVIEW = "MANUAL_REVIEW"
    NO_MATCH = "NO_MATCH"


@dataclass(frozen=True)
class PublicPersonRecord:
    record_id: str
    name: str
    cik: str | None = None
    organization: str | None = None
    role: str | None = None
    city: str | None = None


@dataclass(frozen=True)
class MatchResult:
    left_record_id: str
    right_record_id: str
    score: float
    disposition: MatchDisposition
    reasons: tuple[str, ...]


_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "phd", "md"}
_TITLES = {"mr", "mrs", "ms", "dr", "prof"}


def normalize_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^a-zA-Z0-9]+", " ", value).strip().lower()
    return re.sub(r"\s+", " ", value)


def normalize_name(name: str) -> str:
    tokens = [token for token in normalize_text(name).split() if token not in _TITLES]
    while tokens and tokens[-1] in _SUFFIXES:
        tokens.pop()
    return " ".join(tokens)


def name_similarity(left: str, right: str) -> float:
    left_tokens = normalize_name(left).split()
    right_tokens = normalize_name(right).split()
    if left_tokens == right_tokens:
        return 1.0
    if not left_tokens or not right_tokens:
        return 0.0
    # A missing middle name/initial is common in filings. First and last names must still agree.
    if left_tokens[0] == right_tokens[0] and left_tokens[-1] == right_tokens[-1]:
        left_core = [token for token in left_tokens[1:-1] if len(token) > 1]
        right_core = [token for token in right_tokens[1:-1] if len(token) > 1]
        if not left_core or not right_core or set(left_core) == set(right_core):
            return 0.95
    return token_similarity(" ".join(left_tokens), " ".join(right_tokens))


_ORG_SUFFIXES = {"inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "plc"}
_ROLE_ALIASES = {
    "chief executive officer": "ceo",
    "chief financial officer": "cfo",
    "chief operating officer": "coo",
    "chief technology officer": "cto",
    "chief information officer": "cio",
}


def normalize_organization(value: str | None) -> str | None:
    normalized = normalize_text(value)
    if not normalized:
        return normalized
    tokens = normalized.split()
    while tokens and tokens[-1] in _ORG_SUFFIXES:
        tokens.pop()
    return " ".join(tokens)


def normalize_role(value: str | None) -> str | None:
    normalized = normalize_text(value)
    if not normalized:
        return normalized
    return _ROLE_ALIASES.get(normalized, normalized)


def token_similarity(left: str | None, right: str | None) -> float:
    left_norm, right_norm = normalize_text(left), normalize_text(right)
    if not left_norm or not right_norm:
        return 0.0
    left_tokens, right_tokens = set(left_norm.split()), set(right_norm.split())
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def resolve_public_person(left: PublicPersonRecord, right: PublicPersonRecord) -> MatchResult:
    reasons: list[str] = []
    score = 0.0

    left_name, right_name = normalize_name(left.name), normalize_name(right.name)
    name_score = name_similarity(left.name, right.name)
    score += 0.28 * name_score
    reasons.append(f"name={name_score:.2f}")

    cik_exact = bool(left.cik and right.cik and left.cik.zfill(10) == right.cik.zfill(10))
    if cik_exact:
        score += 0.42
        reasons.append("cik=exact")
    elif left.cik and right.cik:
        reasons.append("cik=conflict")
        score -= 0.35

    organization_score = token_similarity(
        normalize_organization(left.organization), normalize_organization(right.organization)
    )
    score += 0.15 * organization_score
    reasons.append(f"organization={organization_score:.2f}")

    role_score = token_similarity(normalize_role(left.role), normalize_role(right.role))
    score += 0.08 * role_score
    reasons.append(f"role={role_score:.2f}")

    city_score = token_similarity(left.city, right.city)
    score += 0.07 * city_score
    reasons.append(f"city={city_score:.2f}")

    score = max(0.0, min(score, 1.0))

    # A name by itself is never enough. A match needs a stable identifier or strong org/role context.
    has_context = cik_exact or (organization_score >= 0.8 and (role_score >= 0.5 or city_score >= 0.8))
    if score >= 0.84 and name_score >= 0.8 and has_context:
        disposition = MatchDisposition.MATCH
    elif score >= 0.62 and name_score >= 0.65 and has_context:
        disposition = MatchDisposition.MANUAL_REVIEW
    else:
        disposition = MatchDisposition.NO_MATCH

    return MatchResult(
        left_record_id=left.record_id,
        right_record_id=right.record_id,
        score=round(score, 4),
        disposition=disposition,
        reasons=tuple(reasons),
    )
