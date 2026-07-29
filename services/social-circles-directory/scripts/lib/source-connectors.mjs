// Source connectors: one per upstream vertical. Each connector yields normalized
// "entities" (people or orgs) that the resolver clusters into graph nodes.
//
// FOUR are real Cloud SQL sources (healthcare, ria, insurance, hotel_scraper),
// each read through its OWN pg Pool (Postgres cannot cross-database query, so the
// builder opens one Pool per database — same host/port/user/password via the Cloud
// SQL Auth Proxy, only the DB name differs). THREE are social scrapers
// (instagram/twitter/threads) which have NO shared datastore — see the stub note
// below.
//
// Robustness: a source DB may be EMPTY (table exists, 0 rows) or entirely ABSENT
// (the sibling service hasn't been provisioned yet). Connectors classify pg errors
// (missing database / missing table) as "unavailable", log, and return no entities
// — they never throw, so one missing source never crashes the rebuild.
//
// The row MAPPERS are pure (no DB) and unit-tested with fixtures. Because the exact
// upstream column names are owned by the sibling services (and not in this repo),
// mappers read each field from a list of CANDIDATE column names and degrade to null
// — this keeps them resilient to reasonable schema variation without fabricating.

// NOTE: this module has NO `pg` import on purpose — the row MAPPERS are pure and
// unit-tested without a DB or the pg package installed. The Pool factory lives in
// db.mjs (runtime-only) and pools are injected into the connectors here.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

const log = (event, extra = {}) => console.log(JSON.stringify({ event, ...extra }));

// ---- pure field helpers ----------------------------------------------------

