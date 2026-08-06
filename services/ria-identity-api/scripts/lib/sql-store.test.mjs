// sql-store.mjs — the LIVE Form ADV firm table, tested against fixtures taken verbatim from
// the real `ria` database on 2026-08-06 (Cloud SQL hushh-tech-prod:us-central1:
// hushh-directories-db). No network, no database: the store takes an injected `query`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createStore,
  mapFirmRow,
  freshnessFrom,
  notConfiguredFreshness,
  StoreError,
  NOT_CONFIGURED_HEALTH_KEYS,
} from "./sql-store.mjs";

/** Real row, CRD 2907. */
const NESTLERODE = {
  crd: "2907",
  sec_number: "801-112333",
  firm_name: "NESTLERODE & LOY, INC.",
  street1: "110 REGENT COURT, SUITE 202",
  street2: null,
  city: "STATE COLLEGE",
  state: "PA",
  zip: "16801",
  country: "United States",
  phone: "814-238-6249",
  website: "HTTP://WWW.NESTLERODE.COM",
  aum: "199064720.00",
  total_employees: 4,
  num_accounts: "612",
  registration_status: "Registered",
  lat: 40.79,
  lng: -77.86,
  sources: ["firms"],
  first_seen: "2026-07-28T12:52:44.508Z",
  last_seen: "2026-08-06T11:27:05.110Z",
};

/** Real row, CRD 107445 — the firm that reports ZERO advisory employees. */
const ALLIANCEBERNSTEIN = {
  crd: "107445",
  sec_number: "801-56720",
  firm_name: "ALLIANCEBERNSTEIN CORPORATION",
  city: "NEW YORK",
  state: "NY",
  phone: "212-969-1000",
  total_employees: 0,
  registration_status: "Registered",
};

const collect = (rows) => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: typeof rows === "function" ? rows(sql, params) : rows };
  };
  return { calls, query };
};

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

test("mapFirmRow: produces the flat record the resolver publishes", () => {
  const firm = mapFirmRow(NESTLERODE);
  assert.equal(firm.crd, 2907);
  assert.equal(firm.name, "NESTLERODE & LOY, INC.");
  assert.equal(firm.phone10, "8142386249");
  assert.equal(firm.aum, 199064720);
  assert.equal(firm.numAccounts, 612);
  assert.equal(firm.registrationType, "sec");
  assert.equal(firm.recordSource, "form_adv_db");
  assert.equal(firm.lastSeen, "2026-08-06T11:27:05.110Z");
});

test("mapFirmRow: scheduleAPersons is ABSENT, not empty — this source cannot say", () => {
  const firm = mapFirmRow(NESTLERODE);
  assert.equal("scheduleAPersons" in firm, false);
  // An empty array would assert "this firm has no disclosed owners", which is a claim the
  // SEC firm feed does not make. Absence is what lets toFirmSummary report null.
  assert.equal(Array.isArray(firm.scheduleAPersons), false);
});

test("mapFirmRow: a filed headcount of 0 survives as 0, not as null", () => {
  // The disclosure gate has to be able to TELL the difference, and it fails closed on both —
  // but silently turning 0 into null here would hide which one the filing actually said.
  const firm = mapFirmRow(ALLIANCEBERNSTEIN);
  assert.equal(firm.advisoryEmployees, 0);
  assert.equal(firm.totalEmployees, 0);
});

test("mapFirmRow: tolerates a junk row without throwing", () => {
  assert.equal(mapFirmRow(null), null);
  assert.equal(mapFirmRow({ crd: "not a number" }), null);
  const bare = mapFirmRow({ crd: 5 });
  assert.equal(bare.name, null);
  assert.equal(bare.phone10, null);
});

// ---------------------------------------------------------------------------
// lookupByPhone
// ---------------------------------------------------------------------------

test("lookupByPhone: normalises whatever the human typed before it queries", async () => {
  const { calls, query } = collect([NESTLERODE]);
  const store = createStore({ query });
  const found = await store.lookupByPhone("(814) 238-6249 ext. 12");
  assert.equal(found.phone10, "8142386249");
  assert.deepEqual(calls[0].params, ["8142386249"]);
  assert.equal(found.firms[0].crd, 2907);
});

