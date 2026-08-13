"""Public contract for the deliberate NWS/financial-data separation.

This service may describe a bounded *capital-access* relationship in its NWS
methodology when that relationship is supported by a public professional role.
It does not create a named financial-strength, wealth, property, compensation,
or liquidity profile.  Keeping this contract executable makes an accidental
future route or ranking join visible in review and tests.
"""

from __future__ import annotations

from enum import StrEnum


class FinancialContextStatus(StrEnum):
    NOT_PROFILED = "NOT_PROFILED"


def public_financial_context_policy() -> dict[str, object]:
    """Return the response-safe financial-data boundary for every NWS query."""

    return {
        "status": FinancialContextStatus.NOT_PROFILED.value,
        "personal_financial_strength": "NOT_PROVIDED",
        "personal_assets_or_liquidity": "NOT_PROVIDED",
        "property_value_or_residence": "NOT_PROVIDED",
        "aggregate_local_economic_context": "NOT_AVAILABLE",
        "nws_capital_access_component": (
            "PUBLIC_PROFESSIONAL_RELATIONSHIP_ONLY; it is not a measure of personal wealth "
            "or ability to pay."
        ),
        "not_used_for_ranking": [
            "bank_balance",
            "compensation",
            "home_or_property_value",
            "net_worth",
            "social_or_lifestyle_inference",
        ],
    }
