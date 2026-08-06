// Every fixture here is SYNTHETIC — invented names, invented CRDs in the 9999xxx range.
//
// What is real is the LAYOUT: the wrapped title, the column order, the mixed case between
// rows, the entity row with no CRD, the three different places the header's line breaks fall,
// the Schedule B table that starts with the same words, and the "Schedule B" terminator. The
// parser only cares about layout, so a synthetic filing exercises it exactly as well as a
// real one — and real people's ownership records stay out of the repository.
//
// Live verification against real filings is done separately and reported in the change
// description, not committed here.

import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  ADV_PDF_BASE,
  AdvFetchError,
  AdvPdfError,
  DEFAULT_USER_AGENT,
  SCHEDULE_A_CACHE_PREFIX,
  ScheduleAParseError,
  advPdfUrl,
  decodeContentStreamText,
  extractText,
  fetchFirmAdv,
  findScheduleASections,
  getScheduleA,
  isScheduleAHeader,
  looksLikePdf,
  mergeStreamTexts,
  normalizeScheduleAName,
  parseScheduleA,
} from "./adv-schedule-a.mjs";

// ---------------------------------------------------------------------------
// synthetic document fixtures
// ---------------------------------------------------------------------------

/** The narrative that precedes the real table in every filing. It names the ownership codes
 *  and the DE/FE/I convention, so a parser that anchors loosely finds THIS and returns
 *  garbage. It is included in the fixtures on purpose. */
const INSTRUCTIONS = `Schedule A
Direct Owners and Executive Officers
1.
Complete Schedule A only if you are submitting an initial application or report.
4.
In the DE/FE/I column below, enter "DE" if the owner is a domestic entity, "FE" if the owner is an entity
incorporated or domiciled in a foreign country, or "I" if the owner or executive officer is an individual.
6.
Ownership codes are:
NA - less than 5%
B - 10% but less than 25%
D - 50% but less than 75%
A - 5% but less than 10%
C - 25% but less than 50%
E - 75% or more
7.
(c)
Complete each column.`;

/** Header shape as one real filing renders it. */
const HEADER_A = `FULL LEGAL NAME (Individuals: Last
Name, First Name, Middle Name)
DE/FE/I
Title or Status
Date Title or Status
Acquired MM/YYYY
Ownership
Code
Control
Person
PR
CRD
 No. If None: S.S. No. and Date
of Birth, IRS Tax No. or Employer
ID No.`;

/** Same table, different filing: the break falls after "FULL LEGAL NAME". */
const HEADER_B = `FULL LEGAL NAME
(Individuals: Last Name, First
Name, Middle Name)
DE/FE/I
Title or Status
Date Title or
Status Acquired
MM/YYYY
Ownership
Code
Control
Person
PR
CRD
 No. If None: S.S.
No. and Date of Birth,
IRS Tax No. or
Employer ID No.`;

/** Same table again, third filing: the caption is just "Status". */
const HEADER_C = `FULL LEGAL NAME (Individuals: Last
Name, First Name, Middle Name)
DE/FE/I
Status
Date Status
Acquired
MM/YYYY
Ownership
Code
Control
Person
PR
CRD
 No. If None: S.S. No. and Date of
Birth, IRS Tax No. or Employer ID No.`;

/** Schedule B — indirect owners. Starts with the same words and adds ONE column. */
const HEADER_SCHEDULE_B = `FULL LEGAL NAME (Individuals:
Last Name, First Name, Middle
Name)
DE/FE/I
Entity in Which
Interest is Owned
Status
Date Status
Acquired
MM/YYYY
Ownership
Code
Control
Person
PR
CRD
 No. If None: S.S. No. and
Date of Birth, IRS Tax No. or
Employer ID No.`;

/** Two individuals. The first has a title that wraps across three lines; the second is filed
 *  in a different case from the first, in the same table. */