test("lookupByPhone: an unparseable number never reaches the database", async () => {
  const { calls, query } = collect([]);
  const store = createStore({ query });
  const found = await store.lookupByPhone("hello");
  assert.deepEqual(found.firms, []);
  assert.equal(found.phone10, null);
  assert.equal(calls.length, 0);
});

test("lookupByPhone: matches an 11-digit stored value too (547 rows are stored that way)", async () => {
  const { calls, query } = collect([]);
  const store = createStore({ query });
  await store.lookupByPhone("8142386249");
  assert.match(calls[0].sql, /'1' \|\| \$1/);
});

test("lookupByPhone: the SQL expression matches the functional index byte for byte", async () => {
  const { calls, query } = collect([]);
  const store = createStore({ query });
  await store.lookupByPhone("8142386249");
  // firms_phone10_idx is defined on exactly this expression. Change one and Postgres
  // silently seq-scans 23,645 rows instead of using the index.
  assert.match(calls[0].sql, /regexp_replace\(coalesce\(phone, ''\), '\[\^0-9\]', '', 'g'\)/);
});

test("lookupByPhone: multiple firms on one number come back in a deterministic order", async () => {
  const { query } = collect([
    { ...NESTLERODE, crd: "111", firm_name: "ZED ADVISORS", total_employees: 2 },
    { ...NESTLERODE, crd: "222", firm_name: "ACME ADVISORS", total_employees: 9 },
    { ...NESTLERODE, crd: "333", firm_name: "ABLE ADVISORS", total_employees: 2 },
  ]);
  const store = createStore({ query });
  const found = await store.lookupByPhone("8142386249");
  assert.deepEqual(found.firms.map((f) => f.name), ["ACME ADVISORS", "ABLE ADVISORS", "ZED ADVISORS"]);
});

