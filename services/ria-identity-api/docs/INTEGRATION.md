# RIA Identity API

**`https://ria-identity-api-fro3hygenq-uc.a.run.app`** · Cloud Run us-central1 · revision `00003-rf9`

An adviser types their office phone number. You get back their firm and everyone the SEC currently
lists there, and they tap which one they are.

Everything below was measured against the deployed service on **2026-08-06**. All test numbers are
real firm main-office lines from public Form ADV filings, and reproduce.

---

## Quickstart

```bash
curl -H "Authorization: Bearer $KEY" \
  "$BASE/v1/claim/lookup?phone=941-388-7249&stream=off"
```

```jsonc
{
  "firmClaim":        { "crd": 144946, "name": "CAIM LLC", "claimType": "firm", … },
  "individualClaims": [ { "individualCrd": 1427402, "name": "…", "claimType": "individual" } ],
  "meta": { "outcome": "single_person", "nextStep": "choose_identity", "currentAdviserCount": 1 }
}
```

That's the whole product in one call: **a firm to claim, and the people to claim.**

---

## How it works

```
   phone
     │
     ├─────────────┬──────────────────┐         run concurrently
     ▼             ▼                  ▼
 Cloud SQL     Google Places      (fused)
 Form ADV   →  business → IAPD  →  firm CRD
 phone→CRD     name+address
     │
     ▼
 SEC IAPD  ──►  the roster, live, every request
     │
     ▼
 firmClaim + individualClaims[]
```

Two independent paths resolve the phone to a firm and cross-check each other. Agreement →
`confidence: high`. Only one answered → `medium`. **They disagree → both firms returned, you ask
the user.** Never a silent guess.

The roster and every person profile always come **live from SEC IAPD**. They are never read from a
local table — for one test firm the local table held 1 of 4 current advisers, so three real people
would have been told they aren't registered.

### Why one number gives you two things to claim

`425-296-1611` is Robinswood Financial's main line **and** the working number of all seven advisers
there. There is no way to tell from the number alone whether the caller is the firm or a person, so
the service returns both and lets them say. That's the `firmClaim` / `individualClaims` split.

---

## The three calls

| | |
|---|---|
| `GET /v1/claim/lookup?phone=…` | phone → firm + advisers. **Streams.** |
| `POST /v1/claim/evaluate` | after your OTP: unlock the roster, score the claim |
| `GET /v1/advisors/{crd}` | the full public record for the profile they claimed |

Plus `GET /health` and `GET /v1/stats` (open, no key), `GET /v1/firms/{crd}` (firm facts, names
nobody by design), and `GET /v1/claim/search?name=…` when the phone misses.

`/v1/*` needs `Authorization: Bearer <key>`. **Keep the key on your server.** The
`access-control-allow-origin: *` header is for streaming from your backend, not an invitation to
call this from a browser.

### `/v1/claim/lookup` parameters

| Param | Default | Notes |
|---|---|---|
| `phone` | *required* | any format — `(801) 566-3510`, `8015663510`, `+1 801 566 3510`, `866.766.8332`; extensions stripped |
| `mode` | `auto` | `auto` · `firm` · `individual`. Unknown → `400` |
| `detail` | `false` | hydrate each candidate's full profile |
| `limit` | `10` | 1–50 |
| `stream` | `ndjson` | `ndjson` · `sse` · `off` |

`mode=firm` skips person hydration. It **cannot** reveal names that `mode=individual` withholds —
disclosure rules are identical in all three modes.

---

## Streaming

Default is NDJSON: one JSON object per line.

```js
const res = await fetch(`${BASE}/v1/claim/lookup?phone=${phone}`, {
  headers: { Authorization: `Bearer ${KEY}` },
});

const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buf = "";

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;

  const lines = buf.split("\n");
  buf = lines.pop();                         // keep the partial line

  for (const line of lines) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);

    switch (frame.type) {
      case "meta":      setSources(frame);              break;
      case "firm":      renderFirmCard(frame);          break;  // render immediately
      case "candidate": appendPersonRow(frame);         break;  // as they arrive
      case "done":      finish(frame);                  break;
      case "error":     showError(frame.error);         break;  // terminal, see below
    }
  }
}
```

**Two things that will bite you:**

1. **`error` arrives mid-stream on an HTTP 200.** Headers are already sent when a fault happens, so
   the status can't change. Check frame types, never `response.ok`.
2. **A stream that ends without `done` was truncated** — the connection dropped. Retry.

