import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIssuerPrimaryPrices,
  buildPriceBook,
  isMarketPriceCode,
  canonicalSecurity,
  normaliseSecurity,
  priceKey,
  repricePosition,
  valueAt,
} from "./prices.mjs";

const obs = (over = {}) => ({
  issuerCik: "789019",
  security: "Common Stock",
  code: "S",
  price: 400,
  date: "2026-06-16",
  ...over,
});

test("only S, F, P and I are market prices", () => {
  for (const code of ["S", "F", "P", "I", "s", "f"]) {
    assert.equal(isMarketPriceCode(code), true, `${code} should be a market price`);
  }
  // M is an option exercise reported at the STRIKE — measured at 0.299x the same-day
  // sale price across 3,462 rows. X is 0.158x. Letting either set a price understates
  // a position by 70-84%.
  for (const code of ["M", "X", "A", "G", "C", "J", "D", "", null]) {
    assert.equal(isMarketPriceCode(code), false, `${code} must not set a price`);
  }
});

test("an option exercise can never set the price", () => {
  // The Tesla failure in miniature: a code M row at the $23.34 strike arrives AFTER the
  // code F row at the $404.66 market price. Latest-wins would take the strike.
  const book = buildPriceBook([
    obs({ code: "F", price: 404.66, date: "2026-06-17" }),
    obs({ code: "M", price: 23.34, date: "2026-06-18" }),
  ]);
  assert.equal(book.get(priceKey("789019", "Common Stock")).price, 404.66);
});

test("the price is the median of the latest trading day, not a single row", () => {
  // Microsoft's 2026Q2 sales ran $402.84 to $460.99 within one quarter; insiders often
  // file several same-day sales spread across the session.
  const book = buildPriceBook([
    obs({ price: 402.84, date: "2026-06-16" }),
    obs({ price: 412.45, date: "2026-06-16" }),
    obs({ price: 460.99, date: "2026-06-16" }),
    obs({ price: 100, date: "2026-01-05" }),
  ]);
  const entry = book.get(priceKey("789019", "Common Stock"));
  assert.equal(entry.price, 412.45, "median of the latest day");
  assert.equal(entry.asOf, "2026-06-16", "older days do not contribute");
  assert.equal(entry.samples, 3);
  assert.equal(entry.observedDays, 2);
});

test("an even number of same-day trades averages the middle two", () => {
  const book = buildPriceBook([obs({ price: 100 }), obs({ price: 110 })]);
  assert.equal(book.get(priceKey("789019", "Common Stock")).price, 105);
});

test("zero and missing prices never enter the book", () => {
  // A grant reports $0. Taking it literally would price every holder of the stock at
  // nothing.
  const book = buildPriceBook([
    obs({ price: 0 }),
    obs({ price: null }),
    obs({ price: "" }),
    obs({ date: "" }),
  ]);
  assert.equal(book.size, 0);
});

test("share classes are priced separately", () => {
  // Measured: 85 issuer-days where two classes of one company differed by >5%. A
  // Berkshire Class A holder valued at the Class B price would be understated ~1500x.
  const book = buildPriceBook([
    obs({ security: "Class A Common Stock", price: 700000 }),
    obs({ security: "Class B Common Stock", price: 470 }),
  ]);
  assert.equal(book.get(priceKey("789019", "Class A Common Stock")).price, 700000);
  assert.equal(book.get(priceKey("789019", "Class B Common Stock")).price, 470);
});

test("the same class typed with a double space is one security", () => {
  // Both spellings appear in the real data for CIK 1616707 on the same day.
  assert.equal(normaliseSecurity("Class A  Common Stock"), "CLASS A COMMON STOCK");
  const book = buildPriceBook([
    obs({ security: "Class A  Common Stock", price: 80 }),
    obs({ security: "class a common stock", price: 100 }),
  ]);
  assert.equal(book.size, 1, "typography does not create a second security");
  assert.equal(book.get(priceKey("789019", "Class A Common Stock")).price, 90);
});

