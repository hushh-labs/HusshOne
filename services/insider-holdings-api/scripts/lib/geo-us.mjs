/**
 * Is this issuer address in the United States?
 *
 * EDGAR's `isForeignLocation` flag cannot be trusted. Measured against the 2026Q2
 * index: 48 issuers carry a ZIP of "00000"/"000000" — Toyota, NetEase, H World,
 * SOPHiA GENETICS, all plainly foreign — and most are flagged `isForeign: false`.
 * The first record in the index, United Microelectronics of Taipei, carries state
 * code "F5" and is likewise flagged false.
 *
 * The consequence was not cosmetic. "00000" is absent from the Census gazetteer, so
 * those issuers failed to place and 217 people fell into a bucket that looked like a
 * postcode but was not one.
 *
 * So placement keys off an explicit whitelist of US state and territory codes instead
 * of the flag. A code we do not recognise is treated as foreign — an issuer wrongly
 * left off the map is a missing row, whereas an issuer wrongly placed is a wrong answer.
 */

/** The 50 states, DC, and the territories EDGAR uses. */
export const US_STATE_CODES = Object.freeze(
  new Set([
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC", "PR", "VI", "GU", "AS", "MP",
  ]),
);

/**
 * A postcode that is structurally impossible. "00000" is EDGAR's placeholder for a
 * foreign address, not a real ZIP — no US postcode is all zeroes.
 */
export function isPlaceholderZip(zip) {
  const raw = String(zip || "").trim();
  if (!raw) return true;
  return /^0+$/.test(raw.replace(/-.*$/, ""));
}

/** Can this issuer be placed on a US map at all? */
export function isUsAddress(address) {
  if (!address) return false;
  const state = String(address.state || "").trim().toUpperCase();
  if (!US_STATE_CODES.has(state)) return false;
  return !isPlaceholderZip(address.zip);
}