Use `stream=sse` for `event: <type>\ndata: <json>\n\n`, or `stream=off` to buffer the whole thing
into one document (handy in tests).

**Timing:** a 7-adviser firm completes in **~485 ms** end to end, so in practice every frame lands
at once. The frame protocol earns its keep on slow upstreams and large firms, not the common case.

---

## Outcomes → what to render

Measured `nextStep` values, from the deployed service:

| `outcome` | `nextStep` | Render |
|---|---|---|
| `single_person` | `choose_identity` | "Is this you?" — one name, one button |
| `few_candidates` | `choose_identity` | the pick-list; user taps their row |
| `large_firm` | `confirm_firm` | firm card + count. Names come after the OTP — see below |
| `ambiguous_firm` | `pick_firm` | several firms share this line; pick the firm first |
| `no_match` | `enter_name` | no SEC firm files this number |
| `invalid_phone` | `enter_name` | inline validation error |

Read `meta.outcome` and `meta.nextStep` — not the array lengths.

### `large_firm` is not a dead end

The anonymous lookup withholds names above a headcount threshold, so this endpoint can't be walked
into a reverse-phone directory of advisers. **That gate lifts on possession, not headcount.**

Send your OTP, then call `/v1/claim/evaluate` with the accepted `phone_otp`. You get
`rosterUnlocked: true` and the **full current roster**, whatever the size. Render that as the
pick-list. Someone who can answer a firm's filed number is entitled to see who works there — it's
published on adviserinfo.sec.gov anyway.

Measured on Mascoma Wealth Management (11 advisers):

| Request | Names returned |
|---|---|
| Anonymous lookup | **0** |
| `evaluate` + passcode answered on its filed number | **11** |
| `evaluate` + passcode answered on a *different* firm's number | **0** (stays locked) |

So 9-, 11- and 40-adviser firms are all claimable. Only the anonymous caller is limited.

### Two traps

- **`large_firm` usually means "IAPD has no individual index for this firm"** — not "this firm is
  huge". About 30% of lookups. Check `currentAdviserCount === 0 && rosterError === null` before you
  render any "too many advisers" copy.
- **`rosterMatchesIncludingFormer` is not a roster size.** It's the SEC's raw match count, including
  people who left. Use `currentAdviserCount`.

---

## Claiming

### The design point in one paragraph

An OTP to `425-296-1611` proves the caller can answer **Robinswood's phone**. Seven advisers share
that line, plus whoever sits at reception. So the OTP proves **firm affiliation**, not **identity**.
Treating it as identity proof is exactly the bug this model prevents.

### The call

```bash
curl -X POST "$BASE/v1/claim/evaluate" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
    "claimType": "individual",
    "firmCrd": 174907,
    "individualCrd": 4029224,
    "evidence": [{ "type": "phone_otp", "phone": "603-676-8813" }]
  }'
```

| Response field | Meaning |
|---|---|
| `provisional` | OTP answered + a valid roster row picked → **let them into the app** |
| `profileVerified` | the strict, evidence-bound answer |
| `verificationLevel` | `provisional` · `verified` · `none` |
| `upgradePlan[]` | what would make it verified, cheapest first |
| `rosterUnlocked` | `true` once an accepted `phone_otp` proves possession |
| `roster[]` | full current roster — only when unlocked. **`null` means *not unlocked*, never *this firm has nobody*** |
| `grants` | at most one of `{individual, firm}` is ever non-null |
| `evidenceLedger[]` | every signal, accepted or rejected, with the reason |
| `cheapestNextStep` | the single easiest action left — render this, don't encode policy yourself |

**Store a provisional claim as unverified.** Verification belongs in the profile section later, not
as a barrier at the door.

### Evidence signals

| Signal | Asserted by | Proves |
|---|---|---|
| `phone_otp` | your BFF | firm affiliation |
| `domain_email` | your BFF | affiliation, second channel — the domain must come from the **ADV-filed website**, never user input |
| `oidc_verified_name` | your BFF | a name a third party verified |
| `sole_adviser` | *derived* | identity **by elimination** |
| `email_name_match` | *derived* | identity binding (`rmacrae` ↔ Robert MacRae) |
| `oidc_name_match` | *derived* | identity binding |
| `on_live_roster` | *derived* | membership |
| `adv_officer` | *derived* | authority over the entity — matched on the **individual CRD** the firm's own Schedule A carries, name only as a fallback for a line with no CRD |

Derived signals **cannot be asserted** — sending one is rejected as `derived_only`. Tapping your own
name is **intent, never identity**.