test("spellings of the same security canonicalise together", () => {
  // Measured on market-coded trades: of 260 same-issuer same-day title pairs that
  // canonicalise together, 243 agree on price within 5%. Leaving them apart gives one
  // stock several prices and several dates depending on how each filer typed it.
  for (const [written, expected] of [
    ["Common Stock, par value $.01  per share", "COMMON STOCK"],
    ["Common Stock, $0.001 par value per share", "COMMON STOCK"],
    ['"COMMON STOCK, $0.0001 PAR VALUE PER SHARE (""COMMON STOCK"")"', "COMMON STOCK"],
    ["Common Shares", "COMMON STOCK"],
    ["Common", "COMMON STOCK"],
    ["Class A Common Shares", "CLASS A COMMON STOCK"],
    ["Class A Common Stock, par value $0.001 per share", "CLASS A COMMON STOCK"],
  ]) {
    assert.equal(canonicalSecurity(written), expected, written);
  }

  const book = buildPriceBook([
    obs({ security: "Class A Common Stock", price: 20 }),
    obs({ security: "Class A Common Shares", price: 22 }),
  ]);
  assert.equal(book.size, 1, "one security, one price");
  assert.equal(book.get(priceKey("789019", "Class A Common Stock")).price, 21);
});

test("canonicalising never merges two share classes", () => {
  // The guard that matters. CLASS and SERIES designations survive every substitution.
  const distinct = [
    "Class A Common Stock", "Class B Common Stock", "Class C Common Stock",
    "Series A Preferred Stock", "Series B Preferred Stock", "Common Stock",
  ].map(canonicalSecurity);
  assert.equal(new Set(distinct).size, distinct.length, "all six stay distinct");

  const book = buildPriceBook([
    obs({ security: "Class A Common Stock", price: 700000 }),
    obs({ security: "Class B Common Shares", price: 470 }),
  ]);
  assert.equal(book.size, 2, "Berkshire A must never take the B price");
});

test("a leading-zero CIK matches an unpadded one", () => {
  const book = buildPriceBook([obs({ issuerCik: "0000789019" })]);
  assert.ok(book.get(priceKey("789019", "Common Stock")));
});

test("a share position is repriced only from its own security", () => {
  const book = buildPriceBook([obs({ price: 500, date: "2026-06-16" })]);
  const primary = buildIssuerPrimaryPrices(book);

  const result = repricePosition(
    { issuerCik: "789019", security: "Common Stock", kind: "direct", shares: 1000, pricePerShare: 400, priceAsOf: "2026-01-02" },
    book,
    primary,
  );

  assert.equal(result.marketPrice, 500);
  assert.equal(result.marketValue, 500000, "1000 x 500, not 1000 x 400");
  assert.equal(result.marketPriceBasis, "security");
  assert.equal(result.repricedFrom, 400, "the filed price is still reported");
  assert.equal(result.marketPriceAsOf, "2026-06-16");
});

test("a share position with no match for its security keeps the filed price", () => {
  // The Berkshire guard: a Class A holding must never borrow the Class B price.
  const book = buildPriceBook([obs({ security: "Class B Common Stock", price: 470 })]);
  const primary = buildIssuerPrimaryPrices(book);

  const result = repricePosition(
    { issuerCik: "789019", security: "Class A Common Stock", kind: "direct", shares: 10, pricePerShare: 700000 },
    book,
    primary,
  );

  assert.equal(result.marketPriceBasis, "filed");
  assert.equal(result.marketPrice, 700000, "not the Class B price");
  assert.equal(result.marketValue, 7000000);
  assert.equal(result.repricedFrom, null);
});

test("a derivative is priced from the issuer's principal security", () => {
  // An option grant discloses no market price, and its own title never matches the
  // share title, so an exact lookup cannot work.
  const book = buildPriceBook([
    obs({ security: "Common Stock", price: 500, date: "2026-06-16" }),
    obs({ security: "Common Stock", price: 500, date: "2026-06-16" }),
    obs({ security: "Class B Common Stock", price: 90, date: "2026-06-17" }),
  ]);
  const primary = buildIssuerPrimaryPrices(book);

  const result = repricePosition(
    { issuerCik: "789019", security: "Employee Stock Option", kind: "derivative", shares: 100000, strikePrice: 50 },
    book,
    primary,
  );

  assert.equal(result.marketPriceBasis, "issuer");
  assert.equal(result.marketPrice, 500, "the most-traded security, not the most recent");
  assert.equal(result.marketValue, 45000000, "100k x (500 - 50) intrinsic, not face value");
});