test("lookupByPhone: a database failure raises a typed StoreError with status 502", async () => {
  const store = createStore({
    query: async () => {
      throw new Error("connection terminated unexpectedly");
    },
  });
  await assert.rejects(
    () => store.lookupByPhone("8142386249"),
    (error) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.status, 502);
      assert.match(error.message, /connection terminated/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// getFirm
// ---------------------------------------------------------------------------

test("getFirm: rejects a non-CRD without querying", async () => {
  const { calls, query } = collect([]);
  const store = createStore({ query });
  assert.equal(await store.getFirm("abc"), null);
  assert.equal(await store.getFirm(-1), null);
  assert.equal(await store.getFirm(1.5), null);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

test("freshnessFrom: reports the age of the last successful ingest", () => {
  const value = freshnessFrom(
    { source_file: "IA_FIRM_SEC_Feed_07_29_2026.xml.gz", finished_at: "2026-07-29T14:26:24.587Z", rows_upserted: "23640" },
    { now: Date.parse("2026-08-06T14:26:24.587Z"), staleAfterDays: 14 },
  );
  assert.equal(value.lastIngestAt, "2026-07-29T14:26:24.587Z");
  assert.equal(value.ageDays, 8);
  assert.equal(value.rowsUpserted, 23640);
  assert.equal(value.stale, false);
});

test("freshnessFrom: an unknown age counts as STALE", () => {
  const value = freshnessFrom(null, { now: Date.now() });
  assert.equal(value.ageDays, null);
  assert.equal(value.stale, true, "'we cannot tell you how old this is' is not a reassurance");
});

test("freshness: only a run that FINISHED and is ok=true counts", async () => {
  // ingest_runs id 44 really exists: kind=firms, started 2026-08-06, ok=false,
  // finished_at null. Reporting it as freshness would present a broken pipeline as a
  // healthy one.
  const { calls, query } = collect([]);
  const store = createStore({ query });
  await store.freshness();
  assert.match(calls[0].sql, /ok = true/);
  assert.match(calls[0].sql, /finished_at IS NOT NULL/);
  assert.match(calls[0].sql, /kind = 'firms'/);
});

test("freshness: caches for the TTL, then asks again", async () => {
  let clock = 1_000_000;
  const { calls, query } = collect([{ source_file: "f", finished_at: new Date(clock).toISOString(), rows_upserted: 1 }]);
  const store = createStore({ query, now: () => clock, freshnessTtlMs: 60_000 });
  await store.freshness();
  await store.freshness();
  assert.equal(calls.length, 1);
  clock += 61_000;
  await store.freshness();
  assert.equal(calls.length, 2);
});

test("freshness: NEVER throws — a metadata failure must not cost the caller their answer", async () => {
  const store = createStore({
    query: async () => {
      throw new Error("relation \"ingest_runs\" does not exist");
    },
  });
  const value = await store.freshness();
  assert.equal(value.stale, true);
  assert.match(value.error, /ingest_runs/);
});

// ---------------------------------------------------------------------------
// ping / close
// ---------------------------------------------------------------------------

test("ping: reports unreachable rather than throwing, so /health still answers", async () => {
  const store = createStore({
    query: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:5439");
    },
  });
  const health = await store.ping();
  assert.equal(health.ok, false);
  assert.match(health.error, /ECONNREFUSED/);
});

test("ping: ok only when the database actually answered", async () => {
  const store = createStore({ query: async () => ({ rows: [{ ok: 1 }] }) });
  assert.equal((await store.ping()).ok, true);
  const wrong = createStore({ query: async () => ({ rows: [] }) });
  assert.equal((await wrong.ping()).ok, false);
});

test("describe: never leaks the password", async () => {
  const store = createStore({ db: { host: "127.0.0.1", port: 5439, database: "ria", user: "directories", password: "hunter2" }, query: async () => ({ rows: [] }) });
  const described = JSON.stringify(store.describe);
  assert.equal(described.includes("hunter2"), false);
  assert.match(described, /"passwordConfigured":true/);
});

test("a closed store refuses further queries", async () => {
  const store = createStore({ query: async () => ({ rows: [] }) });
  await store.close();
  await assert.rejects(() => store.lookupByPhone("8142386249"), /closed/);
});

// ---------------------------------------------------------------------------
// the rule this module exists to enforce
// ---------------------------------------------------------------------------

test("the store NEVER reads the advisers table", async () => {
  const seen = [];
  const store = createStore({ query: async (sql) => (seen.push(sql), { rows: [] }) });
  await store.lookupByPhone("8142386249");
  await store.getFirm(2907);
  await store.freshness();
  await store.ping();
  for (const sql of seen) {
    assert.equal(/\badvisers\b/i.test(sql), false, `a person query leaked into the store: ${sql}`);
  }
});

test("the store NEVER writes", async () => {
  const seen = [];
  const store = createStore({ query: async (sql) => (seen.push(sql), { rows: [] }) });
  await store.lookupByPhone("8142386249");
  await store.getFirm(2907);
  await store.freshness();
  for (const sql of seen) {
    assert.equal(/\b(insert|update|delete|drop|alter|truncate)\b/i.test(sql), false, `a write leaked into the store: ${sql}`);
  }
});

// ---------------------------------------------------------------------------
// THE DATABASE IS OPTIONAL
//
// The service must stand alone in real time on the live Places -> IAPD chain. These four
// states are the whole contract: not configured, configured-but-unreachable, slow, healthy.
// In the first three the store must cost the caller NOTHING but a corroborating signal.
// ---------------------------------------------------------------------------

/** A store with the database switched off, holding an injected query that would EXPLODE the
 *  assertion if the disabled path ever reached it. */
function disabledStore(extra = {}) {
  const calls = [];
  const store = createStore({
    db: { enabled: false, enabledMode: "auto", reason: "no database configured in this deployment", staleAfterDays: 14 },
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [NESTLERODE] };
    },
    ...extra,
  });
  return { store, calls };
}

// --- 1. not configured -----------------------------------------------------

test("not configured: the store reports disabled and no method ever reaches a query", async () => {
  const { store, calls } = disabledStore();
  assert.equal(store.enabled, false);

  const found = await store.lookupByPhone("(814) 238-6249");
  const firm = await store.getFirm(2907);
  const fresh = await store.freshness();
  const probe = await store.ping();

  assert.equal(calls.length, 0, "a disabled store must not issue a single statement");
  assert.deepEqual(found.firms, []);
  assert.equal(firm, null);
  assert.equal(fresh.configured, false);
  assert.equal(probe.configured, false);
});

test("not configured: lookupByPhone says SKIPPED, not missed — and still normalises the number", async () => {
  const { store } = disabledStore();
  const found = await store.lookupByPhone("814.238.6249 x12");
  // "we did not ask" and "we asked and there was no filing" are different facts. The
  // resolver lowers confidence for the second and must not lower it for the first.
  assert.equal(found.consulted, false);
  assert.equal(found.skipped, "not_configured");
  // Still normalised, so a caller can log/echo the number it would have queried.
  assert.equal(found.phone10, "8142386249");
  assert.equal(found.ms, 0);
});

test("not configured: nothing throws — a disabled dependency is not an error condition", async () => {
  const { store } = disabledStore();
  // Every one of these is on the request path. A rejection here becomes a 5xx or a
  // degraded-mode banner, which is precisely what this mode must never produce.
  await store.lookupByPhone("8142386249");
  await store.lookupByPhone("nonsense");
  await store.getFirm(2907);
  await store.getFirm("abc");
  await store.freshness();
  await store.ping();
  await store.health();
  assert.ok(true);
});

test("not configured: /health says configured:false and NEVER says unreachable or stale", async () => {
  const { store } = disabledStore();
  const health = await store.health();

  assert.equal(health.configured, false);
  assert.equal(health.enabled, false);
  // The absent keys are the point. `reachable:false` or `stale:true` on a database nobody
  // asked for is read by every dashboard as an outage, and this is a supported mode.
  assert.equal("reachable" in health, false);
  assert.equal("stale" in health, false);
  assert.equal("ageDays" in health, false);
  assert.deepEqual(Object.keys(health).sort(), [...NOT_CONFIGURED_HEALTH_KEYS].sort());
  assert.match(health.note, /supported standalone mode, not a degraded one/);
  // And nothing anywhere in the block reads as a failure.
  assert.equal(/unreachable|down|error|fail/i.test(JSON.stringify(health)), false);
});

test("not configured: freshness is unknown-but-NOT-stale, so no ingest alarm fires", async () => {
  const { store } = disabledStore();
  const fresh = await store.freshness();
  assert.equal(fresh.ageDays, null);
  // freshnessFrom(null) is deliberately stale:true — an unreadable age on a source we ARE
  // using is a warning. A source we are not using has no age to be worried about.
  assert.equal(freshnessFrom(null, { now: Date.now() }).stale, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.applicable, false);
  assert.equal(fresh.skipped, "not_configured");
  assert.deepEqual(notConfiguredFreshness({ staleAfterDays: 14 }).staleAfterDays, 14);
});

test("not configured: ping reports ok:null — 'nothing to ask', not 'asked and it failed'", async () => {
  const { store } = disabledStore();
  const probe = await store.ping();
  assert.equal(probe.ok, null);
  assert.notEqual(probe.ok, false, "false would mean the database was asked and did not answer");
  assert.equal(probe.error, null);
  assert.equal(probe.skipped, "not_configured");
});

test("not configured: an empty db config disables the store rather than dialling a default host", async () => {
  // config.db.host defaults to 127.0.0.1, so a store built from nothing MUST NOT decide it
  // has a database. No injected query, so a leak here would try to import pg and connect.
  const store = createStore({ db: {} });
  assert.equal(store.enabled, false);
  assert.equal(store.describe.mode, "disabled");
  assert.equal(store.describe.host, null, "a host we are not going to dial is not a fact worth publishing");
  assert.equal((await store.lookupByPhone("8142386249")).skipped, "not_configured");
});

// --- 2. configured but unreachable -----------------------------------------

const unreachable = (extra = {}) =>
  createStore({
    db: { enabled: true, enabledMode: "auto", host: "127.0.0.1", port: 5439, database: "ria", user: "directories", password: "x" },
    query: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5439"), { code: "ECONNREFUSED" });
    },
    ...extra,
  });

test("unreachable: /health is honest about the source and explicit that the service still works", async () => {
  const health = await unreachable().health();
  assert.equal(health.configured, true);
  assert.equal(health.reachable, false);
  assert.match(health.error, /ECONNREFUSED/);
  // The sentence next to the red flag is what stops someone paging themselves at 3am for a
  // corroborating source.
  assert.match(health.note, /Lookups continue to work/);
  assert.match(health.note, /live Places\/IAPD chain alone/);
});

test("unreachable: the failure is a typed StoreError the resolver can catch, not a crash", async () => {
  const store = unreachable();
  await assert.rejects(
    () => store.lookupByPhone("8142386249"),
    (error) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, "ECONNREFUSED");
      assert.equal(error.timeout, false);
      assert.equal(error.notConfigured, false);
      return true;
    },
  );
  // getFirm is the one the /v1/firms route and firmRecordFor() call; same contract.
  await assert.rejects(() => store.getFirm(2907), StoreError);
});

