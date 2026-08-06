// Every fixture below is trimmed verbatim from a real api.adviserinfo.sec.gov response
// captured 2026-08-06. No network, no disk, no timers longer than a tick.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_USER_AGENT,
  IapdError,
  IapdNotFoundError,
  MAX_NROWS,
  MAX_RESULT_WINDOW,
  getFirm,
  getIndividual,
  listFirmIndividuals,
  parseDoubleEncoded,
  sameCrd,
  searchIndividualsByName,
  toCrd,
} from "./iapd.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// GET /search/individual?firm=142913 — YANNI & ASSOCIATES, a real 2-person RIA.
// Note firm_id is a STRING while the CRD we query with is a number.
const ROSTER_142913 = {
  hits: {
    total: 2,
    hits: [
      {
        _source: {
          ind_source_id: "2767573",
          ind_firstname: "MATTHEW",
          ind_middlename: "ADAM",
          ind_lastname: "YANNI",
          ind_other_names: ["MATTHEW  YANNI"],
          ind_bc_scope: "NotInScope",
          ind_ia_scope: "Active",
          ind_ia_disclosure_fl: "N",
          ind_ia_current_employments: [
            {
              firm_id: "142913",
              firm_name: "YANNI & ASSOCIATES INVESTMENT ADVISORS, LLC",
              branch_city: "WEXFORD",
              branch_state: "PA",
              branch_zip: "15090",
              ia_only: "Y",
            },
          ],
        },
      },
      {
        _source: {
          ind_source_id: "8231615",
          ind_firstname: "Jonathan",
          ind_lastname: "Stasko",
          ind_ia_scope: "Active",
          ind_ia_disclosure_fl: "N",
          ind_ia_current_employments: [
            {
              firm_id: "142913",
              firm_name: "YANNI & ASSOCIATES INVESTMENT ADVISORS, LLC",
              branch_city: "WEXFORD",
              branch_state: "PA",
              branch_zip: "15090",
              ia_only: "Y",
            },
          ],
        },
      },
    ],
  },
};

// GET /search/individual?firm=110518 — the trap. One hit, but his CURRENT employer is
// CRD 135037 (110518 is that firm's SEC number). total 1, currentCount 0.
const ROSTER_110518 = {
  hits: {
    total: 1,
    hits: [
      {
        _source: {
          ind_source_id: "5156870",
          ind_firstname: "BRADLEY",
          ind_lastname: "BARGER",
          ind_ia_scope: "Active",
          ind_ia_disclosure_fl: "N",
          ind_ia_current_employments: [
            {
              firm_id: "135037",
              firm_name: "WEAVER CAPITAL MANAGEMENT, LLC",
              branch_city: "SUWANEE",
              branch_state: "GA",
              branch_zip: "30024",
              ia_only: "Y",
            },
          ],
        },
      },
    ],
  },
};

// GET /search/individual/2767573 — double-encoded, lat/lng as strings.
const INDIVIDUAL_2767573 = {
  hits: {
    total: 1,
    hits: [
      {
        _source: {
          iacontent: JSON.stringify({
            basicInformation: {
              individualId: 2767573,
              firstName: "MATTHEW",
              middleName: "ADAM",
              lastName: "YANNI",
              otherNames: ["MATTHEW  YANNI"],
              bcScope: "NotInScope",
              iaScope: "Active",
            },
            currentIAEmployments: [
              {
                firmId: 142913,
                firmName: "YANNI & ASSOCIATES INVESTMENT ADVISORS, LLC",
                iaOnly: "Y",
                registrationBeginDate: "2/7/2007",
                branchOfficeLocations: [
                  {
                    privateResidenceFlag: "N",
                    branchOfficeId: "314647",
                    street1: "2000 CORPORATE DRIVE",
                    street2: "SUITE 450",
                    city: "WEXFORD",
                    state: "PA",
                    country: "United States",
                    zipCode: "15090",
                    latitude: "40.627036",
                    longitude: "-80.07888",
                    geoLocation: "40.627036,-80.07888",
                  },
                ],
              },
            ],
            currentEmployments: [],
            previousEmployments: [],
            previousIAEmployments: [],
            disclosureFlag: "N",
            iaDisclosureFlag: "N",
            disclosures: [],
            iaDisclosures: [],
            examsCount: { stateExamCount: 0, principalExamCount: 0, productExamCount: 0 },
            stateExamCategory: [],
            principalExamCategory: [],
            productExamCategory: [],
            registrationCount: { approvedIAStateRegistrationCount: 2 },
            registeredStates: [
              { state: "Pennsylvania", regScope: "IA", status: "APPROVED", regDate: "2/7/2007" },
              { state: "Texas", regScope: "IA", status: "APPROVED_RES", regDate: "5/14/2015" },
            ],
            registeredSROs: [],
          }),
        },
      },
    ],
  },
};

