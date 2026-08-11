/**
 * Reading the SEC's quarterly Form 3/4/5 datasets into a position index.
 *
 * The SEC ships each quarter as a zip of tab-separated tables. The three that matter:
 *
 *   SUBMISSION.tsv       one row per filing  -> issuer CIK, ticker, filing date
 *   REPORTINGOWNER.tsv   one row per filer   -> person CIK, name, relationship, title
 *   NONDERIV_TRANS.tsv   one row per trade   -> shares held after, price per share
 *   NONDERIV_HOLDING.tsv one row per holding -> shares held (Form 3, no transaction)
 *
 * They join on ACCESSION_NUMBER. The interesting column is SHRS_OWND_FOLWNG_TRANS:
 * the filer's total position in that security AFTER the reported event. That is a
 * disclosed position, not an inference, which is the entire reason this service can
 * exist without estimating anyone's wealth.
 */

import { assertDisclosable, isSection16Insider } from "./disclosure.mjs";

/**
 * Parse a TSV buffer into row objects.
 *
 * Written as a generator so a 36 MB table is never materialised as an array of objects
 * at once — the largest quarter has ~370k transaction rows and the index builder only
 * needs one row at a time.
 */
export function* parseTsv(text) {
  const lines = text.split("\n");
  if (lines.length === 0) return;

  const header = lines[0].replace(/\r$/, "").split("\t");
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cells = line.replace(/\r$/, "").split("\t");
    const row = {};
    for (let c = 0; c < header.length; c += 1) row[header[c]] = cells[c] ?? "";
    yield row;
  }
}

