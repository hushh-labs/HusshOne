from datetime import datetime, timezone

from app.collectors.contracts import (
    AcquisitionMode,
    ArtifactManifest,
    SourceContract,
    SourceTrustTier,
)
from app.parsers import ObservationPolicyGate, OfficialJsonLdParser, SecForm4Parser


def manifest(source_id: str, content: bytes) -> ArtifactManifest:
    import hashlib

    return ArtifactManifest(
        source_id=source_id,
        requested_uri="https://example.test/source",
        final_uri="https://example.test/source",
        retrieved_at=datetime.now(timezone.utc),
        status_code=200,
        content_type="text/html",
        content_length=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
    )


def test_jsonld_parser_extracts_role_but_ignores_person_address() -> None:
    html = b'''<html><script type="application/ld+json">
    {
      "@type":"Person",
      "@id":"https://example.test/people/alex",
      "name":"Alex Example",
      "jobTitle":"Chief Scientist",
      "worksFor":{"@type":"Organization","@id":"https://example.test/org","name":"Example Labs"},
      "sameAs":["https://github.com/example"],
      "address":{"streetAddress":"123 Private Lane","addressLocality":"Kirkland"}
    }
    </script></html>'''
    observations = OfficialJsonLdParser().parse(html, manifest("official_company_pages", html))
    assert {item.fact_type for item in observations} == {
        "identity_alias",
        "current_role",
        "official_profile_link",
    }
    assert "123 Private Lane" not in str([item.attributes for item in observations])


def test_sec_form4_parser_extracts_relationship_and_transaction() -> None:
    xml = b'''<?xml version="1.0"?>
    <ownershipDocument>
      <periodOfReport>2026-08-01</periodOfReport>
      <issuer><issuerCik>0000123456</issuerCik><issuerName>Example Corp</issuerName></issuer>
      <reportingOwner>
        <reportingOwnerId><rptOwnerCik>0000654321</rptOwnerCik><rptOwnerName>Example Person</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>CEO</officerTitle></reportingOwnerRelationship>
      </reportingOwner>
      <nonDerivativeTable>
        <nonDerivativeTransaction>
          <securityTitle><value>Common Stock</value></securityTitle>
          <transactionDate><value>2026-08-01</value></transactionDate>
          <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
          <transactionAmounts>
            <transactionShares><value>1000</value></transactionShares>
            <transactionPricePerShare><value>42.5</value></transactionPricePerShare>
            <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
          </transactionAmounts>
          <postTransactionAmounts><sharesOwnedFollowingTransaction><value>51000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
          <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
        </nonDerivativeTransaction>
      </nonDerivativeTable>
    </ownershipDocument>'''
    observations = SecForm4Parser().parse(xml, manifest("sec_edgar_ownership", xml))
    types = [item.fact_type for item in observations]
    assert types == ["issuer_relationship", "director_role", "public_role", "beneficial_ownership"]
    transaction = observations[-1]
    assert transaction.attributes["post_transaction_shares"] == "51000"
    assert transaction.subject_external_id == "sec-cik/0000654321"


def test_observation_policy_gate_rejects_uncontracted_fact() -> None:
    html = b'<script type="application/ld+json">{"@type":"Person","name":"A"}</script>'
    observation = OfficialJsonLdParser().parse(
        html, manifest("official_company_pages", html)
    )[0]
    contract = SourceContract(
        source_id="official_company_pages",
        authority="Official organization",
        acquisition_mode=AcquisitionMode.PUBLIC_PAGE,
        trust_tier=SourceTrustTier.PRIMARY,
        base_reliability=0.90,
        allowed_fact_types=frozenset({"current_role"}),
        forbidden_fact_types=frozenset({"private_residence"}),
    )
    decision = ObservationPolicyGate().authorize(observation, contract)
    assert decision.allowed is False
    assert decision.rule_id == "FACT-NOT-CONTRACTED"
