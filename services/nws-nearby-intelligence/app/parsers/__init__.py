"""Versioned parser plugins that emit source-bound observations, never final NWS values."""

from app.parsers.contracts import ObservationParser, ObservationPolicyGate, deterministic_observation_id
from app.parsers.jsonld import OfficialJsonLdParser
from app.parsers.registry import ParserRegistry
from app.parsers.sec_form4 import SecForm4Parser

__all__ = [
    "ObservationParser",
    "ObservationPolicyGate",
    "OfficialJsonLdParser",
    "ParserRegistry",
    "SecForm4Parser",
    "deterministic_observation_id",
]
