// THE ROUTE TABLE, and the single choke point every disclosing response goes through.
//
// WHY THIS FILE EXISTS. The daily cap is the anti-bulk-enumeration control (see DailyCap in
// http.mjs): it is what stops this service from being walked into a phone -> named-adviser
// map. It used to be charged by each route FOR ITSELF, with a comment claiming every
// disclosing route shared it. That claim was false in the shipped build:
//
//   /v1/claim/lookup   charged      names people
//   /v1/firms/{crd}    charged      names no people
//   /v1/advisors/{crd} NOT CHARGED  returns a named adviser profile by CRD
//   /v1/claim/search   NOT CHARGED  returns named advisers by name
//
// CRDs are small sequential integers, so an uncapped /v1/advisors/{crd} is a walk of the SEC's
// individual index — exactly the thing the cap exists to prevent — and it was free.
//
// The fix is structural, not a third call to chargeDailyCap(). A route is DECLARED here with
// what it can disclose, and `dispatch()` below is the only thing that runs a handler. It
// charges the cap before the handler for every route that discloses anything. A new route
// added to this table is charged whether or not its author thought about it, and a new route
// NOT added to this table has no way to be served at all — server.mjs matches nothing else.
//
// routes.test.mjs enumerates this table and fails the build if any person-disclosing route is
// uncharged, and scans server.mjs for a route literal that never made it into the table.

/** What a route can put on the wire. `person` is the one the cap exists for. */
export const DISCLOSES = Object.freeze({
  NONE: "none",
  FIRM: "firm",
  PERSON: "person",
});

/**
 * Every route this service serves.
 *
 * `discloses`     none | firm | person — the disclosure class, and what decides the cap.
 * `requiresAuth`  subject to the optional bearer gate. FALSE for /health and /v1/stats, which
 *                 are deliberately open: an uptime probe that needed a secret is one more
 *                 thing to get wrong at 3am, and stats publishes aggregates only.
 * `rateLimited`   subject to the per-minute token bucket. Same two exceptions.
 * `pattern`       for routes with a path parameter; plain `path` equality otherwise.
 */
export const ROUTES = Object.freeze([
  Object.freeze({
    name: "health",
    method: "GET",
    path: "/health",
    discloses: DISCLOSES.NONE,
    requiresAuth: false,
    rateLimited: false,
    summary: "Uptime and per-dependency health. Open, and before the auth gate.",
  }),
  Object.freeze({
    name: "stats",
    method: "GET",
    path: "/v1/stats",
    discloses: DISCLOSES.NONE,
    requiresAuth: false,
    rateLimited: false,
    summary: "Aggregate cache/rate-limit counters. Never per-identity usage.",
  }),
  Object.freeze({
    name: "claim.lookup",
    method: "GET",
    path: "/v1/claim/lookup",
    discloses: DISCLOSES.PERSON,
    requiresAuth: true,
    rateLimited: true,
    summary: "Office phone -> firm -> the advisers who might be the caller.",
  }),
  Object.freeze({
    name: "claim.search",
    method: "GET",
    path: "/v1/claim/search",
    discloses: DISCLOSES.PERSON,
    requiresAuth: true,
    rateLimited: true,
    summary: "Name fallback. Returns named advisers, so it is capped like the phone path.",
  }),
  // /v1/claim/evaluate — the POLICY endpoint. It scores evidence an integrator's backend has
  // already collected and says what is still missing.
  //
  // IT DISCLOSES PEOPLE, and it is easy to miss why: it takes a firm CRD and no name, and it
  // returns no roster. But to answer "does this evidence identify you?" it reads the live
  // roster, and its explanation and evidence ledger quote adviser names out of it —
  // "Robert David MacRae is the only adviser the SEC currently lists at ...". An uncapped
  // version would be a second, quieter walk of the same index /v1/advisors/{crd} was capped
  // for. Two entries because matchRoute keys on the method; both run the same handler.
  Object.freeze({
    name: "claim.evaluate",
    method: "GET",
    path: "/v1/claim/evaluate",
    discloses: DISCLOSES.PERSON,
    requiresAuth: true,
    rateLimited: true,
    summary: "Score claim evidence and name the cheapest remaining step. GET form carries signal names only.",
  }),
  Object.freeze({
    name: "claim.evaluate.post",
    method: "POST",
    path: "/v1/claim/evaluate",
    discloses: DISCLOSES.PERSON,
    requiresAuth: true,
    rateLimited: true,
    summary: "Same, with the evidence payloads (verified email, verified name) in a JSON body instead of a URL.",
  }),
  Object.freeze({
    name: "advisor.detail",
    method: "GET",
    path: "/v1/advisors/{crd}",
    pattern: /^\/v1\/advisors\/(\d+)$/,
    params: Object.freeze(["crd"]),
    discloses: DISCLOSES.PERSON,
    requiresAuth: true,
    rateLimited: true,
    summary: "One named adviser's SEC profile by individual CRD.",
  }),
  Object.freeze({
    name: "firm.detail",
    method: "GET",
    path: "/v1/firms/{crd}",
    pattern: /^\/v1\/firms\/(\d+)$/,
    params: Object.freeze(["crd"]),
    discloses: DISCLOSES.FIRM,
    requiresAuth: true,
    rateLimited: true,
    summary: "Firm-level public record. Never a person name — see buildFirmDetail.",
  }),
]);