const ROWS_TWO_PEOPLE = `DOE, JANE, Q
I
MANAGING
MEMBER/CHIEF
COMPLIANCE OFFICER
02/2007
E
Y
N
9999001
Roe, Samuel, T
I
CO-COMPLIANCE
OFFICER
06/2025
NA
N
N
9999002`;

const AFTER_TABLE = `Schedule B
Indirect Owners
1.
Complete Schedule B only if you are submitting an initial application or report.`;

const doc = (...parts) => parts.join("\n");

/** assert.throws() returns undefined, so it cannot hand back the error for inspection. */
function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail("expected a throw");
}

const SIMPLE = doc(INSTRUCTIONS, HEADER_A, ROWS_TWO_PEOPLE, AFTER_TABLE);

// ---------------------------------------------------------------------------
// parseScheduleA — the table
// ---------------------------------------------------------------------------

test("parseScheduleA: reads the filed rows, wrapped title and all", () => {
  const rows = parseScheduleA(SIMPLE);
  assert.equal(rows.length, 2);

  assert.deepEqual(rows[0], {
    name: "DOE, JANE, Q",
    nameNormalized: "JANE Q DOE",
    individualCrd: 9999001,
    isIndividual: true,
    // the three physical lines are ONE title
    title: "MANAGING MEMBER/CHIEF COMPLIANCE OFFICER",
    dateAcquired: "02/2007",
    ownershipCode: "E",
    isControlPerson: true,
    isPublicReporting: false,
  });

  assert.deepEqual(rows[1], {
    name: "Roe, Samuel, T",
    nameNormalized: "SAMUEL T ROE",
    individualCrd: 9999002,
    isIndividual: true,
    title: "CO-COMPLIANCE OFFICER",
    dateAcquired: "06/2025",
    ownershipCode: "NA",
    isControlPerson: false,
    isPublicReporting: false,
  });
});

test("parseScheduleA: the individual CRD is on every individual row — no name guessing needed", () => {
  const rows = parseScheduleA(SIMPLE);
  assert.deepEqual(
    rows.map((r) => r.individualCrd),
    [9999001, 9999002],
  );
  assert.ok(rows.every((r) => Number.isInteger(r.individualCrd)));
});

test("parseScheduleA: anchors on the table, never on the instructions that precede it", () => {
  const rows = parseScheduleA(SIMPLE);
  // The instructions block contains "NA - less than 5%", "E - 75% or more" and the DE/FE/I
  // sentence. None of it may become a row.
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((r) => /less than|or more|domestic entity/i.test(r.name)));
});

test("parseScheduleA: every header line-break variant finds the same table", () => {
  for (const [label, header] of [
    ["A", HEADER_A],
    ["B", HEADER_B],
    ["C", HEADER_C],
  ]) {
    const rows = parseScheduleA(doc(INSTRUCTIONS, header, ROWS_TWO_PEOPLE, AFTER_TABLE));
    assert.equal(rows.length, 2, `header variant ${label}`);
    assert.equal(rows[0].individualCrd, 9999001, `header variant ${label}`);
  }
});

test("parseScheduleA: an entity row carries no CRD and does not eat the next owner's name", () => {
  const rows = parseScheduleA(
    doc(
      INSTRUCTIONS,
      HEADER_A,
      `EXAMPLE HOLDCO B, LLC
DE
SOLE MEMBER
01/2020
E
Y
N
DOE, JANE, Q
I
CHIEF FINANCIAL
OFFICER
06/2020
NA
Y
N
9999001`,
      AFTER_TABLE,
    ),
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].isIndividual, false);
  assert.equal(rows[0].name, "EXAMPLE HOLDCO B, LLC");
  assert.equal(rows[0].individualCrd, null);
  assert.equal(rows[0].ownershipCode, "E");
  // the row AFTER the CRD-less entity row is intact
  assert.equal(rows[1].name, "DOE, JANE, Q");
  assert.equal(rows[1].individualCrd, 9999001);
});

