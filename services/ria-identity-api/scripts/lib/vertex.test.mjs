// Tests for the JUDGEMENT-ONLY Vertex helper.
//
// NO NETWORK. Every test injects a fake `fetchImpl` and an explicit `token`, so the suite
// runs identically on a laptop with no ADC, in CI with no egress, and in a container with
// no gcloud binary. A test that needed credentials would be a test that silently stops
// running the day someone rotates a key.
//
// The tests are written as the ABUSE, not the happy path, because the thing this module
// exists to prevent is a language model becoming the source of a fact. Most of what follows
// is a model answering CONFIDENTLY AND WRONGLY, and the assertion is that nothing escapes.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXPLAIN_NOTICE,
  chooseFirmMatch,
  explain,
  getAccessToken,
  isConfigured,
  matchPersonName,
  parseModelJson,
  redactUnsourcedNumbers,
  resetCredentialCache,
  stripHonorifics,
} from "./vertex.mjs";

// ---------------------------------------------------------------------------
// fixtures — the real records, as the caller would have fetched them from SEC
// ---------------------------------------------------------------------------

/** The live SEC roster for ROBINSWOOD FINANCIAL LLC, firm CRD 143417, Kirkland WA — the
 *  names EXACTLY as api.adviserinfo.sec.gov returns them, honorific and all.
 *
 *  SEVEN current advisers. A web-grounded LLM asked the same question named TWO of them,
 *  which is why nothing in this service may take a fact from a model. */
const ROBINSWOOD_ROSTER = [
  "ROBERT WARD GUILD", // 2486426
  "EDWARD LEE WARD", // 2848710
  "JANET HARRIS WEISMAN MRS.", // 4661439 — the honorific is REAL and is in the live payload
  "Robert David MacRae", // 6844196
  "Christopher Edward Simon-Wallace", // 6742656
  "Colleen M Bracy", // 6786615
  "Kelsey Ann Curtis", // 6689626
];

/** The two firm candidates from the measured Nestlerode trap. The SEC's own firm search for
 *  "Nestlerode & Loy Investment Advisors" returns ONLY the wrong one — it matched on one of
 *  ~100 registered DBAs — and returns the right one for the query "Nestlerode & Loy". */
const NESTLERODE_RIGHT = {
  crd: 2907,
  name: "NESTLERODE & LOY, INC.",
  otherNames: ["NESTLERODE & LOY INVESTMENT ADVISORS"],
  officeAddress: { street1: "1524 W COLLEGE AVE", city: "STATE COLLEGE", state: "PA", zip: "16801" },
};
const NESTLERODE_DECOY = {
  crd: 144426,
  name: "INTERNATIONAL ASSETS INVESTMENT MANAGEMENT, LLC",
  otherNames: [
    "NESTLERODE & LOY INVESTMENT ADVISORS",
    "AMERIFLEX GROUP",
    "ARCHER INVESTMENT MANAGEMENT",
    "BEACON POINTE",
    "CARDINAL WEALTH",
    "DELTA ADVISORY",
  ],
  officeAddress: { street1: "390 N ORANGE AVE", city: "ORLANDO", state: "FL", zip: "32801" },
};

const NESTLERODE_ADDRESS = { street1: "1524 W College Ave", city: "State College", state: "PA", zip: "16801" };

const CONFIG = {
  vertex: {
    enabled: true,
    enabledMode: "on",
    project: "hushh-tech-prod",
    projectConfigured: true,
    location: "global",
    model: "gemini-2.5-flash",
    timeoutMs: 6000,
    tokenTtlMs: 2_700_000,
    metadataTimeoutMs: 50,
  },
  iapd: { userAgent: "hushh-ria-identity-api/0.1 (+https://hushh.ai; contact ankit@hushh.ai)" },
};

/** A fake Vertex that always answers with the given object, and records what it was asked. */
function fakeVertex(answer, { status = 200, raw = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (status !== 200) return { ok: false, status, text: async () => "" };
    const text = raw ?? JSON.stringify(answer);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    };
  };
  return { fetchImpl, calls };
}

const deps = (fetchImpl) => ({ config: CONFIG, fetchImpl, token: "fake-token" });

/** The text of the single prompt the module sent. */
const promptOf = (calls) => calls[0].body.contents[0].parts[0].text;

// ---------------------------------------------------------------------------
// THE RULE: no exported function may return a fact the model authored
// ---------------------------------------------------------------------------

test("RULE: chooseFirmMatch returns an INDEX, never a firm name or CRD", async () => {
  const { fetchImpl } = fakeVertex({ index: 0, confidence: 0.95, reasoning: "Same firm." });
  const result = await chooseFirmMatch(
    {
      businessName: "Nestlerode & Loy Investment Advisors",
      businessAddress: NESTLERODE_ADDRESS,
      candidates: [NESTLERODE_RIGHT, NESTLERODE_DECOY],
    },
    deps(fetchImpl),
  );
  assert.equal(result.index, 0);
  // Everything a caller could publish has to come out of ITS OWN array, not out of us.
  assert.deepEqual(Object.keys(result).sort(), ["authoritative", "confidence", "index", "reasoning"]);
  assert.equal(result.authoritative, false);
  assert.equal(result.name, undefined);
  assert.equal(result.crd, undefined);
  assert.equal(result.firm, undefined);
});