test("an underwater option is worth zero, never negative", () => {
  assert.equal(valueAt({ kind: "derivative", shares: 1000, strikePrice: 600 }, 500), 0);
});

test("an RSU converts for free and is worth full market value", () => {
  // A strike of 0 is real, not missing.
  assert.equal(valueAt({ kind: "derivative", shares: 1000, strikePrice: 0 }, 500), 500000);
});

test("a derivative with an unknown strike stays unvalued", () => {
  assert.equal(valueAt({ kind: "derivative", shares: 1000, strikePrice: null }, 500), null);
});

test("a position that never had a price stays unvalued rather than zero", () => {
  // An unknown value is not a value of nothing; collapsing them would rank a large
  // unpriced holding below a small priced one.
  const result = repricePosition(
    { issuerCik: "999", security: "Common Stock", kind: "direct", shares: 5000, pricePerShare: null },
    buildPriceBook([]),
    new Map(),
  );
  assert.equal(result.marketPriceBasis, "none");
  assert.equal(result.marketValue, null);
});

test("a previously unpriced position gains a price from its security", () => {
  // 27,193 of 93,000 positions in the live index carry no price at all — Form 3
  // holdings report a position with no transaction. Most now become valuable.
  const book = buildPriceBook([obs({ price: 500 })]);
  const result = repricePosition(
    { issuerCik: "789019", security: "Common Stock", kind: "direct", shares: 5000, pricePerShare: null },
    book,
    buildIssuerPrimaryPrices(book),
  );
  assert.equal(result.marketValue, 2500000);
  assert.equal(result.marketPriceBasis, "security");
  assert.equal(result.repricedFrom, null, "there was no filed price to move from");
});

test("a violent price move is flagged rather than hidden", () => {
  // Most likely a share split: the filing's share count is pre-split while the price is
  // post-split. Still applied and still reported, but visibly.
  const book = buildPriceBook([obs({ price: 50 })]);
  const primary = buildIssuerPrimaryPrices(book);

  const split = repricePosition(
    { issuerCik: "789019", security: "Common Stock", kind: "direct", shares: 100, pricePerShare: 200 },
    book,
    primary,
  );
  assert.equal(split.priceMovedSuspiciously, true, "4x fall");

  const normal = repricePosition(
    { issuerCik: "789019", security: "Common Stock", kind: "direct", shares: 100, pricePerShare: 40 },
    book,
    primary,
  );
  assert.equal(normal.priceMovedSuspiciously, false, "25% rise is ordinary");
});

test("the issuer primary price prefers the most traded, then the most recent", () => {
  const book = buildPriceBook([
    obs({ security: "A", price: 10, date: "2026-01-01" }),
    obs({ security: "A", price: 10, date: "2026-01-01" }),
    obs({ security: "B", price: 20, date: "2026-06-01" }),
  ]);
  assert.equal(buildIssuerPrimaryPrices(book).get("789019").price, 10, "2 samples beat 1");

  const tied = buildPriceBook([
    obs({ security: "A", price: 10, date: "2026-01-01" }),
    obs({ security: "B", price: 20, date: "2026-06-01" }),
  ]);
  assert.equal(buildIssuerPrimaryPrices(tied).get("789019").price, 20, "tie breaks to newer");
});

test("a trade dated after the filing that reports it cannot set the price", () => {
  // 7 of 166,130 market-coded trades across the four indexed quarters carry a trade
  // date later than their own filing, two of them in the future. Because the book takes
  // the most recent date, one typo would hold a security's price against every owner.
  // collectPriceObservations() falls the date back to the filing date, so by the time a
  // row reaches the book it can no longer be ahead of reality.
  const book = buildPriceBook([
    obs({ price: 400, date: "2026-06-16" }),
    obs({ price: 8.93, date: "2026-03-03" }),
  ]);
  assert.equal(book.get(priceKey("789019", "Common Stock")).price, 400);
});