test("parseScheduleA: an entity's tax/employer ID is consumed but never reported as a CRD", () => {
  const rows = parseScheduleA(
    doc(
      INSTRUCTIONS,
      HEADER_A,
      `EXAMPLE HOLDCO B, LLC
DE
SOLE MEMBER
01/2020
E
Y
N
99-9999001
ROE, SAMUEL, T
I
PARTNER
06/2020
NA
Y
N
9999002`,
      AFTER_TABLE,
    ),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].individualCrd, null, "an EIN is not a person's CRD");
  assert.equal(rows[1].name, "ROE, SAMUEL, T", "the EIN line must not become the next name");
});

test("parseScheduleA: FE marks a foreign entity, and it is not a person either", () => {
  const rows = parseScheduleA(
    doc(INSTRUCTIONS, HEADER_A, `EXAMPLE OFFSHORE LTD\nFE\nMEMBER\n03/2019\nC\nN\nN`, AFTER_TABLE),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isIndividual, false);
  assert.equal(rows[0].individualCrd, null);
});

test("parseScheduleA: every ownership code the form defines survives round-trip", () => {
  const codes = ["NA", "A", "B", "C", "D", "E"];
  const body = codes
    .map((code, i) => `DOE, JANE, ${String.fromCharCode(65 + i)}\nI\nPARTNER\n01/2020\n${code}\nY\nN\n${9999001 + i}`)
    .join("\n");
  const rows = parseScheduleA(doc(INSTRUCTIONS, HEADER_A, body, AFTER_TABLE));
  assert.deepEqual(rows.map((r) => r.ownershipCode), codes);
});

test("parseScheduleA: control-person and PR flags read Y/N, Yes/No and PR alike", () => {
  const rows = parseScheduleA(
    doc(
      INSTRUCTIONS,
      HEADER_A,
      `DOE, JANE, Q
I
PARTNER
01/2020
E
Y
N
9999001
ROE, SAMUEL, T
I
PARTNER
01/2020
NA
No
Yes
9999002
POE, ALEX
I
PARTNER
01/2020
NA
Yes
PR
9999003`,
      AFTER_TABLE,
    ),
  );
  assert.deepEqual(rows.map((r) => r.isControlPerson), [true, false, true]);
  assert.deepEqual(rows.map((r) => r.isPublicReporting), [false, true, true]);
});

test("parseScheduleA: two-part and three-part names both parse, and a wrapped name rejoins", () => {
  const rows = parseScheduleA(
    doc(
      INSTRUCTIONS,
      HEADER_A,
      `POE, ALEX
I
PARTNER
01/2020
NA
Y
N
9999001
DOE, JANE, Q
I
PARTNER
01/2020
NA
Y
N
9999002
VANDERBERGSMITHSON,
MARGUERITE, ELIZABETH
I
PARTNER
01/2020
NA
Y
N
9999003`,
      AFTER_TABLE,
    ),
  );
  assert.deepEqual(rows.map((r) => r.nameNormalized), [
    "ALEX POE",
    "JANE Q DOE",
    "MARGUERITE ELIZABETH VANDERBERGSMITHSON",
  ]);
});

test("parseScheduleA: the section ends at Schedule B — indirect owners never leak in", () => {
  const rows = parseScheduleA(
    doc(
      INSTRUCTIONS,
      HEADER_A,
      ROWS_TWO_PEOPLE,
      "Schedule B",
      "Indirect Owners",
      HEADER_SCHEDULE_B,
      `EXAMPLE PARENT HOLDINGS, LLC
DE
EXAMPLE HOLDCO B, LLC
MANAGING MEMBER
07/2018
E
Y
N`,
    ),
  );
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((r) => /PARENT HOLDINGS/.test(r.name)));
});

test("isScheduleAHeader: the extra column is the only thing that tells the two tables apart", () => {
  assert.equal(isScheduleAHeader(HEADER_A), true);
  assert.equal(isScheduleAHeader(HEADER_B), true);
  assert.equal(isScheduleAHeader(HEADER_C), true);
  assert.equal(isScheduleAHeader(HEADER_SCHEDULE_B), false);
});

