// H1 — THE DISCLOSURE ROUTE THAT WAS NOT CHARGED.
//
// The shipped build charged the daily cap at two of the four disclosing route sites.
// /v1/advisors/{crd} returned a named adviser profile and charged nothing, and /v1/claim/search
// returned named advisers and charged nothing — while chargeDailyCap's own docstring claimed
// every disclosing route shared it.
//
// These tests are the thing that keeps that docstring true. They enumerate the route table and
// fail if ANY person-disclosing route can be served without paying the cap, they prove the
// dispatcher charges before it discloses rather than merely being able to, and they read
// server.mjs to catch a future route wired up outside the table entirely.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  ROUTES,
  DISCLOSES,
  PERSON_DISCLOSING_ROUTES,
  chargesDailyCap,
  matchRoute,
  dispatch,
  assertHandlersComplete,
} from "./routes.mjs";

const SERVER_PATH = new URL("../../server.mjs", import.meta.url);

/** Handlers that record what ran, in order, next to the cap charges. */
function spy() {
  const events = [];
  const handlers = {};
  for (const route of ROUTES) handlers[route.name] = () => events.push(`handler:${route.name}`);
  return {
    events,
    handlers,
    charge: (route) => {
      events.push(`charge:${route.name}`);
      return { ok: true, limit: 2000, used: 1, remaining: 1999 };
    },
  };
}

// ---------------------------------------------------------------------------
// the table itself
// ---------------------------------------------------------------------------

test("H1: EVERY person-disclosing route charges the daily cap", () => {
  const uncharged = ROUTES.filter((route) => route.discloses === DISCLOSES.PERSON && !chargesDailyCap(route));
  assert.deepEqual(
    uncharged.map((r) => r.path),
    [],
    `these routes can name a person without paying the daily cap: ${uncharged.map((r) => r.path).join(", ")}`,
  );
  assert.ok(PERSON_DISCLOSING_ROUTES.length >= 3, "there are at least three person-disclosing routes");
});

test("H1: the two routes that shipped uncharged are declared as person-disclosing", () => {
  // A future change that dodges the cap by relabelling the route is the same bug wearing a
  // different hat, so the classification is asserted by PATH and not merely counted.
  const byPath = new Map(ROUTES.map((route) => [route.path, route]));
  for (const path of ["/v1/advisors/{crd}", "/v1/claim/search", "/v1/claim/lookup"]) {
    const route = byPath.get(path);
    assert.ok(route, `${path} is missing from the route table`);
    assert.equal(route.discloses, DISCLOSES.PERSON, `${path} returns named people`);
    assert.equal(chargesDailyCap(route), true, `${path} must charge the daily cap`);
  }
});

test("PRESERVED: /v1/firms/{crd} discloses no person and is still charged", () => {
  const firms = ROUTES.find((route) => route.path === "/v1/firms/{crd}");
  assert.equal(firms.discloses, DISCLOSES.FIRM);
  assert.equal(chargesDailyCap(firms), true, "a small sequential CRD is enumerable whether or not it names a person");
});

test("PRESERVED: /health and /v1/stats stay open, unlimited and free", () => {
  for (const name of ["health", "stats"]) {
    const route = ROUTES.find((r) => r.name === name);
    assert.equal(route.discloses, DISCLOSES.NONE);
    assert.equal(route.requiresAuth, false, `${route.path} must stay in front of the auth gate`);
    assert.equal(route.rateLimited, false);
    assert.equal(chargesDailyCap(route), false, "an uptime probe must not spend a caller's disclosure quota");
  }
});

test("every disclosing route sits behind the auth gate and the per-minute bucket", () => {
  for (const route of ROUTES.filter(chargesDailyCap)) {
    assert.equal(route.requiresAuth, true, `${route.path} must be behind the bearer gate`);
    assert.equal(route.rateLimited, true, `${route.path} must be behind the token bucket`);
  }
});

// ---------------------------------------------------------------------------
// the dispatcher — the charge is structural, not a convention
// ---------------------------------------------------------------------------

test("H1: dispatch CHARGES BEFORE it discloses, for every disclosing route", async () => {
  for (const route of ROUTES.filter(chargesDailyCap)) {
    const { events, handlers, charge } = spy();
    await dispatch({ route, handlers, charge, onCapExceeded: () => {} });
    assert.deepEqual(
      events,
      [`charge:${route.name}`, `handler:${route.name}`],
      `${route.path} must charge the cap before its handler runs`,
    );
  }
});