/** SEC dates are "30-JUN-2026". Returns an ISO date, or null when unparseable. */
export function parseSecDate(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/i.exec(raw);
  if (!match) return null;

  const months = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const month = months[match[2].toUpperCase()];
  if (month == null) return null;

  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

const number = (value) => {
  const parsed = Number(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * A price of zero means "no price to disclose", not "worthless".
 *
 * Filings for privately-held issuers report 0.00 — SpaceX's Form 4s do exactly this.
 * Taking that literally values an 842-million-share position at $0, which reads as
 * worthless when the truth is that no public price exists. Both cases collapse to
 * null so the caller sees "shares disclosed, no price on file".
 */
const price = (value) => {
  const parsed = number(value);
  return parsed === 0 ? null : parsed;
};

/**
 * Build the position index from one quarter's tables.
 *
 * Returns a Map keyed by `${personCik}:${issuerCik}` holding the person's LATEST
 * disclosed position in that issuer. Later filings win, which is why the filing date
 * is compared rather than trusting file order — the SEC's tables are not sorted by date.
 *
 * Rows for people without a Section 16 role are dropped here, before they can reach
 * any index, so the disclosure rule is enforced at ingest rather than at render.
 */
export function buildPositions({
  submissions,
  owners,
  transactions,
  holdings,
  derivTransactions = [],
  derivHoldings = [],
}) {
  // accession -> issuer + filing date
  const filings = new Map();
  for (const row of submissions) {
    const filedOn = parseSecDate(row.FILING_DATE);
    filings.set(row.ACCESSION_NUMBER, {
      issuerCik: String(row.ISSUERCIK || "").replace(/^0+/, ""),
      issuerName: row.ISSUERNAME || "",
      ticker: (row.ISSUERTRADINGSYMBOL || "").trim() || null,
      filedOn,
      documentType: row.DOCUMENT_TYPE || "",
    });
  }

  // accession -> the people who filed it (a joint filing can have several)
  const filers = new Map();
  for (const row of owners) {
    if (!isSection16Insider(row.RPTOWNER_RELATIONSHIP)) continue;

    // NOTE: the filer's own address columns are deliberately NOT read. See disclosure.mjs.
    const person = assertDisclosable({
      cik: String(row.RPTOWNERCIK || "").replace(/^0+/, ""),
      name: row.RPTOWNERNAME || "",
      relationship: row.RPTOWNER_RELATIONSHIP || "",
      title: (row.RPTOWNER_TITLE || "").trim() || null,
    });

    if (!filers.has(row.ACCESSION_NUMBER)) filers.set(row.ACCESSION_NUMBER, []);
    filers.get(row.ACCESSION_NUMBER).push(person);
  }

  const positions = new Map();

  const record = (accession, security, shares, price, kind = "direct", strike = null) => {
    if (shares == null || shares <= 0) return;

    const filing = filings.get(accession);
    const people = filers.get(accession);
    if (!filing || !people || !filing.issuerCik) return;

    for (const person of people) {
      if (!person.cik) continue;
      // Kind is part of the key so a person's options do not overwrite their shares.
      // They are genuinely different holdings and are valued by different rules.
      const key = `${person.cik}:${filing.issuerCik}:${kind}`;
      const existing = positions.get(key);

      // Keep the most recently FILED position, and on an equal date keep the FIRST row.
      //
      // Verified against Musk's 17-JUN-2026 Tesla filing, which carries two rows:
      //   row 1  code F (shares withheld for tax)  price 404.66  ->  710,172,677 held
      //   row 2  code M (option exercise)          price  23.34  ->  727,704,534 held
      // The exercise happened first and the withholding second, so 710,172,677 is the
      // closing position — and the SEC lists it FIRST. Preferring the later row instead
      // reports a stale position priced at the option strike rather than the market.
      if (existing && existing.asOf && filing.filedOn && existing.asOf >= filing.filedOn) {
        // An older filing can still supply a price the newer one omitted (Form 3s and
        // gifts report no price), so fill the gap without disturbing the share count.
        if (existing.pricePerShare == null && price != null) {
          existing.pricePerShare = price;
          existing.priceAsOf = filing.filedOn;
        }
        continue;
      }

      positions.set(key, {
        personCik: person.cik,
        personName: person.name,
        relationship: person.relationship,
        title: person.title,
        issuerCik: filing.issuerCik,
        issuerName: filing.issuerName,
        ticker: filing.ticker,
        security,
        kind,
        // For a derivative this is the number of UNDERLYING shares it converts into,
        // not a share count the person already holds.
        shares,
        pricePerShare: price ?? existing?.pricePerShare ?? null,
        priceAsOf: price != null ? filing.filedOn : existing?.priceAsOf ?? null,
        strikePrice: strike ?? existing?.strikePrice ?? null,
        asOf: filing.filedOn,
        formType: filing.documentType,
      });
    }
  };

  for (const row of transactions) {
    record(
      row.ACCESSION_NUMBER,
      row.SECURITY_TITLE || "Common Stock",
      number(row.SHRS_OWND_FOLWNG_TRANS),
      price(row.TRANS_PRICEPERSHARE),
    );
  }

  // Form 3 holdings carry a position with no transaction and therefore no price.
  for (const row of holdings) {
    record(
      row.ACCESSION_NUMBER,
      row.SECURITY_TITLE || "Common Stock",
      number(row.SHRS_OWND_FOLWNG_TRANS),
      null,
    );
  }

  /**
   * Derivative holdings — options, restricted stock units, warrants.
   *
   * Measured on 2026Q2: 33,088 filers qualify under our role filter, but only 28,221
   * have any non-derivative row. The other 4,867 (14.7%) hold ONLY derivatives and were
   * being dropped entirely — not by any legal distinction, just because the join looked
   * at one pair of tables. They are real Section 16 insiders with real disclosed
   * holdings, and a great many senior executives are paid mostly this way.
   *
   * The share count lives in UNDLYNG_SEC_SHARES (how many shares the instrument
   * converts into), and CONV_EXERCISE_PRICE is the strike. Both differ from the
   * non-derivative tables, which is why they need their own pass.
   */
  for (const row of derivTransactions) {
    record(
      row.ACCESSION_NUMBER,
      row.SECURITY_TITLE || "Derivative",
      number(row.UNDLYNG_SEC_SHARES),
      null,
      "derivative",
      // A strike of 0 is real here: RSUs convert for free. Only a MISSING strike is
      // unknown, so this deliberately does not use the price() zero-to-null rule.
      number(row.CONV_EXERCISE_PRICE),
    );
  }

  for (const row of derivHoldings) {
    record(
      row.ACCESSION_NUMBER,
      row.SECURITY_TITLE || "Derivative",
      number(row.UNDLYNG_SEC_SHARES),
      null,
      "derivative",
      number(row.CONV_EXERCISE_PRICE),
    );
  }

  /**
   * Price the derivatives.
   *
   * A derivative filing discloses no market price of its own, so the market value comes
   * from the same issuer's most recent DIRECT position — the only honest price we hold.
   * Without one the position stays unpriced rather than guessed.
   */
  const marketPrice = new Map();
  for (const position of positions.values()) {
    if (position.kind !== "direct" || position.pricePerShare == null) continue;
    const seen = marketPrice.get(position.issuerCik);
    if (!seen || (position.priceAsOf || "") > (seen.asOf || "")) {
      marketPrice.set(position.issuerCik, { price: position.pricePerShare, asOf: position.priceAsOf });
    }
  }

  for (const position of positions.values()) {
    if (position.kind !== "derivative") continue;
    const market = marketPrice.get(position.issuerCik);
    if (!market) continue;
    position.pricePerShare = market.price;
    position.priceAsOf = market.asOf;
  }

  return positions;
}

/**
 * Value a position.
 *
 * Deliberately returns null rather than 0 when no price was ever disclosed. A
 * position of unknown value is not a position of no value, and collapsing the two
 * would rank a large unpriced holding below a small priced one.
 */
export function valuePosition(position) {
  if (!position || position.shares == null) return null;
  // `price()` already maps 0 to null at parse time; this repeats the guard so a value
  // can never be computed from a zero price even if a caller builds a position by hand.
  if (!position.pricePerShare) return null;

  /**
   * A derivative is worth its INTRINSIC value, not the face value of its shares.
   *
   * Someone holding options over 100,000 shares at a $50 strike does not have $50
   * million when the stock trades at $500 — they must pay the strike to exercise, so
   * the position is worth 100,000 x ($500 - $50). Valuing derivatives at the full
   * market price would inflate option-heavy executives enormously and rank them above
   * people who genuinely own the shares outright.
   *
   * Underwater options — strike above market — are worth nothing today, and return 0
   * rather than a negative number. A strike of 0 is a restricted stock unit, which
   * converts for free and so is worth full market value.
   */
  if (position.kind === "derivative") {
    if (position.strikePrice == null) return null;
    const intrinsic = position.pricePerShare - position.strikePrice;
    return intrinsic <= 0 ? 0 : Math.round(position.shares * intrinsic);
  }

  return Math.round(position.shares * position.pricePerShare);
}