test("parseScheduleA: a document with ONLY a Schedule B table throws rather than returning its rows", () => {
  const text = doc(
    "Schedule B",
    "Indirect Owners",
    HEADER_SCHEDULE_B,
    `EXAMPLE PARENT HOLDINGS, LLC
DE
EXAMPLE HOLDCO B, LLC
MANAGING MEMBER
07/2018
E
Y
N`,
  );
  const error = thrown(() => parseScheduleA(text));
  assert.ok(error instanceof ScheduleAParseError);
  assert.match(error.message, /Schedule B/);
});

// ---------------------------------------------------------------------------
// parseScheduleA — the duplication the PDF producer creates
// ---------------------------------------------------------------------------

test("parseScheduleA: a duplicated table yields ONE set of rows, not two", () => {
  const once = doc(INSTRUCTIONS, HEADER_A, ROWS_TWO_PEOPLE, AFTER_TABLE);
  const rows = parseScheduleA(doc(once, once));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.individualCrd), [9999001, 9999002]);
});

test("parseScheduleA: a TRUNCATED copy loses to the complete one — the complete row wins", () => {
  // The real failure this guards: one copy of the table was cut off mid-row, leaving a last
  // row whose title was half-read and whose successor was missing. Merging the copies would
  // keep the WRONG row; picking the fullest copy discards it.
  const truncated = doc(
    INSTRUCTIONS,
    HEADER_A,
    `DOE, JANE, Q
I
MANAGING
MEMBER/CHIEF
COMPLIANCE OFFICER
02/2007
E
Y
N
9999001
Roe, Samuel, T
I
CO-COMPLIANCE
06/2025
NA
N
N
9999002`,
    "14.",
    "What is the approximate percentage of the private fund beneficially owned by you:",
    "0",
    "%",
  );
  const complete = doc(INSTRUCTIONS, HEADER_A, ROWS_TWO_PEOPLE, AFTER_TABLE);

  for (const text of [doc(truncated, complete), doc(complete, truncated)]) {
    const rows = parseScheduleA(text);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].title, "CO-COMPLIANCE OFFICER", "the complete copy's title must win");
  }
});

test("parseScheduleA: a table broken across a page keeps reading past the repeated header", () => {
  const rows = parseScheduleA(
    doc(
      INSTRUCTIONS,
      HEADER_A,
      `DOE, JANE, Q
I
MANAGING MEMBER
02/2007
E
Y
N
9999001`,
      HEADER_A, // page break: the header is drawn again above the continuation
      `Roe, Samuel, T
I
CO-COMPLIANCE
OFFICER
06/2025
NA
N
N
9999002`,
      AFTER_TABLE,
    ),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.individualCrd), [9999001, 9999002]);
});

// ---------------------------------------------------------------------------
// parseScheduleA — "nobody" vs "we could not read it"
// ---------------------------------------------------------------------------

test('parseScheduleA: "Schedule A lists nobody" is [] — a real answer about the firm', () => {
  const rows = parseScheduleA(doc(INSTRUCTIONS, HEADER_A, AFTER_TABLE));
  assert.deepEqual(rows, []);
});

test("parseScheduleA: no Schedule A anywhere is a typed error, never []", () => {
  const error = thrown(() => parseScheduleA("Item 1 Identifying Information\nA. Your full legal name: EXAMPLE ADVISERS LLC"));
  assert.ok(error instanceof ScheduleAParseError);
  assert.equal(error.name, "ScheduleAParseError");
  assert.equal(error.candidates, 0);
});

test("parseScheduleA: a header over unreadable content is a typed error, never []", () => {
  const error = thrown(() =>
    parseScheduleA(doc(INSTRUCTIONS, HEADER_A, "1.\nthis is not a table\n2.\nnor is this\n3.\nnor this", AFTER_TABLE)),
  );
  assert.ok(error instanceof ScheduleAParseError);
  assert.match(error.message, /no row could be read/);
  assert.equal(error.candidates, 1);
});