test("unreachable: freshness and ping still answer instead of throwing", async () => {
  const store = unreachable();
  const fresh = await store.freshness();
  assert.equal(fresh.configured, true);
  assert.equal(fresh.stale, true, "a source we ARE using whose age we cannot read is stale");
  assert.match(fresh.error, /ECONNREFUSED/);

  const probe = await store.ping();
  assert.equal(probe.ok, false);
  assert.equal(probe.configured, true);
});

// --- 3. timeout ------------------------------------------------------------

/** Never settles. The realistic shape of the failure this guards: the Auth Proxy accepts the
 *  connection and then goes quiet, which pg's 5s connect/statement timeouts do not cover in
 *  any time a person is willing to wait. */
const hang = () => new Promise(() => {});

test("timeout: a hung query is abandoned at RIA_DB_TIMEOUT_MS with a typed timeout error", async () => {
  const store = createStore({ db: { enabled: true }, timeoutMs: 25, query: hang });
  const started = Date.now();
  await assert.rejects(
    () => store.lookupByPhone("8142386249"),
    (error) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, "timeout");
      assert.equal(error.timeout, true);
      assert.match(error.message, /did not answer within 25ms/);
      assert.match(error.message, /continuing without it/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `the deadline must actually fire, took ${elapsed}ms`);
});

