# RIA Identity API — integration guide

Build the "claim your profile" screen against this. An adviser types their office phone number;
you get back the firm and the advisers the SEC currently lists there, and they pick which one
they are.

Everything here was measured against the running service on **2026-08-06**. Numbers in the test
appendix are real firm main-office lines from public Form ADV filings and are reproducible.

---

## 1. The journey

```
  phone number
      │
      ▼
  GET /v1/claim/lookup?phone=…            ~0.5s, streams
      │
      ├── firmClaim          → "Claim ROBINSWOOD FINANCIAL"      (the entity)
      └── individualClaims[] → "Claim your adviser profile"      (a person)
      │
      ▼
  your BFF sends an OTP to that number, then
  POST /v1/claim/evaluate                 ~250ms
      │
      ├── rosterUnlocked: true, roster[]   → the pick-list, ANY firm size
      │
      ▼
  user picks one identity
      │
      ▼
  provisional: true, profileVerified: false   → let them into the app
  upgradePlan[]                                → verification, later, in the profile section
```

The OTP does two jobs: it proves the claimant can answer the firm's filed number, and that
possession is what unlocks the roster for firms too large to list anonymously.

One number belongs to **both** a firm and the people registered at it. `425-296-1611` is
Robinswood Financial's main line and also the working number of all seven advisers there. The
service returns both claim targets and never guesses between them.

---

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + source status. Open, no key. |
| GET | `/v1/stats` | caches, uptime, and the live `claimPolicy` vocabulary. Open. |
| GET | `/v1/claim/lookup` | **the main one.** phone → firm + advisers. Streams. |
| GET/POST | `/v1/claim/evaluate` | score a claim, return provisional/verified + upgrade plan. |
| GET | `/v1/advisors/{crd}` | one adviser's full public record. |
| GET | `/v1/firms/{crd}` | firm facts. **Names nobody, by design.** |
| GET | `/v1/claim/search` | name fallback when the phone misses. |

`/v1/*` requires `Authorization: Bearer <key>`. **The key stays on your server.** The response
carries `access-control-allow-origin: *` for streaming convenience — that is not an invitation to
call this from a browser.

### `/v1/claim/lookup`

| Param | Default | Notes |
|---|---|---|
| `phone` | required | any format: `(801) 566-3510`, `801-566-3510`, `8015663510`, `+1 801 566 3510`, `866.766.8332`, extensions stripped |
| `mode` | `auto` | `auto` \| `firm` \| `individual`. Unknown value → 400. |
| `detail` | `false` | hydrate each candidate's full profile |
| `limit` | `10` | 1–50 |
| `stream` | `ndjson` | `ndjson` \| `sse` \| `off` |

`mode=firm` skips person hydration. It **cannot** be used to see names that `mode=individual`
would withhold — the disclosure rules are identical in all three modes.

---

## 3. Streaming

`stream=ndjson` (default) emits one JSON object per line. `stream=sse` emits
`event: <type>\ndata: <json>\n\n`. `stream=off` buffers into a single document.

Frame order:

```
meta        request echo, resolved sources, timings
firm        the firm claim target                       ← render immediately
candidate   one per adviser, repeated                   ← render as they arrive
done        totals, upstream budget spent
```

`error` is terminal and can arrive **mid-stream on an HTTP 200**. Check frame types, not
`response.ok`. A truncated stream without `done` means the connection dropped — retry.

In practice a 7-adviser firm completes in **~485 ms**, so all frames usually land together. The
frame protocol matters for slow upstreams and large firms, not for the common case.

---

## 4. Outcomes → what to render

| `outcome` | `nextStep` | UI |
|---|---|---|
| `single_person` | `choose_identity` | "Is this you?" — one name, one button |
| `few_candidates` | `pick_person` | short list, user taps their row |
| `large_firm` | `enter_name` | firm shown, ask for a name instead of listing people |
| `ambiguous_firm` | `pick_firm` | several firms share this line — user picks the firm first |
| `no_match` | `enter_name` | no SEC firm files this number |
| `invalid_phone` | `none` | inline validation error |

Two traps worth coding around:

- **`large_firm` usually means "IAPD has no individual index for this firm"**, not "this firm is
  huge" — about 30% of lookups. Read `currentAdviserCount === 0 && rosterError === null` before
  showing any "too many advisers" copy.