test("parseScheduleA: empty input is an error, not an empty Schedule A", () => {
  for (const input of ["", "   ", null, undefined, 42]) {
    assert.throws(() => parseScheduleA(input), ScheduleAParseError);
  }
});

test("parseScheduleA: a row it cannot read is DROPPED with a warning, never guessed", () => {
  const warnings = [];
  const rows = parseScheduleA(
    doc(
      INSTRUCTIONS,
      HEADER_A,
      `DOE, JANE, Q
I
MANAGING MEMBER
02/2007
E
Y
N
9999001
Roe, Samuel, T
I
CO-COMPLIANCE OFFICER
NOT-A-DATE
ZZ
maybe
sometimes`,
      AFTER_TABLE,
    ),
    { onWarn: (m) => warnings.push(m) },
  );

  assert.equal(rows.length, 1, "the readable row survives");
  assert.equal(rows[0].individualCrd, 9999001);
  assert.ok(!rows.some((r) => /Roe/.test(r.name)), "the unreadable row must not be invented");
  assert.ok(warnings.length >= 1);
  assert.match(warnings.join(" "), /Roe, Samuel, T/);
});

test("parseScheduleA: a lost row cannot run away with the rest of the document", () => {
  // 400 lines of prose after a broken row. The bounded name/title scans stop it dead.
  const noise = Array.from({ length: 400 }, (_, i) => `line ${i} of unrelated Schedule D prose`).join("\n");
  const warnings = [];
  const rows = parseScheduleA(
    doc(INSTRUCTIONS, HEADER_A, `DOE, JANE, Q\nI\nMANAGING MEMBER\n02/2007\nE\nY\nN\n9999001`, noise),
    { onWarn: (m) => warnings.push(m) },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "DOE, JANE, Q");
});

test("findScheduleASections: reports what the discriminator rejected", () => {
  const sections = findScheduleASections(
    doc(INSTRUCTIONS, HEADER_A, ROWS_TWO_PEOPLE, "Schedule B", HEADER_SCHEDULE_B, "EXAMPLE PARENT, LLC"),
  );
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((s) => s.isScheduleA), [true, false]);
});

// ---------------------------------------------------------------------------
// normalizeScheduleAName
// ---------------------------------------------------------------------------

test("normalizeScheduleAName: surname-first becomes natural order, in one case", () => {
  assert.equal(normalizeScheduleAName("DOE, JANE, Q"), "JANE Q DOE");
  assert.equal(normalizeScheduleAName("Roe, Samuel, T"), "SAMUEL T ROE");
  assert.equal(normalizeScheduleAName("POE, ALEX"), "ALEX POE");
});

test("normalizeScheduleAName: mixed case between rows of the same table collapses to one key", () => {
  assert.equal(normalizeScheduleAName("DelRoe, Robin, Dale"), normalizeScheduleAName("DELROE, ROBIN, DALE"));
});

test("normalizeScheduleAName: an entity keeps its filed order — it has no surname", () => {
  assert.equal(normalizeScheduleAName("EXAMPLE HOLDCO B, LLC", false), "EXAMPLE HOLDCO B, LLC");
  assert.equal(normalizeScheduleAName("Example Offshore Ltd", false), "EXAMPLE OFFSHORE LTD");
});

test("normalizeScheduleAName: whitespace from a wrapped cell is collapsed", () => {
  assert.equal(normalizeScheduleAName("DOE,\n  JANE,\tQ"), "JANE Q DOE");
  assert.equal(normalizeScheduleAName(""), "");
});

// ---------------------------------------------------------------------------
// the text layer
// ---------------------------------------------------------------------------

test("decodeContentStreamText: literal strings come out, positioning operators become lines", () => {
  const stream = "BT /F1 9 Tf 72 720 Td (DOE, JANE, Q) Tj 0 -12 Td (I) Tj T* (MANAGING MEMBER) Tj ET";
  assert.deepEqual(
    decodeContentStreamText(stream).split("\n").map((s) => s.trim()).filter(Boolean),
    ["DOE, JANE, Q", "I", "MANAGING MEMBER"],
  );
});