test("RULE: a model that invents a firm not in the list gets nothing through", async () => {
  // The failure mode this module exists for: a fluent, confident answer about a firm that
  // was never in the caller's SEC result set.
  const { fetchImpl } = fakeVertex({
    index: 7,
    confidence: 0.99,
    reasoning: "The firm is NESTLERODE & LOY FINANCIAL GROUP, CRD 8675309.",
  });
  const result = await chooseFirmMatch(
    {
      businessName: "Nestlerode & Loy Investment Advisors",
      businessAddress: NESTLERODE_ADDRESS,
      candidates: [NESTLERODE_RIGHT],
    },
    deps(fetchImpl),
  );
  assert.equal(result, null, "an out-of-range index is a failure, not a discovery");
});

test("RULE: an invented CRD cannot ride out inside `reasoning`", async () => {
  const { fetchImpl } = fakeVertex({
    index: 0,
    confidence: 0.9,
    // 2907 IS in the input (we showed it). 8675309 is not — it is invented.
    reasoning: "CRD 2907 matches, superseding CRD 8675309 from 1998.",
  });
  const result = await chooseFirmMatch(
    {
      businessName: "Nestlerode & Loy Investment Advisors",
      businessAddress: NESTLERODE_ADDRESS,
      candidates: [NESTLERODE_RIGHT],
    },
    deps(fetchImpl),
  );
  assert.match(result.reasoning, /CRD 2907/, "a number we supplied is echoed untouched");
  assert.doesNotMatch(result.reasoning, /8675309/, "a number we never supplied must not survive");
  assert.match(result.reasoning, /\[unverified\]/);
});

test("redactUnsourcedNumbers: keeps sourced runs, strips unsourced ones, ignores short numbers", () => {
  const source = "CRD 2907, CRD 143417, 7 advisers, 90% confidence";
  assert.equal(redactUnsourcedNumbers("CRD 2907 and CRD 143417", source), "CRD 2907 and CRD 143417");
  assert.equal(redactUnsourcedNumbers("CRD 6844196", source), "CRD [unverified]");
  // Under four digits is not an identifier; redacting it would mangle ordinary prose.
  assert.equal(redactUnsourcedNumbers("7 of 100 advisers", source), "7 of 100 advisers");
});

// ---------------------------------------------------------------------------
// chooseFirmMatch — the measured Nestlerode trap
// ---------------------------------------------------------------------------

test("chooseFirmMatch: picks NESTLERODE & LOY, INC. over the string-dissimilar legal name", async () => {
  // The whole reason this beats normalization: "Nestlerode & Loy Investment Advisors" and
  // "NESTLERODE & LOY, INC." are not close under any normaliser that does not also merge
  // firms that must stay separate.
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 0.94, reasoning: "Same firm, same address." });
  const result = await chooseFirmMatch(
    {
      businessName: "Nestlerode & Loy Investment Advisors",
      businessAddress: NESTLERODE_ADDRESS,
      candidates: [NESTLERODE_RIGHT, NESTLERODE_DECOY],
    },
    deps(fetchImpl),
  );
  assert.equal(result.index, 0);
  // The model was shown how many trade names the decoy registers — that count is the signal.
  assert.match(promptOf(calls), /6 registered trade name\(s\)/);
});

test("chooseFirmMatch: REFUSES the DBA decoy even when the model confidently picks it", async () => {
  // CRD 144426 matched the search because one of its ~100 DBAs is literally the query. A
  // model handed that candidate will justify it. The deterministic floor overrules it:
  // no shared legal-name token, and Orlando FL is not State College PA.
  const { fetchImpl } = fakeVertex({
    index: 0,
    confidence: 0.98,
    reasoning: "It registers 'NESTLERODE & LOY INVESTMENT ADVISORS' as a trade name.",
  });
  const result = await chooseFirmMatch(
    {
      businessName: "Nestlerode & Loy Investment Advisors",
      businessAddress: NESTLERODE_ADDRESS,
      candidates: [NESTLERODE_DECOY],
    },
    deps(fetchImpl),
  );
  assert.equal(result, null, "a DBA-only overlap in another state is not evidence");
});

test("chooseFirmMatch: shared industry words alone are never evidence", async () => {
  const { fetchImpl } = fakeVertex({ index: 0, confidence: 0.99, reasoning: "Both are investment advisors." });
  const result = await chooseFirmMatch(
    {
      businessName: "Robinswood Financial LLC",
      businessAddress: { city: "Kirkland", state: "WA" },
      candidates: [
        {
          crd: 111111,
          name: "SUMMIT FINANCIAL ADVISORS LLC",
          officeAddress: { city: "AUSTIN", state: "TX" },
        },
      ],
    },
    deps(fetchImpl),
  );
  assert.equal(result, null);
});

