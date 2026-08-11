/**
 * Re-pricing disclosed positions at a consistent, recent market price.
 *
 * ── The problem this solves ───────────────────────────────────────────────────────
 *
 * A position's value was previously `shares × the price printed on that person's own
 * filing`. That price is the execution price of whatever trade prompted the filing, on
 * the day it happened, so two people holding the same stock were valued at different
 * prices — and someone who last filed a year ago was valued at a year-old price.
 *
 * Measured on the live index at Bellevue: Bezos's Amazon stake was priced 2026-05-05
 * while another Amazon insider had filed at 2026-06-03, and SVF's Coupang stake was
 * carrying a price from 2025-08-22 — 355 days stale — even though Coupang insiders
 * filed as recently as 2026-06-12.
 *
 * So this module builds one price per security from every observation in the dataset
 * and re-prices every holder against it. Same stock, same price, newest date available.
 *
 * ── Not every filed price is a market price ───────────────────────────────────────
 *
 * This is the part that makes a naive "take the latest price" wrong. A Form 4 price
 * column means different things depending on the transaction code, and only some of
 * them are the market price of the share.
 *
 * Measured across all 34,191 priced non-derivative rows in 2026Q2, taking each code's
 * price as a ratio of the same issuer/security/day median SALE price:
 *
 *     code   n       %$0    median ratio vs same-day sale
 *     S    27527      0%    1.000     open-market sale          <- market
 *     F      940      0%    0.999     shares withheld for tax   <- market
 *     P      197      0%    1.000     open-market purchase      <- market
 *     I        3      0%    0.996     discretionary transaction <- market
 *     A     1029     86%    0.998     grant or award
 *     D       74     35%    0.988     disposition to the issuer
 *     G      222     97%    1.004     bona fide gift
 *     J      263     80%    0.997     other
 *     C      441     97%    0.845     conversion of a derivative
 *     M     3462     29%    0.299     option exercise           <- the STRIKE, not market
 *     X       33     24%    0.158     exercise of a derivative  <- the STRIKE, not market
 *
 * Codes M and X report what the holder PAID to exercise, which is the strike price. At
 * a median of 0.299 and 0.158 of market they would understate a position by 70-84%.
 * This is the same failure that once valued Musk's Tesla stake at $9.6B instead of
 * $287.4B, now measured across the whole market rather than one filing.
 *
 * Codes A, G, J and C are mostly $0 — a grant or a gift has no purchase price — and a
 * zero price is already discarded upstream, but they are excluded here as well so the
 * non-zero minority cannot contribute either.
 *
 * Only S, F, P and I are treated as market prices.
 *
 * ── Share classes must not be merged ──────────────────────────────────────────────
 *
 * A price is keyed by issuer AND security title, never by issuer alone. On 85 issuer-
 * days in the sampled quarter two share classes of the same company differed by more
 * than 5% — Alphabet's Class C capital stock at $247.83 against Class C Google stock
 * units at $345.04 on 2026-06-29, and a Class B at $45 against a Class A at $54.
 * Collapsing those to one issuer price would value a Berkshire Class A holder, whose
 * shares run to six figures each, at the Class B price of a few hundred dollars.
 *
 * Titles are matched after collapsing whitespace and case, because the same class is
 * sometimes typed with a double space — "Class A  Common Stock" against "Class A
 * Common Stock" — but they are NOT normalised any further than that. Stripping par
 * value text would merge classes that genuinely differ.
 *
 * For that reason a non-derivative position whose exact security has no market-coded
 * observation keeps its filed price rather than borrowing the issuer's. Falling back
 * would be the Berkshire error.
 */

/**
 * Transaction codes whose price column is the market price of the share.
 *
 * See the measurement table above. Anything not in this set either reports a strike
 * price, a conversion price, or nothing at all.
 */
export const MARKET_PRICE_CODES = Object.freeze(new Set(["S", "F", "P", "I"]));

export const isMarketPriceCode = (code) =>
  MARKET_PRICE_CODES.has(String(code || "").trim().toUpperCase());