test("decodeContentStreamText: TJ arrays, escapes, nested parens and hex strings", () => {
  assert.equal(decodeContentStreamText("[(CHIEF) -250 (COMPLIANCE) -250 (OFFICER)] TJ").trim(), "CHIEFCOMPLIANCEOFFICER");
  assert.equal(decodeContentStreamText("(A \\(B\\) C) Tj").trim(), "A (B) C");
  assert.equal(decodeContentStreamText("(outer (inner) outer) Tj").trim(), "outer (inner) outer");
  assert.equal(decodeContentStreamText("(50\\045 or more) Tj").trim(), "50% or more");
  assert.equal(decodeContentStreamText("<444F452C204A414E45> Tj").trim(), "DOE, JANE");
});

test("decodeContentStreamText: a dictionary is not mistaken for a hex string", () => {
  const out = decodeContentStreamText("<</Type /Page>> BT (ROE, SAMUEL, T) Tj ET");
  assert.match(out, /ROE, SAMUEL, T/);
});

test("mergeStreamTexts: cumulative page streams collapse to the longest member", () => {
  // The measured shape: page N's stream contains everything through page N.
  const pages = ["A", "A\nB", "A\nB\nC", "A\nB\nC\nD"];
  assert.equal(mergeStreamTexts(pages), "A\nB\nC\nD");
});

test("mergeStreamTexts: genuinely distinct pages are all kept, in order", () => {
  assert.equal(mergeStreamTexts(["page one", "page two", "page three"]), "page one\npage two\npage three");
});

test("mergeStreamTexts: exact duplicates keep exactly one copy — never zero", () => {
  assert.equal(mergeStreamTexts(["same", "same", "same"]), "same");
});

test("mergeStreamTexts: a duplicated table stops being duplicated", () => {
  const merged = mergeStreamTexts([SIMPLE, SIMPLE, SIMPLE]);
  assert.equal(parseScheduleA(merged).length, 2);
});

test("mergeStreamTexts: empty and non-string chunks are ignored", () => {
  assert.equal(mergeStreamTexts(["", "kept", null, undefined, 7]), "kept");
  assert.equal(mergeStreamTexts(null), "");
});

test("looksLikePdf / extractText: bytes that are not a PDF are a typed error", () => {
  assert.equal(looksLikePdf(Buffer.from("%PDF-1.4\r\n%...")), true);
  assert.equal(looksLikePdf(Buffer.from("<!doctype html><title>Error</title>")), false);
  assert.equal(looksLikePdf("%PDF-1.4"), false, "a string is not a Buffer");
  assert.equal(looksLikePdf(Buffer.alloc(0)), false);

  assert.throws(() => extractText(Buffer.from("<!doctype html>")), AdvPdfError);
  assert.throws(() => extractText("%PDF-1.4"), AdvPdfError);
});

test("extractText: a PDF with no readable text layer is a typed error, not an empty string", () => {
  assert.throws(() => extractText(Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF")), AdvPdfError);
});

// ---------------------------------------------------------------------------
// fetchFirmAdv
// ---------------------------------------------------------------------------

const PDF_BYTES = Buffer.from("%PDF-1.4\r\n%stub\r\n%%EOF");

const okResponse = (body = PDF_BYTES) => ({
  status: 200,
  ok: true,
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
});

const errorResponse = (status) => ({
  status,
  ok: false,
  arrayBuffer: async () => new ArrayBuffer(0),
});

test("advPdfUrl: the CRD really does appear twice — that is the SEC's URL shape", () => {
  assert.equal(advPdfUrl(9999001), `${ADV_PDF_BASE}/9999001/PDF/9999001.pdf`);
});

test("fetchFirmAdv: identifies this service on every request", async () => {
  const seen = [];
  const buffer = await fetchFirmAdv(9999001, {
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return okResponse();
    },
  });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, advPdfUrl(9999001));
  assert.equal(seen[0].options.headers["user-agent"], DEFAULT_USER_AGENT);
  assert.ok(seen[0].options.signal, "an AbortController signal must be attached");
});