test("chooseFirmMatch: an out-of-state firm still matches on its legal name", async () => {
  // A branch office is real: the address arm may fail while the name arm carries it.
  const { fetchImpl } = fakeVertex({ index: 0, confidence: 0.88, reasoning: "Same firm, branch office." });
  const result = await chooseFirmMatch(
    {
      businessName: "Robinswood Financial",
      businessAddress: { city: "Boise", state: "ID" },
      candidates: [{ crd: 143417, name: "ROBINSWOOD FINANCIAL LLC", officeAddress: { city: "KIRKLAND", state: "WA" } }],
    },
    deps(fetchImpl),
  );
  assert.equal(result.index, 0);
});

test("chooseFirmMatch: a trading name with no legal-name overlap passes on ADDRESS, not on the DBA", async () => {
  const { fetchImpl } = fakeVertex({ index: 0, confidence: 0.85, reasoning: "Trading name of the same firm." });
  const result = await chooseFirmMatch(
    {
      businessName: "Cascade Peak Advisory",
      businessAddress: { street1: "40 Lake Bellevue Dr", city: "Kirkland", state: "WA" },
      candidates: [
        {
          crd: 222222,
          name: "HALVERSON & PRICE INC",
          otherNames: ["CASCADE PEAK ADVISORY"],
          officeAddress: { city: "KIRKLAND", state: "WA" },
        },
      ],
    },
    deps(fetchImpl),
  );
  assert.equal(result.index, 0);
});

test("chooseFirmMatch: below the confidence floor is null even with good evidence", async () => {
  const { fetchImpl } = fakeVertex({ index: 0, confidence: 0.4, reasoning: "Possibly." });
  const result = await chooseFirmMatch(
    { businessName: "Nestlerode & Loy", businessAddress: NESTLERODE_ADDRESS, candidates: [NESTLERODE_RIGHT] },
    deps(fetchImpl),
  );
  assert.equal(result, null);
});

test("chooseFirmMatch: null index, empty candidates and a missing name never call the model", async () => {
  const { fetchImpl, calls } = fakeVertex({ index: null, confidence: 0, reasoning: "None match." });
  assert.equal(
    await chooseFirmMatch({ businessName: "X", businessAddress: null, candidates: [] }, deps(fetchImpl)),
    null,
  );
  assert.equal(
    await chooseFirmMatch({ businessName: "", businessAddress: null, candidates: [NESTLERODE_RIGHT] }, deps(fetchImpl)),
    null,
  );
  assert.equal(calls.length, 0, "nothing to choose between is not a question worth asking");

  // A model that declines is respected.
  assert.equal(
    await chooseFirmMatch(
      { businessName: "Nestlerode & Loy", businessAddress: NESTLERODE_ADDRESS, candidates: [NESTLERODE_RIGHT] },
      deps(fetchImpl),
    ),
    null,
  );
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// matchPersonName — the deterministic path
// ---------------------------------------------------------------------------

test("matchPersonName: the real Robinswood roster resolves 'Bob MacRae' with NO model call", async () => {
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 1, reasoning: "should not be reached" });
  const result = await matchPersonName(
    { claimedName: "Bob MacRae", rosterNames: ROBINSWOOD_ROSTER },
    deps(fetchImpl),
  );
  assert.equal(result.index, 3);
  assert.equal(result.method, "namesMatch");
  assert.equal(result.confidence, 1);
  assert.equal(calls.length, 0, "the hand-written table already knew; spending a model call would be waste");
});

test("matchPersonName: 'Chris Simon Wallace' and 'Kelsey Curtis' are deterministic too", async () => {
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 1, reasoning: "" });
  const wallace = await matchPersonName(
    { claimedName: "Chris Simon Wallace", rosterNames: ROBINSWOOD_ROSTER },
    deps(fetchImpl),
  );
  assert.equal(wallace.index, 4);
  assert.equal(wallace.method, "namesMatch");

  const curtis = await matchPersonName(
    { claimedName: "Kelsey Curtis", rosterNames: ROBINSWOOD_ROSTER },
    deps(fetchImpl),
  );
  assert.equal(curtis.index, 6);
  assert.equal(curtis.method, "namesMatch");
  assert.equal(calls.length, 0);
});

test("matchPersonName: a name that is NOT on the roster returns null and spends no call", async () => {
  const { fetchImpl, calls } = fakeVertex({ index: 2, confidence: 0.99, reasoning: "Close enough." });
  const result = await matchPersonName(
    { claimedName: "Michael Thompson", rosterNames: ROBINSWOOD_ROSTER },
    deps(fetchImpl),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0, "nothing on the roster is orthographically plausible, so there is nothing to ask");
});

// ---------------------------------------------------------------------------
// matchPersonName — the regressions this must not reintroduce
// ---------------------------------------------------------------------------

