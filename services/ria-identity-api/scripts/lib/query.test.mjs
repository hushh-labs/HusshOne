import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery, parseSearchQuery, parseEvaluateQuery, parseEvaluateBody, QueryError, MODES } from "./query.mjs";

const q = (s) => new URLSearchParams(s);

/** Returns the .field of the QueryError a call throws, so a test asserts WHICH input was
 *  rejected — the front-end highlights a form field with it, so it is part of the contract,
 *  not decoration. Returns null if the call did not throw. */
function rejectedField(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof QueryError, `expected QueryError, got ${error?.name}: ${error?.message}`);
    return error.field;
  }
  return null;
}

// ---------------------------------------------------------------------------
// parseQuery — /v1/claim/lookup
// ---------------------------------------------------------------------------

test("a bare phone parses and applies every default", () => {
  const parsed = parseQuery(q("phone=9142251000"));
  assert.deepEqual(parsed, { phone: "9142251000", detail: false, stream: "ndjson", limit: 10, mode: "auto" });
});

test("phone is passed through verbatim — normalisation is resolve.mjs's job", () => {
  for (const raw of ["(914) 225-1000", "914-225-1000", "+1 914 225 1000", "1-914-225-1000", "914-225-1000 x123"]) {
    assert.equal(parseQuery(q(`phone=${encodeURIComponent(raw)}`)).phone, raw);
  }
});

test("a phone that cannot possibly be a number is still a 200-shaped request", () => {
  // Deliberate: "banana" reaches resolve.mjs and comes back as outcome:"invalid_phone"
  // with a guidance string, rather than a bare 400 the UI has to reinterpret.
  assert.equal(parseQuery(q("phone=banana")).phone, "banana");
});

test("phone is trimmed, and whitespace-only counts as missing", () => {
  assert.equal(parseQuery(q("phone=%20%20914-225-1000%20")).phone, "914-225-1000");
  assert.equal(rejectedField(() => parseQuery(q("phone=%20%20%20"))), "phone");
});

test("a missing or empty phone is rejected and names the field", () => {
  assert.equal(rejectedField(() => parseQuery(q(""))), "phone");
  assert.equal(rejectedField(() => parseQuery(q("phone="))), "phone");
  assert.equal(rejectedField(() => parseQuery(q("detail=true&limit=5"))), "phone");
});

test("an over-long phone is refused instead of handed to the normaliser", () => {
  assert.equal(rejectedField(() => parseQuery(q(`phone=${"9".repeat(65)}`))), "phone");
  assert.equal(parseQuery(q(`phone=${"9".repeat(64)}`)).phone.length, 64);
});

test("detail defaults to false and accepts both spellings of both answers", () => {
  assert.equal(parseQuery(q("phone=9142251000")).detail, false);
  for (const on of ["true", "1", "yes", "on", "TRUE", "On"]) {
    assert.equal(parseQuery(q(`phone=9142251000&detail=${on}`)).detail, true, on);
  }
  for (const off of ["false", "0", "no", "off", "FALSE"]) {
    assert.equal(parseQuery(q(`phone=9142251000&detail=${off}`)).detail, false, off);
  }
});

test("a misspelled detail is rejected, not silently read as false", () => {
  assert.equal(rejectedField(() => parseQuery(q("phone=9142251000&detail=treu"))), "detail");
  assert.equal(rejectedField(() => parseQuery(q("phone=9142251000&detail=maybe"))), "detail");
});

test("stream validates against the three wire formats", () => {
  for (const mode of ["ndjson", "sse", "off"]) {
    assert.equal(parseQuery(q(`phone=9142251000&stream=${mode}`)).stream, mode);
  }
  assert.equal(parseQuery(q("phone=9142251000&stream=SSE")).stream, "sse");
  assert.equal(rejectedField(() => parseQuery(q("phone=9142251000&stream=websocket"))), "stream");
  assert.equal(rejectedField(() => parseQuery(q("phone=9142251000&stream=json"))), "stream");
});

test("limit clamps into 1..50 rather than failing the request", () => {
  assert.equal(parseQuery(q("phone=9142251000&limit=999")).limit, 50);
  assert.equal(parseQuery(q("phone=9142251000&limit=0")).limit, 1);
  assert.equal(parseQuery(q("phone=9142251000&limit=-5")).limit, 1);
  assert.equal(parseQuery(q("phone=9142251000&limit=7")).limit, 7);
  assert.equal(parseQuery(q("phone=9142251000&limit=7.6")).limit, 8);
  assert.equal(parseQuery(q("phone=9142251000&limit=")).limit, 10);
});