// First non-empty value among the given candidate column names (case-insensitive).
export function pick(row, candidates) {
  if (!row) return null;
  const lower = {};
  for (const k of Object.keys(row)) lower[k.toLowerCase()] = row[k];
  for (const c of candidates) {
    const v = lower[c.toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

const str = (v) => (v == null ? null : String(v).trim() || null);

const NAME_COLS = ["full_name", "name", "provider_name", "legal_name", "display_name", "producer_name", "adviser_name", "advisor_name"];
const FIRST_COLS = ["first_name", "firstname", "given_name", "fname"];
const LAST_COLS = ["last_name", "lastname", "surname", "family_name", "lname"];
const ORG_COLS = ["org", "organization", "organization_name", "org_name", "firm", "firm_name", "employer", "employer_name", "business_name", "company", "company_name", "practice_name", "agency", "agency_name"];
const ADDR_COLS = ["address", "street", "street_address", "address_line1", "addr", "mailing_address", "business_address", "formatted_address", "practice_address", "office_address"];
const ZIP_COLS = ["zip", "postal_code", "zip_code", "postalcode", "mailing_zip", "business_zip", "addr_zip", "practice_zip"];
const STATE_COLS = ["state", "state_code", "admin_state", "region", "addr_state", "mailing_state", "business_state", "practice_state", "license_state"];

function baseFields(row) {
  return {
    name: str(pick(row, NAME_COLS)),
    firstName: str(pick(row, FIRST_COLS)),
    lastName: str(pick(row, LAST_COLS)),
    org: str(pick(row, ORG_COLS)),
    address: str(pick(row, ADDR_COLS)),
    zip: str(pick(row, ZIP_COLS)),
    state: str(pick(row, STATE_COLS)),
  };
}

// Compose a display name from first/last when there is no explicit name column.
function displayName(f) {
  if (f.name) return f.name;
  const joined = [f.firstName, f.lastName].filter(Boolean).join(" ").trim();
  return joined || null;
}

// ---- pure row mappers (one per source; return entity or null) ---------------

// healthcare.providers, stable id = npi (person).
export function mapHealthcareRow(row) {
  const key = str(pick(row, ["npi", "npi_number", "provider_npi", "id"]));
  const f = baseFields(row);
  const name = displayName(f);
  if (!key || (!name && !f.lastName)) return null;
  return {
    sourceVertical: "healthcare",
    sourceKey: key,
    kind: "person",
    profession: "healthcare",
    name,
    firstName: f.firstName,
    lastName: f.lastName,
    org: f.org,
    address: f.address,
    zip: f.zip,
    state: f.state,
    attributes: { npi: key, taxonomy: str(pick(row, ["taxonomy", "specialty", "primary_specialty"])) },
  };
}

// ria.advisers, stable id = crd (person).
export function mapRiaAdviserRow(row) {
  const key = str(pick(row, ["crd", "crd_number", "individual_crd", "id"]));
  const f = baseFields(row);
  const name = displayName(f);
  if (!key || (!name && !f.lastName)) return null;
  return {
    sourceVertical: "ria",
    sourceKey: key,
    kind: "person",
    profession: "ria",
    name,
    firstName: f.firstName,
    lastName: f.lastName,
    org: f.org,
    address: f.address,
    zip: f.zip,
    state: f.state,
    attributes: { crd: key },
  };
}

// ria.firms, stable id = crd (ORG node). The firm name doubles as its own org key.
export function mapRiaFirmRow(row) {
  const key = str(pick(row, ["crd", "firm_crd", "crd_number", "id"]));
  const name = str(pick(row, ["firm_name", "name", "legal_name", "business_name"]));
  const f = baseFields(row);
  if (!key || !name) return null;
  return {
    sourceVertical: "ria",
    sourceKey: key,
    kind: "org",
    profession: "ria",
    name,
    org: name,
    address: f.address,
    zip: f.zip,
    state: f.state,
    attributes: { crd: key, kind: "firm" },
  };
}

// insurance.producers, stable id = license_no (person).
export function mapInsuranceRow(row) {
  const key = str(pick(row, ["license_no", "license_number", "npn", "producer_id", "id"]));
  const f = baseFields(row);
  const name = displayName(f);
  if (!key || (!name && !f.lastName)) return null;
  return {
    sourceVertical: "insurance",
    sourceKey: key,
    kind: "person",
    profession: "insurance",
    name,
    firstName: f.firstName,
    lastName: f.lastName,
    org: f.org,
    address: f.address,
    zip: f.zip,
    state: f.state,
    attributes: { licenseNo: key, licenseState: str(pick(row, ["license_state", "state"])) },
  };
}

// hotel_scraper.hotels, stable id = dedup_key (ORG node; owner unknown -> the hotel
// itself is the org entity). Uses the known hotel-scraper column names.
export function mapHotelRow(row) {
  const key = str(pick(row, ["dedup_key", "place_id", "id"]));
  const name = str(pick(row, ["name", "display_name"]));
  if (!key || !name) return null;
  return {
    sourceVertical: "hotel",
    sourceKey: key,
    kind: "org",
    profession: "hospitality",
    name,
    org: name,
    address: str(pick(row, ["formatted_address", "address"])),
    zip: str(pick(row, ["zip", "postal_code"])),
    state: str(pick(row, ["state", "state_code"])),
    attributes: { placeId: str(pick(row, ["place_id"])), primaryType: str(pick(row, ["primary_type"])) },
  };
}

// One social scrape record -> { entity, relations }. The scrape "template" shape is
// { username, fullName?, stats:{followers,following}, ... }; follower/following
// LISTS and mentions are only present if a future exporter includes them, so
// relations are emitted opportunistically (empty by default).
export function mapSocialRecord(vertical, rec) {
  if (!rec) return { entity: null, relations: [] };
  const handle = str(rec.username || rec.handle || rec.screen_name);
  if (!handle) return { entity: null, relations: [] };
  const entity = {
    sourceVertical: vertical, // instagram|twitter|threads
    sourceKey: handle.toLowerCase(),
    kind: "person",
    profession: "social",
    name: str(rec.fullName || rec.full_name || rec.name) || handle,
    org: null,
    address: null,
    zip: null,
    state: null,
    attributes: {
      handle,
      followers: rec.stats?.followers ?? rec.followers ?? null,
      following: rec.stats?.following ?? rec.following ?? null,
      bio: str(rec.bio) || null,
    },
  };
  const relations = [];
  for (const f of arr(rec.follows || rec.following_handles)) {
    const dst = str(f?.username || f?.handle || f);
    if (dst) relations.push({ vertical, srcHandle: handle.toLowerCase(), dstHandle: dst.toLowerCase(), type: "follow" });
  }
  for (const m of arr(rec.mentions)) {
    const dst = str(m?.username || m?.handle || m);
    if (dst) relations.push({ vertical, srcHandle: handle.toLowerCase(), dstHandle: dst.toLowerCase(), type: "mention" });
  }
  return { entity, relations };
}

const arr = (v) => (Array.isArray(v) ? v : []);

// ---- SQL source specs ------------------------------------------------------

// role -> which entry of config.sources.names to open a Pool against.
export const SOURCE_SPECS = [
  { vertical: "healthcare", role: "healthcare", table: process.env.HEALTHCARE_TABLE || "providers", mapper: mapHealthcareRow },
  { vertical: "ria", role: "ria", table: process.env.RIA_ADVISERS_TABLE || "advisers", mapper: mapRiaAdviserRow },
  { vertical: "ria", role: "ria", table: process.env.RIA_FIRMS_TABLE || "firms", mapper: mapRiaFirmRow },
  { vertical: "insurance", role: "insurance", table: process.env.INSURANCE_TABLE || "producers", mapper: mapInsuranceRow },
  { vertical: "hotel", role: "hotel", table: process.env.HOTEL_TABLE || "hotels", mapper: mapHotelRow },
];

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;
function assertIdent(name) {
  if (!IDENT_RE.test(String(name))) throw new Error(`Unsafe SQL identifier: ${name}`);
  return name;
}

// pg error codes that mean "this source just isn't there yet" (treat as empty).
const ABSENT_CODES = new Set([
  "42P01", // undefined_table
  "3D000", // invalid_catalog_name (database does not exist)
  "3F000", // invalid_schema_name
  "ECONNREFUSED",
  "ENOTFOUND",
  "57P03", // cannot_connect_now
]);

// ---- SQL source reader (streamed via a cursor; bounded memory) --------------

// Read every row of one source table, mapping each to an entity. Uses a server-side
// cursor so a large table streams in batches instead of buffering in memory. On a
// missing DB/table it returns { available:false } instead of throwing.
export async function fetchSqlSource(pool, spec, { batchSize = 1000, maxEntities = 0 } = {}) {
  assertIdent(spec.table);
  const entities = [];
  let scanned = 0;
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(`DECLARE graph_cur NO SCROLL CURSOR FOR SELECT to_jsonb(t) AS r FROM ${spec.table} t`);
    for (;;) {
      const { rows } = await client.query(`FETCH FORWARD ${Number(batchSize) || 1000} FROM graph_cur`);
      if (!rows.length) break;
      for (const { r } of rows) {
        scanned++;
        const entity = spec.mapper(r);
        if (entity) entities.push(entity);
        if (maxEntities && entities.length >= maxEntities) break;
      }
      if (maxEntities && entities.length >= maxEntities) break;
    }
    await client.query("CLOSE graph_cur").catch(() => {});
    await client.query("COMMIT").catch(() => {});
    return { available: true, entities, scanned };
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    const code = err?.code || "";
    if (ABSENT_CODES.has(code)) {
      log("source.unavailable", { vertical: spec.vertical, table: spec.table, code });
      return { available: false, entities: [], scanned: 0, error: code };
    }
    log("source.error", { vertical: spec.vertical, table: spec.table, message: err.message });
    return { available: false, entities: [], scanned: 0, error: err.message };
  } finally {
    if (client) client.release();
  }
}

// ---- social scraper connectors (honest STUBS) ------------------------------
//
// The IG/X/Threads scrapers do NOT share a datastore: each persists per-request
// scrape JSON to its OWN VM's local disk (OUTPUT_DIR), and the scrape "template"
// exposes follower/following COUNTS, not follower LISTS — so there is nothing
// queryable and no follow-graph to read from this VM. Rather than fabricate edges,
// these connectors define a clear ingest INTERFACE: point SOCIAL_<X>_DIR at a
// directory of exported scrape JSON and it will be ingested; unset (the default)
// yields nothing.
//
// TODO(social): when a central social store exists (a shared `social_raw` DB or a
// GCS export bucket the sibling scrapers write to), replace readSocialDir with a
// real reader. Until then this is intentionally empty in production.
export function readSocialDir(vertical, dir) {
  if (!dir) return { available: false, entities: [], relations: [], scanned: 0, note: "no SOCIAL_*_DIR configured (stub)" };
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    log("social.dir_unreadable", { vertical, dir, message: err.message });
    return { available: false, entities: [], relations: [], scanned: 0, error: err.message };
  }
  const entities = [];
  const relations = [];
  let scanned = 0;
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      log("social.file_parse_error", { vertical, file, message: err.message });
      continue;
    }
    for (const rec of extractSocialRecords(parsed)) {
      scanned++;
      const { entity, relations: rels } = mapSocialRecord(vertical, rec);
      if (entity) entities.push(entity);
      relations.push(...rels);
    }
  }
  return { available: true, entities, relations, scanned };
}

