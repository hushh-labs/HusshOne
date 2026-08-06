// Every fixture below is trimmed verbatim from a REAL response captured 2026-08-06 —
// Google Places API (New) places:searchText, and api.adviserinfo.sec.gov firm search/detail.
// No network, no disk writes outside os.tmpdir(), no live keys.
//
// The centrepiece is NESTLERODE: the full business name returns exactly ONE firm from IAPD
// and it is the WRONG one. Any change that makes that test pass by trusting `total === 1`
// has reintroduced the bug this module exists to prevent.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_SCORE,
  MIN_SCORE,
  PLACES_REASON,
  clearPlacesMemo,
  distinctiveTokens,
  firmQueryVariants,
  lookupBusinessByPhone,
  normalizeFirmName,
  parseFormattedAddress,
  resolveByPhoneLive,
  resolveFirmFromBusiness,
  scoreCandidate,
  scoreName,
  streetBase,
} from "./places.mjs";
import { searchFirmsByName } from "./iapd.mjs";

// ---------------------------------------------------------------------------
// fixtures — Google Places
// ---------------------------------------------------------------------------

// POST places:searchText {"textQuery":"+18142386249","regionCode":"US"}
const PLACES_NESTLERODE = {
  places: [
    {
      id: "ChIJoeXqwL2ozokRaUpadgF5Uks",
      nationalPhoneNumber: "(814) 238-6249",
      formattedAddress: "110 Regent Ct Ste 202, State College, PA 16801",
      websiteUri: "https://www.nlinvestmentadvisors.com/?utm_source=gmb&utm_medium=button&utm_campaign=gmbbuttonclick",
      displayName: { text: "Nestlerode & Loy Investment Advisors", languageCode: "en" },
    },
  ],
};

// POST places:searchText {"textQuery":"+17249400310","regionCode":"US"}
const PLACES_YANNI = {
  places: [
    {
      id: "ChIJj839CwOKNIgRTD5MblY-W5w",
      nationalPhoneNumber: "(724) 940-0310",
      formattedAddress: "2000 Corporate Dr Ste 450, Wexford, PA 15090",
      websiteUri: "https://www.yanniassociates.com/",
      displayName: { text: "Yanni & Associates Investment Advisors, LLC", languageCode: "en" },
    },
  ],
};

// THE MISS SHAPE. "+18054828899" and "+19142251000" both return this: an empty JSON OBJECT.
// Not an error, not {"places":[]}. Anything that reads body.places[0] without a guard throws.
const PLACES_MISS = {};

// ---------------------------------------------------------------------------
// fixtures — IAPD firm search
// ---------------------------------------------------------------------------

// GET /search/firm?query=nestlerode+loy — the CORRECT firm.
const FIRM_SEARCH_NESTLERODE_SHORT = {
  hits: {
    total: 1,
    hits: [
      {
        _source: {
          firm_source_id: "2907",
          firm_name: "NESTLERODE & LOY, INC.",
          ia_firm_name: "NESTLERODE & LOY, INC.",
          firm_other_names: ["DISCOUNT BROKERAGE OF PENNSYLVANIA", "WWW.NESTLERODE.COM", "NESTLERODE & LOY, INC."],
          firm_ia_scope: "ACTIVE",
          firm_ia_full_sec_number: "801-112333",
          firm_branches_count: 3,
          firm_ia_address_details:
            '{"officeAddress": {"street1": "110 REGENT COURT, SUITE 202", "city": "STATE COLLEGE", "state": "PA", "country": "United States", "postalCode": "16801"}}',
          firm_address_details:
            '{"officeAddress": {"street1": "110 REGENT COURT", "street2": "SUITE 202", "city": "STATE COLLEGE", "state": "PA", "country": "UNITED STATES", "postalCode": "16801"}}',
        },
      },
    ],
  },
};

// GET /search/firm?query=Nestlerode+%26+Loy+Investment+Advisors — total 1, and WRONG.
// It matched one of this firm's 100 registered DBAs. CRD 2907 is absent entirely.
const FIRM_SEARCH_NESTLERODE_FULL = {
  hits: {
    total: 1,
    hits: [
      {
        _source: {
          firm_source_id: "144426",
          firm_name: "INTERNATIONAL ASSETS INVESTMENT MANAGEMENT, LLC",
          ia_firm_name: null,
          firm_other_names: ["A. JOSEPH MARGOLIS LLC", "WOODS ASSOCIATES", "VERMONT WEALTH MANAGEMENT"],
          firm_ia_scope: "ACTIVE",
          firm_ia_full_sec_number: "801-68114",
          firm_branches_count: 122,
          firm_ia_address_details:
            '{"officeAddress": {"street1": "111 NORTH ORANGE AVENUE", "street2": "SUITE 1000", "city": "ORLANDO", "state": "FL", "country": "United States", "postalCode": "32801"}}',
          firm_address_details: null,
        },
      },
    ],
  },
};