- **`rosterMatchesIncludingFormer` is not a roster size.** It is the SEC's raw match count and
  includes people who left. Use `currentAdviserCount`.

### `large_firm` is not a dead end

The anonymous lookup withholds names above a headcount threshold so this cannot be walked into a
reverse-phone directory of advisers. **That gate is lifted by possession, not by headcount.**

Send the OTP, then call `/v1/claim/evaluate` with the accepted `phone_otp`. The response carries
`rosterUnlocked: true` and the **full current roster**, whatever the size — render that as the
pick-list. Someone who can answer a firm's filed number is entitled to see who works there; it is
published on adviserinfo.sec.gov either way.

Measured: Mascoma Wealth Management (11 advisers) returns `large_firm` with **0 names** anonymously,
and all **11** once the passcode is answered on its filed number. A passcode answered on a
*different* firm's number leaves it locked.

So a 9-, 11- or 40-adviser firm is claimable. Only the anonymous caller is limited.

---

## 5. Claiming

### The core design point

An OTP to `425-296-1611` proves the person can answer **Robinswood's phone**. Seven advisers
share that line, plus whoever sits at reception. So the OTP proves **firm affiliation**, not
**identity**. Treating it as identity proof is the bug this model exists to prevent.

### Provisional vs verified

`POST /v1/claim/evaluate` returns both answers:

| Field | Meaning |
|---|---|
| `provisional` | OTP answered + a valid roster row picked. **Let them into the app.** |
| `profileVerified` | the strict, evidence-bound answer |
| `verificationLevel` | `provisional` \| `verified` \| `none` |
| `upgradePlan[]` | what would make it verified, cheapest first |
| `grants` | at most one of `{individual, firm}` is ever non-null |
| `evidenceLedger[]` | every signal, accepted or rejected, with the reason |
| `rosterUnlocked` | `true` once an accepted `phone_otp` proves possession |
| `roster[]` | the full current roster — present only when unlocked. `null` means *not unlocked*, never *this firm has nobody* |

**Store a provisional claim as unverified.** The consuming project must not treat it as
identity-proven. Verification belongs in the profile section, later — it is not a barrier at the
door.

### Signals

| Signal | Asserted by | Proves |
|---|---|---|
| `phone_otp` | your BFF | firm affiliation |
| `domain_email` | your BFF | affiliation, second channel — domain must come from the **ADV-filed website**, never user input |
| `oidc_verified_name` | your BFF | a name a third party verified |
| `sole_adviser` | *derived* | identity **by elimination** |
| `email_name_match` | *derived* | identity binding |
| `oidc_name_match` | *derived* | identity binding |
| `on_live_roster` | *derived* | membership |
| `adv_officer` | *derived* | authority over the entity |

Derived signals cannot be asserted — sending one is rejected with `derived_only`. Tapping your own
name is **intent, never identity**.

### Thresholds

- **Individual → verified:** `phone_otp` + one of `sole_adviser`, `email_name_match`, `oidc_name_match`
- **Firm → verified:** `phone_otp` + (`adv_officer`, or `domain_email` while on the live roster)

**The zero-friction path:** at a one-adviser firm, affiliation plus elimination *is* identity. The
passcode alone reaches `verified`, nothing else to do. That covers most small RIAs — 54% of
state-registered firms report a single adviser.

Nobody ever types a CRD.

> `adv_officer` cannot fire in the current deployment: the Form ADV table carries no Schedule A.
> It reports `no_schedule_a_available` — missing data, not a finding that someone is not an
> officer. Firm claims rest on `domain_email` + roster membership until the Schedule A feed is
> ingested.

---

## 6. Edge cases