// GET /search/individual/5156870 — dual history + exams, used for the merge/exam mapping.
const INDIVIDUAL_5156870 = {
  hits: {
    total: 1,
    hits: [
      {
        _source: {
          iacontent: JSON.stringify({
            basicInformation: { individualId: 5156870, firstName: "BRADLEY", lastName: "BARGER", iaScope: "Active" },
            currentIAEmployments: [
              {
                firmId: 135037,
                firmName: "WEAVER CAPITAL MANAGEMENT, LLC",
                iaOnly: "Y",
                registrationBeginDate: "6/10/2025",
                branchOfficeLocations: [
                  {
                    branchOfficeId: "72083",
                    street1: "5400 LAUREL SPRINGS PARKWAY",
                    street2: "SUITE 303",
                    city: "SUWANEE",
                    state: "GA",
                    zipCode: "30024",
                    latitude: "34.064899",
                    longitude: "-84.093288",
                    privateResidenceFlag: "N",
                  },
                ],
              },
            ],
            currentEmployments: [],
            previousIAEmployments: [
              {
                firmId: 19616,
                firmName: "WELLS FARGO ADVISORS",
                registrationBeginDate: "7/15/2024",
                registrationEndDate: "5/22/2025",
              },
            ],
            previousEmployments: [
              {
                firmId: 17499,
                firmName: "TRUIST INVESTMENT SERVICES, INC.",
                registrationBeginDate: "6/13/2016",
                registrationEndDate: "5/23/2024",
              },
            ],
            stateExamCategory: [
              {
                examCategory: "Series 65",
                examName: "Uniform Investment Adviser Law Examination",
                examTakenDate: "6/30/2016",
                examScope: "IA",
              },
            ],
            principalExamCategory: [],
            productExamCategory: [],
            examsCount: { stateExamCount: 2, principalExamCount: 0, productExamCount: 3 },
            iaDisclosureFlag: "Y",
            disclosureFlag: "N",
            iaDisclosures: [{ disclosureType: "Regulatory Event", disclosureCount: 1 }],
            disclosures: [],
            registeredStates: [],
            registeredSROs: [],
          }),
        },
      },
    ],
  },
};

// GET /search/firm/142913 — brochures is an OBJECT, not an array.
const FIRM_142913 = {
  hits: {
    total: 1,
    hits: [
      {
        _source: {
          iacontent: JSON.stringify({
            basicInformation: {
              firmId: 142913,
              firmName: "YANNI & ASSOCIATES INVESTMENT ADVISORS, LLC",
              iaScope: "ACTIVE",
              isIAFirm: "Y",
              iaSECNumber: "123404",
              iaSECNumberType: "801",
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
            registrationStatus: [{ secJurisdiction: "SEC", status: "Approved", effectiveDate: "3/9/2022" }],
            noticeFilings: [{ jurisdiction: "California", status: "Notice Filed", effectiveDate: "7/29/2024" }],
            brochures: {
              part2ExemptFlag: "N",
              brochuredetails: [
                { brochureVersionID: 1004123, brochureName: "YAIA ADV PART 2A", dateSubmitted: "1/27/2026" },
              ],
            },
          }),
        },
      },
    ],
  },
};

// GET /search/individual?query=Bernzott — name search matches surnames AND otherNames.
const NAME_SEARCH_BERNZOTT = {
  hits: {
    total: 45,
    hits: [
      {
        _source: {
          ind_source_id: "2595235",
          ind_firstname: "KEVIN",
          ind_lastname: "BERNZOTT",
          ind_ia_scope: "Active",
          ind_ia_disclosure_fl: "N",
          ind_ia_current_employments: [
            {
              firm_id: "104583",
              firm_name: "BERNZOTT  CAPITAL ADVISORS",
              branch_city: "CAMARILLO",
              branch_state: "CA",
              branch_zip: "93010",
              ia_only: "Y",
            },
          ],
        },
      },
      {
        // No employments at all — a lapsed registrant. Must not crash the mapper.
        _source: {
          ind_source_id: "4365778",
          ind_firstname: "DONALD",
          ind_middlename: "EDWARD",
          ind_lastname: "BERNOTUS",
          ind_namesuffix: "II",
          ind_ia_scope: "NotInScope",
          ind_ia_disclosure_fl: "N",
        },
      },
    ],
  },
};

// The over-limit body: HTTP 200, errorCode -1, hits null.
const EXCEEDED_LIMIT = { errorCode: -1, errorMessage: "Exceeded limit", hits: null };
const EMPTY_HITS = { hits: { total: 0, hits: [] } };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A fetch double that records the URLs it was asked for. */
function stubFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Returns a different response per attempt, so retry behaviour is observable. */
function sequenceFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body = {} } = next;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const fast = { retryDelayMs: 0 };