// GET /search/firm?query=yanni — total 5. A real fuzzy list: the right firm plus noise that
// shares only industry words.
const FIRM_SEARCH_YANNI = {
  hits: {
    total: 5,
    hits: [
      {
        _source: {
          firm_source_id: "142913",
          firm_name: "YANNI & ASSOCIATES INVESTMENT ADVISORS, LLC",
          ia_firm_name: null,
          firm_other_names: [],
          firm_ia_scope: "ACTIVE",
          firm_ia_full_sec_number: "801-123404",
          firm_branches_count: 1,
          firm_ia_address_details:
            '{"officeAddress": {"street1": "2000 CORPORATE DRIVE", "street2": "SUITE 450", "city": "WEXFORD", "state": "PA", "country": "United States", "postalCode": "15090"}}',
          firm_address_details: null,
        },
      },
      {
        _source: {
          firm_source_id: "106438",
          firm_name: "XPYRIA INVESTMENT ADVISORS, INC.",
          firm_ia_scope: "INACTIVE",
          firm_ia_full_sec_number: "801-37555",
          firm_branches_count: 0,
          firm_ia_address_details:
            '{"officeAddress": {"street1": "603 STANWIX STREET", "street2": "SUITE 1850", "city": "PITTSBURGH", "state": "PA", "country": "United States", "postalCode": "15222"}}',
        },
      },
      {
        // No address at all, and no IA scope. Must not crash the scorer.
        _source: {
          firm_source_id: "23742",
          firm_name: "YP, LLC",
          firm_ia_scope: null,
          firm_branches_count: 0,
          firm_ia_address_details: null,
          firm_address_details: null,
        },
      },
      {
        // Address present but street/ZIP absent — partial addresses are common.
        _source: {
          firm_source_id: "315633",
          firm_name: "CARDINAL SIGN ADVISORY, LLC",
          firm_ia_scope: "INACTIVE",
          firm_branches_count: 0,
          firm_ia_address_details: '{"officeAddress": {"city": "NAPLES", "state": "FL", "country": "United States"}}',
        },
      },
      {
        _source: {
          firm_source_id: "146509",
          firm_name: "GALLAGHER FIDUCIARY ADVISORS, LLC",
          firm_ia_scope: "ACTIVE",
          firm_branches_count: 125,
          firm_ia_address_details:
            '{"officeAddress": {"street1": "2850 GOLF ROAD", "city": "ROLLING MEADOWS", "state": "IL", "country": "United States", "postalCode": "60008"}}',
        },
      },
    ],
  },
};

// Trap #1, on the firm endpoint: HTTP 200 carrying a failure.
const FIRM_SEARCH_EXCEEDED = { errorCode: -1, errorMessage: "Exceeded limit", hits: null };

// ---------------------------------------------------------------------------
// fixtures — IAPD firm detail (double-encoded iacontent, trap #4)
// ---------------------------------------------------------------------------

const firmDetailBody = (content) => ({
  hits: { total: 1, hits: [{ _source: { iacontent: JSON.stringify(content) } }] },
});

const FIRM_DETAIL_2907 = firmDetailBody({
  basicInformation: {
    firmId: 2907,
    firmName: "NESTLERODE & LOY, INC.",
    iaSECNumber: "112333",
    iaSECNumberType: "801",
    isIAFirm: "Y",
    iaScope: "ACTIVE",
  },
  iaFirmAddressDetails: {
    officeAddress: {
      street1: "110 REGENT COURT, SUITE 202",
      city: "STATE COLLEGE",
      state: "PA",
      country: "United States",
      postalCode: "16801",
    },
  },
});

