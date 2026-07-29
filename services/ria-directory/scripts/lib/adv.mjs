// Pure Form ADV / IAPD helpers — NO database. This module holds everything that can
// be unit-tested from fixtures: CSV parsing, ADV row → firm/adviser mappers, and the
// SEC compilation-feed discovery/download logic. It imports only config.mjs + zip.mjs
// (both pg-free) and node builtins, so `node --test` never needs the `pg` dependency.
//
// ── Reality check on the source format ─────────────────────────────────────────────
// The task specifies a CSV compilation. The SEC's LIVE Investment Adviser feeds are in
// fact gzipped/zipped XML:
//     IA_FIRM_SEC_Feed_MM_DD_YYYY.xml.gz     (firms)
//     IA_INDVL_Feed_MM_DD_YYYY.xml.zip       (individuals)
// discovered via the reports manifest JSON. We therefore ship a full CSV pipeline
// (parser + mappers + tests, per the task) AND make the downloader format-aware
// (gunzip .gz, flag .zip for deploy-time unzip) with an explicit guard downstream that
// refuses to ingest XML as CSV rather than corrupting the tables. See README.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.mjs";
import { normalizeZip } from "./zip.mjs";

// ── CSV parsing (RFC-4180-ish, no dependency) ──────────────────────────────────────

// Parse ONE complete logical CSV line into fields. Quote-aware: fields may be wrapped
// in double quotes, and a doubled quote ("") inside a quoted field is a literal quote.
export function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// True if a string ends mid-quoted-field — i.e. a record spans multiple physical lines
// (a quoted field contains an embedded newline). Used by the streaming assembler.
export function hasUnterminatedQuote(s) {
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') {
      if (inQuotes && s[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    }
  }
  return inQuotes;
}

// Reassemble logical CSV records from physical lines. push(line) returns the parsed
// fields once a record is complete, or null while a quoted field is still open.
export function createCsvRecordAssembler() {
  let pending = null;
  return {
    push(line) {
      const combined = pending == null ? line : `${pending}\n${line}`;
      if (hasUnterminatedQuote(combined)) {
        pending = combined;
        return null;
      }
      pending = null;
      return parseCsvLine(combined);
    },
    flush() {
      if (pending == null) return null;
      const fields = parseCsvLine(pending);
      pending = null;
      return fields;
    },
  };
}

// ── Value normalizers ──────────────────────────────────────────────────────────────