test("a non-numeric limit is rejected — it means the caller believes something untrue", () => {
  assert.equal(rejectedField(() => parseQuery(q("phone=9142251000&limit=all"))), "limit");
  assert.equal(rejectedField(() => parseQuery(q("phone=9142251000&limit=ten"))), "limit");
});

// ---------------------------------------------------------------------------
// parseSearchQuery — /v1/claim/search
// ---------------------------------------------------------------------------

test("a name parses and applies defaults", () => {
  assert.deepEqual(parseSearchQuery(q("name=Jane%20Doe")), { name: "Jane Doe", state: null, limit: 10 });
});

test("name is trimmed, and whitespace-only counts as missing", () => {
  assert.equal(parseSearchQuery(q("name=%20Jane%20Doe%20")).name, "Jane Doe");
  assert.equal(rejectedField(() => parseSearchQuery(q("name=%20%20"))), "name");
});

test("a missing or empty name is rejected and names the field", () => {
  assert.equal(rejectedField(() => parseSearchQuery(q(""))), "name");
  assert.equal(rejectedField(() => parseSearchQuery(q("name="))), "name");
  assert.equal(rejectedField(() => parseSearchQuery(q("state=NY"))), "name");
});

test("an over-long name is refused", () => {
  assert.equal(rejectedField(() => parseSearchQuery(q(`name=${"a".repeat(121)}`))), "name");
  assert.equal(parseSearchQuery(q(`name=${"a".repeat(120)}`)).name.length, 120);
});

test("state is optional, upper-cased, and must be exactly two letters", () => {
  assert.equal(parseSearchQuery(q("name=Jane&state=ny")).state, "NY");
  assert.equal(parseSearchQuery(q("name=Jane&state=%20wa%20")).state, "WA");
  assert.equal(parseSearchQuery(q("name=Jane&state=")).state, null);
  for (const bad of ["N", "NYC", "N1", "12", "New%20York"]) {
    assert.equal(rejectedField(() => parseSearchQuery(q(`name=Jane&state=${bad}`))), "state", bad);
  }
});

test("search shares the lookup's limit rules", () => {
  assert.equal(parseSearchQuery(q("name=Jane&limit=999")).limit, 50);
  assert.equal(parseSearchQuery(q("name=Jane&limit=0")).limit, 1);
  assert.equal(rejectedField(() => parseSearchQuery(q("name=Jane&limit=lots"))), "limit");
});

// ---------------------------------------------------------------------------

test("QueryError is a real Error the server can branch on for its 400", () => {
  const error = rejectedFieldError(() => parseQuery(q("")));
  assert.ok(error instanceof Error);
  assert.equal(error.name, "QueryError");
  assert.equal(error.field, "phone");
  assert.match(error.message, /phone is required/);
});

function rejectedFieldError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

// ---------------------------------------------------------------------------
// mode — /v1/claim/lookup
// ---------------------------------------------------------------------------

test("mode accepts exactly the three documented values", () => {
  for (const mode of MODES) {
    assert.equal(parseQuery(q(`phone=9142251000&mode=${mode}`)).mode, mode);
  }
  assert.equal(parseQuery(q("phone=9142251000&mode=FIRM")).mode, "firm", "case-insensitive, like every other enum here");
});

test("AN UNKNOWN mode IS A 400, NOT A SHRUG", () => {
  // This is the whole reason mode is parsed here rather than read in the handler. An unknown
  // QUERY PARAMETER is silently ignored by this service and by every other, so a front-end
  // that shipped `mode=firms` (or `claimType=firm`, or `mode=Firms`) would get a full dual
  // response, see a firmClaim in it, and conclude the parameter worked — while being broken in
  // exactly the case it was added for. A 400 naming the legal values is found in one round trip.
  for (const bad of ["firms", "person", "individuals", "both", "none", "1"]) {
    assert.equal(rejectedField(() => parseQuery(q(`phone=9142251000&mode=${bad}`))), "mode", `mode=${bad} should be rejected`);
  }
});

test("an empty mode falls back to auto rather than failing", () => {
  assert.equal(parseQuery(q("phone=9142251000&mode=")).mode, "auto");
});

// ---------------------------------------------------------------------------
// parseEvaluateQuery — GET /v1/claim/evaluate
// ---------------------------------------------------------------------------

test("the GET form parses a claim type, a firm CRD and bare signal names", () => {
  const parsed = parseEvaluateQuery(q("claimType=individual&firmCrd=143417&individualCrd=6844196&evidence=phone_otp,roster_selection"));
  assert.equal(parsed.claimType, "individual");
  assert.equal(parsed.firmCrd, 143417);
  assert.equal(parsed.individualCrd, 6844196);
  assert.deepEqual(parsed.evidence, [{ type: "phone_otp" }, { type: "roster_selection" }]);
});