// Pull scrape "template" records out of the various shapes the scrapers emit:
// a bare template, a single {results:[...]} envelope, or an array of either.
export function extractSocialRecords(parsed) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (Array.isArray(node.results)) return node.results.forEach(visit);
    if (node.template && typeof node.template === "object") return visit(node.template);
    if (node.username || node.handle || node.screen_name) out.push(node);
  };
  visit(parsed);
  return out;
}

// ---- top-level: gather everything for one build pass -----------------------

// Returns { entities, relations, scanned:{vertical:count}, available:{vertical:bool} }.
// `poolFor(role)` returns (or lazily creates) a Pool for a source role; injected so
// the worker can manage/close pools and tests can stub it.
export async function gatherAllSources(poolFor, opts = {}) {
  const batchSize = opts.batchSize ?? config.sources.batchSize;
  const maxEntities = opts.maxEntities ?? config.sources.maxEntitiesPerSource;

  const entities = [];
  const relations = [];
  const scanned = {};
  const available = {};

  for (const spec of SOURCE_SPECS) {
    const pool = poolFor(spec.role);
    if (!pool) {
      available[spec.vertical] = false;
      continue;
    }
    const res = await fetchSqlSource(pool, spec, { batchSize, maxEntities });
    entities.push(...res.entities);
    scanned[spec.vertical] = (scanned[spec.vertical] || 0) + res.scanned;
    // A vertical with two tables (ria) is available if ANY of its tables loaded.
    available[spec.vertical] = available[spec.vertical] || res.available;
  }

  const socialDirs = [
    ["instagram", config.social.instagramDir],
    ["twitter", config.social.twitterDir],
    ["threads", config.social.threadsDir],
  ];
  for (const [vertical, dir] of socialDirs) {
    const res = readSocialDir(vertical, dir);
    entities.push(...res.entities);
    relations.push(...res.relations);
    scanned[vertical] = res.scanned;
    available[vertical] = res.available;
  }

  return { entities, relations, scanned, available };
}