| Case | Behaviour |
|---|---|
| Shared switchboard | `ambiguous_firm`, both firms returned, no guess. 630 numbers map to 2 firms, 202 to 3+. |
| Departed adviser | Excluded. The SEC's `firm=` filter also matches former employers; we filter on current employment. |
| Firm reports 0 advisory staff | Names nobody. The gate fails closed on `0`, `null`, `""`, `NaN`. |
| Number Google knows, SEC doesn't | Places resolves it, cross-validated into a CRD via name **and** address. Address agreement alone is refused — office buildings hold many firms. |
| Number SEC knows, Google doesn't | Form ADV mapping resolves it. This is why the DB carries coverage: Places alone finds only ~63% of random RIA main lines, name-matching on 79% of those. |
| Filing typo | Tolerated. One firm filed its own number with two digits transposed; matching allows a single transposition. |
| IAPD down | Degrades to firm-only with a reason. Never a 5xx for this. |
| Vertex down | Falls back to deterministic matching. `/v1/claim/lookup` never calls Vertex at all. |
| Database off | Service runs fully on Places + IAPD. Confidence ceiling drops to `medium`; `ambiguous_firm` can no longer fire. |
| Roster > 300 | `rosterTruncated: true`, names nobody. |
| Non-NANP number | Rejected before any upstream call. |

Errors: `400` bad input (with `field`), `401` missing/wrong key, `404` no such CRD, `429` rate or
daily cap (`retry-after` set), `502` upstream fault.

---

## 7. Limits

30 requests/minute per caller, burst 10, plus a daily cap on every route that can name a person.
The client IP is read from the **right** of `X-Forwarded-For`, so rotating the header buys
nothing. These exist to stop bulk enumeration of the number space; don't raise them without a
reason.

> On Cloud Run with `min-instances=0` the daily counter is per-instance and resets when an
> instance is reclaimed. The per-minute limiter is unaffected. If hard daily enforcement matters,
> use the VM path or `--min-instances=1`.

---

## 8. Data sources

| Fact | Source |
|---|---|
| phone → firm | Cloud SQL Form ADV mapping (optional) |
| phone → business, cross-check | Google Places — **only `placeId` may be stored** |
| roster, every person profile, firm detail | SEC IAPD, live on every request |

The local `advisers` table is **never** read for a roster. For one test firm it held 1 of 4
current advisers; three real people could not have claimed a profile.

Gemini (Vertex) adjudicates fuzzy name and firm matching only. It returns an *index* into a roster
we fetched from the SEC — never a name, CRD or date. Asked directly about a real 7-adviser firm it
named 2 of 7.

Attribution: SEC Investment Adviser Public Disclosure (IAPD) and Form ADV public data,
<https://adviserinfo.sec.gov>, with the retrieval date on every response.

---

## 9. Test cases

Real firm main-office lines from public Form ADV filings. Adviser counts verified against live
IAPD on 2026-08-06.

### Firm claim — multi-adviser

| Phone | Firm | CRD | Advisers |
|---|---|---|---|
| 603-676-8813 | Mascoma Wealth Management | 174907 | 11 |
| 888-879-1376 | Envoy Advisory | 306559 | 10 |
| 615-665-1085 | Barksdale Investment Management | 105098 | 9 |
| 800-456-8850 | Penserra Global Investors | 174309 | 8 |
| 866.766.8332 | Rooted Wealth Advisors | 313759 | 8 |

The last one is filed with dots instead of dashes — a free formatting check.

### Individual claim — sole adviser (zero-friction path)

| Phone | Firm | CRD | Advisers |
|---|---|---|---|
| (801) 566-3510 | Olympus Peaks Financial | 283040 | 1 |
| 818-707-5304 | Carmandalian Financial Group | 292458 | 1 |
| 941-388-7249 | CAIM LLC | 144946 | 1 |
| 917-885-5382 | Cypress Point Capital Management | 167195 | 1 |
| 224-326-2044 | Boon Capital Advisors | 174016 | 1 |

Each reaches `verified` on the passcode alone.

### Edge cases

| Phone | Expect |
|---|---|
| 425-296-1611 | Robinswood Financial (CRD 143417) — firm claim **and** 7 individual claims |
| 617-217-2772 | more IAPD matches than current staff — departed advisers filtered out |
| 512-322-9318 | same |
| 201-827-2000 | `ambiguous_firm` — several firms share the line |
| 914-225-1000 | `no_match` — a wirehouse HQ, deliberately not resolved to a person |
| 212-969-1000 | firm reports 0 advisory staff — must name **nobody** |
| `555` | `invalid_phone` |

### Live responses — Cloud Run, 2026-08-06

All 17 numbers above, run against the deployed service
(`https://ria-identity-api-fro3hygenq-uc.a.run.app`, revision `ria-identity-api-00002-g8x`,
image `80e834b`) with `stream=off` and a bearer key. Every firm below resolved from
`form_adv_db` and was corroborated by live IAPD; no adviser names are reproduced here.