test("REGRESSION: Jon and Jack are both Johns and are NOT each other, whatever the model says", async () => {
  // resolve.mjs's namesMatch refuses this pair. Nine such pairs once shipped as matches and
  // the failure was not a missed match — it named the WRONG adviser as a majority owner.
  const { fetchImpl, calls } = fakeVertex({
    index: 0,
    confidence: 0.97,
    reasoning: "Jon and Jack are both short for John.",
  });
  const result = await matchPersonName({ claimedName: "Jon Smith", rosterNames: ["Jack Smith"] }, deps(fetchImpl));
  assert.equal(result, null);
  assert.equal(calls.length, 0, "the guard refuses the pairing before the model is even consulted");
});

test("REGRESSION: the other eight nickname pairs stay refused", async () => {
  const { fetchImpl } = fakeVertex({ index: 0, confidence: 0.99, reasoning: "Same formal name." });
  const pairs = [
    ["Ted Brown", "Ed Brown"],
    ["Bob Brown", "Rob Brown"],
    ["Bill Brown", "Will Brown"],
    ["Beth Brown", "Betty Brown"],
    ["Kate Brown", "Kathy Brown"],
    ["Dick Brown", "Rich Brown"],
    ["Jim Brown", "Jamie Brown"],
    ["Sue Brown", "Suzy Brown"],
  ];
  for (const [claimed, roster] of pairs) {
    const result = await matchPersonName({ claimedName: claimed, rosterNames: [roster] }, deps(fetchImpl));
    assert.equal(result, null, `${claimed} must not be matched to ${roster}`);
  }
});

test("REGRESSION: a suffix on one side only stays a different person", async () => {
  // Father and son at the family firm is a real configuration in this data.
  const { fetchImpl } = fakeVertex({ index: 0, confidence: 0.95, reasoning: "Same name." });
  assert.equal(
    await matchPersonName({ claimedName: "John Smith", rosterNames: ["John Smith Jr"] }, deps(fetchImpl)),
    null,
  );
});

test("REGRESSION: contradicting middle initials stay a different person", async () => {
  const { fetchImpl } = fakeVertex({ index: 0, confidence: 0.96, reasoning: "Initial is a typo." });
  assert.equal(
    await matchPersonName({ claimedName: "John A Smith", rosterNames: ["John B Smith"] }, deps(fetchImpl)),
    null,
  );
});

// ---------------------------------------------------------------------------
// matchPersonName — the model can only confirm or veto ONE candidate
// ---------------------------------------------------------------------------

test("matchPersonName: the model adjudicates a nickname the table does not carry", async () => {
  // JAN -> JANET is not in resolve.mjs's table, so namesMatch declines. JAN is a prefix of
  // JANET, and exactly one Weisman is on the roster, so the model gets exactly one candidate
  // to confirm or veto.
  const { fetchImpl, calls } = fakeVertex({ index: 2, confidence: 0.92, reasoning: "Jan is short for Janet." });
  const result = await matchPersonName(
    { claimedName: "Jan Weisman", rosterNames: ROBINSWOOD_ROSTER },
    deps(fetchImpl),
  );
  assert.equal(result.index, 2);
  assert.equal(result.method, "vertex");
  assert.equal(calls.length, 1);
  // It was shown the WHOLE roster, so it can see whether anyone else could be the claimant.
  assert.match(promptOf(calls), /JANET HARRIS WEISMAN/);
  assert.match(promptOf(calls), /Kelsey Ann Curtis/);
});

test("matchPersonName: a model answering a DIFFERENT index than the guard isolated is discarded", async () => {
  // The structural expression of "a model may rank, never source". The guard isolated the
  // one Weisman; the model names a MacRae. That is not a discovery, it is a failure.
  const { fetchImpl } = fakeVertex({ index: 3, confidence: 0.99, reasoning: "Actually it is Robert MacRae." });
  const result = await matchPersonName(
    { claimedName: "Jan Weisman", rosterNames: ROBINSWOOD_ROSTER },
    deps(fetchImpl),
  );
  assert.equal(result, null);
});

test("matchPersonName: the model can VETO the one candidate the guard allowed", async () => {
  // JAN/JANET clears the guard, so the question is asked; a model that says no is respected.
  const { fetchImpl, calls } = fakeVertex({ index: null, confidence: 0, reasoning: "Cannot be sure." });
  const result = await matchPersonName(
    { claimedName: "Jan Weisman", rosterNames: ROBINSWOOD_ROSTER },
    deps(fetchImpl),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 1, "the guard allowed the question; the model answered no");
});

// ---------------------------------------------------------------------------
// the two defects the LIVE run found, which unit tests had not
// ---------------------------------------------------------------------------

