import assert from "node:assert/strict";
import test from "node:test";

import { buildPositions, parseSecDate, parseTsv, valuePosition } from "./dataset.mjs";

test("parseTsv yields row objects keyed by header", () => {
  const rows = [...parseTsv("A\tB\n1\t2\n3\t4\n")];
  assert.deepEqual(rows, [{ A: "1", B: "2" }, { A: "3", B: "4" }]);
});

test("parseTsv tolerates CRLF, blank lines and short rows", () => {
  const rows = [...parseTsv("A\tB\r\n1\t2\r\n\n5\n")];
  assert.equal(rows.length, 2);
  assert.equal(rows[1].A, "5");
  assert.equal(rows[1].B, "", "missing trailing cell becomes empty, not undefined");
});

test("parseSecDate converts the SEC's DD-MON-YYYY form", () => {
  assert.equal(parseSecDate("30-JUN-2026"), "2026-06-30");
  assert.equal(parseSecDate("1-JAN-2025"), "2025-01-01");
  assert.equal(parseSecDate(""), null);
  assert.equal(parseSecDate("2026-06-30"), null);
  assert.equal(parseSecDate("30-XXX-2026"), null);
});

const submissions = [
  { ACCESSION_NUMBER: "a1", FILING_DATE: "01-MAY-2026", ISSUERCIK: "0000320193", ISSUERNAME: "Apple Inc.", ISSUERTRADINGSYMBOL: "AAPL", DOCUMENT_TYPE: "4" },
  { ACCESSION_NUMBER: "a2", FILING_DATE: "30-JUN-2026", ISSUERCIK: "0000320193", ISSUERNAME: "Apple Inc.", ISSUERTRADINGSYMBOL: "AAPL", DOCUMENT_TYPE: "4" },
];

const owners = [
  { ACCESSION_NUMBER: "a1", RPTOWNERCIK: "0001111111", RPTOWNERNAME: "REAL OFFICER", RPTOWNER_RELATIONSHIP: "Officer", RPTOWNER_TITLE: "CFO", RPTOWNER_STREET1: "12 PRIVATE ROAD" },
  { ACCESSION_NUMBER: "a2", RPTOWNERCIK: "0001111111", RPTOWNERNAME: "REAL OFFICER", RPTOWNER_RELATIONSHIP: "Officer", RPTOWNER_TITLE: "CFO", RPTOWNER_STREET1: "12 PRIVATE ROAD" },
];

test("the newest filing wins, regardless of table order", () => {
  const positions = buildPositions({
    submissions,
    owners,
    // a2 (June) listed BEFORE a1 (May) on purpose — the SEC's tables are not date-sorted.
    transactions: [
      { ACCESSION_NUMBER: "a2", SECURITY_TITLE: "Common Stock", SHRS_OWND_FOLWNG_TRANS: "500", TRANS_PRICEPERSHARE: "200" },
      { ACCESSION_NUMBER: "a1", SECURITY_TITLE: "Common Stock", SHRS_OWND_FOLWNG_TRANS: "100", TRANS_PRICEPERSHARE: "150" },
    ],
    holdings: [],
  });

  const position = positions.get("1111111:320193:direct");
  assert.equal(position.shares, 500, "June's share count must win over May's");
  assert.equal(position.asOf, "2026-06-30");
});

test("a filer's street address never enters a position", () => {
  const positions = buildPositions({ submissions, owners, transactions: [
    { ACCESSION_NUMBER: "a1", SHRS_OWND_FOLWNG_TRANS: "100", TRANS_PRICEPERSHARE: "150" },
  ], holdings: [] });

  const serialised = JSON.stringify([...positions.values()]);
  assert.equal(serialised.includes("PRIVATE ROAD"), false);
  assert.equal(serialised.includes("RPTOWNER_STREET1"), false);
});

test("non-Section-16 filers are dropped before indexing", () => {
  const positions = buildPositions({
    submissions,
    owners: [{ ACCESSION_NUMBER: "a1", RPTOWNERCIK: "0002222222", RPTOWNERNAME: "A SPOUSE", RPTOWNER_RELATIONSHIP: "Spouse" }],
    transactions: [{ ACCESSION_NUMBER: "a1", SHRS_OWND_FOLWNG_TRANS: "100", TRANS_PRICEPERSHARE: "150" }],
    holdings: [],
  });
  assert.equal(positions.size, 0);
});

test("an older filing may backfill a price the newer one omitted", () => {
  // A gift or Form 3 reports shares with no price. The share count must stay current
  // while still carrying the last price actually disclosed.
  const positions = buildPositions({
    submissions,
    owners,
    transactions: [{ ACCESSION_NUMBER: "a1", SHRS_OWND_FOLWNG_TRANS: "100", TRANS_PRICEPERSHARE: "150" }],
    holdings: [{ ACCESSION_NUMBER: "a2", SECURITY_TITLE: "Common Stock", SHRS_OWND_FOLWNG_TRANS: "500" }],
  });

  const position = positions.get("1111111:320193:direct");
  assert.equal(position.shares, 500);
  assert.equal(position.pricePerShare, 150, "price should carry forward from the priced filing");
});