**Evidence must be asserted by your server.** A browser-supplied assertion defeats the whole model.

### Thresholds for `verified`

- **Individual:** `phone_otp` + one of `sole_adviser`, `email_name_match`, `oidc_name_match`
- **Firm:** `phone_otp` + (`adv_officer`, or `domain_email` while on the live roster)

**A firm claim costs one extra SEC round trip, the first time.** `claimType: "firm"` reads that
firm's Form ADV Part 1 PDF to get its Schedule A — measured live: **+0.7–0.9s cold, ~0ms warm**,
cached 30 days and across restarts. `claimType: "individual"` never pays it, and neither does
`/v1/claim/lookup` or `/v1/firms/{crd}` — Schedule A only answers "may this person act for the
entity", which is a question only the firm claim asks.

**The zero-friction path:** at a one-adviser firm, affiliation plus elimination *is* identity. The
passcode alone reaches `verified` — nothing else to do. That covers most small RIAs; 54% of
state-registered firms report a single adviser.

**Nobody ever types a CRD.**

---

## Edge cases

| Case | Behaviour |
|---|---|
| Shared switchboard | `ambiguous_firm`, every firm returned, no guess. 630 numbers map to 2 firms, 202 to 3+ |
| Departed adviser | Excluded. SEC's `firm=` filter also matches former employers; we filter on current employment |
| Firm reports 0 advisory staff | Names nobody. Gate fails closed on `0`, `null`, `""`, `NaN` |
| **Filing typo** | Tolerated. One firm filed its own number with two digits transposed; we try the nine adjacent transpositions on an exact miss and report `matchedVia: "transposition"`. Two firms one transposition away → nobody, not a guess |
| Google knows it, SEC doesn't | Places resolves it, cross-validated into a CRD on name **and** address. Address alone is refused — office buildings hold many firms |
| SEC knows it, Google doesn't | Form ADV mapping resolves it. Places alone finds only ~63% of random RIA main lines, name-matching 79% of those — which is why the DB carries coverage |
| Roster > 300 | `rosterTruncated: true`, names nobody |
| IAPD down | Degrades to firm-only with a reason. Never a 5xx |
| Vertex down | Falls back to deterministic matching. `/v1/claim/lookup` never calls Vertex at all |
| Database off | Runs fully on Places + IAPD. Confidence ceiling drops to `medium`; `ambiguous_firm` can't fire |
| Non-NANP number | Rejected before any upstream call |

### Errors

| Status | Meaning |
|---|---|
| `400` | bad input — the body names the offending `field` |
| `401` | missing or wrong bearer key |
| `404` | no such CRD |
| `429` | rate limit or daily cap — honour `retry-after` |
| `502` | upstream fault (IAPD/Places), not your request |

### Limits

30 requests/minute per caller, burst 10, plus a daily cap on every route that can name a person.
Client IP is read from the **right** of `X-Forwarded-For`, so rotating the header buys nothing.
These stop bulk enumeration of the number space — don't raise them without a reason.

> On Cloud Run with `min-instances=0` the daily counter is per-instance and resets when an instance
> is reclaimed. The per-minute limiter is unaffected. Use the VM path or `--min-instances=1` if hard
> daily enforcement matters.

---

## Test numbers

All verified against live IAPD on 2026-08-06.

### Individual claim — sole adviser, the zero-friction path

| Phone | Firm | CRD |
|---|---|---|
| (801) 566-3510 | Olympus Peaks Financial | 283040 |
| 818-707-5304 | Carmandalian Financial Group | 292458 |
| 941-388-7249 | CAIM LLC | 144946 |
| 917-885-5382 | Cypress Point Capital Management | 167195 |
| 224-326-2044 | Boon Capital Advisors | 174016 |

Each returns `single_person` / `choose_identity` and reaches `verified` on the passcode alone.

### Firm claim — multi-adviser

| Phone | Firm | CRD | Advisers | Anonymous outcome |
|---|---|---|---|---|
| 603-676-8813 | Mascoma Wealth Management | 174907 | 11 | `large_firm` — unlock with OTP |
| 888-879-1376 | Envoy Advisory | 306559 | 10 | `large_firm` — unlock with OTP |
| 615-665-1085 | Barksdale Investment Management | 105098 | 9 | `large_firm` — unlock with OTP |
| 866.766.8332 | Rooted Wealth Advisors | 313759 | 8 | `few_candidates` — 8 names inline |
| 800-456-8850 | *two* Penserra entities | 159042 + 174309 | 16 + 12 | `ambiguous_firm` — pick the firm |