test("fetchFirmAdv: an empty user-agent override falls back rather than going anonymous", async () => {
  const seen = [];
  await fetchFirmAdv(9999001, {
    userAgent: "   ",
    fetchImpl: async (_url, options) => {
      seen.push(options.headers["user-agent"]);
      return okResponse();
    },
  });
  assert.equal(seen[0], DEFAULT_USER_AGENT);
});

test("fetchFirmAdv: retries a 5xx exactly once", async () => {
  let calls = 0;
  const buffer = await fetchFirmAdv(9999001, {
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? errorResponse(503) : okResponse();
    },
  });
  assert.equal(calls, 2);
  assert.ok(Buffer.isBuffer(buffer));
});

test("fetchFirmAdv: two 5xx in a row give up — it does not retry forever", async () => {
  let calls = 0;
  const error = await fetchFirmAdv(9999001, {
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      return errorResponse(500);
    },
  }).then(
    () => null,
    (e) => e,
  );
  assert.equal(calls, 2);
  assert.ok(error instanceof AdvFetchError);
  assert.equal(error.status, 500);
});

test("fetchFirmAdv: a 4xx is final — an unknown CRD stays unknown however often you ask", async () => {
  let calls = 0;
  const error = await fetchFirmAdv(9999001, {
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      return errorResponse(404);
    },
  }).then(
    () => null,
    (e) => e,
  );
  assert.equal(calls, 1, "a 404 must not be retried");
  assert.equal(error.status, 404);
});

test("fetchFirmAdv: a network fault is not retried either — only 5xx is", async () => {
  let calls = 0;
  const error = await fetchFirmAdv(9999001, {
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      throw new Error("ECONNRESET");
    },
  }).then(
    () => null,
    (e) => e,
  );
  assert.equal(calls, 1);
  assert.ok(error instanceof AdvFetchError);
  assert.match(error.message, /ECONNRESET/);
});