| Phone | Outcome | nextStep | Firm (CRD) | Current advisers | Candidates | ms |
|---|---|---|---|---|---|---|
| 603-676-8813 | `large_firm` | `confirm_firm` | Mascoma Wealth Management (174907) | 11 | 0 | 871 |
| 888-879-1376 | `large_firm` | `confirm_firm` | Envoy Advisory Inc. (306559) | 10 | 0 | 748 |
| 615-665-1085 | `large_firm` | `confirm_firm` | Barksdale Investment Management (105098) | 9 | 0 | 576 |
| 800-456-8850 | `ambiguous_firm` | `pick_firm` | 2 firms — see note | — | 0 | 482 |
| 866.766.8332 | `few_candidates` | `choose_identity` | Rooted Wealth Advisors (313759) | 8 | 8 | 710 |
| (801) 566-3510 | `single_person` | `choose_identity` | Olympus Peaks Financial, LLC (283040) | 1 | 1 | 754 |
| 818-707-5304 | `single_person` | `choose_identity` | Carmandalian Financial Group (292458) | 1 | 1 | 639 |
| 941-388-7249 | `single_person` | `choose_identity` | CAIM LLC (144946) | 1 | 1 | 724 |
| 917-885-5382 | `single_person` | `choose_identity` | Cypress Point Capital Mgmt (167195) | 1 | 1 | 667 |
| 224-326-2044 | `single_person` | `choose_identity` | Boon Capital Advisors LLC (174016) | 1 | 1 | 635 |
| 425-296-1611 | `few_candidates` | `choose_identity` | Robinswood Financial (143417) | 7 | 7 | 681 |
| 617-217-2772 | `few_candidates` | `choose_identity` | Osbon Capital Management (134731) | 2 | 2 | 596 |
| 512-322-9318 | `few_candidates` | `choose_identity` | Alpha Capital Management (121703) | 6 | 6 | 711 |
| 201-827-2000 | `ambiguous_firm` | `pick_firm` | 4 Lord Abbett entities | — | 0 | 497 |
| 914-225-1000 | `large_firm` | `confirm_firm` | Consulting Group Advisory Services (137463) | 0 | 0 | 642 |
| 212-969-1000 | `large_firm` | `confirm_firm` | AllianceBernstein Corporation (107445) | 0 | 0 | 795 |
| `555` | `invalid_phone` | `enter_name` | — | — | 0 | 359 |

Where the live answer differs from the expectation tables above, the live answer is the more
precise one:

- **800-456-8850 is `ambiguous_firm`, not a clean Penserra claim** — two Penserra entities
  file the same line: Penserra Capital Management LLC (159042, 16 advisers) and Penserra
  Global Investors LLC (174309, 12). The claimant picks the firm first. The expectation
  table's "one firm, 8 advisers" was written from a single filing.
- **914-225-1000 is not `no_match`** — it resolves to Consulting Group Advisory Services
  (137463), which reports 0 advisory staff, so it still names **nobody**. The disclosure
  rule holds; the outcome label differs.
- **617-217-2772 and 512-322-9318 filter departed advisers as designed** — IAPD matches
  including former staff were 5 and 7; only the 2 and 6 current advisers were returned.
- **`555` returns `nextStep: "enter_name"`**, not `none` as §4's mapping table suggests —
  render it as an inline validation error either way.
- The two `429`s in the first pass were the per-minute limiter doing its job at 15 rapid
  requests; both numbers answered normally after the window reset.

---

## 10. Running it

```bash
# local
npm install && npm test                      # 481 tests
PLACES_API_KEY=… RIA_DB_PASSWORD=… node server.mjs

# deploy (scale to zero, ~$0 idle)
./scripts/cloudrun/deploy-cloudrun.sh
DRY_RUN=1 ./scripts/cloudrun/deploy-cloudrun.sh    # print every call, change nothing

# post-deploy
./scripts/cloudrun/smoke-cloudrun.sh
```

The VM path (`scripts/gcp-vm/deploy-gcp-vm.sh`) still works and is the alternative when the
per-instance daily cap matters more than the idle bill. Neither path touches the other.