test("LIVE DEFECT: 'Robertson' is not a short form of 'Robert' — measured, at 0.9 confidence", async () => {
  // Against the real roster, gemini-2.5-flash returned index 3 for "Robertson MacRae" and
  // justified it with "'Robertson' being a known diminutive or alternative form of 'Robert'".
  // It invented that. A truncation is SHORT; ROBERT is a complete formal name at six
  // characters, so the guard now refuses the pairing and never asks.
  const { fetchImpl, calls } = fakeVertex({
    index: 3,
    confidence: 0.9,
    reasoning: "'Robertson' is a known diminutive or alternative form of 'Robert'.",
  });
  const result = await matchPersonName(
    { claimedName: "Robertson MacRae", rosterNames: ROBINSWOOD_ROSTER },
    deps(fetchImpl),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("LIVE DEFECT: ROBERT is not a short form of ROBERTA either — same trap, different sex", async () => {
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 0.95, reasoning: "Same root name." });
  assert.equal(
    await matchPersonName({ claimedName: "Robert Nkemelu", rosterNames: ["Roberta Nkemelu"] }, deps(fetchImpl)),
    null,
  );
  assert.equal(calls.length, 0);
});

test("truncation: a short form still works — JAN/JANET, CHRIS/CHRISTINA", async () => {
  const jan = fakeVertex({ index: 2, confidence: 0.93, reasoning: "Jan is short for Janet." });
  const janResult = await matchPersonName(
    { claimedName: "Jan Weisman", rosterNames: ROBINSWOOD_ROSTER },
    deps(jan.fetchImpl),
  );
  assert.equal(janResult.index, 2);
  assert.equal(jan.calls.length, 1);

  // The roster holding the SHORT form and the claimant giving the formal one is just as
  // common — SEC records whatever the filer typed.
  const chris = fakeVertex({ index: 0, confidence: 0.9, reasoning: "Chris is short for Christina." });
  const chrisResult = await matchPersonName(
    { claimedName: "Christina Okonkwo", rosterNames: ["Chris Okonkwo"] },
    deps(chris.fetchImpl),
  );
  assert.equal(chrisResult.index, 0);
});

test("LIVE DEFECT: 'JANET HARRIS WEISMAN MRS.' — the honorific parsed as her SURNAME", async () => {
  // Live SEC payload for CRD 4661439. splitPositional reads the last token as the surname,
  // so without stripping, her surname is "MRS" and she matches nobody — a real adviser who
  // could not claim her own profile. The deterministic path must reach her.
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 1, reasoning: "unreachable" });
  const result = await matchPersonName(
    { claimedName: "Janet Weisman", rosterNames: ROBINSWOOD_ROSTER },
    deps(fetchImpl),
  );
  assert.equal(result.index, 2);
  assert.equal(result.method, "namesMatch");
  assert.equal(calls.length, 0);

  // And the claimant may write an honorific too.
  const withTitle = await matchPersonName(
    { claimedName: "Mrs. Janet Harris Weisman", rosterNames: ROBINSWOOD_ROSTER },
    deps(fetchImpl),
  );
  assert.equal(withTitle.index, 2);
});

test("stripHonorifics: preserves the comma that means 'Last, First', and never empties a name", () => {
  assert.equal(stripHonorifics("JANET HARRIS WEISMAN MRS."), "JANET HARRIS WEISMAN");
  assert.equal(stripHonorifics("WEISMAN, JANET HARRIS MRS."), "WEISMAN, JANET HARRIS");
  assert.equal(stripHonorifics("Dr. John A Smith Jr"), "John A Smith Jr");
  assert.equal(stripHonorifics("John Smith"), "John Smith");
  // Stripping that would leave less than a comparable name is refused outright.
  assert.equal(stripHonorifics("Mr Ms"), "Mr Ms");
  assert.equal(stripHonorifics(""), "");
});

test("matchPersonName: below the person confidence floor (0.8) is null, even where a firm would pass", async () => {
  const { fetchImpl } = fakeVertex({ index: 2, confidence: 0.7, reasoning: "Probably Janet." });
  assert.equal(
    await matchPersonName({ claimedName: "Jan Weisman", rosterNames: ROBINSWOOD_ROSTER }, deps(fetchImpl)),
    null,
    "0.7 clears the firm floor and must not clear the person floor",
  );
});

