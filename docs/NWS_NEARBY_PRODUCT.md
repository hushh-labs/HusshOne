# NWS nearby product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Purpose

NWS means **Net Worth Score**. It answers one question: how much attributable wealth is
supported by verified public financial evidence after liabilities?

The nearby surface uses a U.S. ZIP or approximate location to select eligible public or
opted-in profiles. Location never changes a person's wealth estimate or NWS.

## Users

- People exploring verified public financial disclosures around a U.S. area.
- Opted-in people reviewing their own verified financial profile.
- Developers using the standalone NWS service through a server-side boundary.

## Core contract

```text
Estimated net worth
= cash and near-cash
+ attributable public securities
+ attributable private-business equity
+ real-estate equity
+ other supported assets
- attributable liabilities
```

The dollar range is primary. NWS is its versioned fixed-national log-scale representation
from 0 to 100. Confidence and liquidity remain separate.

## Eligibility

- Publish a named NWS only for a verified public financial profile or verified opt-in.
- Every component needs attributable evidence and provenance.
- Liabilities are mandatory for component-ledger estimates.
- Unknown categories stay unknown; they never become zero.
- A legally declared whole-net-worth total may publish without itemized components because
  it already includes assets and liabilities.
- Insufficient evidence returns `Not enough verified public financial information.`

## Source boundaries

- Florida Form 6 sworn whole-net-worth declarations are the first narrow positive source.
- SEC ownership can support an attributable securities component only after identity,
  ownership, price, and liability coverage; one holding is never total net worth.
- OGE ranges and opt-in verified ledgers may support future estimates after governed ingest.
- Form D offering amounts, company funding or revenue, fund AUM, nonprofit assets,
  compensation, awards, and lifestyle signals never become personal wealth.

## Nationwide behavior

A U.S. ZIP present in the packaged 33,791-ZCTA Census release can resolve a public search area;
unknown USPS ZIPs return `LOCATION_UNRESOLVED`. Broad location coverage does not mean nationwide
named financial coverage. The response keeps these states separate:

- location not covered or unresolved;
- no eligible nearby candidates;
- nearby candidates but insufficient financial evidence;
- partial or available verified NWS results;
- financial source unavailable.

## Privacy

- Coarsen browser coordinates before the request.
- Use only public office, issuer, practice, or opt-in location relationships.
- Never expose home addresses, exact person coordinates, contacts, filing schedules, or raw
  financial source payloads.
- Keep the NWS API key server-side.

## Brand direction

Voice: minimal, intelligent, human, and confident. One clear headline, one primary action,
short recovery copy, generous space, and evidence details only on demand.

## Success

The user can search, understand whether verified NWS coverage exists, compare supported
estimates, and inspect the evidence without mistaking missing data for zero or public-office
association for residence.