test("zero and negative share counts are ignored", () => {
  const positions = buildPositions({
    submissions, owners,
    transactions: [{ ACCESSION_NUMBER: "a1", SHRS_OWND_FOLWNG_TRANS: "0", TRANS_PRICEPERSHARE: "150" }],
    holdings: [],
  });
  assert.equal(positions.size, 0);
});

test("within one filing date, the first row is the closing position", () => {
  // Musk's real 17-JUN-2026 Tesla filing. The option exercise (code M, priced at the
  // $23.34 STRIKE) happened first and the tax withholding (code F, priced at the
  // $404.66 MARKET price) second — so 710,172,677 is what he ends up holding, and the
  // SEC lists that row first. Taking the later row would report both a stale position
  // and a strike price masquerading as a market price.
  const positions = buildPositions({
    submissions: [submissions[0]],
    owners: [owners[0]],
    transactions: [
      { ACCESSION_NUMBER: "a1", TRANS_CODE: "F", SHRS_OWND_FOLWNG_TRANS: "710172677", TRANS_PRICEPERSHARE: "404.66" },
      { ACCESSION_NUMBER: "a1", TRANS_CODE: "M", SHRS_OWND_FOLWNG_TRANS: "727704534", TRANS_PRICEPERSHARE: "23.34" },
    ],
    holdings: [],
  });

  const position = positions.get("1111111:320193:direct");
  assert.equal(position.shares, 710172677, "closing position, not the mid-transaction one");
  assert.equal(position.pricePerShare, 404.66, "market price, not the option strike");
  assert.equal(valuePosition(position), 287378475475);
});

test("a disclosed price of zero is treated as no price at all", () => {
  // Filings for privately-held issuers report 0.00. SpaceX's Form 4s do this, and
  // taking it literally values an 842m-share position at $0 — worthless, rather than
  // unpriced. Caught against live 2026Q2 data.
  const positions = buildPositions({
    submissions, owners,
    transactions: [{ ACCESSION_NUMBER: "a1", SHRS_OWND_FOLWNG_TRANS: "842091670", TRANS_PRICEPERSHARE: "0.00" }],
    holdings: [],
  });

  const position = positions.get("1111111:320193:direct");
  assert.equal(position.shares, 842091670, "the share count is still disclosed");
  assert.equal(position.pricePerShare, null, "0.00 must not survive as a price");
  assert.equal(valuePosition(position), null, "must be unpriced, never $0");
});

test("derivative-only filers are indexed, priced from the issuer's direct price", () => {
  // 14.7% of qualifying filers hold ONLY options/RSUs and were dropped entirely.
  const positions = buildPositions({
    submissions,
    owners,
    transactions: [{ ACCESSION_NUMBER: "a1", SHRS_OWND_FOLWNG_TRANS: "100", TRANS_PRICEPERSHARE: "500" }],
    holdings: [],
    derivTransactions: [{
      ACCESSION_NUMBER: "a2", SECURITY_TITLE: "Stock Option (Right to Buy)",
      UNDLYNG_SEC_SHARES: "100000", CONV_EXERCISE_PRICE: "50",
    }],
    derivHoldings: [],
  });

  const option = positions.get("1111111:320193:derivative");
  assert.equal(option.kind, "derivative");
  assert.equal(option.shares, 100000, "underlying share count");
  assert.equal(option.strikePrice, 50);
  assert.equal(option.pricePerShare, 500, "market price borrowed from the direct position");

  // Intrinsic only: 100,000 x (500 - 50). Valuing at face would claim $50m.
  assert.equal(valuePosition(option), 45000000);

  // The direct holding is untouched and separately keyed.
  assert.equal(positions.get("1111111:320193:direct").shares, 100);
});

test("an underwater option is worth zero, never a negative", () => {
  const option = { kind: "derivative", shares: 1000, pricePerShare: 10, strikePrice: 90 };
  assert.equal(valuePosition(option), 0);
});

test("a zero-strike derivative is an RSU and carries full market value", () => {
  // RSUs convert for free, so 0 is a real strike here — not a missing one.
  const rsu = { kind: "derivative", shares: 1000, pricePerShare: 250, strikePrice: 0 };
  assert.equal(valuePosition(rsu), 250000);
});

test("a derivative with no strike at all is unpriceable, not free", () => {
  const unknown = { kind: "derivative", shares: 1000, pricePerShare: 250, strikePrice: null };
  assert.equal(valuePosition(unknown), null);
});

test("a derivative at an issuer with no direct price stays unpriced", () => {
  const positions = buildPositions({
    submissions, owners, transactions: [], holdings: [],
    derivTransactions: [{ ACCESSION_NUMBER: "a1", UNDLYNG_SEC_SHARES: "5000", CONV_EXERCISE_PRICE: "12" }],
    derivHoldings: [],
  });
  const option = positions.get("1111111:320193:derivative");
  assert.equal(option.pricePerShare, null, "no honest market price exists, so none is invented");
  assert.equal(valuePosition(option), null);
});

test("valuePosition multiplies, and returns null when no price was disclosed", () => {
  // A real row from the 2026Q2 dataset: 3,214,080 shares at the $171.30 disclosed on
  // that filing.
  assert.equal(valuePosition({ shares: 3214080, pricePerShare: 171.3 }), 550571904);
  assert.equal(valuePosition({ shares: 100, pricePerShare: null }), null,
    "unpriced must be null, not 0 — unknown value is not zero value");
  assert.equal(valuePosition(null), null);
});
