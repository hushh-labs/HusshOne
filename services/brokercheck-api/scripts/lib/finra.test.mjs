import test from "node:test";
import assert from "node:assert/strict";
import { buildFilter, mapStub, pooled } from "./finra.mjs";

test("buildFilter: IA + active is the default product query", () => {
  assert.equal(buildFilter({ type: "ia", status: "active" }), "ia=true,active=true");
});

test("buildFilter: `both` expands to all three type flags", () => {
  assert.equal(buildFilter({ type: "both", status: "active" }), "broker=true,ia=true,brokeria=true,active=true");
});

test("buildFilter: experience is encoded as a DAY range, not years", () => {
  // FINRA's UI multiplies the years slider by 365; 20 years -> 7300 days, open upper bound.
  assert.ok(buildFilter({ type: "ia", status: "active", minExperienceYears: 20 }).includes("experience=7300-*"));
});

test("buildFilter: no experience clause when the floor is absent or zero", () => {
  assert.ok(!buildFilter({ type: "ia", status: "active" }).includes("experience"));
  assert.ok(!buildFilter({ type: "ia", status: "active", minExperienceYears: 0 }).includes("experience"));
});

const HIT = {
  _source: {
    ind_source_id: "1781753",
    ind_firstname: "SUZANNE",
    ind_middlename: "LEIGH",
    ind_lastname: "OMAN",
    ind_other_names: ["SUZANNE LEIGH GIPSON"],
    ind_bc_scope: "Active",
    ind_ia_scope: "Active",
    ind_bc_disclosure_fl: "N",
    ind_approved_finra_registration_count: 1,
    ind_employments_count: 3,
    ind_industry_cal_date: "1990-12-17",
    ind_current_employments: [{ firm_id: 999, firm_name: "WRONG ONE", branch_zip: "00000" }],
  },
  inner_hits: {
    ind_current_employments: {
      hits: {
        hits: [
          {
            _source: {
              firm_id: 149777,
              firm_name: "MORGAN STANLEY",
              branch_city: "Kirkland",
              branch_state: "WA",
              branch_zip: "98033",
              ia_only: "N",
            },
          },
        ],
      },
    },
  },
};

test("mapStub prefers the inner_hits branch — the one that matched the geo query", () => {
  const stub = mapStub(HIT);
  assert.equal(stub.firm.firmName, "MORGAN STANLEY");
  assert.equal(stub.firm.branchZip, "98033");
  // Falling back to ind_current_employments[0] would have picked the wrong office.
  assert.notEqual(stub.firm.branchZip, "00000");
});

test("mapStub derives years of experience from the SEARCH endpoint's ISO date", () => {
  const stub = mapStub(HIT);
  assert.ok(stub.yearsExperience > 30 && stub.yearsExperience < 45, `got ${stub.yearsExperience}`);
});

test("mapStub composes the display name and keeps scope flags", () => {
  const stub = mapStub(HIT);
  assert.equal(stub.name, "SUZANNE LEIGH OMAN");
  assert.equal(stub.crd, "1781753");
  assert.equal(stub.isBroker, true);
  assert.equal(stub.isInvestmentAdvisor, true);
  assert.equal(stub.hasDisclosures, false);
});

test("mapStub falls back to ind_current_employments when inner_hits is absent", () => {
  const stub = mapStub({ _source: { ...HIT._source } });
  assert.equal(stub.firm.firmName, "WRONG ONE");
});

test("mapStub returns null for a hit with no CRD rather than a half-built record", () => {
  assert.equal(mapStub({ _source: {} }), null);
  assert.equal(mapStub({}), null);
  assert.equal(mapStub(null), null);
});

test("mapStub handles a person with no current employment", () => {
  const stub = mapStub({ _source: { ind_source_id: "1", ind_firstname: "A", ind_lastname: "B" } });
  assert.equal(stub.firm, null);
  assert.equal(stub.yearsExperience, null);
});

test("pooled preserves input order regardless of completion order", async () => {
  const out = await pooled([30, 10, 20], async (ms) => {
    await new Promise((r) => setTimeout(r, ms / 10));
    return ms;
  }, 3);
  assert.deepEqual(out, [30, 10, 20]);
});

test("pooled isolates failures to their own slot", async () => {
  const out = await pooled([1, 2, 3], async (n) => {
    if (n === 2) throw new Error("boom");
    return n;
  }, 2);
  assert.deepEqual(out, [1, null, 3]);
});

test("pooled respects the concurrency limit", async () => {
  let inFlight = 0;
  let peak = 0;
  await pooled(Array.from({ length: 20 }, (_, i) => i), async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
  }, 4);
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

// --- duplicate handling -------------------------------------------------------
// FINRA emits one hit per MATCHING BRANCH, so an adviser with two offices inside the
// radius arrives twice. Caught live: LEEANN HUGGINS (CRD 1630652) appeared twice in a
// single 10-row page.
test("mapStub keeps CRD stable so duplicates are detectable downstream", () => {
  const a = mapStub({ ...HIT, inner_hits: { ind_current_employments: { hits: { hits: [{ _source: { firm_id: 1, branch_zip: "98033" } }] } } } });
  const b = mapStub({ ...HIT, inner_hits: { ind_current_employments: { hits: { hits: [{ _source: { firm_id: 1, branch_zip: "98004" } }] } } } });
  assert.equal(a.crd, b.crd);
  assert.notEqual(a.firm.branchZip, b.firm.branchZip);
});