test("timeout: freshness and ping absorb it, so /health never hangs on a dead proxy", async () => {
  const store = createStore({ db: { enabled: true }, timeoutMs: 25, query: hang });
  const started = Date.now();
  const health = await store.health();
  assert.equal(health.configured, true);
  assert.equal(health.reachable, false);
  assert.match(health.error, /did not answer within 25ms/);
  assert.equal(health.stale, true);
  assert.ok(Date.now() - started < 1_000, "health must not wait on a hung database");
});

test("timeout: a query that fails AFTER the deadline does not become an unhandled rejection", async () => {
  // The loser of the race is not cancellable, so it must at least stay handled: an unhandled
  // 'error' from a late pg failure would take the whole process down.
  const store = createStore({
    db: { enabled: true },
    timeoutMs: 10,
    query: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late boom")), 60)),
  });
  await assert.rejects(() => store.lookupByPhone("8142386249"), /did not answer within 10ms/);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(true, "still alive 120ms after the late rejection");
});

test("timeout: the default deadline is 800ms, and 0 means no deadline", async () => {
  assert.equal(createStore({ db: { enabled: true }, query: async () => ({ rows: [] }) }).describe.timeoutMs, 800);
  // 0 is a legal configured value, not a falsy fallback to 800 — an operator who wants pg's
  // own timeouts to be the only ones must be able to say so.
  const store = createStore({ db: { enabled: true, timeoutMs: 0 }, query: async () => ({ rows: [NESTLERODE] }) });
  assert.equal(store.describe.timeoutMs, 0);
  assert.equal((await store.lookupByPhone("8142386249")).firms[0].crd, 2907);
});

// --- 4. a healthy hit ------------------------------------------------------

const HEALTHY_INGEST = {
  source_file: "IA_FIRM_SEC_Feed_08_03_2026.xml.gz",
  finished_at: "2026-08-03T14:26:24.587Z",
  rows_upserted: "23640",
};

/** Routes each statement to the fixture it would really return. */
function healthyStore() {
  const calls = [];
  const now = () => Date.parse("2026-08-06T14:26:24.587Z");
  const store = createStore({
    db: { enabled: true, enabledMode: "auto", host: "127.0.0.1", port: 5439, database: "ria", user: "directories", password: "hunter2", staleAfterDays: 14 },
    now,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT 1 AS ok/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/ingest_runs/.test(sql)) return { rows: [HEALTHY_INGEST] };
      return { rows: [NESTLERODE] };
    },
  });
  return { store, calls };
}

test("healthy: a hit comes back mapped, with consulted:true", async () => {
  const { store } = healthyStore();
  const found = await store.lookupByPhone("(814) 238-6249");
  assert.equal(found.consulted, true, "consulted:true is what makes a miss meaningful evidence");
  assert.equal(found.skipped, null);
  assert.equal(found.firms.length, 1);
  assert.equal(found.firms[0].crd, 2907);
  assert.equal(found.firms[0].name, "NESTLERODE & LOY, INC.");
  assert.equal(found.firms[0].recordSource, "form_adv_db");
});