const FIRM_DETAIL_142913 = firmDetailBody({
  basicInformation: {
    firmId: 142913,
    firmName: "YANNI & ASSOCIATES INVESTMENT ADVISORS, LLC",
    iaSECNumber: "123404",
    iaSECNumberType: "801",
    isIAFirm: "Y",
    iaScope: "ACTIVE",
  },
  iaFirmAddressDetails: {
    officeAddress: {
      street1: "2000 CORPORATE DRIVE",
      street2: "SUITE 450",
      city: "WEXFORD",
      state: "PA",
      country: "United States",
      postalCode: "15090",
    },
  },
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** One fetch that answers both upstreams, so an end-to-end test exercises the real routing
 *  rather than a hand-fed sequence. `calls` records everything for assertions. */
function makeFetch({ places = PLACES_MISS, firmSearch = {}, firmDetail = {}, placesStatus = 200 } = {}) {
  const calls = { places: [], firmSearch: [], firmDetail: [] };

  const fetchImpl = async (url, options = {}) => {
    const target = String(url);

    if (target.includes("places.googleapis.com")) {
      calls.places.push({ url: target, options });
      return jsonResponse(places, placesStatus);
    }

    const parsed = new URL(target);

    // /search/firm?query=... (search) vs /search/firm/<crd> (detail)
    const detailMatch = parsed.pathname.match(/\/search\/firm\/(\d+)$/);
    if (detailMatch) {
      const crd = detailMatch[1];
      calls.firmDetail.push(crd);
      const body = firmDetail[crd];
      if (!body) throw new Error(`unexpected firm detail fetch for CRD ${crd}`);
      return jsonResponse(body);
    }

    const query = parsed.searchParams.get("query");
    calls.firmSearch.push(query);
    const body = firmSearch[query];
    if (!body) throw new Error(`unexpected firm search for query ${JSON.stringify(query)}`);
    return jsonResponse(body);
  };

  return { fetchImpl, calls };
}

/** Places lookups are memoised in-process for 60s; a stale entry would leak between tests. */
test.beforeEach(() => clearPlacesMemo());

// ---------------------------------------------------------------------------
// address parsing
// ---------------------------------------------------------------------------

test("parseFormattedAddress splits a real Places address", () => {
  assert.deepEqual(parseFormattedAddress("110 Regent Ct Ste 202, State College, PA 16801"), {
    street: "110 Regent Ct Ste 202",
    city: "State College",
    state: "PA",
    zip: "16801",
  });
});

test("parseFormattedAddress handles a multi-comma street", () => {
  assert.deepEqual(parseFormattedAddress("2000 Corporate Dr, Ste 450, Wexford, PA 15090"), {
    street: "2000 Corporate Dr, Ste 450",
    city: "Wexford",
    state: "PA",
    zip: "15090",
  });
});

test("parseFormattedAddress drops a trailing country and keeps ZIP5 from ZIP+4", () => {
  assert.deepEqual(parseFormattedAddress("1 Main St, Austin, TX 78701-1234, USA"), {
    street: "1 Main St",
    city: "Austin",
    state: "TX",
    zip: "78701",
  });
});

test("parseFormattedAddress degrades instead of throwing", () => {
  assert.deepEqual(parseFormattedAddress(""), { street: null, city: null, state: null, zip: null });
  assert.deepEqual(parseFormattedAddress(null), { street: null, city: null, state: null, zip: null });
  assert.equal(parseFormattedAddress("Wexford, PA").city, "Wexford");
  assert.equal(parseFormattedAddress("Wexford, PA").state, "PA");
});

test("streetBase makes Places and SEC street formats agree", () => {
  // "110 Regent Ct Ste 202" (Places) vs "110 REGENT COURT, SUITE 202" (SEC).
  assert.equal(streetBase("110 Regent Ct Ste 202"), "110 regent ct");
  assert.equal(streetBase("110 REGENT COURT, SUITE 202"), "110 regent ct");
  assert.equal(streetBase("2000 Corporate Dr Ste 450"), "2000 corporate dr");
  assert.equal(streetBase("2000 CORPORATE DRIVE SUITE 450"), "2000 corporate dr");
  // Different buildings must not collapse together.
  assert.notEqual(streetBase("111 North Orange Avenue"), streetBase("110 Regent Court"));
});

// ---------------------------------------------------------------------------
// name normalisation and scoring
// ---------------------------------------------------------------------------

test("normalizeFirmName strips legal suffixes, punctuation and ampersands", () => {
  assert.equal(normalizeFirmName("NESTLERODE & LOY, INC."), "nestlerode loy");
  assert.equal(normalizeFirmName("Yanni & Associates Investment Advisors, LLC"), "yanni associates investment advisors");
  assert.equal(normalizeFirmName("Acme Capital L.L.C."), "acme capital");
  assert.equal(normalizeFirmName(""), "");
  assert.equal(normalizeFirmName(null), "");
});

test("distinctiveTokens drops the industry vocabulary", () => {
  assert.deepEqual(distinctiveTokens(normalizeFirmName("Nestlerode & Loy Investment Advisors")), ["nestlerode", "loy"]);
  assert.deepEqual(distinctiveTokens(normalizeFirmName("Yanni & Associates Investment Advisors, LLC")), ["yanni"]);
  // Nothing identifying at all.
  assert.deepEqual(distinctiveTokens(normalizeFirmName("Investment Advisory Group LLC")), []);
});

test("scoreName treats the SEC legal name and the Places trading name as the same firm", () => {
  // The exact real-world pair this had to solve.
  const r = scoreName("Nestlerode & Loy Investment Advisors", "NESTLERODE & LOY, INC.");
  assert.equal(r.matched, true);
  assert.equal(r.score, 50);

  const exact = scoreName("Yanni & Associates Investment Advisors, LLC", "YANNI & ASSOCIATES INVESTMENT ADVISORS, LLC");
  assert.equal(exact.matched, true);
  assert.equal(exact.score, 50);
});

test("scoreName refuses a match built only from industry words", () => {
  // THE guard. Without it these look like a 3/4 token overlap and score ~40.
  const r = scoreName("Smith Investment Advisors", "Jones Investment Advisors");
  assert.equal(r.score, 0);
  assert.equal(r.matched, false);

  // The wrong-firm case from the live trap: no identifying word in common.
  const wrong = scoreName("Nestlerode & Loy Investment Advisors", "INTERNATIONAL ASSETS INVESTMENT MANAGEMENT, LLC");
  assert.equal(wrong.score, 0);
  assert.equal(wrong.matched, false);
});

test("scoreCandidate awards the full 165 when every signal agrees", () => {
  const business = {
    name: "Nestlerode & Loy Investment Advisors",
    street: "110 Regent Ct Ste 202",
    city: "State College",
    state: "PA",
    zip: "16801",
  };
  const scored = scoreCandidate(business, "NESTLERODE & LOY, INC.", {
    street1: "110 REGENT COURT, SUITE 202",
    city: "STATE COLLEGE",
    state: "PA",
    zip: "16801",
  });
  assert.equal(scored.score, MAX_SCORE);
  assert.deepEqual(scored.matchedOn, ["name", "city", "state", "zip", "address"]);
});

test("scoreCandidate gives the wrong firm nothing at all", () => {
  const business = {
    name: "Nestlerode & Loy Investment Advisors",
    street: "110 Regent Ct Ste 202",
    city: "State College",
    state: "PA",
    zip: "16801",
  };
  const scored = scoreCandidate(business, "INTERNATIONAL ASSETS INVESTMENT MANAGEMENT, LLC", {
    street1: "111 NORTH ORANGE AVENUE",
    street2: "SUITE 1000",
    city: "ORLANDO",
    state: "FL",
    zip: "32801",
  });
  assert.equal(scored.score, 0);
  assert.deepEqual(scored.matchedOn, []);
});

test("scoreCandidate: same building, different firm, never clears the threshold", () => {
  // A neighbour in the same suite. Every geographic signal fires; the name does not.
  const business = {
    name: "Nestlerode & Loy Investment Advisors",
    street: "110 Regent Ct Ste 202",
    city: "State College",
    state: "PA",
    zip: "16801",
  };
  const scored = scoreCandidate(business, "KEYSTONE TAX PARTNERS", {
    street1: "110 REGENT COURT, SUITE 202",
    city: "STATE COLLEGE",
    state: "PA",
    zip: "16801",
  });
  assert.equal(scored.nameMatched, false);
  assert.equal(scored.score, 115); // city+state+zip+address, and still no CRD (see below)
  assert.ok(scored.score > MIN_SCORE, "score alone would have passed — nameMatched is what stops it");
});

// ---------------------------------------------------------------------------
// query variants
// ---------------------------------------------------------------------------

test("firmQueryVariants puts the shortened forms first", () => {
  assert.deepEqual(firmQueryVariants("Nestlerode & Loy Investment Advisors"), [
    "nestlerode loy",
    "nestlerode loy investment advisors",
    "Nestlerode & Loy Investment Advisors",
  ]);
  assert.deepEqual(firmQueryVariants("Yanni & Associates Investment Advisors, LLC"), [
    "yanni",
    "yanni associates investment advisors",
    "Yanni & Associates Investment Advisors, LLC",
  ]);
});

test("firmQueryVariants also tries the prefix before the first industry word", () => {
  // distinctive = "smith brothers" (capital is generic); prefix = "smith".
  assert.deepEqual(firmQueryVariants("Smith Capital Brothers"), ["smith brothers", "smith", "smith capital brothers"]);
});

test("firmQueryVariants is empty for an empty name", () => {
  assert.deepEqual(firmQueryVariants(""), []);
  assert.deepEqual(firmQueryVariants(null), []);
});

// ---------------------------------------------------------------------------
// searchFirmsByName (iapd.mjs) — double-encoded address + the 200-error trap
// ---------------------------------------------------------------------------

test("searchFirmsByName decodes the address that arrives as a JSON string", async () => {
  const { fetchImpl } = makeFetch({ firmSearch: { "nestlerode loy": FIRM_SEARCH_NESTLERODE_SHORT } });
  const result = await searchFirmsByName("nestlerode loy", { fetchImpl });

  assert.equal(result.total, 1);
  assert.equal(result.firms.length, 1);
  assert.deepEqual(result.firms[0].officeAddress, {
    street1: "110 REGENT COURT, SUITE 202",
    street2: null,
    city: "STATE COLLEGE",
    state: "PA",
    zip: "16801",
    country: "United States",
  });
  assert.equal(result.firms[0].crd, 2907);
  assert.equal(result.firms[0].branchCount, 3);
});

test("searchFirmsByName tolerates hits with no address at all", async () => {
  const { fetchImpl } = makeFetch({ firmSearch: { yanni: FIRM_SEARCH_YANNI } });
  const result = await searchFirmsByName("yanni", { fetchImpl });

  assert.equal(result.firms.length, 5);
  const yp = result.firms.find((f) => f.crd === 23742);
  assert.equal(yp.officeAddress, null);
  // Partial address survives with nulls rather than being discarded.
  const cardinal = result.firms.find((f) => f.crd === 315633);
  assert.equal(cardinal.officeAddress.city, "NAPLES");
  assert.equal(cardinal.officeAddress.zip, null);
});

test("searchFirmsByName rejects the HTTP-200 'Exceeded limit' body", async () => {
  const { fetchImpl } = makeFetch({ firmSearch: { yanni: FIRM_SEARCH_EXCEEDED } });
  await assert.rejects(() => searchFirmsByName("yanni", { fetchImpl, retries: 0 }), /Exceeded limit/);
});

// ---------------------------------------------------------------------------
// lookupBusinessByPhone
// ---------------------------------------------------------------------------

test("lookupBusinessByPhone returns the live business identity", async () => {
  const { fetchImpl, calls } = makeFetch({ places: PLACES_NESTLERODE });
  const business = await lookupBusinessByPhone("+1 814-238-6249", { fetchImpl, apiKey: "test-key" });

  assert.equal(business.found, true);
  assert.equal(business.placeId, "ChIJoeXqwL2ozokRaUpadgF5Uks");
  assert.equal(business.name, "Nestlerode & Loy Investment Advisors");
  assert.equal(business.city, "State College");
  assert.equal(business.state, "PA");
  assert.equal(business.zip, "16801");
  assert.equal(business.street, "110 Regent Ct Ste 202");
  assert.equal(business.phoneVerified, true);

  // The request shape is part of the contract with Google.
  const [call] = calls.places;
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers["X-Goog-Api-Key"], "test-key");
  assert.match(call.options.headers["X-Goog-FieldMask"], /places\.nationalPhoneNumber/);
  assert.deepEqual(JSON.parse(call.options.body), { textQuery: "+18142386249", regionCode: "US" });
});

test("lookupBusinessByPhone handles the empty-OBJECT miss", async () => {
  // The 805-482-8899 / 914-225-1000 shape. Not {"places":[]}, not an error: {}.
  const { fetchImpl } = makeFetch({ places: PLACES_MISS });
  const business = await lookupBusinessByPhone("+1 805-482-8899", { fetchImpl, apiKey: "test-key" });

  assert.equal(business.found, false);
  assert.equal(business.reason, PLACES_REASON.NO_MATCH);
});

test("lookupBusinessByPhone degrades to places_unconfigured with no key", async () => {
  const { fetchImpl, calls } = makeFetch({ places: PLACES_NESTLERODE });
  for (const apiKey of ["", "   ", undefined, null]) {
    const business = await lookupBusinessByPhone("+1 814-238-6249", { fetchImpl, apiKey });
    assert.equal(business.found, false);
    assert.equal(business.reason, PLACES_REASON.UNCONFIGURED);
  }
  assert.equal(calls.places.length, 0, "must not call Google without a key");
});

test("lookupBusinessByPhone never throws on a bad key or a network fault", async () => {
  const bad = makeFetch({ places: { error: { code: 400 } }, placesStatus: 400 });
  const onBadKey = await lookupBusinessByPhone("+1 814-238-6249", { fetchImpl: bad.fetchImpl, apiKey: "bogus" });
  assert.equal(onBadKey.found, false);
  assert.equal(onBadKey.reason, PLACES_REASON.ERROR);
  assert.equal(onBadKey.status, 400);

  const boom = async () => {
    throw new Error("ECONNRESET");
  };
  const onFault = await lookupBusinessByPhone("+1 814-238-6249", { fetchImpl: boom, apiKey: "k" });
  assert.equal(onFault.found, false);
  assert.equal(onFault.reason, PLACES_REASON.ERROR);
});

test("lookupBusinessByPhone rejects a non-NANP input before spending a Places call", async () => {
  const { fetchImpl, calls } = makeFetch({ places: PLACES_NESTLERODE });
  const business = await lookupBusinessByPhone("+44 20 7946 0958", { fetchImpl, apiKey: "k" });
  assert.equal(business.found, false);
  assert.equal(business.reason, PLACES_REASON.INVALID_PHONE);
  assert.equal(calls.places.length, 0);
});

test("lookupBusinessByPhone rejects a place whose own number is a different one", async () => {
  // searchText is a TEXT search; a hit that lists another phone matched on something else.
  const other = {
    places: [{ ...PLACES_NESTLERODE.places[0], nationalPhoneNumber: "(814) 555-0101" }],
  };
  const { fetchImpl } = makeFetch({ places: other });
  const business = await lookupBusinessByPhone("+1 814-238-6249", { fetchImpl, apiKey: "k" });
  assert.equal(business.found, false);
  assert.equal(business.reason, PLACES_REASON.PHONE_MISMATCH);
});

test("lookupBusinessByPhone memoises within the TTL and honours a disabled memo", async () => {
  const hot = makeFetch({ places: PLACES_NESTLERODE });
  await lookupBusinessByPhone("+1 814-238-6249", { fetchImpl: hot.fetchImpl, apiKey: "k" });
  await lookupBusinessByPhone("814-238-6249", { fetchImpl: hot.fetchImpl, apiKey: "k" });
  assert.equal(hot.calls.places.length, 1, "same number in two formats is one canonical key");

  clearPlacesMemo();
  const cold = makeFetch({ places: PLACES_NESTLERODE });
  await lookupBusinessByPhone("+1 814-238-6249", { fetchImpl: cold.fetchImpl, apiKey: "k", memoTtlMs: 0 });
  await lookupBusinessByPhone("+1 814-238-6249", { fetchImpl: cold.fetchImpl, apiKey: "k", memoTtlMs: 0 });
  assert.equal(cold.calls.places.length, 2, "memoTtlMs:0 disables caching entirely");
});

// ---------------------------------------------------------------------------
// resolveFirmFromBusiness — the decisive behaviour
// ---------------------------------------------------------------------------

const NESTLERODE_BUSINESS = {
  found: true,
  placeId: "ChIJoeXqwL2ozokRaUpadgF5Uks",
  name: "Nestlerode & Loy Investment Advisors",
  street: "110 Regent Ct Ste 202",
  city: "State College",
  state: "PA",
  zip: "16801",
  phoneVerified: true,
};

const NESTLERODE_SEARCHES = {
  "nestlerode loy": FIRM_SEARCH_NESTLERODE_SHORT,
  "nestlerode loy investment advisors": FIRM_SEARCH_NESTLERODE_FULL,
  "Nestlerode & Loy Investment Advisors": FIRM_SEARCH_NESTLERODE_FULL,
};

test("resolveFirmFromBusiness rejects the single WRONG hit and finds the right firm", async () => {
  const { fetchImpl, calls } = makeFetch({
    firmSearch: NESTLERODE_SEARCHES,
    firmDetail: { 2907: FIRM_DETAIL_2907 },
  });

  const result = await resolveFirmFromBusiness(NESTLERODE_BUSINESS, { iapd: { fetchImpl } });

  assert.equal(result.crd, 2907);
  assert.equal(result.firmName, "NESTLERODE & LOY, INC.");
  assert.equal(result.confidence, "high");
  assert.equal(result.score, MAX_SCORE);
  assert.deepEqual(result.matchedOn, ["name", "city", "state", "zip", "address"]);

  // The wrong firm was pooled, scored, and shown to have zero evidence.
  const wrong = result.candidates.find((c) => c.crd === 144426);
  assert.ok(wrong, "the wrong firm stays visible as a candidate");
  assert.equal(wrong.score, 0);

  // Only the name-matching candidate cost a detail round trip.
  assert.deepEqual(calls.firmDetail, ["2907"]);
  assert.equal(calls.firmSearch.length, 3, "all three query variants are tried and pooled");
});

test("resolveFirmFromBusiness picks the right firm out of a fuzzy list", async () => {
  const business = {
    found: true,
    name: "Yanni & Associates Investment Advisors, LLC",
    street: "2000 Corporate Dr Ste 450",
    city: "Wexford",
    state: "PA",
    zip: "15090",
    phoneVerified: true,
  };
  const { fetchImpl } = makeFetch({
    firmSearch: {
      yanni: FIRM_SEARCH_YANNI,
      "yanni associates investment advisors": FIRM_SEARCH_YANNI,
      "Yanni & Associates Investment Advisors, LLC": FIRM_SEARCH_YANNI,
    },
    firmDetail: { 142913: FIRM_DETAIL_142913 },
  });

  const result = await resolveFirmFromBusiness(business, { iapd: { fetchImpl } });

  assert.equal(result.crd, 142913);
  assert.equal(result.confidence, "high");
  assert.equal(result.score, MAX_SCORE);
  assert.equal(result.branchCount, 1);
  // XPYRIA is in the same state and shares "investment advisors" — it must not be a rival.
  const xpyria = result.candidates.find((c) => c.crd === 106438);
  assert.ok(xpyria.score < MIN_SCORE);
  assert.ok(result.candidates.length <= 5, "the candidate list stays answerable");
});

test("resolveFirmFromBusiness returns crd:null when nothing clears the threshold", async () => {
  // Right name, wrong city/state/ZIP — a firm that has moved, or a DBA collision.
  const business = {
    found: true,
    name: "Nestlerode & Loy Investment Advisors",
    street: "1 Elsewhere Rd",
    city: "Boise",
    state: "ID",
    zip: "83701",
    phoneVerified: true,
  };
  const { fetchImpl } = makeFetch({
    firmSearch: NESTLERODE_SEARCHES,
    firmDetail: { 2907: FIRM_DETAIL_2907 },
  });

  const result = await resolveFirmFromBusiness(business, { iapd: { fetchImpl } });

  assert.equal(result.crd, null);
  assert.equal(result.confidence, "low");
  assert.equal(result.reason, PLACES_REASON.BELOW_THRESHOLD);
  assert.equal(result.candidates[0].crd, 2907, "the near-miss is still offered for a human to confirm");
  assert.equal(result.topScore, 50);
});

test("resolveFirmFromBusiness never returns a CRD on geography alone", async () => {
  // The firm at the address has a completely different name.
  const search = {
    hits: {
      total: 1,
      hits: [
        {
          _source: {
            firm_source_id: "999999",
            firm_name: "KEYSTONE TAX PARTNERS",
            firm_ia_scope: "ACTIVE",
            firm_branches_count: 1,
            firm_ia_address_details:
              '{"officeAddress": {"street1": "110 REGENT COURT, SUITE 202", "city": "STATE COLLEGE", "state": "PA", "country": "United States", "postalCode": "16801"}}',
          },
        },
      ],
    },
  };
  const { fetchImpl, calls } = makeFetch({
    firmSearch: {
      "nestlerode loy": search,
      "nestlerode loy investment advisors": search,
      "Nestlerode & Loy Investment Advisors": search,
    },
  });

  const result = await resolveFirmFromBusiness(NESTLERODE_BUSINESS, { iapd: { fetchImpl } });

  assert.equal(result.crd, null, "115 points of address agreement is not identity");
  assert.equal(result.confidence, "low");
  assert.equal(calls.firmDetail.length, 0, "a candidate with no name signal is not worth a round trip");
});

test("resolveFirmFromBusiness downgrades when two candidates are indistinguishable", async () => {
  // Two firms, same name, same building. Real when a firm re-registers under a new CRD.
  const twin = (crd) => ({
    _source: {
      firm_source_id: String(crd),
      firm_name: "NESTLERODE & LOY, INC.",
      firm_ia_scope: "ACTIVE",
      firm_branches_count: 1,
      firm_ia_address_details:
        '{"officeAddress": {"street1": "110 REGENT COURT, SUITE 202", "city": "STATE COLLEGE", "state": "PA", "country": "United States", "postalCode": "16801"}}',
    },
  });
  const search = { hits: { total: 2, hits: [twin(2907), twin(880011)] } };
  const { fetchImpl } = makeFetch({
    firmSearch: {
      "nestlerode loy": search,
      "nestlerode loy investment advisors": search,
      "Nestlerode & Loy Investment Advisors": search,
    },
    firmDetail: { 2907: FIRM_DETAIL_2907, 880011: FIRM_DETAIL_2907 },
  });

  const result = await resolveFirmFromBusiness(NESTLERODE_BUSINESS, { iapd: { fetchImpl } });

  assert.equal(result.crd, null, "a tie is a question, not an answer");
  assert.equal(result.reason, "ambiguous");
  assert.equal(result.candidates.length, 2);
});

test("resolveFirmFromBusiness separates an IAPD outage from an honest no-match", async () => {
  const down = async () => {
    throw new Error("ECONNRESET");
  };
  const outage = await resolveFirmFromBusiness(NESTLERODE_BUSINESS, { searchFirms: down });
  assert.equal(outage.crd, null);
  assert.equal(outage.reason, PLACES_REASON.IAPD_ERROR);

  const empty = async () => ({ total: 0, firms: [] });
  const noMatch = await resolveFirmFromBusiness(NESTLERODE_BUSINESS, { searchFirms: empty });
  assert.equal(noMatch.crd, null);
  assert.equal(noMatch.reason, PLACES_REASON.NO_CANDIDATES);
});

test("resolveFirmFromBusiness passes a Places miss straight through", async () => {
  const result = await resolveFirmFromBusiness({ found: false, reason: PLACES_REASON.NO_MATCH }, {});
  assert.equal(result.crd, null);
  assert.equal(result.reason, PLACES_REASON.NO_MATCH);
  assert.deepEqual(result.candidates, []);
});

test("resolveFirmFromBusiness caps confidence when a firm detail cannot be confirmed", async () => {
  const { fetchImpl } = makeFetch({ firmSearch: NESTLERODE_SEARCHES, firmDetail: {} });
  // firmDetail throws for every CRD, so the top candidate stays unconfirmed.
  const result = await resolveFirmFromBusiness(NESTLERODE_BUSINESS, { iapd: { fetchImpl } });

  assert.equal(result.crd, 2907, "the search payload is still real evidence");
  assert.equal(result.confidence, "medium", "but unconfirmed can never be 'high'");
  assert.equal(result.candidates[0].confirmed, false);
});

// ---------------------------------------------------------------------------
// resolveByPhoneLive — end to end
// ---------------------------------------------------------------------------

test("resolveByPhoneLive chains phone -> Places -> IAPD -> CRD", async () => {
  const { fetchImpl } = makeFetch({
    places: PLACES_NESTLERODE,
    firmSearch: NESTLERODE_SEARCHES,
    firmDetail: { 2907: FIRM_DETAIL_2907 },
  });

  const result = await resolveByPhoneLive("(814) 238-6249", { fetchImpl, apiKey: "k", iapd: { fetchImpl } });

  assert.equal(result.found, true);
  assert.equal(result.crd, 2907);
  assert.equal(result.confidence, "high");
  assert.equal(result.phone.national10, "8142386249");
  assert.equal(result.phone.e164, "+18142386249");
  assert.equal(result.business.name, "Nestlerode & Loy Investment Advisors");
  assert.equal(result.branchCount, 3);
});

test("resolveByPhoneLive reports a Places miss without touching IAPD", async () => {
  const { fetchImpl, calls } = makeFetch({ places: PLACES_MISS });
  const result = await resolveByPhoneLive("+1 805-482-8899", { fetchImpl, apiKey: "k", iapd: { fetchImpl } });

  assert.equal(result.found, false);
  assert.equal(result.reason, PLACES_REASON.NO_MATCH);
  assert.equal(result.business, null);
  assert.equal(result.crd, null);
  assert.deepEqual(result.candidates, []);
  assert.equal(calls.firmSearch.length, 0);
});

test("resolveByPhoneLive degrades cleanly with no key configured", async () => {
  const { fetchImpl, calls } = makeFetch({ places: PLACES_NESTLERODE });
  const result = await resolveByPhoneLive("+1 814-238-6249", { fetchImpl, apiKey: "", iapd: { fetchImpl } });

  assert.equal(result.found, false);
  assert.equal(result.reason, PLACES_REASON.UNCONFIGURED);
  assert.equal(calls.places.length, 0);
  assert.equal(calls.firmSearch.length, 0);
});

// ---------------------------------------------------------------------------
// Google Maps ToS
// ---------------------------------------------------------------------------

test("resolveByPhoneLive marks placeId as the only persistable Places field", async () => {
  const { fetchImpl } = makeFetch({
    places: PLACES_NESTLERODE,
    firmSearch: NESTLERODE_SEARCHES,
    firmDetail: { 2907: FIRM_DETAIL_2907 },
  });
  const result = await resolveByPhoneLive("+1 814-238-6249", { fetchImpl, apiKey: "k", iapd: { fetchImpl } });
  assert.deepEqual(result.business.persistable, ["placeId"]);
});

/** Run the whole live chain the way server.mjs wires it — including handing it the PERSISTED
 *  firm cache — then snapshot to a temp file and hand back what was written. */
async function snapshotAfterLookup() {
  const { fetchImpl } = makeFetch({
    places: PLACES_NESTLERODE,
    firmSearch: NESTLERODE_SEARCHES,
    firmDetail: { 2907: FIRM_DETAIL_2907 },
  });

  const { firmCache, saveSnapshot } = await import("./cache.mjs");
  const result = await resolveByPhoneLive("+1 814-238-6249", {
    fetchImpl,
    apiKey: "k",
    // This is EXACTLY what PLACES_OPTS.iapd carries in server.mjs: the persisted, snapshotted
    // firm cache. The protection has to hold with the real wiring, not with a test-only cache.
    iapd: { fetchImpl, cache: firmCache },
  });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "places-tos-"));
  const file = path.join(dir, "snapshot.json");
  await saveSnapshot(file);
  const written = await fs.readFile(file, "utf8");
  await fs.rm(dir, { recursive: true, force: true });
  return { result, written };
}

