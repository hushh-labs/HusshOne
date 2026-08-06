import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhone,
  digitsOnly,
  toNational10,
  formatNational10,
  PHONE_REASON,
} from "./phone.mjs";

test("digitsOnly keeps order and drops everything else", () => {
  assert.equal(digitsOnly("+1 (914) 225-1000 x7"), "191422510007");
  assert.equal(digitsOnly(null), "");
  assert.equal(digitsOnly(undefined), "");
  assert.equal(digitsOnly("no digits here"), "");
});

test("every human spelling of one office line collapses to the same 10 digits", () => {
  const variants = [
    "(914) 225-1000",
    "914-225-1000",
    "9142251000",
    "+1 914 225 1000",
    "1-914-225-1000",
    "914.225.1000",
    "914 225 1000",
    "  (914)225-1000  ",
    "+1(914)225-1000",
    "19142251000",
    "1 (914) 225 1000",
  ];
  for (const v of variants) {
    const r = normalizePhone(v);
    assert.equal(r.ok, true, `expected ok for ${JSON.stringify(v)}: ${r.reason}`);
    assert.equal(r.national10, "9142251000", `wrong national10 for ${JSON.stringify(v)}`);
    assert.equal(r.e164, "+19142251000");
    assert.equal(r.reason, null);
    assert.equal(r.raw, v);
  }
});

test("extensions are split off, never folded into the subscriber number", () => {
  for (const [input, ext] of [
    ["914-225-1000 x123", "123"],
    ["914-225-1000x123", "123"],
    ["(914) 225-1000 ext 4", "4"],
    ["914 225 1000 ext. 4021", "4021"],
    ["914-225-1000 extension 99", "99"],
    ["1-914-225-1000 X12", "12"],
    // Real string shape from the SEC roster: a trailing menu option after a "#".
    ["914-225-1000 OPTION#1", "1"],
  ]) {
    const r = normalizePhone(input);
    assert.equal(r.ok, true, `expected ok for ${input}: ${r.reason}`);
    assert.equal(r.national10, "9142251000", `wrong national10 for ${input}`);
    assert.equal(r.extension, ext, `wrong extension for ${input}`);
  }
});

test("no extension means extension is null, not empty string", () => {
  assert.equal(normalizePhone("9142251000").extension, null);
});

test("a bare number is not mistaken for an extension marker", () => {
  // "…x…" only counts as an extension if what is left is still a whole phone number.
  const r = normalizePhone("PHOENIX 6023815");
  assert.equal(r.ok, false);
  assert.equal(r.national10, null);
});

test("non-NANP country codes are rejected as such, not as a length problem", () => {
  for (const v of ["+44 20 7946 0958", "+91 98765 43210", "+33 1 42 68 53 00"]) {
    const r = normalizePhone(v);
    assert.equal(r.ok, false, v);
    assert.equal(r.reason, PHONE_REASON.NON_NANP_COUNTRY, v);
  }
  // 11 digits that do not start with the NANP country code 1.
  assert.equal(normalizePhone("29142251000").reason, PHONE_REASON.NON_NANP_COUNTRY);
});

test("too short and too long are distinguished", () => {
  assert.equal(normalizePhone("225-1000").reason, PHONE_REASON.TOO_SHORT);
  assert.equal(normalizePhone("914225100").reason, PHONE_REASON.TOO_SHORT);
  assert.equal(normalizePhone("1-914-225-10").reason, PHONE_REASON.TOO_SHORT);
  assert.equal(normalizePhone("914225100012").reason, PHONE_REASON.TOO_LONG);
  assert.equal(normalizePhone("+1 914 225 1000 5555").reason, PHONE_REASON.TOO_LONG);
});

test("structurally impossible NANP numbers are refused", () => {
  assert.equal(normalizePhone("114-225-1000").reason, PHONE_REASON.INVALID_AREA_CODE);
  assert.equal(normalizePhone("011-225-1000").reason, PHONE_REASON.INVALID_AREA_CODE);
  // N11 service codes cannot be area codes (911, 411, 611 …).
  assert.equal(normalizePhone("911-225-1000").reason, PHONE_REASON.INVALID_AREA_CODE);
  assert.equal(normalizePhone("411-225-1000").reason, PHONE_REASON.INVALID_AREA_CODE);
  // …nor central office codes inside a geographic area code.
  assert.equal(normalizePhone("914-911-1000").reason, PHONE_REASON.INVALID_EXCHANGE);
  assert.equal(normalizePhone("914-125-1000").reason, PHONE_REASON.INVALID_EXCHANGE);
  assert.equal(normalizePhone("1111111111").reason, PHONE_REASON.INVALID_AREA_CODE);
});

test("toll-free numbers may carry an N11-shaped exchange — real firms use them", () => {
  // All four are live main-office lines in the 2026-08-03 SEC roster. The generic "NXX is
  // a central office code and cannot be N11" rule does not hold inside a toll-free NPA.
  for (const [input, expected] of [
    ["888-511-4611", "8885114611"],
    ["866-211-8970", "8662118970"],
    ["(800) 711-4818", "8007114818"],
    ["877-411-2737", "8774112737"],
  ]) {
    const r = normalizePhone(input);
    assert.equal(r.ok, true, `${input}: ${r.reason}`);
    assert.equal(r.national10, expected);
  }
  // The relaxation is scoped to toll-free codes only.
  assert.equal(normalizePhone("914-511-4611").reason, PHONE_REASON.INVALID_EXCHANGE);
  // …and the leading-digit rule still applies everywhere.
  assert.equal(normalizePhone("800-163-3326").reason, PHONE_REASON.INVALID_EXCHANGE);
});

test("toll-free and vanity-ish real numbers still pass", () => {
  assert.equal(normalizePhone("800-999-2000").national10, "8009992000");
  assert.equal(normalizePhone("1-800-356-2906").national10, "8003562906");
  assert.equal(normalizePhone("13123817963").national10, "3123817963");
});

test("junk in, structured refusal out — never a throw", () => {
  for (const [input, reason] of [
    ["", PHONE_REASON.EMPTY],
    ["   ", PHONE_REASON.EMPTY],
    [null, PHONE_REASON.EMPTY],
    [undefined, PHONE_REASON.EMPTY],
    ["hello there", PHONE_REASON.NO_DIGITS],
    ["N/A", PHONE_REASON.NO_DIGITS],
    ["----", PHONE_REASON.NO_DIGITS],
    ["+", PHONE_REASON.NO_DIGITS],
  ]) {
    const r = normalizePhone(input);
    assert.equal(r.ok, false, String(input));
    assert.equal(r.reason, reason, String(input));
    assert.equal(r.national10, null);
    assert.equal(r.e164, null);
    assert.equal(typeof r.raw, "string");
  }
});

test("non-string inputs are coerced, not crashed on", () => {
  assert.equal(normalizePhone(9142251000).national10, "9142251000");
  assert.equal(normalizePhone({}).ok, false);
  assert.equal(normalizePhone([]).ok, false);
});

test("toNational10 is the null-or-digits shorthand", () => {
  assert.equal(toNational10("(914) 225-1000"), "9142251000");
  assert.equal(toNational10("+44 20 7946 0958"), null);
});

test("formatNational10 renders the canonical display form", () => {
  assert.equal(formatNational10("9142251000"), "(914) 225-1000");
  assert.equal(formatNational10("91422510"), null);
});