test("H1: a route the cap refuses never reaches its handler", async () => {
  for (const route of ROUTES.filter(chargesDailyCap)) {
    const { events, handlers } = spy();
    let refused = null;
    const outcome = await dispatch({
      route,
      handlers,
      charge: () => ({ ok: false, limit: 2000, used: 2000, retryAfterSec: 60 }),
      onCapExceeded: (day) => {
        refused = day;
      },
    });
    assert.deepEqual(events, [], `${route.path} disclosed after the cap refused it`);
    assert.equal(outcome.capExceeded, true);
    assert.equal(outcome.ran, false);
    assert.equal(refused.ok, false);
  }
});

test("H1: a disclosing route with no cap wired to it refuses to serve at all", async () => {
  const route = ROUTES.find((r) => r.discloses === DISCLOSES.PERSON);
  const { events, handlers } = spy();
  await assert.rejects(() => dispatch({ route, handlers }), /no charge function/);
  assert.deepEqual(events, [], "nothing was disclosed");
});

test("the free routes run without a cap being charged at all", async () => {
  for (const route of ROUTES.filter((r) => !chargesDailyCap(r))) {
    const { events, handlers } = spy();
    // No `charge` at all: an open route must not need one.
    const outcome = await dispatch({ route, handlers });
    assert.deepEqual(events, [`handler:${route.name}`]);
    assert.equal(outcome.charged, false);
  }
});

test("a validator runs BEFORE the cap, so a caller's typo costs them no quota", async () => {
  const route = ROUTES.find((r) => r.name === "claim.lookup");
  const { events, handlers, charge } = spy();
  const bad = new Error("phone is required");
  bad.field = "phone";

  await assert.rejects(
    () =>
      dispatch({
        route,
        handlers,
        charge,
        validators: {
          "claim.lookup": () => {
            events.push("validate");
            throw bad;
          },
        },
      }),
    /phone is required/,
  );
  assert.deepEqual(events, ["validate"], "a rejected request must charge nothing and disclose nothing");
});

test("the validated query reaches the handler, so it is parsed exactly once", async () => {
  const route = ROUTES.find((r) => r.name === "claim.search");
  const seen = [];
  await dispatch({
    route,
    handlers: { [route.name]: (_context, _params, validated) => seen.push(validated) },
    validators: { [route.name]: () => ({ name: "smith", limit: 10 }) },
    charge: () => ({ ok: true, limit: 2000, remaining: 1999 }),
  });
  assert.deepEqual(seen, [{ name: "smith", limit: 10 }]);
});

test("assertHandlersComplete names every route left without a handler", () => {
  assert.throws(() => assertHandlersComplete({}), /claim\.lookup/);
  const { handlers } = spy();
  assert.equal(assertHandlersComplete(handlers), true);
});

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

test("matchRoute pulls the CRD out of the path and refuses everything else", () => {
  assert.deepEqual(matchRoute("GET", "/v1/advisors/2249019").params, { crd: 2249019 });
  assert.deepEqual(matchRoute("GET", "/v1/firms/2907").params, { crd: 2907 });
  assert.equal(matchRoute("GET", "/v1/advisors/2249019/disclosures"), null);
  assert.equal(matchRoute("GET", "/v1/advisors/abc"), null);
  assert.equal(matchRoute("POST", "/v1/claim/lookup"), null, "a wrong method is a 404, not a disclosure");
  assert.equal(matchRoute("GET", "/v1/claim/lookup").route.name, "claim.lookup");
  assert.equal(matchRoute("GET", "/nope"), null);
});

// ---------------------------------------------------------------------------
// the guard against the NEXT uncharged route
// ---------------------------------------------------------------------------

test("H1: server.mjs declares every route it serves in the table", async () => {
  const source = await fs.readFile(SERVER_PATH, "utf8");
  // Comments describe routes constantly (that is a good thing); only CODE can serve one.
  // Line comments go FIRST: this file documents "/v1/*", and "/v1/*" contains "/*", so
  // stripping block comments first would treat the rest of the file as one giant comment and
  // make this test pass by seeing nothing at all.
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const declared = new Set(ROUTES.map((route) => route.path));
  const found = new Set();
  for (const match of code.matchAll(/["'`](\/v1\/[A-Za-z0-9_\-/{}]+)["'`]/g)) {
    // /v1/firms/79 in a code sample is the same route as /v1/firms/{crd}.
    found.add(match[1].replace(/\/\d+$/, "/{crd}"));
  }

  const undeclared = [...found].filter((path) => !declared.has(path));
  assert.deepEqual(
    undeclared,
    [],
    `server.mjs handles ${undeclared.join(", ")} outside routes.mjs, so it bypasses the daily-cap choke point`,
  );

  // And the handlers really are reached through the dispatcher, not around it.
  assert.match(code, /dispatch\(\{/, "server.mjs must run handlers through routes.mjs dispatch()");
  assert.equal(
    /chargeDailyCap\(/.test(code.replace(/function chargeDailyCap\([^)]*\)/, "")),
    true,
    "the cap is still charged somewhere",
  );
});