test("no Places-derived value can reach the on-disk cache snapshot", async () => {
  // The regression that matters: someone wires the Places result into one of cache.mjs's
  // persisted caches and Google's name/address/phone silently lands on disk.
  const { written } = await snapshotAfterLookup();

  for (const secret of [
    "Nestlerode & Loy Investment Advisors", // Places displayName
    "ChIJoeXqwL2ozokRaUpadgF5Uks", // place_id (persistable in OUR db, but not something the snapshot should carry)
    "110 Regent Ct Ste 202", // Places formattedAddress
    "nlinvestmentadvisors.com", // Places websiteUri
    "(814) 238-6249", // Places nationalPhoneNumber
  ]) {
    assert.ok(!written.includes(secret), `snapshot must not contain Places-derived value: ${secret}`);
  }

  // The SEC data it DID cache is public record and is expected to be there.
  assert.ok(written.includes("NESTLERODE & LOY, INC."), "SEC firm data is cacheable and should persist");
});

// ---------------------------------------------------------------------------
// H2 — the Places displayName was reaching the snapshot as a CACHE KEY
// ---------------------------------------------------------------------------

test("H2: a Places-derived firm-search QUERY never reaches the snapshot, in any casing", async () => {
  // What shipped: places.mjs built its IAPD firm-search queries out of the Google displayName,
  // iapd.mjs put the query into the cache key, and server.mjs handed that call the PERSISTED
  // firm cache. After one lookup and a SIGTERM the snapshot on disk held
  //   "iapd:firmsearch:nestlerode & loy investment advisors:10"
  // with a 30-day TTL — Google's business name, on our disk, for a month.
  //
  // The old assertion missed it only because the key is LOWERCASED and the fixture is not.
  // Everything below is case-insensitive for exactly that reason.
  const { result, written } = await snapshotAfterLookup();
  assert.equal(result.crd, 2907, "the chain really did run and really did search IAPD");

  const lower = written.toLowerCase();

  assert.ok(
    !lower.includes("iapd:firmsearch:"),
    "a firm-search cache entry is in the snapshot, and its key is built from the Google business name",
  );

  for (const derived of [
    "nestlerode & loy investment advisors", // the displayName, verbatim
    "nestlerode loy investment advisors", // the normalised variant
    "nestlerode loy", // the distinctive-token variant
    "110 regent ct", // the Places address
    "chijoexqwl2ozokraupadgf5uks", // the place_id
  ]) {
    assert.ok(!lower.includes(derived), `snapshot must not contain the Places-derived string: ${derived}`);
  }

  // Proof the test is looking at a populated snapshot rather than an empty one: the IAPD firm
  // DETAIL, keyed by CRD and holding SEC public record, is exactly what SHOULD be persisted.
  assert.ok(written.includes("iapd:firm:2907"), "SEC firm detail keyed by CRD is still cached and persisted");
});