test("healthy: a consulted MISS is distinguishable from a skip", async () => {
  const store = createStore({ db: { enabled: true }, query: async () => ({ rows: [] }) });
  const found = await store.lookupByPhone("8142386249");
  assert.deepEqual(found.firms, []);
  assert.equal(found.consulted, true);
  assert.equal(found.skipped, null);
});

test("healthy: /health reports reachable, the age of the feed, and staleness", async () => {
  const { store } = healthyStore();
  const health = await store.health();
  assert.equal(health.configured, true);
  assert.equal(health.enabled, true);
  assert.equal(health.reachable, true);
  assert.equal(health.error, null);
  assert.equal(health.ageDays, 3);
  assert.equal(health.stale, false);
  assert.equal(health.lastIngestAt, "2026-08-03T14:26:24.587Z");
  assert.equal(health.staleAfterDays, 14);
  assert.equal(health.database, "ria");
  // Even on the happy path the block never carries the secret.
  assert.equal(JSON.stringify(health).includes("hunter2"), false);
  assert.match(JSON.stringify(health), /"passwordConfigured":true/);
});

test("healthy: getFirm returns the row", async () => {
  const { store } = healthyStore();
  const firm = await store.getFirm(2907);
  assert.equal(firm.crd, 2907);
  assert.equal(firm.city, "STATE COLLEGE");
});

// --- the RIA_DB_ENABLED switch, resolved by config.mjs ---------------------

/** config.mjs reads process.env at import, so the only honest test of the switch is a fresh
 *  process. Four states, one spawn each. */
function dbConfigUnder(env) {
  const configUrl = new URL("./config.mjs", import.meta.url).href;
  const script = `import { config } from ${JSON.stringify(configUrl)};
    const { enabled, enabledMode, configured, timeoutMs, host, hostConfigured } = config.db;
    process.stdout.write(JSON.stringify({ enabled, enabledMode, configured, timeoutMs, host, hostConfigured }));`;
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith("RIA_DB_")) delete clean[key];
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...clean, ...env },
    encoding: "utf8",
    cwd: fileURLToPath(new URL(".", import.meta.url)),
  });
  return JSON.parse(out);
}

test("RIA_DB_ENABLED: auto means enabled IFF someone actually configured a database", () => {
  // Nothing set — a laptop, a CI run, or a deployment that deliberately stands alone.
  const bare = dbConfigUnder({});
  assert.equal(bare.enabled, false);
  assert.equal(bare.enabledMode, "auto");
  assert.equal(bare.configured, false);
  assert.equal(bare.timeoutMs, 800);
  assert.equal(bare.hostConfigured, false);

  // A password is what "someone set this up" looks like in production.
  assert.equal(dbConfigUnder({ RIA_DB_PASSWORD: "s3cret" }).enabled, true);
  // So is an explicit host, even without a password (IAM auth, a trust-auth proxy).
  const hosted = dbConfigUnder({ RIA_DB_HOST: "127.0.0.1" });
  assert.equal(hosted.enabled, true);
  assert.equal(hosted.hostConfigured, true);
});

test("RIA_DB_ENABLED: an explicit off beats a configured password; an explicit on beats nothing", () => {
  const off = dbConfigUnder({ RIA_DB_PASSWORD: "s3cret", RIA_DB_ENABLED: "off" });
  assert.equal(off.enabled, false);
  assert.equal(off.enabledMode, "off");

  const on = dbConfigUnder({ RIA_DB_ENABLED: "true" });
  assert.equal(on.enabled, true);
  assert.equal(on.enabledMode, "on");

  // A typo must not silently switch a configured database off.
  const typo = dbConfigUnder({ RIA_DB_PASSWORD: "s3cret", RIA_DB_ENABLED: "yse" });
  assert.equal(typo.enabledMode, "auto");
  assert.equal(typo.enabled, true);

  assert.equal(dbConfigUnder({ RIA_DB_PASSWORD: "s3cret", RIA_DB_TIMEOUT_MS: "1500" }).timeoutMs, 1500);
  assert.equal(dbConfigUnder({ RIA_DB_PASSWORD: "s3cret", RIA_DB_TIMEOUT_MS: "0" }).timeoutMs, 0);
});