// Parse regulatory AUM. Strips $/commas/spaces; supports a trailing k/m/b multiplier.
export function parseAum(value) {
  if (value == null) return null;
  let s = String(value).trim().toLowerCase();
  if (!s) return null;
  let mult = 1;
  const suffix = s.slice(-1);
  if (suffix === "k") {
    mult = 1e3;
    s = s.slice(0, -1);
  } else if (suffix === "m") {
    mult = 1e6;
    s = s.slice(0, -1);
  } else if (suffix === "b") {
    mult = 1e9;
    s = s.slice(0, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (!s || s === "-") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * mult * 100) / 100;
}

// A CRD is an integer registry id. Returns a positive safe integer or null.
export function normalizeCrd(value) {
  if (value == null) return null;
  const digits = String(value).replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function normState(s) {
  if (!s) return null;
  const st = String(s).trim().toUpperCase().slice(0, 2);
  return /^[A-Z]{2}$/.test(st) ? st : null;
}

function parseIntOrNull(v) {
  if (v == null) return null;
  const cleaned = String(v).replace(/[^\d-]/g, "");
  if (!cleaned || cleaned === "-") return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

// ── Header mapping ───────────────────────────────────────────────────────────────

const normKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Map logical field names → the first matching header column index. `aliases` is
// { fieldName: [possible header spellings...] }. Header spellings are matched after
// normalization (lowercase, alphanumeric only), so "Main Office City", "MainOfficeCity"
// and "main_office_city" all collapse to the same key. Unmatched fields map to -1.
export function buildHeaderIndex(headers, aliases) {
  const normHeaders = (headers || []).map(normKey);
  const index = {};
  for (const [field, names] of Object.entries(aliases)) {
    let found = -1;
    for (const alias of names) {
      const i = normHeaders.indexOf(normKey(alias));
      if (i !== -1) {
        found = i;
        break;
      }
    }
    index[field] = found;
  }
  return index;
}

// Form ADV firm feed columns vary across vintages, so each field carries several
// aliases (plain names + a few ADV Part 1 item codes). raw JSONB keeps the source row
// verbatim regardless, so nothing is lost when a column is renamed upstream.
export const FIRM_FIELD_ALIASES = {
  crd: ["crd", "organizationcrd", "organizationcrdnumber", "firmcrd", "firmcrdnumber", "crdnumber", "orgcrd"],
  secNumber: ["secnumber", "secno", "secfilenumber", "sec", "1e1"],
  firmName: ["primarybusinessname", "legalname", "firmname", "businessname", "1b1", "name"],
  street1: ["mainofficestreetaddress1", "mainofficeaddress1", "street1", "addressstreet1", "address1", "1f1street1"],
  street2: ["mainofficestreetaddress2", "mainofficeaddress2", "street2", "address2", "1f1street2"],
  city: ["mainofficecity", "city", "1f1city"],
  state: ["mainofficestate", "state", "1f1state"],
  zip: ["mainofficepostalcode", "mainofficezip", "postalcode", "zip", "zipcode", "1f1postalcode"],
  country: ["mainofficecountry", "country", "1f1country"],
  phone: ["mainofficetelephonenumber", "mainofficephone", "telephonenumber", "telephone", "phone"],
  website: ["website", "websiteaddress", "webaddress", "url", "1i"],
  aum: ["regulatoryassetsundermanagement", "assetsundermanagement", "aum", "raum", "totalgrossassets", "5f2c"],
  totalEmployees: ["totalemployees", "numberofemployees", "employees", "5a"],
  numAccounts: ["numberofaccounts", "totalaccounts", "numaccounts", "accounts", "5f2f"],
  registrationStatus: ["registrationstatus", "secstatus", "status", "registrationtype"],
};

export const ADVISER_FIELD_ALIASES = {
  crd: ["crd", "individualcrd", "individualcrdnumber", "indvlcrd", "repcrd", "crdnumber"],
  firstName: ["firstname", "first", "givenname", "indvlfirstname"],
  lastName: ["lastname", "last", "surname", "familyname", "indvllastname"],
  currentFirmCrd: ["currentfirmcrd", "employingfirmcrd", "firmcrd", "organizationcrd", "currentemployercrd"],
  currentFirmName: ["currentfirmname", "employingfirmname", "currentemployername", "firmname", "primarybusinessname"],
  street1: ["street1", "businessstreet1", "officestreetaddress1", "address1"],
  street2: ["street2", "businessstreet2", "address2"],
  city: ["city", "businesscity", "officecity"],
  state: ["state", "businessstate", "officestate"],
  zip: ["zip", "postalcode", "zipcode", "businesspostalcode"],
  country: ["country", "businesscountry"],
};

function rawObject(headers, fields) {
  const raw = {};
  for (let i = 0; i < headers.length; i++) {
    const key = headers[i];
    if (key == null || key === "") continue;
    raw[key] = fields[i] ?? null;
  }
  return raw;
}

// Map one firm CSV row → an upsertFirm() record, or null when the row has no numeric
// CRD (can't be keyed). `precomputedIndex` lets the caller build the header map once.
export function mapAdvRowToFirm(headers, fields, precomputedIndex) {
  const idx = precomputedIndex || buildHeaderIndex(headers, FIRM_FIELD_ALIASES);
  const at = (field) => {
    const i = idx[field];
    if (i == null || i < 0 || i >= fields.length) return null;
    const v = String(fields[i] ?? "").trim();
    return v === "" ? null : v;
  };
  const crd = normalizeCrd(at("crd"));
  if (crd == null) return null;
  return {
    crd,
    secNumber: at("secNumber"),
    firmName: at("firmName"),
    street1: at("street1"),
    street2: at("street2"),
    city: at("city"),
    state: normState(at("state")),
    zip: normalizeZip(at("zip")),
    country: at("country"),
    phone: at("phone"),
    website: at("website"),
    aum: parseAum(at("aum")),
    totalEmployees: parseIntOrNull(at("totalEmployees")),
    numAccounts: parseIntOrNull(at("numAccounts")),
    registrationStatus: at("registrationStatus"),
    raw: rawObject(headers, fields),
  };
}

// Map one individual CSV row → an upsertAdviser() record, or null with no numeric CRD.
export function mapAdvRowToAdviser(headers, fields, precomputedIndex) {
  const idx = precomputedIndex || buildHeaderIndex(headers, ADVISER_FIELD_ALIASES);
  const at = (field) => {
    const i = idx[field];
    if (i == null || i < 0 || i >= fields.length) return null;
    const v = String(fields[i] ?? "").trim();
    return v === "" ? null : v;
  };
  const crd = normalizeCrd(at("crd"));
  if (crd == null) return null;
  return {
    crd,
    firstName: at("firstName"),
    lastName: at("lastName"),
    currentFirmCrd: normalizeCrd(at("currentFirmCrd")),
    currentFirmName: at("currentFirmName"),
    street1: at("street1"),
    street2: at("street2"),
    city: at("city"),
    state: normState(at("state")),
    zip: normalizeZip(at("zip")),
    country: at("country"),
    raw: rawObject(headers, fields),
  };
}

// ── SEC compilation discovery ──────────────────────────────────────────────────────

function joinUrl(base, name) {
  if (!name) return null;
  if (/^https?:\/\//i.test(name)) return name;
  const b = String(base || "").replace(/\/+$/, "");
  return `${b}/${String(name).replace(/^\/+/, "")}`;
}

function resolveUrl(candidate, base) {
  if (/^https?:\/\//i.test(candidate)) return candidate;
  if (candidate.startsWith("/")) {
    try {
      const u = new URL(base);
      return `${u.protocol}//${u.host}${candidate}`;
    } catch {
      return joinUrl(base, candidate.split("/").pop());
    }
  }
  return joinUrl(base, candidate.split("/").pop());
}

// Sortable YYYYMMDD key for a feed, taken from an MM_DD_YYYY stamp in the name, else
// the entry's own date field, else zero (so it sorts last).
function feedDateKey(entry) {
  const name = entry?.name || "";
  const m = /(\d{2})[_-](\d{2})[_-](\d{4})/.exec(name);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}${mm}${dd}`;
  }
  if (entry?.date) {
    const t = Date.parse(entry.date);
    if (Number.isFinite(t)) {
      const d = new Date(t);
      return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    }
  }
  return "00000000";
}

// Normalize a manifest into {name,size,date}[] regardless of whether the list lives
// under `files` or `query` (the SEC JS bundle references both), and regardless of the
// per-entry field spellings.
function extractManifestEntries(manifest) {
  if (!manifest || typeof manifest !== "object") return [];
  const arr = Array.isArray(manifest.files)
    ? manifest.files
    : Array.isArray(manifest.query)
      ? manifest.query
      : Array.isArray(manifest)
        ? manifest
        : [];
  return arr
    .map((e) => {
      if (typeof e === "string") return { name: e, size: null, date: null };
      if (!e || typeof e !== "object") return null;
      const name = e.name || e.fileName || e.file || e.key || e.filename || null;
      if (!name) return null;
      const size = e.size ?? e.bytes ?? e.length ?? null;
      const date = e.date || e.lastModified || e.modified || e.uploaded || e.updated || null;
      return { name, size, date };
    })
    .filter(Boolean);
}

function pickNewest(entries, pattern) {
  const p = String(pattern || "").toLowerCase();
  const cand = entries.filter((e) => e.name.toLowerCase().includes(p));
  if (!cand.length) return null;
  cand.sort((a, b) => (feedDateKey(a) < feedDateKey(b) ? 1 : -1));
  return cand[0];
}

// Parse the CompilationReports manifest JSON → newest firm + individual links.
export function parseCompilationManifest(manifest, { firmPattern, individualPattern, baseUrl } = {}) {
  const entries = extractManifestEntries(manifest);
  const toLink = (e) =>
    e ? { name: e.name, url: joinUrl(baseUrl, e.name), size: e.size ?? null, date: e.date ?? null } : null;
  return {
    firm: toLink(pickNewest(entries, firmPattern)),
    individual: toLink(pickNewest(entries, individualPattern)),
  };
}

// Fallback: scrape hrefs / bare feed filenames out of the compilation index HTML.
export function extractCompilationLinksFromHtml(html, { firmPattern, individualPattern, baseUrl } = {}) {
  const urls = new Set();
  const attr = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attr.exec(html || ""))) urls.add(m[1]);
  const bare = /([A-Za-z0-9_-]*IA_(?:FIRM_SEC|INDVL)_Feed[A-Za-z0-9_.-]*\.(?:zip|gz|csv|xml))/gi;
  while ((m = bare.exec(html || ""))) urls.add(m[1]);
  const list = [...urls];
  const pick = (pattern) => {
    const p = String(pattern || "").toLowerCase();
    const cand = list.filter((u) => u.toLowerCase().includes(p));
    if (!cand.length) return null;
    cand.sort((a, b) => (feedDateKey({ name: a }) < feedDateKey({ name: b }) ? 1 : -1));
    const chosen = cand[0];
    return { name: chosen.split("/").pop(), url: resolveUrl(chosen, baseUrl), size: null, date: null };
  };
  return { firm: pick(firmPattern), individual: pick(individualPattern) };
}

// Last-resort fallback: construct the well-known dated static paths. Flagged
// verified:false — these MUST be confirmed on the VM (the real extension is .xml.gz /
// .xml.zip and the exact daily stamp changes).
export function staticFallbackUrls(date = new Date(), { baseUrl } = {}) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();
  const firmName = `IA_FIRM_SEC_Feed_${mm}_${dd}_${yyyy}.xml.gz`;
  const indName = `IA_INDVL_Feed_${mm}_${dd}_${yyyy}.xml.zip`;
  return {
    firm: { name: firmName, url: joinUrl(baseUrl, firmName), size: null, date: null, verified: false },
    individual: { name: indName, url: joinUrl(baseUrl, indName), size: null, date: null, verified: false },
    verified: false,
  };
}

// Discover the newest firm + individual compilation URLs. Order: manifest JSON (the
// verified-live path) → HTML scrape → dated static fallback. Returns
// { firm, individual, via }. `deps` allows fixture injection in tests.
export async function discoverLatestCompilationUrls(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const manifestUrl = deps.manifestUrl || config.sec.manifestUrl;
  const pageUrl = deps.compilationPageUrl || config.sec.compilationPageUrl;
  const baseUrl = deps.reportsBaseUrl || config.sec.reportsBaseUrl;
  const firmPattern = deps.firmPattern || config.sec.firmFilePattern;
  const individualPattern = deps.individualPattern || config.sec.individualFilePattern;
  const userAgent = deps.userAgent || config.sec.userAgent;
  const headers = { "user-agent": userAgent, accept: "application/json,text/html,*/*" };

  // 1) Manifest JSON.
  try {
    const res = await fetchImpl(manifestUrl, { headers });
    if (res && res.ok) {
      const manifest = await res.json();
      const links = parseCompilationManifest(manifest, { firmPattern, individualPattern, baseUrl });
      if (links.firm || links.individual) return { ...links, via: "manifest" };
    }
  } catch {
    /* fall through to HTML */
  }

  // 2) HTML scrape.
  try {
    const res = await fetchImpl(pageUrl, { headers });
    if (res && res.ok) {
      const html = await res.text();
      const links = extractCompilationLinksFromHtml(html, { firmPattern, individualPattern, baseUrl });
      if (links.firm || links.individual) return { ...links, via: "html" };
    }
  } catch {
    /* fall through to static fallback */
  }

  // 3) Dated static fallback (UNVERIFIED).
  const fb = staticFallbackUrls(deps.now || new Date(), { baseUrl });
  return { firm: fb.firm, individual: fb.individual, via: "static-fallback", verified: false };
}

// True if a leading sample looks like XML rather than CSV. Used by the ingest router to
// send the live XML feed to the XML parser (and to keep the CSV path from mis-reading it).
export function looksLikeXml(sample) {
  const s = String(sample || "").trimStart();
  return s.startsWith("<?xml") || s.startsWith("<");
}

// ── XML feed parsing (the SEC's LIVE format) ─────────────────────────────────────────
// The task brief said CSV; the live IAPD feeds are XML. IA_FIRM_SEC_Feed*.xml.gz is one
// <IAPDFirmSECReport> with many <Firm> elements; IA_INDVL_Feed*.xml.zip unzips to ~20
// <IAPDIndividualReport> files with many <Indvl> elements. These parsers STREAM one
// element at a time (feeds are 50-170 MB) and emit the SAME record shape as the CSV
// mappers above, so db.upsertFirm/upsertAdviser and the rest of the pipeline are unchanged.
// Fields live on child elements/attributes (verified against the live 2026-07 feed):
//   Firm : Info@FirmCrdNb/SECNb/BusNm/LegalNm · MainAddr@Strt1/Strt2/City/State/Cntry/
//          PostlCd/PhNb · Rgstn@FirmType/St · Item5A@TtlEmp · Item5F@Q5F2C(RAUM)/Q5F2F
//          (accounts) · WebAddrs>WebAddr(text)
//   Indvl: Info@indvlPK(CRD)/firstNm/lastNm · first CrntEmp@orgPK(firm CRD)/orgNm/str1/
//          city/state/cntry/postlCd

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Decode the XML entities that appear in the feed (named + numeric, decimal and hex).
export function decodeXmlEntities(s) {
  if (s == null) return s;
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(XML_ENTITIES, ent) ? XML_ENTITIES[ent] : m;
  });
}

// Attributes of the FIRST <tag ...> found in `block`, as a plain object (values decoded).
export function xmlAttrs(block, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*?)/?>`, "i");
  const m = re.exec(block);
  if (!m) return {};
  const attrs = {};
  const are = /([A-Za-z0-9_:.]+)\s*=\s*"([^"]*)"/g;
  let a;
  while ((a = are.exec(m[1])) !== null) attrs[a[1]] = decodeXmlEntities(a[2]);
  return attrs;
}

// Trimmed, entity-decoded text of the FIRST <tag>...</tag> in `block` (or null).
export function xmlText(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  if (!m) return null;
  const t = decodeXmlEntities(m[1].trim());
  return t === "" ? null : t;
}

// Streaming element extractor. push(chunk) returns any complete "<tag ...>...</tag>"
// blocks now available; at most one partial element stays buffered, so memory is flat on
// a 170 MB feed. The lookahead `(?=[\s/>])` stops `<Firm` from also matching `<Firms>`.
export function createXmlElementExtractor(tag) {
  const closeTag = `</${tag}>`;
  const openRe = new RegExp(`<${tag}(?=[\\s/>])`, "g");
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      const out = [];
      let ci;
      while ((ci = buf.indexOf(closeTag)) !== -1) {
        const end = ci + closeTag.length;
        const head = buf.slice(0, end);
        openRe.lastIndex = 0;
        let start = -1;
        let m;
        while ((m = openRe.exec(head)) !== null) start = m.index; // last open before close
        if (start === -1) {
          buf = buf.slice(end); // stray close with no open — drop it
          continue;
        }
        out.push(buf.slice(start, end));
        buf = buf.slice(end);
      }
      return out;
    },
    flush() {
      buf = "";
      return [];
    },
  };
}