test("matchPersonName: TWO deterministic matches is an ambiguity a model must not break", async () => {
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 0.99, reasoning: "The first one." });
  const result = await matchPersonName(
    { claimedName: "Robert Smith", rosterNames: ["Robert Smith", "Bob Smith", "Alice Jones"] },
    deps(fetchImpl),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("matchPersonName: TWO orthographically plausible entries is null without a call", async () => {
  // "Rob" prefixes both ROBERT and ROBERTA. Two people could be the claimant, so nobody is.
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 0.99, reasoning: "The man, obviously." });
  const result = await matchPersonName(
    { claimedName: "Robb Smith", rosterNames: ["Robbie Smith", "Robbina Smith"] },
    deps(fetchImpl),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("matchPersonName: accepts roster entries as objects with a .name, and returns their index", async () => {
  const { fetchImpl } = fakeVertex({ index: 0, confidence: 1, reasoning: "" });
  const roster = ROBINSWOOD_ROSTER.map((name, i) => ({ name, crd: 1000000 + i }));
  const result = await matchPersonName({ claimedName: "Bob MacRae", rosterNames: roster }, deps(fetchImpl));
  assert.equal(result.index, 3);
  assert.equal(result.crd, undefined, "we return the index; the CRD stays the caller's to read");
});

test("matchPersonName: an empty roster or a blank claim is null", async () => {
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 1, reasoning: "" });
  assert.equal(await matchPersonName({ claimedName: "Bob MacRae", rosterNames: [] }, deps(fetchImpl)), null);
  assert.equal(await matchPersonName({ claimedName: "", rosterNames: ROBINSWOOD_ROSTER }, deps(fetchImpl)), null);
  assert.equal(await matchPersonName({}, deps(fetchImpl)), null);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// explain — free text, labelled non-authoritative
// ---------------------------------------------------------------------------

test("explain: returns one sentence and nothing else", async () => {
  const { fetchImpl } = fakeVertex({
    sentence:
      "We found ROBINSWOOD FINANCIAL LLC in Kirkland, WA and 7 advisers registered there. Pick yourself from the list. Then we will text you a code.",
  });
  const sentence = await explain(
    { outcome: "few_candidates", firm: { name: "ROBINSWOOD FINANCIAL LLC", city: "Kirkland", state: "WA" }, candidateCount: 7 },
    deps(fetchImpl),
  );
  assert.equal(sentence, "We found ROBINSWOOD FINANCIAL LLC in Kirkland, WA and 7 advisers registered there.");
  assert.equal(typeof sentence, "string");
});

test("explain: ships a notice callers must render with it, since the string carries no label", () => {
  assert.match(EXPLAIN_NOTICE, /not part of the SEC record/);
  assert.match(EXPLAIN_NOTICE, /machine-generated/);
});

test("explain: an invented CRD in the sentence is redacted", async () => {
  const { fetchImpl } = fakeVertex({ sentence: "We matched you to firm CRD 9998887 in Kirkland." });
  const sentence = await explain(
    { outcome: "single_person", firm: { name: "ROBINSWOOD FINANCIAL LLC", city: "Kirkland", state: "WA" }, candidateCount: 1 },
    deps(fetchImpl),
  );
  assert.equal(sentence, "We matched you to firm CRD [unverified] in Kirkland.");
});

test("explain: a count we DID supply survives verbatim", async () => {
  const { fetchImpl } = fakeVertex({ sentence: "All 1500 advisers is too many to list." });
  const sentence = await explain({ outcome: "large_firm", firm: { name: "BIG CO" }, candidateCount: 1500 }, deps(fetchImpl));
  assert.match(sentence, /1500/);
});

test("explain: no outcome, an empty sentence, or a model failure is null", async () => {
  const a = fakeVertex({ sentence: "x" });
  assert.equal(await explain({ outcome: "" }, deps(a.fetchImpl)), null);
  assert.equal(a.calls.length, 0);

  const b = fakeVertex({ sentence: "   " });
  assert.equal(await explain({ outcome: "single_person" }, deps(b.fetchImpl)), null);

  const c = fakeVertex(null, { status: 500 });
  assert.equal(await explain({ outcome: "single_person" }, deps(c.fetchImpl)), null);
});

// ---------------------------------------------------------------------------
// DEGRADE SILENTLY — Vertex must never be able to break a lookup
// ---------------------------------------------------------------------------

const FIRM_INPUT = {
  businessName: "Nestlerode & Loy Investment Advisors",
  businessAddress: NESTLERODE_ADDRESS,
  candidates: [NESTLERODE_RIGHT],
};

test("degrade: a 500, a 403 and a 429 all return null rather than throwing", async () => {
  for (const status of [500, 403, 429, 404]) {
    const { fetchImpl } = fakeVertex(null, { status });
    assert.equal(await chooseFirmMatch(FIRM_INPUT, deps(fetchImpl)), null, `status ${status}`);
  }
});

test("degrade: a timeout (aborted fetch) returns null", async () => {
  const fetchImpl = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    });
  const config = { ...CONFIG, vertex: { ...CONFIG.vertex, timeoutMs: 20 } };
  const started = Date.now();
  const result = await chooseFirmMatch(FIRM_INPUT, { config, fetchImpl, token: "fake-token" });
  assert.equal(result, null);
  assert.ok(Date.now() - started < 2000, "the abort must actually fire, not hang the lookup");
});

