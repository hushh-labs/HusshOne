# Financial Context Boundary

The Financial Strength Factor proposed for a separate product is **not enabled
in NWS**. The Nearby Opportunity Score remains a public professional-network
and public-association score, not a measure of financial capacity.

The API now returns a top-level `financial_context` object on every discovery
response:

```json
{
  "status": "NOT_PROFILED",
  "personal_financial_strength": "NOT_PROVIDED",
  "personal_assets_or_liquidity": "NOT_PROVIDED",
  "property_value_or_residence": "NOT_PROVIDED",
  "aggregate_local_economic_context": "NOT_AVAILABLE"
}
```

`nws_capital_access_component` is only a bounded public professional
relationship signal, such as a verified organization role. It is not a proxy
for personal wealth, ability to pay, income, ownership value, or credit.

## Enforced policy

`PolicyEngine` now fails closed for `EvidenceUse.WEALTH`, including verified
public figures and SEC ownership evidence. Public visibility is not consent for
a named financial profile. The following remain prohibited:

- Bank balance, income, compensation, liquidity, net-worth, or asset estimates.
- Property-assessor, sale, trust, LLC, or mailing-record linkage to a named
  person.
- Form D offering amount, adviser AUM, fund assets, nonprofit assets, or grant
  amount as personal wealth.
- Social, lifestyle, follower, check-in, vehicle, or home inference.
- Any financial-strength field or filter in `/v2/nearby-network/discover`.

The existing `capital_access` NWS component continues to be explained as a
non-financial, public professional-network relationship.

## Safe future companion: aggregate local economic context

If a separate product is approved, it must be an aggregate geography service,
not a named-person score. Its minimum contract should be:

```json
{
  "schema_version": "local-economic-context-v1",
  "query": {"postal_code": "98033", "country_code": "US"},
  "context": {
    "housing_value_band": "ABOVE_AREA_MEDIAN",
    "income_context_band": "ABOVE_AREA_MEDIAN"
  },
  "limitations": [
    "Aggregate area context only; it does not describe a person or property.",
    "It is not joined to NWS candidates and does not influence their ranking."
  ]
}
```

Do not expose that endpoint until it has an approved aggregate source snapshot,
geography provenance, a conservative minimum-population suppression rule,
source-term review, and tests proving no person ID, candidate ID, parcel ID,
address, raw coordinate, or individual-dollar value can enter its data path.

A consented financial product, if ever approved, must be private to its subject,
separately consented, encrypted, auditable, correctable/deletable, and not
searchable through NWS. It requires its own product, legal, and data-governance
review; it is not an extension of the public nearby directory.
