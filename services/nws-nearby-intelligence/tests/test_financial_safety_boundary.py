from __future__ import annotations

import ast
import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from app.collectors.contracts import ArtifactManifest
from app.financial_context import public_financial_context_policy
from app.main import app
from app.observation_projection import ObservationProjector
from app.parsers.sec_form4 import SecForm4Parser
from app.security import rate_limiter

API_HEADERS = {"X-NWS-API-Key": "local-development-only"}
SERVICE_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = SERVICE_ROOT / "app"


def setup_function() -> None:
    rate_limiter._events.clear()  # noqa: SLF001 - test reset for the in-process limiter


def _walk_values(value: object):  # type: ignore[no-untyped-def]
    if isinstance(value, Mapping):
        for child in value.values():
            yield from _walk_values(child)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for child in value:
            yield from _walk_values(child)
    else:
        yield value


def _normalized_keys(value: object) -> set[str]:
    keys: set[str] = set()
    if isinstance(value, Mapping):
        for key, child in value.items():
            keys.add("".join(character for character in str(key).casefold() if character.isalnum()))
            keys.update(_normalized_keys(child))
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for child in value:
            keys.update(_normalized_keys(child))
    return keys


def _module_path(module: str) -> Path | None:
    if module == "app":
        candidate = APP_ROOT / "__init__.py"
    elif module.startswith("app."):
        relative = module.removeprefix("app.").replace(".", "/")
        module_file = APP_ROOT / f"{relative}.py"
        package_file = APP_ROOT / relative / "__init__.py"
        candidate = module_file if module_file.exists() else package_file
    else:
        return None
    return candidate if candidate.exists() else None


def _app_imports(module: str) -> set[str]:
    path = _module_path(module)
    if path is None:
        return set()
    imports: set[str] = set()
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names if alias.name.startswith("app"))
        elif isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("app"):
            imports.add(node.module)
            for alias in node.names:
                nested = f"{node.module}.{alias.name}"
                if _module_path(nested) is not None:
                    imports.add(nested)
    return imports


def _reachable_app_modules(root: str) -> set[str]:
    visited: set[str] = set()
    pending = [root]
    while pending:
        module = pending.pop()
        if module in visited:
            continue
        visited.add(module)
        pending.extend(_app_imports(module) - visited)
    return visited


def test_missing_finance_is_explicitly_not_profiled_and_never_numeric() -> None:
    context = public_financial_context_policy()

    assert context["status"] == "NOT_PROFILED"
    assert context["personal_financial_strength"] == "NOT_PROVIDED"
    assert all(not isinstance(value, (int, float)) for value in _walk_values(context))


def test_public_results_never_serialize_personal_financial_evidence() -> None:
    response = TestClient(app).post(
        "/v2/nearby-network/discover",
        headers=API_HEADERS,
        json={"query": {"postal_code": "98033"}, "top_n": 3},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["financial_context"]["status"] == "NOT_PROFILED"
    forbidden_keys = {
        "assets",
        "bankbalance",
        "compensation",
        "disclosedvalue",
        "email",
        "homevalue",
        "income",
        "liquidity",
        "marketprice",
        "marketvalue",
        "mortgage",
        "networth",
        "phone",
        "pricepershare",
        "propertyvalue",
        "residence",
        "securitytitle",
        "shares",
        "streetaddress",
    }
    assert _normalized_keys(body["results"]).isdisjoint(forbidden_keys)
    assert "financial-canary" not in json.dumps(body["results"]).casefold()


def test_owner_only_form4_cannot_enter_graph_or_score_pipeline() -> None:
    xml = b'''<?xml version="1.0"?>
    <ownershipDocument>
      <periodOfReport>2026-08-01</periodOfReport>
      <issuer><issuerCik>0000123456</issuerCik><issuerName>Example Corp</issuerName></issuer>
      <reportingOwner>
        <reportingOwnerId>
          <rptOwnerCik>0000654321</rptOwnerCik>
          <rptOwnerName>Owner Only</rptOwnerName>
        </reportingOwnerId>
        <reportingOwnerRelationship>
          <isDirector>0</isDirector><isOfficer>0</isOfficer><isTenPercentOwner>1</isTenPercentOwner>
        </reportingOwnerRelationship>
      </reportingOwner>
      <nonDerivativeTable>
        <nonDerivativeTransaction>
          <securityTitle><value>Common Stock</value></securityTitle>
          <transactionDate><value>2026-08-01</value></transactionDate>
          <transactionAmounts>
            <transactionShares><value>999999999999</value></transactionShares>
            <transactionPricePerShare><value>999999999</value></transactionPricePerShare>
          </transactionAmounts>
          <postTransactionAmounts>
            <sharesOwnedFollowingTransaction><value>999999999999</value></sharesOwnedFollowingTransaction>
          </postTransactionAmounts>
        </nonDerivativeTransaction>
      </nonDerivativeTable>
    </ownershipDocument>'''
    manifest = ArtifactManifest(
        source_id="sec_edgar_ownership",
        requested_uri="https://www.sec.gov/example.xml",
        final_uri="https://www.sec.gov/example.xml",
        retrieved_at=datetime(2026, 8, 14, tzinfo=UTC),
        status_code=200,
        content_type="application/xml",
        content_length=len(xml),
        sha256=hashlib.sha256(xml).hexdigest(),
    )
    observations = SecForm4Parser().parse(xml, manifest)

    assert [item.fact_type for item in observations] == [
        "issuer_relationship",
        "beneficial_ownership",
    ]
    batch = ObservationProjector().project(
        observations,
        external_to_canonical={
            "sec-cik/0000654321": "person-1",
            "sec-cik/0000123456": "issuer-1",
        },
        source_quality_by_source={"sec_edgar_ownership": 0.98},
        identity_confidence_by_person={"person-1": 0.95},
        default_observed_on=datetime(2026, 8, 14, tzinfo=UTC).date(),
    )

    assert batch.graph_edges == ()
    assert batch.feature_signals == ()
    assert set(batch.ignored_observation_ids) == {
        observation.observation_id for observation in observations
    }


def test_production_main_import_graph_excludes_financial_property_prototypes() -> None:
    reachable = _reachable_app_modules("app.main")

    assert reachable.isdisjoint(
        {
            "app.affluence",
            "app.domain",
            "app.domain.models",
            "app.policy",
            "app.ranking",
            "app.valuation",
        }
    )


def test_production_image_excludes_financial_property_prototypes() -> None:
    ignored = {
        line.strip()
        for line in (SERVICE_ROOT / ".dockerignore").read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }

    assert {
        "app/affluence.py",
        "app/domain",
        "app/policy.py",
        "app/ranking.py",
        "app/valuation.py",
    }.issubset(ignored)