// ---------------------------------------------------------------------------
// coercion
// ---------------------------------------------------------------------------

test("toCrd normalises the string and number forms the API mixes", () => {
  assert.equal(toCrd("142913"), 142913);
  assert.equal(toCrd(142913), 142913);
  assert.equal(toCrd(" 142913 "), 142913);
  assert.equal(toCrd(null), null);
  assert.equal(toCrd(""), null);
  assert.equal(toCrd("abc"), null);
  assert.equal(toCrd(0), null);
  assert.equal(toCrd(-5), null);
  assert.equal(toCrd(1.5), null);
});

test("sameCrd bridges the string/number mismatch that === would miss", () => {
  // This is the whole point: the roster says "142913", we ask with 142913.
  assert.equal("142913" === 142913, false);
  assert.equal(sameCrd("142913", 142913), true);
  assert.equal(sameCrd(142913, "142913"), true);
  assert.equal(sameCrd("142913", "135037"), false);
  assert.equal(sameCrd(null, 142913), false);
  assert.equal(sameCrd(undefined, undefined), false);
});

// ---------------------------------------------------------------------------
// listFirmIndividuals
// ---------------------------------------------------------------------------

test("listFirmIndividuals returns both current advisers at a real 2-person RIA", async () => {
  const fetchImpl = stubFetch(ROSTER_142913);
  const result = await listFirmIndividuals(142913, { fetchImpl, ...fast });

  assert.equal(result.total, 2);
  assert.equal(result.currentCount, 2);
  assert.equal(result.individuals.length, 2);

  const [matthew] = result.individuals;
  assert.equal(matthew.crd, 2767573);
  assert.equal(matthew.name, "MATTHEW ADAM YANNI");
  assert.equal(matthew.firstName, "MATTHEW");
  assert.equal(matthew.middleName, "ADAM");
  assert.equal(matthew.lastName, "YANNI");
  assert.equal(matthew.iaScope, "Active");
  assert.equal(matthew.isCurrentAtFirm, true);
  assert.equal(matthew.hasDisclosures, false);
  assert.equal(matthew.iaOnly, true);
  assert.equal(matthew.branchCity, "WEXFORD");
  assert.equal(matthew.branchState, "PA");
  assert.equal(matthew.branchZip, "15090");
});

test("listFirmIndividuals rejects a departed adviser at their OLD firm", async () => {
  // The load-bearing filter. Live: firm=110518 returns Bradley Barger, whose current
  // employer is CRD 135037. Without the filter he would be offered this firm's profile.
  const fetchImpl = stubFetch(ROSTER_110518);
  const result = await listFirmIndividuals(110518, { fetchImpl, ...fast });

  assert.equal(result.total, 1, "the API still reports one match");
  assert.equal(result.currentCount, 0, "but nobody is currently at this firm");
  assert.equal(result.individuals[0].isCurrentAtFirm, false);
  assert.notEqual(result.total, result.currentCount);
});

test("listFirmIndividuals currentOnly drops non-current people entirely", async () => {
  const fetchImpl = stubFetch(ROSTER_110518);
  const result = await listFirmIndividuals(110518, { fetchImpl, currentOnly: true, ...fast });

  assert.equal(result.total, 1);
  assert.equal(result.currentCount, 0);
  assert.deepEqual(result.individuals, []);
});

test("listFirmIndividuals sorts current advisers ahead of departed ones", async () => {
  const mixed = {
    hits: {
      total: 2,
      hits: [ROSTER_110518.hits.hits[0], ROSTER_142913.hits.hits[0]],
    },
  };
  const result = await listFirmIndividuals(142913, { fetchImpl: stubFetch(mixed), ...fast });
  assert.deepEqual(
    result.individuals.map((i) => i.isCurrentAtFirm),
    [true, false],
  );
  assert.equal(result.currentCount, 1);
});