test("degrade: malformed, fenced, empty and no-parts response bodies", async () => {
  // A response with NO parts array is exactly what a thinkingBudget regression produces.
  const noParts = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ candidates: [{ content: {} }] }),
  });
  assert.equal(await chooseFirmMatch(FIRM_INPUT, deps(noParts)), null);

  const notJson = fakeVertex(null, { raw: "I think it is the first one." });
  assert.equal(await chooseFirmMatch(FIRM_INPUT, deps(notJson.fetchImpl)), null);

  const bodyNotJson = async () => ({ ok: true, status: 200, text: async () => "<html>502</html>" });
  assert.equal(await chooseFirmMatch(FIRM_INPUT, deps(bodyNotJson)), null);

  // Fenced JSON is a MEASURED real response shape and must parse.
  const fenced = fakeVertex(null, {
    raw: '```json\n{"index": 0, "confidence": 0.9, "reasoning": "Same firm."}\n```',
  });
  const ok = await chooseFirmMatch(FIRM_INPUT, deps(fenced.fetchImpl));
  assert.equal(ok.index, 0);
});

test("degrade: VERTEX_ENABLED=off short-circuits every function without a call", async () => {
  const config = { ...CONFIG, vertex: { ...CONFIG.vertex, enabled: false } };
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 1, reasoning: "" });
  const d = { config, fetchImpl, token: "fake-token" };
  assert.equal(await chooseFirmMatch(FIRM_INPUT, d), null);
  assert.equal(await explain({ outcome: "single_person" }, d), null);
  assert.equal(await isConfigured(d), false);
  // The deterministic person path still works with Vertex switched off — that is the point.
  const person = await matchPersonName({ claimedName: "Bob MacRae", rosterNames: ROBINSWOOD_ROSTER }, d);
  assert.equal(person.index, 3);
  assert.equal(person.method, "namesMatch");
  assert.equal(calls.length, 0);
});

test("degrade: no project configured means no call and no credentials probe", async () => {
  const config = { ...CONFIG, vertex: { ...CONFIG.vertex, project: "", projectConfigured: false } };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    throw new Error("metadata unreachable");
  };
  resetCredentialCache();
  assert.equal(await chooseFirmMatch(FIRM_INPUT, { config, fetchImpl, token: "fake-token" }), null);
  assert.ok(
    calls.every((url) => url.includes("metadata.google.internal")),
    "the only thing it may try is discovering a project from the metadata server",
  );
});

test("degrade: a missing fetch implementation returns null instead of throwing", async () => {
  assert.equal(await chooseFirmMatch(FIRM_INPUT, { config: CONFIG, fetchImpl: null, token: "t" }), null);
});

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

test("credentials: the metadata server is tried FIRST and its token is used", async () => {
  resetCredentialCache();
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.startsWith("http://metadata.google.internal")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: "metadata-token", expires_in: 3599 }),
      };
    }
    throw new Error("unexpected");
  };
  const token = await getAccessToken({ config: CONFIG, fetchImpl });
  assert.equal(token, "metadata-token");
  assert.equal(seen[0], "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
  resetCredentialCache();
});

test("credentials: the metadata token is cached, not re-fetched per call", async () => {
  resetCredentialCache();
  let hits = 0;
  const fetchImpl = async () => {
    hits += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: "metadata-token", expires_in: 3599 }),
    };
  };
  await getAccessToken({ config: CONFIG, fetchImpl });
  await getAccessToken({ config: CONFIG, fetchImpl });
  await getAccessToken({ config: CONFIG, fetchImpl });
  assert.equal(hits, 1);
  resetCredentialCache();
});

test("credentials: the metadata request carries Metadata-Flavor: Google", async () => {
  resetCredentialCache();
  let headers = null;
  const fetchImpl = async (_url, options) => {
    headers = options.headers;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "t", expires_in: 3599 }) };
  };
  await getAccessToken({ config: CONFIG, fetchImpl });
  assert.equal(headers["Metadata-Flavor"], "Google");
  resetCredentialCache();
});

test("credentials: a 401 refreshes the token exactly once, then gives up", async () => {
  resetCredentialCache();
  let tokenFetches = 0;
  let modelCalls = 0;
  const fetchImpl = async (url) => {
    if (url.startsWith("http://metadata.google.internal")) {
      tokenFetches += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: `t${tokenFetches}`, expires_in: 3599 }),
      };
    }
    modelCalls += 1;
    return { ok: false, status: 401, text: async () => "" };
  };
  const result = await chooseFirmMatch(FIRM_INPUT, { config: CONFIG, fetchImpl });
  assert.equal(result, null);
  assert.equal(modelCalls, 2, "one original attempt plus exactly one retry");
  assert.equal(tokenFetches, 2, "the cache was dropped and a fresh token obtained");
  resetCredentialCache();
});

test("credentials: an injected token bypasses every credential source", async () => {
  resetCredentialCache();
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 0.9, reasoning: "Same firm." });
  await chooseFirmMatch(FIRM_INPUT, deps(fetchImpl));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, "Bearer fake-token");
});

test("isConfigured: async — false with no credentials, true with them", async () => {
  resetCredentialCache();
  const dead = async () => {
    throw new Error("no network");
  };
  // No metadata, no GOOGLE_APPLICATION_CREDENTIALS, and gcloud may or may not exist here —
  // an injected token is what makes this deterministic in both directions.
  assert.equal(await isConfigured({ config: CONFIG, fetchImpl: dead, token: "fake-token" }), true);
  const noProject = { ...CONFIG, vertex: { ...CONFIG.vertex, project: "" } };
  assert.equal(await isConfigured({ config: noProject, fetchImpl: dead, token: "fake-token" }), false);
  resetCredentialCache();
});