test("H2: the firm-search cache is memory-only and is not on the persisted list", async () => {
  const { firmSearchCache } = await import("./places.mjs");
  const { firmCache, profileCache, branchGeoCache, queryCache } = await import("./cache.mjs");

  assert.equal(firmSearchCache.persisted, false);
  // The flag is not decoration: it is what iapd.mjs reads to refuse a snapshotted cache.
  assert.equal(firmCache.persisted, true);
  assert.equal(profileCache.persisted, true);
  assert.equal(branchGeoCache.persisted, true);
  assert.equal(queryCache.persisted, false, "rosters and name searches are volatile and are not written to disk");
});

test("H2: iapd.searchFirmsByName refuses a persisted cache even if a caller hands it one", async () => {
  // The backstop for the next caller, who will not have read the ToS block in places.mjs.
  const { firmCache, saveSnapshot } = await import("./cache.mjs");
  const { fetchImpl } = makeFetch({ firmSearch: { "nestlerode loy": FIRM_SEARCH_NESTLERODE_SHORT } });

  const result = await searchFirmsByName("nestlerode loy", { fetchImpl, cache: firmCache });
  assert.equal(result.firms[0].crd, 2907, "the answer is unaffected — only the caching is");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "places-tos-key-"));
  const file = path.join(dir, "snapshot.json");
  await saveSnapshot(file);
  const written = await fs.readFile(file, "utf8");
  await fs.rm(dir, { recursive: true, force: true });

  assert.ok(!written.toLowerCase().includes("iapd:firmsearch:"), "a search query must never be a persisted cache key");
});