// Map one <Firm>...</Firm> block → an upsertFirm() record (null when it has no CRD).
export function mapFirmXmlElement(block) {
  const info = xmlAttrs(block, "Info");
  const addr = xmlAttrs(block, "MainAddr");
  const rgstn = xmlAttrs(block, "Rgstn");
  const item5a = xmlAttrs(block, "Item5A");
  const item5f = xmlAttrs(block, "Item5F");
  const crd = normalizeCrd(info.FirmCrdNb);
  if (crd == null) return null;
  const website = xmlText(block, "WebAddr");
  return {
    crd,
    secNumber: info.SECNb || null,
    firmName: info.BusNm || info.LegalNm || null,
    street1: addr.Strt1 || null,
    street2: addr.Strt2 || null,
    city: addr.City || null,
    state: normState(addr.State),
    zip: normalizeZip(addr.PostlCd),
    country: addr.Cntry || null,
    phone: addr.PhNb || null,
    website,
    aum: parseAum(item5f.Q5F2C),
    totalEmployees: parseIntOrNull(item5a.TtlEmp),
    numAccounts: parseIntOrNull(item5f.Q5F2F),
    registrationStatus: rgstn.FirmType || rgstn.St || null,
    raw: { info, mainAddr: addr, rgstn, item5A: item5a, item5F: item5f, website },
  };
}