`866.766.8332` is filed with dots — a free formatting check. `800-456-8850` is a genuine
shared-line case: two Penserra entities file the same toll-free number.

### Edge cases

| Phone | Expect |
|---|---|
| 425-296-1611 | Robinswood Financial (143417) — firm claim **and** 7 individual claims. Resolves via `matchedVia: "transposition"`: the firm typo'd its own number on the filing |
| 617-217-2772 | Osbon Capital — 5 IAPD matches, **2** returned (departed filtered) |
| 512-322-9318 | Alpha Capital — 7 matches, **6** returned |
| 201-827-2000 | `ambiguous_firm` — 4 Lord Abbett entities share the line |
| 914-225-1000 | Consulting Group Advisory Services (137463), 0 advisory staff → names **nobody** |
| 212-969-1000 | AllianceBernstein (107445), 0 advisory staff → names **nobody** |
| `555` | `invalid_phone` |

---

## Data sources & attribution

| Fact | Source |
|---|---|
| phone → firm | Cloud SQL Form ADV mapping (optional) |
| phone → business, cross-check | Google Places — **only `placeId` may be stored** |
| roster, person profiles, firm detail | SEC IAPD, live on every request |

Gemini (Vertex) adjudicates fuzzy name and firm matching only. It returns an **index into a roster
we fetched from the SEC** — never a name, CRD or date. Asked directly about a real 7-adviser firm it
named 2 of 7, which is why it can propose but never source a fact.

Attribution: SEC Investment Adviser Public Disclosure (IAPD) and Form ADV public data,
<https://adviserinfo.sec.gov>, with the retrieval date on every response.

---

## Authority: how `adv_officer` works

A **firm** claim reads that one firm's own Form ADV Part 1 PDF from `reports.adviserinfo.sec.gov`,
on demand, and matches the claimant against the Schedule A the firm itself filed — its declared
list of direct owners and executive officers.

**Matched on the CRD, not the name.** Every individual's Schedule A line carries their CRD, so
when the claimant has selected one this is an exact integer comparison. Nothing in the path that
grants authority over a legal entity depends on how a name is spelled. A line carrying *someone
else's* CRD is never name-matched against the claimant — the filing already said who that line is.
Name matching survives only for lines with no CRD (entities, older filings).

Ownership size is **not** a threshold. Schedule A is "direct owners *and executive officers*"; the
ownership code answers how much of the firm someone owns, which is a different question from
whether they may act for it. Gating on it would lock out most CCOs, most non-founder presidents,
and every officer at a firm held through a holding company. The gate that matters is already
there: you must be on the firm's own filing, and your name must be identity-bound by a channel
that binds identity — not tapped.

| Situation | `adv_officer` |
|---|---|
| On Schedule A, identity-bound | accepted → authority |
| On the live roster but not on Schedule A | `not_on_schedule_a` |
| Filing unreachable or unparseable | `no_schedule_a_available` — **missing data, never a finding that someone isn't an officer** |
| Asserted by a caller rather than derived | `derived_only` |

`sources.advScheduleA` on the response tells you which happened.

**Cost.** The PDF is fetched only on a firm claim — never on the anonymous lookup, never on an
individual claim, never in a batch — and is cached 30 days per firm.

| Filing | Cold firm claim | Warm |
|---|---|---|
| ~0.6–1 MB (typical RIA) | ~1.7–2.2 s | ~0.25 s |
| ~5 MB | ~3.0 s | ~0.25 s |
| ~13 MB (a wirehouse) | **~8 s** | ~0.25 s |

Size your client timeout for the worst case, not the typical one. The download has a 20 s ceiling
and is not charged against the per-request upstream budget.

---

## Running it

```bash
npm install && npm test                            # 564 tests
PLACES_API_KEY=… RIA_DB_PASSWORD=… node server.mjs # local

./scripts/cloudrun/deploy-cloudrun.sh              # deploy, scale-to-zero, ~$0 idle
DRY_RUN=1 ./scripts/cloudrun/deploy-cloudrun.sh    # print every call, change nothing
./scripts/cloudrun/smoke-cloudrun.sh               # post-deploy check
```

The VM path (`scripts/gcp-vm/deploy-gcp-vm.sh`) still works and is the alternative when the
per-instance daily cap matters more than the idle bill. Neither path touches the other.

This service is standalone: nothing in `src/` imports it, and it adds no secret, env var or IAM
grant to the `one` app.
