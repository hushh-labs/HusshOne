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

  const position = positions.get("1111111:320193");
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

  const position = positions.get("1111111:320193");
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

test("valuePosition multiplies, and returns null when no price was disclosed", () => {
  // A real row from the 2026Q2 dataset: 3,214,080 shares at the $171.30 disclosed on
  // that filing.
  assert.equal(valuePosition({ shares: 3214080, pricePerShare: 171.3 }), 550571904);
  assert.equal(valuePosition({ shares: 100, pricePerShare: null }), null,
    "unpriced must be null, not 0 — unknown value is not zero value");
  assert.equal(valuePosition(null), null);
});
