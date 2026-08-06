// NANP phone normalisation. Pure — no I/O, no deps.
//
// This is the ONLY key the claim lookup is allowed to search on, so it has to be strict in
// both directions: every reasonable way a human types their own office line must collapse
// onto one canonical 10-digit string, and anything that is not a real North American
// number must be rejected loudly rather than silently indexed as a near-miss. A sloppy
// normaliser here would turn a disambiguation aid into a phone-space enumeration tool.

/** Every digit in the string, in order. Non-digits (including "+") are dropped. */
export function digitsOnly(s) {
  return String(s ?? "").replace(/\D+/g, "");
}

// Extension markers, anchored to the end. "#" is included deliberately: the SEC roster
// really does carry values like "800-454-1628 OPTION#1", and without this the trailing
// digit would corrupt the number into an 11-digit non-NANP string. Longest alternative
// first so "extension" is not eaten as "ext" + "ension".
const EXTENSION_RE = /(?:extension|extn|ext|x|#)\.?\s*[:.\-]?\s*(\d{1,7})\s*$/i;

// Assigned and reserved toll-free area codes (NANP SMS/800 administration).
const TOLL_FREE_NPA = new Set([
  "800", "822", "833", "844", "855", "866", "877", "880",
  "881", "882", "883", "884", "885", "886", "887", "888", "889",
]);

/** Reason codes returned when `ok` is false. Stable — safe to branch on. */
export const PHONE_REASON = {
  EMPTY: "empty",
  NO_DIGITS: "no_digits",
  TOO_SHORT: "too_short",
  TOO_LONG: "too_long",
  NON_NANP_COUNTRY: "non_nanp_country",
  INVALID_AREA_CODE: "invalid_area_code",
  INVALID_EXCHANGE: "invalid_exchange",
};

/**
 * Normalise a typed phone number to NANP canonical form.
 *
 * Accepts "(914) 225-1000", "914-225-1000", "9142251000", "+1 914 225 1000",
 * "1-914-225-1000", "914-225-1000 x123" and the punctuation soup in between.
 *
 * @returns {{ok:boolean, national10:string|null, e164:string|null,
 *            extension:string|null, raw:string, reason:string|null}}
 */
export function normalizePhone(input) {
  const raw = input == null ? "" : String(input);
  const fail = (reason, extension = null) => ({
    ok: false,
    national10: null,
    e164: null,
    extension,
    raw,
    reason,
  });

  const trimmed = raw.trim();
  if (!trimmed) return fail(PHONE_REASON.EMPTY);

  // Pull the extension off first, so its digits never leak into the subscriber number.
  // If stripping it leaves too few digits to be a phone number at all, the "x"/"#" was
  // part of the number's own text rather than an extension marker — put it back.
  let body = trimmed;
  let extension = null;
  const extMatch = body.match(EXTENSION_RE);
  if (extMatch) {
    const stripped = body.slice(0, extMatch.index);
    const strippedDigits = digitsOnly(stripped).replace(/^1(?=\d{10}$)/, "");
    if (strippedDigits.length >= 10) {
      extension = extMatch[1];
      body = stripped;
    }
  }

  const hasPlus = /^\s*\+/.test(body);
  let digits = digitsOnly(body);
  if (!digits) return fail(PHONE_REASON.NO_DIGITS, extension);

  // "+44 20 7946 0958" is a perfectly good number — it is just not one we index. An
  // explicit "+" with a country code other than 1 is unambiguous, so say so precisely
  // instead of blaming the length.
  if (hasPlus && digits[0] !== "1") return fail(PHONE_REASON.NON_NANP_COUNTRY, extension);

  if (digits.length === 11) {
    if (digits[0] !== "1") return fail(PHONE_REASON.NON_NANP_COUNTRY, extension);
    digits = digits.slice(1);
  }

  if (digits.length < 10) return fail(PHONE_REASON.TOO_SHORT, extension);
  if (digits.length > 10) return fail(PHONE_REASON.TOO_LONG, extension);

  // NANP structure: NPA = [2-9] and never an N11 service code (911, 411 …); NXX = [2-9].
  // These are what keep "111-111-1111" and mis-typed foreign numbers out of the index.
  const npa = digits.slice(0, 3);
  const nxx = digits.slice(3, 6);
  if (npa[0] < "2" || (npa[1] === "1" && npa[2] === "1")) {
    return fail(PHONE_REASON.INVALID_AREA_CODE, extension);
  }
  if (nxx[0] < "2") return fail(PHONE_REASON.INVALID_EXCHANGE, extension);
  // The "no N11 central office code" rule is a rule about real central offices, so it does
  // NOT apply inside a toll-free NPA, where the last seven digits are just a subscriber
  // number. Enforcing it there rejects live advisory-firm lines — measured against the
  // 2026-08-03 SEC roster it wrongly refused nine, including 888-511-4611 and 866-211-8970.
  if (!TOLL_FREE_NPA.has(npa) && nxx[1] === "1" && nxx[2] === "1") {
    return fail(PHONE_REASON.INVALID_EXCHANGE, extension);
  }

  return {
    ok: true,
    national10: digits,
    e164: `+1${digits}`,
    extension,
    raw,
    reason: null,
  };
}

/** Convenience: the canonical 10-digit string, or null if the input is not a NANP number. */
export function toNational10(input) {
  const parsed = normalizePhone(input);
  return parsed.ok ? parsed.national10 : null;
}

/** Display form for a canonical 10-digit string: "9142251000" -> "(914) 225-1000". */
export function formatNational10(national10) {
  const d = digitsOnly(national10);
  if (d.length !== 10) return null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