test("fetchFirmAdv: the timeout aborts the request", async () => {
  const error = await fetchFirmAdv(9999001, {
    timeoutMs: 5,
    sleepImpl: async () => {},
    fetchImpl: (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(error instanceof AdvFetchError);
  assert.match(error.message, /aborted/);
});

test("fetchFirmAdv: an HTML error page served with HTTP 200 is caught, not parsed", async () => {
  const html = Buffer.from("<!doctype html><title>Service unavailable</title>");
  const error = await fetchFirmAdv(9999001, {
    fetchImpl: async () => okResponse(html),
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(error instanceof AdvPdfError);
  assert.match(error.message, /not a PDF/);
});

test("fetchFirmAdv: an oversized body is refused before it is parsed", async () => {
  const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(4096)]);
  const error = await fetchFirmAdv(9999001, {
    maxBytes: 1024,
    fetchImpl: async () => okResponse(big),
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(error instanceof AdvPdfError);
  assert.match(error.message, /over the 1024 limit/);
});

test("fetchFirmAdv: a malformed CRD never reaches the network", async () => {
  for (const bad of [0, -1, "abc", null, undefined, 1.5]) {
    const error = await fetchFirmAdv(bad, {
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    }).then(
      () => null,
      (e) => e,
    );
    assert.ok(error instanceof AdvFetchError, `crd=${bad}`);
    assert.equal(error.status, 400, `crd=${bad}`);
  }
});

// ---------------------------------------------------------------------------
// getScheduleA — the degrade-never-throw contract
// ---------------------------------------------------------------------------

const deps = (overrides = {}) => ({
  fetchImpl: async () => okResponse(),
  extractTextImpl: () => SIMPLE,
  sleepImpl: async () => {},
  ...overrides,
});

test("getScheduleA: fetch, extract and parse end to end", async () => {
  const rows = await getScheduleA(9999001, deps());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].individualCrd, 9999001);
});

test("getScheduleA: a network fault degrades to null — it never throws", async () => {
  const warnings = [];
  const result = await getScheduleA(
    9999001,
    deps({
      fetchImpl: async () => {
        throw new Error("ENOTFOUND reports.adviserinfo.sec.gov");
      },
      onWarn: (m) => warnings.push(m),
    }),
  );
  assert.equal(result, null);
  assert.match(warnings.join(" "), /ENOTFOUND/);
});

test("getScheduleA: an unreadable PDF degrades to null", async () => {
  const result = await getScheduleA(
    9999001,
    deps({
      extractTextImpl: () => {
        throw new AdvPdfError("no text layer");
      },
    }),
  );
  assert.equal(result, null);
});

test("getScheduleA: a parse failure degrades to null", async () => {
  const result = await getScheduleA(9999001, deps({ extractTextImpl: () => "Item 1 Identifying Information" }));
  assert.equal(result, null);
});

test("getScheduleA: a bad CRD degrades to null instead of throwing at the caller", async () => {
  assert.equal(await getScheduleA("not-a-crd", deps()), null);
  assert.equal(await getScheduleA(null, deps()), null);
});

test('getScheduleA: "lists nobody" comes back as [], which is NOT null', async () => {
  const result = await getScheduleA(9999001, deps({ extractTextImpl: () => doc(INSTRUCTIONS, HEADER_A, AFTER_TABLE) }));
  assert.deepEqual(result, []);
  assert.notEqual(result, null);
});

test("getScheduleA: reads through a cache.mjs-style wrap()", async () => {
  const store = new Map();
  const cache = {
    wrap: async (key, produce) => {
      if (store.has(key)) return store.get(key);
      const value = await produce();
      store.set(key, value);
      return value;
    },
  };
  let fetches = 0;
  const d = deps({
    cache,
    fetchImpl: async () => {
      fetches++;
      return okResponse();
    },
  });

  const first = await getScheduleA(9999001, d);
  const second = await getScheduleA(9999001, d);
  assert.equal(fetches, 1, "the second call must be served from cache");
  assert.deepEqual(second, first);
  assert.ok(store.has(`${SCHEDULE_A_CACHE_PREFIX}9999001`));
});

test("getScheduleA: reads through a plain get/set cache too", async () => {
  const store = new Map();
  const cache = {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
      return value;
    },
  };
  let fetches = 0;
  const d = deps({
    cache,
    fetchImpl: async () => {
      fetches++;
      return okResponse();
    },
  });
  await getScheduleA(9999001, d);
  await getScheduleA(9999001, d);
  assert.equal(fetches, 1);
});

test("getScheduleA: a failure is NOT cached — the next caller gets a real attempt", async () => {
  const store = new Map();
  const cache = {
    wrap: async (key, produce) => {
      if (store.has(key)) return store.get(key);
      const value = await produce(); // a rejected producer must leave the key cold
      store.set(key, value);
      return value;
    },
  };
  let attempts = 0;
  const d = deps({
    cache,
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return okResponse();
    },
  });

  assert.equal(await getScheduleA(9999001, d), null);
  assert.equal(store.size, 0, "nothing may be stored for a failed lookup");
  const second = await getScheduleA(9999001, d);
  assert.equal(second.length, 2);
  assert.equal(attempts, 2);
});

test("getScheduleA: different firms do not share a cache key", async () => {
  const store = new Map();
  const cache = {
    wrap: async (key, produce) => (store.has(key) ? store.get(key) : store.set(key, await produce()).get(key)),
  };
  await getScheduleA(9999001, deps({ cache }));
  await getScheduleA(9999002, deps({ cache }));
  assert.deepEqual([...store.keys()], [`${SCHEDULE_A_CACHE_PREFIX}9999001`, `${SCHEDULE_A_CACHE_PREFIX}9999002`]);
});