test("listFirmIndividuals sends only the `firm` param, capped at nrows=100", async () => {
  const fetchImpl = stubFetch(ROSTER_142913);
  await listFirmIndividuals(142913, { fetchImpl, limit: 500, ...fast });

  const { url, init } = fetchImpl.calls[0];
  assert.match(url, /[?&]firm=142913(&|$)/);
  assert.match(url, /[?&]nrows=100(&|$)/);
  assert.match(url, /[?&]start=0(&|$)/);
  // firm_crd / firmid / firm_id are silently ignored by the API — never send them.
  assert.doesNotMatch(url, /firm_crd|firmid|firm_id/);
  assert.equal(init.headers["user-agent"], "hushh-ria-identity-api/0.1 (+https://hushh.ai; contact ankit@hushh.ai)");
});

test("listFirmIndividuals refuses to page past the result window", async () => {
  const fetchImpl = stubFetch(ROSTER_142913);
  await assert.rejects(
    () => listFirmIndividuals(142913, { fetchImpl, start: MAX_RESULT_WINDOW, limit: MAX_NROWS, ...fast }),
    (error) => error instanceof IapdError && error.status === 400,
  );
  assert.equal(fetchImpl.calls.length, 0, "should fail before spending a request");
});

test("listFirmIndividuals rejects a malformed CRD without calling the API", async () => {
  const fetchImpl = stubFetch(ROSTER_142913);
  await assert.rejects(
    () => listFirmIndividuals("not-a-crd", { fetchImpl, ...fast }),
    (error) => error instanceof IapdError && error.status === 400,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("listFirmIndividuals throws on the HTTP-200 'Exceeded limit' body", async () => {
  const fetchImpl = stubFetch(EXCEEDED_LIMIT);
  await assert.rejects(
    () => listFirmIndividuals(142913, { fetchImpl, ...fast }),
    (error) => error instanceof IapdError && error.code === -1 && /Exceeded limit/.test(error.message),
  );
});

test("listFirmIndividuals handles a firm with no advisers", async () => {
  const result = await listFirmIndividuals(142913, { fetchImpl: stubFetch(EMPTY_HITS), ...fast });
  assert.deepEqual(result, { total: 0, currentCount: 0, individuals: [] });
});

test("listFirmIndividuals reads the {value,relation} total shape too", async () => {
  const body = { hits: { total: { value: 2, relation: "eq" }, hits: ROSTER_142913.hits.hits } };
  const result = await listFirmIndividuals(142913, { fetchImpl: stubFetch(body), ...fast });
  assert.equal(result.total, 2);
});

// ---------------------------------------------------------------------------
// getIndividual
// ---------------------------------------------------------------------------

test("getIndividual decodes the double-encoded payload and keeps branch lat/lng", async () => {
  const fetchImpl = stubFetch(INDIVIDUAL_2767573);
  const person = await getIndividual(2767573, { fetchImpl, ...fast });

  assert.equal(person.crd, 2767573);
  assert.equal(person.name, "MATTHEW ADAM YANNI");
  assert.deepEqual(person.otherNames, ["MATTHEW YANNI"]);

  assert.equal(person.currentEmployments.length, 1);
  const [job] = person.currentEmployments;
  assert.equal(job.firmCrd, 142913);
  assert.equal(job.firmName, "YANNI & ASSOCIATES INVESTMENT ADVISORS, LLC");
  assert.equal(job.iaOnly, true);
  assert.equal(job.registrationBeginDate, "2/7/2007");

  const [branch] = job.branches;
  assert.equal(branch.branchOfficeId, "314647");
  assert.equal(branch.street1, "2000 CORPORATE DRIVE");
  assert.equal(branch.street2, "SUITE 450");
  assert.equal(branch.city, "WEXFORD");
  assert.equal(branch.state, "PA");
  assert.equal(branch.zip, "15090");
  // Strings on the wire, numbers in our contract.
  assert.equal(branch.lat, 40.627036);
  assert.equal(branch.lng, -80.07888);
  assert.equal(typeof branch.lat, "number");
  assert.equal(branch.privateResidence, false);

  assert.equal(person.hasDisclosures, false);
  assert.deepEqual(person.disclosures, []);
  assert.equal(person.registeredStates.length, 2);
  assert.equal(person.reportUrl, "https://adviserinfo.sec.gov/individual/summary/2767573");
});

test("getIndividual merges IA and broker-dealer history and flags disclosures", async () => {
  const person = await getIndividual(5156870, { fetchImpl: stubFetch(INDIVIDUAL_5156870), ...fast });

  assert.equal(person.currentEmployments[0].firmCrd, 135037);
  assert.deepEqual(
    person.previousEmployments.map((e) => e.firmCrd),
    [19616, 17499],
    "IA history first, then the broker-dealer rows it did not cover",
  );
  assert.deepEqual(person.previousEmployments[0], {
    firmCrd: 19616,
    firmName: "WELLS FARGO ADVISORS",
    from: "7/15/2024",
    to: "5/22/2025",
  });

  assert.deepEqual(person.exams, [
    { code: "Series 65", name: "Uniform Investment Adviser Law Examination", date: "6/30/2016" },
  ]);
  assert.equal(person.examCounts.productExamCount, 3);

  assert.equal(person.hasDisclosures, true);
  assert.deepEqual(person.disclosures, [{ disclosureType: "Regulatory Event", disclosureCount: 1 }]);
});

test("getIndividual raises a typed not-found for an unknown CRD", async () => {
  // An unknown CRD is HTTP 200 with zero hits, not a 404.
  await assert.rejects(
    () => getIndividual(999999999, { fetchImpl: stubFetch(EMPTY_HITS), ...fast }),
    (error) => error instanceof IapdNotFoundError && error.status === 404,
  );
});

test("IapdNotFoundError is distinguishable from a transport failure", async () => {
  // The resolver degrades differently for "no such person" vs "IAPD is down".
  const notFound = await getIndividual(999999999, { fetchImpl: stubFetch(EMPTY_HITS), ...fast }).catch((e) => e);
  assert.ok(notFound instanceof IapdNotFoundError);
  assert.ok(notFound instanceof IapdError, "still an IapdError for blanket catches");
});

// ---------------------------------------------------------------------------
// getFirm
// ---------------------------------------------------------------------------

test("getFirm flattens the brochures object into the contracted array", async () => {
  const firm = await getFirm(142913, { fetchImpl: stubFetch(FIRM_142913), ...fast });

  assert.equal(firm.crd, 142913);
  assert.equal(firm.name, "YANNI & ASSOCIATES INVESTMENT ADVISORS, LLC");
  // iaSECNumberType + iaSECNumber, as the SEC displays it.
  assert.equal(firm.secNumber, "801-123404");
  assert.equal(firm.iaScope, "ACTIVE");
  assert.equal(firm.isIaFirm, true);

  assert.deepEqual(firm.officeAddress, {
    street1: "2000 CORPORATE DRIVE",
    street2: "SUITE 450",
    city: "WEXFORD",
    state: "PA",
    zip: "15090",
    country: "United States",
  });
  assert.equal(firm.mailingAddress, null);

  // brochures arrives as {part2ExemptFlag, brochuredetails:[...]} — an object, not an array.
  assert.deepEqual(firm.brochures, [
    { versionId: 1004123, name: "YAIA ADV PART 2A", dateSubmitted: "1/27/2026" },
  ]);
  assert.equal(firm.registrationStatus[0].status, "Approved");
  assert.equal(firm.noticeFilings[0].jurisdiction, "California");
  assert.equal(firm.reportUrl, "https://adviserinfo.sec.gov/firm/summary/142913");
});

test("getFirm survives a firm with no brochures", async () => {
  const body = {
    hits: {
      total: 1,
      hits: [{ _source: { iacontent: JSON.stringify({ basicInformation: { firmId: 1, firmName: "X" } }) } }],
    },
  };
  const firm = await getFirm(1, { fetchImpl: stubFetch(body), ...fast });
  assert.deepEqual(firm.brochures, []);
  assert.deepEqual(firm.registrationStatus, []);
  assert.equal(firm.officeAddress, null);
  assert.equal(firm.secNumber, null);
  assert.equal(firm.isIaFirm, false);
});

// ---------------------------------------------------------------------------
// searchIndividualsByName
// ---------------------------------------------------------------------------

test("searchIndividualsByName maps hits and never claims current-at-firm", async () => {
  const fetchImpl = stubFetch(NAME_SEARCH_BERNZOTT);
  const people = await searchIndividualsByName("Bernzott", { fetchImpl, ...fast });

  assert.equal(people.length, 2);
  assert.equal(people[0].crd, 2595235);
  assert.equal(people[0].name, "KEVIN BERNZOTT");
  assert.equal(people[0].branchCity, "CAMARILLO");
  assert.equal(people[0].branchState, "CA");
  // No firm was asked about, so this must not assert an affiliation.
  assert.equal(people[0].isCurrentAtFirm, false);

  // The lapsed registrant with no employments must map cleanly, not crash.
  assert.equal(people[1].name, "DONALD EDWARD BERNOTUS II");
  assert.equal(people[1].branchCity, null);
  assert.equal(people[1].iaOnly, null);
});

test("searchIndividualsByName repeats the state param and caps nrows", async () => {
  const fetchImpl = stubFetch(NAME_SEARCH_BERNZOTT);
  await searchIndividualsByName("Yanni", { fetchImpl, state: ["pa", "tx"], limit: 999, ...fast });

  const url = fetchImpl.calls[0].url;
  assert.match(url, /[?&]query=Yanni(&|$)/);
  assert.match(url, /[?&]nrows=100(&|$)/);
  assert.match(url, /[?&]state=PA(&|$)/);
  assert.match(url, /[?&]state=TX(&|$)/);
  // `city` is accepted by the API and always returns zero — we never send it.
  assert.doesNotMatch(url, /[?&]city=/);
});

test("searchIndividualsByName accepts a single state string", async () => {
  const fetchImpl = stubFetch(NAME_SEARCH_BERNZOTT);
  await searchIndividualsByName("Yanni", { fetchImpl, state: "PA", ...fast });
  assert.match(fetchImpl.calls[0].url, /[?&]state=PA(&|$)/);
});

test("searchIndividualsByName rejects an empty query without a request", async () => {
  const fetchImpl = stubFetch(NAME_SEARCH_BERNZOTT);
  await assert.rejects(
    () => searchIndividualsByName("   ", { fetchImpl, ...fast }),
    (error) => error instanceof IapdError && error.status === 400,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

// ---------------------------------------------------------------------------
// transport behaviour
// ---------------------------------------------------------------------------

test("retries a 500 twice and then succeeds", async () => {
  const fetchImpl = sequenceFetch({ status: 500 }, { status: 503 }, { status: 200, body: ROSTER_142913 });
  const result = await listFirmIndividuals(142913, { fetchImpl, ...fast });
  assert.equal(result.currentCount, 2);
  assert.equal(fetchImpl.calls.length, 3);
});

test("retries a network fault", async () => {
  const fetchImpl = sequenceFetch(new Error("ECONNRESET"), { status: 200, body: ROSTER_142913 });
  const result = await listFirmIndividuals(142913, { fetchImpl, ...fast });
  assert.equal(result.total, 2);
  assert.equal(fetchImpl.calls.length, 2);
});

test("gives up after three attempts and reports the last status", async () => {
  const fetchImpl = sequenceFetch({ status: 500 }, { status: 500 }, { status: 500 });
  await assert.rejects(
    () => listFirmIndividuals(142913, { fetchImpl, ...fast }),
    (error) => error instanceof IapdError && error.status === 500 && error.retriable === true,
  );
  assert.equal(fetchImpl.calls.length, 3, "1 attempt + 2 retries, no more");
});

test("does NOT retry a 4xx", async () => {
  const fetchImpl = sequenceFetch({ status: 400 }, { status: 200, body: ROSTER_142913 });
  await assert.rejects(
    () => listFirmIndividuals(142913, { fetchImpl, ...fast }),
    (error) => error instanceof IapdError && error.status === 400 && error.retriable === false,
  );
  assert.equal(fetchImpl.calls.length, 1, "a 4xx will not improve by asking again");
});

test("does NOT retry the 200-shaped 'Exceeded limit' error", async () => {
  const fetchImpl = sequenceFetch({ status: 200, body: EXCEEDED_LIMIT }, { status: 200, body: ROSTER_142913 });
  await assert.rejects(() => listFirmIndividuals(142913, { fetchImpl, ...fast }), IapdError);
  assert.equal(fetchImpl.calls.length, 1);
});

test("passes an abort signal on every request", async () => {
  const fetchImpl = stubFetch(ROSTER_142913);
  await listFirmIndividuals(142913, { fetchImpl, timeoutMs: 50, ...fast });
  const { init } = fetchImpl.calls[0];
  assert.ok(init.signal, "an AbortSignal must be attached");
  assert.equal(init.signal.aborted, false);
});

test("a timeout aborts the request and surfaces as an error", async () => {
  // fetch that never resolves until aborted — proves the AbortController is wired up.
  const fetchImpl = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  await assert.rejects(
    () => listFirmIndividuals(142913, { fetchImpl, timeoutMs: 10, retries: 0, retryDelayMs: 0 }),
    (error) => error instanceof IapdError && /aborted/.test(error.message),
  );
});

test("each call issues exactly one request per attempt — no parallel storms", async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    return { ok: true, status: 200, json: async () => ROSTER_142913 };
  };
  await listFirmIndividuals(142913, { fetchImpl, ...fast });
  assert.equal(peak, 1);
});

// ---------------------------------------------------------------------------
// cache injection
// ---------------------------------------------------------------------------

test("an injected cache short-circuits the second identical call", async () => {
  const store = new Map();
  const cache = {
    async wrap(key, produce) {
      if (store.has(key)) return store.get(key);
      const value = await produce();
      store.set(key, value);
      return value;
    },
  };
  const fetchImpl = stubFetch(ROSTER_142913);

  const first = await listFirmIndividuals(142913, { fetchImpl, cache, ...fast });
  const second = await listFirmIndividuals(142913, { fetchImpl, cache, ...fast });

  assert.equal(fetchImpl.calls.length, 1, "second call served from cache");
  assert.deepEqual(first, second);
  assert.equal(store.size, 1);
});

test("a failed request never poisons the cache", async () => {
  // Regression: the 'Exceeded limit' reply is a perfectly cacheable HTTP 200. If the raw
  // body were cached before validation, one bad reply would break the key for its whole
  // TTL and every later caller would see a firm with no advisers.
  const store = new Map();
  const cache = {
    async wrap(key, produce) {
      if (store.has(key)) return store.get(key);
      const value = await produce(); // a rejection must propagate, never be stored
      store.set(key, value);
      return value;
    },
  };

  const failing = stubFetch(EXCEEDED_LIMIT);
  await assert.rejects(() => listFirmIndividuals(142913, { fetchImpl: failing, cache, ...fast }), IapdError);
  assert.equal(store.size, 0, "nothing may be cached from a failed call");

  // The very next call, once IAPD is healthy again, must succeed.
  const healthy = stubFetch(ROSTER_142913);
  const result = await listFirmIndividuals(142913, { fetchImpl: healthy, cache, ...fast });
  assert.equal(result.currentCount, 2);
});

test("currentOnly and the full roster share one cache entry", async () => {
  const store = new Map();
  const cache = {
    async wrap(key, produce) {
      if (store.has(key)) return store.get(key);
      const value = await produce();
      store.set(key, value);
      return value;
    },
  };
  const fetchImpl = stubFetch(ROSTER_110518);

  const all = await listFirmIndividuals(110518, { fetchImpl, cache, ...fast });
  const current = await listFirmIndividuals(110518, { fetchImpl, cache, currentOnly: true, ...fast });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(store.size, 1);
  assert.equal(all.individuals.length, 1);
  assert.equal(current.individuals.length, 0, "the filtered view must not mutate the cached roster");
  // Prove the cached entry was not mutated by the filtered read.
  const again = await listFirmIndividuals(110518, { fetchImpl, cache, ...fast });
  assert.equal(again.individuals.length, 1);
});

test("cache keys separate firms, individuals, pages and searches", async () => {
  const keys = [];
  const cache = {
    async wrap(key, produce) {
      keys.push(key);
      return produce();
    },
  };
  await listFirmIndividuals(142913, { fetchImpl: stubFetch(ROSTER_142913), cache, ...fast });
  await listFirmIndividuals(142913, { fetchImpl: stubFetch(ROSTER_142913), cache, start: 100, ...fast });
  await listFirmIndividuals(104583, { fetchImpl: stubFetch(ROSTER_142913), cache, ...fast });
  await getIndividual(2767573, { fetchImpl: stubFetch(INDIVIDUAL_2767573), cache, ...fast });
  await getFirm(142913, { fetchImpl: stubFetch(FIRM_142913), cache, ...fast });
  await searchIndividualsByName("Yanni", { fetchImpl: stubFetch(NAME_SEARCH_BERNZOTT), cache, ...fast });

  assert.equal(new Set(keys).size, keys.length, `keys must be distinct: ${keys.join(" | ")}`);
  // A firm CRD and an individual CRD can collide numerically — they must not share a key.
  assert.ok(keys.some((k) => k.startsWith("iapd:firm:142913")));
  assert.ok(keys.some((k) => k.startsWith("iapd:roster:142913")));
});

// ---------------------------------------------------------------------------
// parseDoubleEncoded
// ---------------------------------------------------------------------------

test("parseDoubleEncoded rejects malformed inner JSON with context", () => {
  const body = { hits: { total: 1, hits: [{ _source: { iacontent: "{not json" } }] } };
  assert.throws(
    () => parseDoubleEncoded(body, { context: "individual 1", crd: 1 }),
    (error) => error instanceof IapdError && /not valid JSON/.test(error.message),
  );
});

test("parseDoubleEncoded tolerates an already-decoded object", () => {
  const body = { hits: { total: 1, hits: [{ _source: { iacontent: { basicInformation: { firmId: 7 } } } }] } };
  assert.deepEqual(parseDoubleEncoded(body, { context: "firm 7", crd: 7 }), {
    basicInformation: { firmId: 7 },
  });
});

// ---------------------------------------------------------------------------
// F9 — config.iapd.userAgent and config.iapd.gapMs were DEAD
// ---------------------------------------------------------------------------
//
// The transport hard-coded its own UA constant and ignored both settings, so the SEC-facing
// identity of this service could not actually be configured or contacted differently without
// a code change — which is precisely the sort of thing you need to change quickly when an
// upstream asks you to.

test("F9: a configured userAgent reaches the wire on EVERY endpoint", async () => {
  const UA = "hushh-ria-identity-api/9.9 (+https://hushh.ai; contact ops@hushh.ai)";

  const roster = stubFetch(ROSTER_142913);
  await listFirmIndividuals(142913, { fetchImpl: roster, userAgent: UA, ...fast });
  assert.equal(roster.calls[0].init.headers["user-agent"], UA);

  const firm = stubFetch(FIRM_142913);
  await getFirm(142913, { fetchImpl: firm, userAgent: UA, ...fast });
  assert.equal(firm.calls[0].init.headers["user-agent"], UA);

  const individual = stubFetch(INDIVIDUAL_2767573);
  await getIndividual(2767573, { fetchImpl: individual, userAgent: UA, ...fast });
  assert.equal(individual.calls[0].init.headers["user-agent"], UA);

  const search = stubFetch(ROSTER_142913);
  await searchIndividualsByName("Yanni", { fetchImpl: search, userAgent: UA, ...fast });
  assert.equal(search.calls[0].init.headers["user-agent"], UA);
});

test("F9: an unset or blank userAgent still identifies us honestly", async () => {
  const blank = stubFetch(ROSTER_142913);
  await listFirmIndividuals(142913, { fetchImpl: blank, userAgent: "   ", ...fast });
  assert.equal(blank.calls[0].init.headers["user-agent"], DEFAULT_USER_AGENT);
  assert.match(DEFAULT_USER_AGENT, /hushh\.ai/, "the fallback must still be contactable");

  const unset = stubFetch(ROSTER_142913);
  await listFirmIndividuals(142913, { fetchImpl: unset, ...fast });
  assert.equal(unset.calls[0].init.headers["user-agent"], DEFAULT_USER_AGENT);
});

test("F9: gapMs actually paces outbound requests, across concurrent callers", async () => {
  const at = [];
  const fetchImpl = async () => {
    at.push(Date.now());
    return { ok: true, status: 200, json: async () => ROSTER_142913 };
  };
  const started = Date.now();
  await Promise.all([
    listFirmIndividuals(142913, { fetchImpl, gapMs: 40, ...fast }),
    listFirmIndividuals(110518, { fetchImpl, gapMs: 40, ...fast }),
    listFirmIndividuals(2907, { fetchImpl, gapMs: 40, ...fast }),
  ]);
  assert.equal(at.length, 3);
  // Three requests at a 40ms floor cannot all land inside 40ms, which is exactly what
  // happened while gapMs was ignored.
  assert.ok(Date.now() - started >= 80, `three paced requests took ${Date.now() - started}ms`);
  for (let i = 1; i < at.length; i += 1) {
    assert.ok(at[i] - at[i - 1] >= 35, `gap ${i} was ${at[i] - at[i - 1]}ms`);
  }
});

test("F9: gapMs 0 adds no delay at all", async () => {
  const fetchImpl = stubFetch(ROSTER_142913);
  const started = Date.now();
  await Promise.all([
    listFirmIndividuals(142913, { fetchImpl, gapMs: 0, ...fast }),
    listFirmIndividuals(110518, { fetchImpl, gapMs: 0, ...fast }),
  ]);
  assert.ok(Date.now() - started < 50);
});