test("claimType is required and closed", () => {
  assert.equal(rejectedField(() => parseEvaluateQuery(q("firmCrd=143417"))), "claimType");
  assert.equal(rejectedField(() => parseEvaluateQuery(q("claimType=advisor&firmCrd=143417"))), "claimType");
});

test("firmCrd is required, and must be a CRD rather than anything that coerces to one", () => {
  assert.equal(rejectedField(() => parseEvaluateQuery(q("claimType=firm"))), "firmCrd");
  for (const bad of ["0", "-1", "1.5", "abc", "143417x", " "]) {
    assert.equal(rejectedField(() => parseEvaluateQuery(q(`claimType=firm&firmCrd=${encodeURIComponent(bad)}`))), "firmCrd", `firmCrd=${bad}`);
  }
});

test("EVIDENCE CARRYING PERSONAL DATA IS REFUSED IN A QUERY STRING", () => {
  // A verified email address and a verified legal name belong in a request BODY. In a URL they
  // land in the access log, the Referer header of every asset the next page loads, and the
  // user's own browser history. Refusing them here means nobody can put a claimant's email in a
  // query string by accident — they have to POST, which is also where the richer form lives.
  assert.equal(rejectedField(() => parseEvaluateQuery(q("claimType=individual&firmCrd=1&evidence=domain_email"))), "evidence");
  assert.equal(rejectedField(() => parseEvaluateQuery(q("claimType=individual&firmCrd=1&evidence=oidc_verified_name"))), "evidence");
});

test("an unusable signal name is rejected before it reaches the engine", () => {
  assert.equal(rejectedField(() => parseEvaluateQuery(q("claimType=firm&firmCrd=1&evidence=" + encodeURIComponent("<script>")))), "evidence");
  assert.equal(rejectedField(() => parseEvaluateQuery(q("claimType=firm&firmCrd=1&evidence=" + "x".repeat(50)))), "evidence");
});

test("evidence is optional — 'what would a passcode alone get me?' is a legitimate question", () => {
  const parsed = parseEvaluateQuery(q("claimType=firm&firmCrd=143417"));
  assert.deepEqual(parsed.evidence, []);
  assert.equal(parsed.individualCrd, null);
});

// ---------------------------------------------------------------------------
// parseEvaluateBody — POST /v1/claim/evaluate
// ---------------------------------------------------------------------------

test("the POST form carries evidence objects with their payloads", () => {
  const parsed = parseEvaluateBody({
    claimType: "individual",
    firmCrd: 143417,
    individualCrd: 6844196,
    evidence: [{ type: "phone_otp", phone: "4252961611" }, { type: "domain_email", email: "rmacrae@robinswoodfinancial.com" }],
  });
  assert.equal(parsed.claimType, "individual");
  assert.equal(parsed.evidence.length, 2);
  assert.equal(parsed.evidence[1].email, "rmacrae@robinswoodfinancial.com");
});

test("selectedIndividualCrd is accepted as an alias, so the engine's own field name works", () => {
  assert.equal(parseEvaluateBody({ claimType: "firm", firmCrd: 1, selectedIndividualCrd: 42 }).individualCrd, 42);
});

test("a body that is not an object is a 400 with a field, not a 500 from inside the engine", () => {
  assert.equal(rejectedField(() => parseEvaluateBody(null)), "body");
  assert.equal(rejectedField(() => parseEvaluateBody([{ claimType: "firm" }])), "body");
  assert.equal(rejectedField(() => parseEvaluateBody("claimType=firm")), "body");
});

test("malformed evidence is named by its index", () => {
  assert.equal(rejectedField(() => parseEvaluateBody({ claimType: "firm", firmCrd: 1, evidence: {} })), "evidence");
  assert.equal(rejectedField(() => parseEvaluateBody({ claimType: "firm", firmCrd: 1, evidence: [{ phone: "x" }] })), "evidence");
  assert.equal(rejectedField(() => parseEvaluateBody({ claimType: "firm", firmCrd: 1, evidence: [null] })), "evidence");
  assert.equal(rejectedField(() => parseEvaluateBody({ claimType: "firm", firmCrd: 1, evidence: new Array(33).fill("phone_otp") })), "evidence");
});

test("a float or a zero CRD in a JSON body is rejected the same way it is in a query string", () => {
  assert.equal(rejectedField(() => parseEvaluateBody({ claimType: "firm", firmCrd: 1.5 })), "firmCrd");
  assert.equal(rejectedField(() => parseEvaluateBody({ claimType: "firm", firmCrd: 0 })), "firmCrd");
  assert.equal(rejectedField(() => parseEvaluateBody({ claimType: "firm" })), "firmCrd");
});