/** Routes that put a NAMED PERSON on the wire. The set the daily cap exists for. */
export const PERSON_DISCLOSING_ROUTES = Object.freeze(ROUTES.filter((r) => r.discloses === DISCLOSES.PERSON));

/**
 * Does this route spend a unit of the daily cap?
 *
 * Every route that discloses a firm OR a person does. Naming a person is the reason the cap
 * exists; naming a firm from a small sequential CRD is enumerable in exactly the same way, and
 * /v1/firms/{crd} has been charged since that route was fixed. Only the two open, non-
 * disclosing routes (/health, /v1/stats) are free.
 */
export function chargesDailyCap(route) {
  return route?.discloses === DISCLOSES.PERSON || route?.discloses === DISCLOSES.FIRM;
}

/**
 * Find the route for a method+path.
 *
 * @returns {{route:object, params:object}|null} null means 404 — there is no other table.
 */
export function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    if (route.pattern) {
      const found = String(pathname).match(route.pattern);
      if (!found) continue;
      const params = {};
      (route.params || []).forEach((name, i) => {
        params[name] = Number(found[i + 1]);
      });
      return { route, params };
    }
    if (route.path === pathname) return { route, params: {} };
  }
  return null;
}

/** Every route has a handler, checked once at boot rather than as a 500 on the first request
 *  to whichever route someone forgot. */
export function assertHandlersComplete(handlers = {}) {
  const missing = ROUTES.filter((route) => typeof handlers[route.name] !== "function").map((r) => r.name);
  if (missing.length) {
    throw new Error(`routes.mjs: no handler registered for ${missing.join(", ")}`);
  }
  return true;
}

/**
 * THE CHOKE POINT. The only thing in this service that runs a route handler.
 *
 * VALIDATE, then CHARGE, then DISCLOSE. All three positions in that order were chosen because
 * the other orders were bugs:
 *   - charging before validation made a caller lose quota to their own typo, and (worse) a
 *     missing `phone` came back 429 instead of 400 — a miserable thing to debug against
 *     someone else's API. So a route may register a `validate` that runs first. A validator
 *     may only PARSE AND REJECT; it must never disclose or call upstream, which is what makes
 *     it safe to run before the cap;
 *   - charging after the handler would let the enumeration this cap exists to stop happen for
 *     free.
 * A cap refusal never reaches the handler, so a refused request costs zero upstream calls as
 * well as zero disclosure.
 *
 * @param {object} input
 * @param {object} input.route      from matchRoute
 * @param {object} input.params     from matchRoute
 * @param {object} input.handlers   name -> (context, params, validated) => Promise
 * @param {object} [input.validators] name -> (context, params) => parsed query; may throw
 * @param {object} input.context    passed through to the handler untouched
 * @param {() => object} input.charge         charges one unit; returns DailyCap.take()'s result
 * @param {(day:object) => any} input.onCapExceeded  writes the 429
 * @returns {Promise<{charged:boolean, capExceeded:boolean, ran:boolean}>}
 */
export async function dispatch({ route, params = {}, handlers = {}, validators = {}, context = {}, charge, onCapExceeded }) {
  const mustCharge = chargesDailyCap(route);

  const validate = validators[route.name];
  const validated = typeof validate === "function" ? await validate(context, params) : null;

  if (mustCharge) {
    if (typeof charge !== "function") {
      // Refuse to serve rather than serve uncharged. A disclosing route with no cap wired to
      // it is the exact defect this file was written to make impossible.
      throw new Error(`routes.mjs: route ${route?.name} discloses ${route?.discloses} but no charge function was provided`);
    }
    const day = await charge(route);
    if (!day?.ok) {
      await onCapExceeded?.(day, route);
      return { charged: true, capExceeded: true, ran: false };
    }
  }

  const handler = handlers[route.name];
  if (typeof handler !== "function") {
    throw new Error(`routes.mjs: no handler registered for route ${route.name}`);
  }
  await handler(context, params, validated);
  return { charged: mustCharge, capExceeded: false, ran: true };
}