/** Whitespace and case only. The first, always-safe pass. */
export function normaliseSecurity(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Reduce a security title to the security it actually names.
 *
 * Filers type the same security many ways. Coupang's Class A appears as both "Class A
 * Common Stock" and "Class A Common Shares"; Nvidia's as "Common Stock" and "Common";
 * par value is written "$.01", "$0.01" and omitted entirely, sometimes with the whole
 * thing repeated in a parenthetical. Left alone, each spelling becomes its own security
 * with its own price and date, so two people holding the identical stock are valued
 * differently depending on how their filing was typed.
 *
 * Checked before adopting this, on market-coded trades only: of 260 same-issuer,
 * same-day pairs whose titles differ but canonicalise together, 243 (93.5%) agree on
 * price within 5% and the other 17 differ by 10-16% — ordinary intraday spread between
 * two sets of trades, not two different securities. No pair was a share-class collision.
 *
 * CLASS and SERIES designations survive untouched, which is the part that matters:
 * "Class A Common Stock" and "Class B Common Stock" must never merge, or a Berkshire
 * Class A holder gets priced at the Class B price.
 *
 * (An earlier version of this file kept par-value spellings apart, on the strength of a
 * measurement that had not filtered out option-exercise rows. Once codes M and X were
 * excluded the apparent disagreement went away — the gap was the strike price, not the
 * security.)
 */
export function canonicalSecurity(title) {
  const upper = normaliseSecurity(title)
    // Parentheticals restate the name: 'COMMON STOCK, $0.0001 PAR VALUE ("COMMON STOCK")'
    .replace(/\([^)]*\)/g, " ")
    .replace(/["']/g, " ");

  const kept = upper
    .split(",")
    // A clause carrying par value or a dollar amount describes the share, not which
    // security it is. "COMMON STOCK, $.01 PAR VALUE PER SHARE" is just common stock.
    .filter((part) => !/PAR\s*VALUE/.test(part) && !/\$/.test(part))
    .join(" ");

  return kept
    // "Shares" and "Stock" are the same noun. Applied after the class designation is
    // already safe, so CLASS A / CLASS B are unaffected.
    .replace(/\bSH(ARE)?S\b/g, "STOCK")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A bare "COMMON" is common stock; Nvidia files both spellings.
    .replace(/^COMMON$/, "COMMON STOCK")
    // Collapse the repetition the substitutions above can create.
    .replace(/\bSTOCK(\s+STOCK)+\b/g, "STOCK");
}

export const priceKey = (issuerCik, security) =>
  `${String(issuerCik || "").replace(/^0+/, "")}|${canonicalSecurity(security)}`;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * The highest price per share that can be believed.
 *
 * Berkshire Hathaway Class A is the most expensive US share ever traded and has never
 * reached $1m. Anything above this is a filer putting the total consideration in the
 * price-per-share column, which really happens: one 2026Q1 filing reports Rare Element
 * Resources at $24,035,774.40 per share, against a real price of $0.24.
 */
export const MAX_PLAUSIBLE_PRICE = 1_000_000;

/**
 * How far one observation may sit from its security's own median before it is discarded.
 *
 * A typo in the price column is not rare enough to ignore and not small enough to
 * survive: Ferrellgas appears at $312,115.08 against a real $24.25, Mainz Biomed at
 * $201,000.755 against $1.51. Both are under the absolute ceiling, so they are caught
 * instead by disagreeing violently with every other trade in the same security.
 *
 * 20x is deliberately loose. A genuine stock can double or halve inside a year and a
 * small one can run several times over, so this is set to catch data entry rather than
 * to smooth out real movement.
 */
export const OUTLIER_FACTOR = 20;

/**
 * Build one market price per security from raw transaction observations.
 *
 * Each observation is `{ issuerCik, security, code, price, date }`. Rows whose code is
 * not a market code, whose price is missing or zero, or which carry no date are
 * ignored.
 *
 * The price is the MEDIAN of every observation on the most recent date that security
 * traded, not a single row. Insiders at one company often file several sales on the
 * same day at prices spread across the session — Microsoft's 2026Q2 sales ran $402.84
 * to $460.99 — and a median is not moved by whichever row happens to be last.
 */
export function buildPriceBook(observations) {
  /** key -> date -> prices[] */
  const byKey = new Map();

  for (const row of observations || []) {
    if (!row || !isMarketPriceCode(row.code)) continue;

    const price = Number(row.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (price > MAX_PLAUSIBLE_PRICE) continue;

    const date = String(row.date || "").trim();
    if (!date) continue;

    const cik = String(row.issuerCik || "").replace(/^0+/, "");
    if (!cik) continue;

    const key = priceKey(cik, row.security);
    if (!byKey.has(key)) byKey.set(key, new Map());
    const dates = byKey.get(key);
    if (!dates.has(date)) dates.set(date, []);
    dates.get(date).push(price);
  }

  const book = new Map();
  let rejected = 0;

  for (const [key, dates] of byKey) {
    /**
     * Discard typos before choosing a date, not after.
     *
     * The reference is the median of EVERY observation of this security across the
     * whole window, which a handful of bad rows cannot move. Anything more than
     * OUTLIER_FACTOR away from it is dropped. Doing this first matters: the book takes
     * the most recent date a security traded, so a single mistyped row on a late date
     * would otherwise become that security's price for every holder of it.
     */
    const all = [];
    for (const prices of dates.values()) all.push(...prices);
    const reference = median(all);

    const clean = new Map();
    for (const [date, prices] of dates) {
      const kept = prices.filter(
        (price) => price <= reference * OUTLIER_FACTOR && price >= reference / OUTLIER_FACTOR,
      );
      rejected += prices.length - kept.length;
      if (kept.length) clean.set(date, kept);
    }
    if (clean.size === 0) continue;

    let latest = null;
    for (const date of clean.keys()) if (latest == null || date > latest) latest = date;
    const prices = clean.get(latest);

    book.set(key, {
      price: median(prices),
      asOf: latest,
      // How many trades set this price, and over how many days it was observed. A
      // security priced by a single trade on a single day is weaker evidence than one
      // priced by twenty, and the caller can see which it got.
      samples: prices.length,
      observedDays: clean.size,
    });
  }

  book.outliersRejected = rejected;
  return book;
}

/**
 * The issuer's principal security price, for valuing derivatives.
 *
 * A derivative filing discloses no market price of its own — an option grant does not
 * say what the stock is worth — so its underlying has to be priced from the issuer's
 * ordinary shares. The security title on a derivative row ("Class C Google Stock
 * Units", "Employee Stock Option") does not match the share title, so an exact lookup
 * cannot work and the issuer's most heavily traded security is used instead.
 *
 * This is only ever applied to derivatives. Doing it for ordinary shares would merge
 * share classes, which is precisely what the per-security key exists to prevent.
 */
export function buildIssuerPrimaryPrices(book) {
  const best = new Map();

  for (const [key, entry] of book) {
    const cik = key.slice(0, key.indexOf("|"));
    const current = best.get(cik);
    // Most-traded wins; ties break to the more recent date.
    if (
      !current ||
      entry.samples > current.samples ||
      (entry.samples === current.samples && entry.asOf > current.asOf)
    ) {
      best.set(cik, entry);
    }
  }

  return best;
}

/**
 * How far a re-price may move a position before it is called out.
 *
 * A genuine quarter of price movement does not triple a stock. A ratio beyond this is
 * more likely a share split — the filing's share count is pre-split while the new price
 * is post-split, which would halve or quarter someone's apparent wealth — or two
 * different securities colliding under one title. The re-price is still applied and
 * still reported, but the position is flagged so a caller can see it rather than
 * discovering it as a silent error.
 */
export const SUSPECT_RATIO = 3;

/**
 * Re-price one position.
 *
 * Returns the fields to merge onto it. The disclosed value is NEVER overwritten: both
 * numbers are kept side by side so "what they filed" and "what it is worth now" stay
 * distinguishable, and a caller that wants the filed figure can still have it.
 *
 * `basis` says where the price came from, always:
 *   security  - a market-coded trade in this exact security
 *   issuer    - the issuer's principal security, derivatives only
 *   filed     - no market price available; the filing's own price stands
 *   none      - no price at any point; the position stays unvalued
 */
export function repricePosition(position, book, issuerPrimary) {
  if (!position) return null;

  const isDerivative = position.kind === "derivative";
  const filed = position.pricePerShare ?? null;

  let price = null;
  let asOf = null;
  let basis = "filed";

  if (isDerivative) {
    const primary = issuerPrimary?.get(String(position.issuerCik || "").replace(/^0+/, ""));
    if (primary) {
      price = primary.price;
      asOf = primary.asOf;
      basis = "issuer";
    }
  } else {
    const entry = book?.get(priceKey(position.issuerCik, position.security));
    if (entry) {
      price = entry.price;
      asOf = entry.asOf;
      basis = "security";
    }
  }

  if (price == null) {
    price = filed;
    asOf = position.priceAsOf ?? null;
    basis = filed == null ? "none" : "filed";
  }

  const marketValue = valueAt(position, price);
  const ratio = filed && price ? price / filed : null;

  return {
    marketPrice: price,
    marketPriceAsOf: asOf,
    marketPriceBasis: basis,
    marketValue,
    // Only meaningful when a market price actually replaced the filed one.
    repricedFrom: basis === "security" || basis === "issuer" ? filed : null,
    priceMovedSuspiciously:
      ratio != null && (ratio >= SUSPECT_RATIO || ratio <= 1 / SUSPECT_RATIO),
  };
}

/**
 * Value a position at a given price.
 *
 * Mirrors valuePosition() in dataset.mjs — a derivative is worth its intrinsic value,
 * never the face value of its underlying shares — but takes the price as an argument
 * so the same rule applies to a market price as to a filed one.
 */
export function valueAt(position, price) {
  if (!position || position.shares == null || !price) return null;

  if (position.kind === "derivative") {
    if (position.strikePrice == null) return null;
    const intrinsic = price - position.strikePrice;
    return intrinsic <= 0 ? 0 : Math.round(position.shares * intrinsic);
  }

  return Math.round(position.shares * price);
}