// ---------------------------------------------------------------------------
// request shape — the measured, load-bearing details
// ---------------------------------------------------------------------------

test("request: hits the GLOBAL endpoint, because the regional one 404s for every gemini id", async () => {
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 0.9, reasoning: "Same firm." });
  await chooseFirmMatch(FIRM_INPUT, deps(fetchImpl));
  assert.equal(
    calls[0].url,
    "https://aiplatform.googleapis.com/v1/projects/hushh-tech-prod/locations/global/publishers/google/models/gemini-2.5-flash:generateContent",
  );
});

test("request: an explicitly configured REGION uses the regional host", async () => {
  const config = { ...CONFIG, vertex: { ...CONFIG.vertex, location: "us-east5" } };
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 0.9, reasoning: "Same firm." });
  await chooseFirmMatch(FIRM_INPUT, { config, fetchImpl, token: "fake-token" });
  assert.ok(calls[0].url.startsWith("https://us-east5-aiplatform.googleapis.com/v1/projects/hushh-tech-prod/"));
});

test("request: thinkingBudget is 0 and temperature is 0", async () => {
  // MEASURED: without thinkingBudget 0, thinking consumes the whole output budget and the
  // response comes back with no parts at all. This assertion is the regression guard.
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 0.9, reasoning: "Same firm." });
  await chooseFirmMatch(FIRM_INPUT, deps(fetchImpl));
  const generationConfig = calls[0].body.generationConfig;
  assert.equal(generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(generationConfig.temperature, 0);
  assert.equal(generationConfig.responseMimeType, "application/json");
});

test("request: identifies this service in the User-Agent", async () => {
  const { fetchImpl, calls } = fakeVertex({ index: 0, confidence: 0.9, reasoning: "Same firm." });
  await chooseFirmMatch(FIRM_INPUT, deps(fetchImpl));
  assert.match(calls[0].options.headers["user-agent"], /hushh-ria-identity-api/);
});

test("parseModelJson: fences, whitespace, arrays and junk", () => {
  assert.deepEqual(parseModelJson('{"index":1}'), { index: 1 });
  assert.deepEqual(parseModelJson('```json\n{"index":1}\n```'), { index: 1 });
  assert.deepEqual(parseModelJson('```\n{"index":1}\n```'), { index: 1 });
  assert.deepEqual(parseModelJson('  {"index":1}  '), { index: 1 });
  assert.equal(parseModelJson("[1,2,3]"), null);
  assert.equal(parseModelJson("not json"), null);
  assert.equal(parseModelJson(""), null);
  assert.equal(parseModelJson(null), null);
});

test("index coercion: a stringified or float index is handled; anything else is refused", async () => {
  const asString = fakeVertex({ index: "0", confidence: 0.9, reasoning: "Same firm." });
  assert.equal((await chooseFirmMatch(FIRM_INPUT, deps(asString.fetchImpl))).index, 0);

  for (const bad of [0.5, "first", true, {}, [], -1, Infinity, NaN]) {
    const { fetchImpl } = fakeVertex({ index: bad, confidence: 0.9, reasoning: "Same firm." });
    assert.equal(await chooseFirmMatch(FIRM_INPUT, deps(fetchImpl)), null, `index ${JSON.stringify(bad)}`);
  }
});

test("confidence coercion: junk confidence is 0, which fails every floor", async () => {
  for (const bad of ["high", null, undefined, NaN, {}]) {
    const { fetchImpl } = fakeVertex({ index: 0, confidence: bad, reasoning: "Same firm." });
    assert.equal(await chooseFirmMatch(FIRM_INPUT, deps(fetchImpl)), null, `confidence ${String(bad)}`);
  }
  // Over 1 is clamped, not rejected — an over-eager model is still allowed to be right.
  const { fetchImpl } = fakeVertex({ index: 0, confidence: 42, reasoning: "Same firm." });
  assert.equal((await chooseFirmMatch(FIRM_INPUT, deps(fetchImpl))).confidence, 1);
});

test("reasoning is capped at one sentence and never unbounded", async () => {
  const { fetchImpl } = fakeVertex({
    index: 0,
    confidence: 0.9,
    reasoning: `${"Same firm. ".repeat(200)}`,
  });
  const result = await chooseFirmMatch(FIRM_INPUT, deps(fetchImpl));
  assert.equal(result.reasoning, "Same firm.");

  const long = fakeVertex({ index: 0, confidence: 0.9, reasoning: "a".repeat(5000) });
  const capped = await chooseFirmMatch(FIRM_INPUT, deps(long.fetchImpl));
  assert.ok(capped.reasoning.length <= 300);
});