// Map one <Indvl>...</Indvl> block → an upsertAdviser() record (null when it has no CRD).
export function mapAdviserXmlElement(block) {
  const info = xmlAttrs(block, "Info");
  const emp = xmlAttrs(block, "CrntEmp"); // first current employer = primary
  const crd = normalizeCrd(info.indvlPK);
  if (crd == null) return null;
  return {
    crd,
    firstName: info.firstNm || null,
    lastName: info.lastNm || null,
    currentFirmCrd: normalizeCrd(emp.orgPK),
    currentFirmName: emp.orgNm || null,
    street1: emp.str1 || null,
    street2: emp.str2 || null,
    city: emp.city || null,
    state: normState(emp.state),
    zip: normalizeZip(emp.postlCd),
    country: emp.cntry || null,
    raw: { info, crntEmp: emp },
  };
}

// Stream a URL to disk. Transparently gunzips a .gz; a .zip is written as-is and
// flagged needsUnzip (Node has no built-in zip-container extraction — the deploy/init
// step unzips it, mirroring how GeoNames US.zip is handled). Returns
// { path, needsUnzip, gunzipped }.
export async function downloadToFile(url, dest, { fetchImpl, userAgent } = {}) {
  const fetch2 = fetchImpl || globalThis.fetch;
  const res = await fetch2(url, { headers: { "user-agent": userAgent || config.sec.userAgent } });
  if (!res || !res.ok) {
    throw new Error(`download failed ${res ? res.status : "no-response"} for ${url}`);
  }
  const lower = String(url).toLowerCase();
  const isGz = lower.endsWith(".gz");
  const needsUnzip = lower.endsWith(".zip");
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const source = Readable.fromWeb(res.body);
  if (isGz) {
    await pipeline(source, zlib.createGunzip(), fs.createWriteStream(dest));
  } else {
    await pipeline(source, fs.createWriteStream(dest));
  }
  return { path: dest, needsUnzip, gunzipped: isGz };
}
