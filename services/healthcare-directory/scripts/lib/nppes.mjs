// Pure helpers for the NPPES NPI Registry vertical: CSV field parsing, the
// header→column index map, NPPES-row→provider mapping, entity-type + taxonomy
// mapping, and the bulk-file discovery (parse the index HTML for the newest
// monthly + weekly ZIP hrefs). Everything here is side-effect free and unit-tested
// with fixtures — no network, no DB, no filesystem.

import { normalizeZip } from "./zip.mjs";

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

// Parse one complete logical CSV record (the NPPES pfile is comma-separated, every
// field wrapped in double quotes, with "" as an escaped quote inside a field).
// Handles: quoted fields, escaped quotes, commas inside quotes, and (defensively)
// newlines inside quotes. A trailing \r (CRLF) is stripped from the last field.
export function parseCsvLine(line) {
  const out = [];
  let field = "";
  let inQuotes = false;
  const s = String(line ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false; // closing quote
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else if (ch === "\r") {
      // ignore bare CR (CRLF line endings)
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

// ---------------------------------------------------------------------------
// Header → column index
// ---------------------------------------------------------------------------

// NPPES ships a header row naming every column. We map by NAME (not position) so the
// V2 field-length changes — or any column reordering — don't silently corrupt data.
// The 15 taxonomy code/switch slots are collected as ordered arrays.
const HEADER_KEYS = {
  npi: "NPI",
  entityType: "Entity Type Code",
  orgName: "Provider Organization Name (Legal Business Name)",
  lastName: "Provider Last Name (Legal Name)",
  firstName: "Provider First Name",
  middleName: "Provider Middle Name",
  credential: "Provider Credential Text",
  addr1: "Provider First Line Business Practice Location Address",
  addr2: "Provider Second Line Business Practice Location Address",
  city: "Provider Business Practice Location Address City Name",
  state: "Provider Business Practice Location Address State Name",
  postal: "Provider Business Practice Location Address Postal Code",
  phone: "Provider Business Practice Location Address Telephone Number",
  enumerationDate: "Provider Enumeration Date",
  deactivationDate: "NPI Deactivation Date",
  reactivationDate: "NPI Reactivation Date",
};

// Build the column-index map from the parsed header row. Unknown-but-required headers
// resolve to -1 (the mapper treats those fields as null). Taxonomy slots 1..15 are
// discovered by their numbered suffix.
export function buildNppesIndex(headerFields) {
  const pos = new Map();
  headerFields.forEach((h, i) => {
    if (!pos.has(h)) pos.set(h, i); // first occurrence wins
  });
  const idx = {};
  for (const [key, header] of Object.entries(HEADER_KEYS)) {
    idx[key] = pos.has(header) ? pos.get(header) : -1;
  }
  idx.taxonomyCodes = [];
  idx.taxonomySwitches = [];
  for (let n = 1; n <= 15; n++) {
    const code = pos.get(`Healthcare Provider Taxonomy Code_${n}`);
    const sw = pos.get(`Healthcare Provider Primary Taxonomy Switch_${n}`);
    if (code != null) idx.taxonomyCodes.push(code);
    if (sw != null) idx.taxonomySwitches.push(sw);
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

export function entityTypeFromCode(code) {
  const c = String(code ?? "").trim();
  if (c === "1") return "individual";
  if (c === "2") return "organization";
  return null;
}

// NPPES enumeration/deactivation dates are "MM/DD/YYYY". Return ISO "YYYY-MM-DD"
// (a valid Postgres date literal) or null.
export function toIsoDate(mmddyyyy) {
  const s = String(mmddyyyy ?? "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// A curated NUCC taxonomy code → human specialty map. The NPPES pfile stores only
// the CODE (the description lives in the separate NUCC reference set), so we resolve
// the most common specialties inline and leave the long tail to null — the NPI API
// refresh path fills descriptions directly when it enriches a slice. Intentionally
// small and honest: unknown codes return null rather than a stale guess.
export const TAXONOMY_DESC = {
  "207Q00000X": "Family Medicine",
  "208D00000X": "General Practice",
  "207R00000X": "Internal Medicine",
  "208000000X": "Pediatrics",
  "207V00000X": "Obstetrics & Gynecology",
  "207P00000X": "Emergency Medicine",
  "2084P0800X": "Psychiatry",
  "207T00000X": "Neurological Surgery",
  "207X00000X": "Orthopaedic Surgery",
  "208600000X": "Surgery",
  "207W00000X": "Ophthalmology",
  "207N00000X": "Dermatology",
  "207RC0000X": "Cardiovascular Disease",
  "1223G0001X": "Dentist - General Practice",
  "363L00000X": "Nurse Practitioner",
  "363A00000X": "Physician Assistant",
  "1041C0700X": "Clinical Social Worker",
  "225100000X": "Physical Therapist",
  "183500000X": "Pharmacist",
  "152W00000X": "Optometrist",
  "111N00000X": "Chiropractor",
  "122300000X": "Dentist",
  "367500000X": "Certified Registered Nurse Anesthetist",
  "163W00000X": "Registered Nurse",
  "251E00000X": "Home Health Agency",
  "282N00000X": "General Acute Care Hospital",
  "3336C0003X": "Community/Retail Pharmacy",
  "261Q00000X": "Clinic/Center",
  "374700000X": "Technician",
  "171100000X": "Acupuncturist",
};

export function taxonomyDesc(code) {
  const c = String(code ?? "").trim().toUpperCase();
  return TAXONOMY_DESC[c] || null;
}

// Compute status from the deactivation/reactivation dates. The monthly full file
// normally excludes deactivated NPIs, but the columns exist: a deactivation date
// with no later reactivation => 'deactivated', otherwise 'active'.
export function statusFromDates(deactivationDate, reactivationDate) {
  const deact = toIsoDate(deactivationDate);
  if (!deact) return "active";
  const react = toIsoDate(reactivationDate);
  if (react && react >= deact) return "active"; // ISO strings sort chronologically
  return "deactivated";
}

// Pick the primary taxonomy: the slot whose "Primary Taxonomy Switch" is "Y".
// Falls back to the first non-empty code if none is flagged primary.
export function pickPrimaryTaxonomy(fields, idx) {
  const codes = idx.taxonomyCodes || [];
  const switches = idx.taxonomySwitches || [];
  let firstCode = null;
  for (let i = 0; i < codes.length; i++) {
    const code = String(fields[codes[i]] ?? "").trim();
    if (!code) continue;
    if (firstCode == null) firstCode = code;
    const sw = String(fields[switches[i]] ?? "").trim().toUpperCase();
    if (sw === "Y") return code;
  }
  return firstCode;
}

const clean = (v) => {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
};

// Map one parsed NPPES data row (array of fields) to a provider record. Returns null
// for rows without a valid 10-digit NPI. `source` tags provenance ('nppes_bulk' or
// 'nppes_weekly'). Uses the PRACTICE-location address fields, never the mailing address.
export function mapNppesRow(fields, idx, source = "nppes_bulk") {
  if (!Array.isArray(fields) || !idx) return null;
  const get = (i) => (i != null && i >= 0 ? fields[i] : undefined);

  const npi = String(get(idx.npi) ?? "").trim();
  if (!/^\d{10}$/.test(npi)) return null;

  const primaryCode = pickPrimaryTaxonomy(fields, idx);

  return {
    npi,
    entityType: entityTypeFromCode(get(idx.entityType)),
    lastName: clean(get(idx.lastName)),
    firstName: clean(get(idx.firstName)),
    middleName: clean(get(idx.middleName)),
    credential: clean(get(idx.credential)),
    organizationName: clean(get(idx.orgName)),
    primaryTaxonomyCode: primaryCode || null,
    primaryTaxonomyDesc: primaryCode ? taxonomyDesc(primaryCode) : null,
    enumerationDate: toIsoDate(get(idx.enumerationDate)),
    status: statusFromDates(get(idx.deactivationDate), get(idx.reactivationDate)),
    addressLine1: clean(get(idx.addr1)),
    addressLine2: clean(get(idx.addr2)),
    city: clean(get(idx.city)),
    state: (clean(get(idx.state)) || "").toUpperCase().slice(0, 2) || null,
    zip: normalizeZip(get(idx.postal)),
    phone: clean(get(idx.phone)),
    source,
    raw: null, // bulk rows are voluminous; raw JSON is reserved for API-enriched rows
  };
}

// ---------------------------------------------------------------------------
// Bulk-file discovery (parse the NPPES index HTML)
// ---------------------------------------------------------------------------

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// MMDDYY (as used in weekly filenames) -> a sortable YYYYMMDD number. Two-digit
// years are treated as 2000-2099 (NPPES has only ever published in the 2000s).
function mmddyyToSortable(mmddyy) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(String(mmddyy));
  if (!m) return -1;
  const [, mm, dd, yy] = m;
  return 20000000 + Number(yy) * 10000 + Number(mm) * 100 + Number(dd);
}

// Extract every .zip href from the index HTML and resolve it against baseUrl.
function extractZipHrefs(html, baseUrl) {
  const hrefs = [];
  const re = /href\s*=\s*['"]([^'"]+\.zip)['"]/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    let url;
    if (/^https?:\/\//i.test(raw)) url = raw;
    else url = new URL(raw, baseUrl).toString();
    hrefs.push({ href: raw, url, filename: url.split("/").pop() });
  }
  return hrefs;
}

// Classify + rank the index links and return the newest monthly + weekly full
// dissemination files. Deactivation reports and the weekly's start date are ignored.
//
// Monthly full-replacement:  NPPES_Data_Dissemination_<Month>_<Year>[_V<n>].zip
// Weekly incremental:        NPPES_Data_Dissemination_<MMDDYY>_<MMDDYY>_Weekly[_V<n>].zip
//
// Returns { monthly, weekly } where each is { url, filename, sortKey, version } or null.
export function discoverLatestBulkUrl(html, baseUrl = "https://download.cms.gov/nppes/") {
  const links = extractZipHrefs(html, baseUrl);

  const monthlyRe = /^NPPES_Data_Dissemination_([A-Za-z]+)_(\d{4})(?:_V(\d+))?\.zip$/i;
  const weeklyRe = /^NPPES_Data_Dissemination_(\d{6})_(\d{6})_Weekly(?:_V(\d+))?\.zip$/i;

  let monthly = null;
  let weekly = null;

  for (const link of links) {
    const name = link.filename || "";
    // Never mistake the deactivation report for a full/weekly data file.
    if (/deactivat/i.test(name)) continue;

    const wm = weeklyRe.exec(name);
    if (wm) {
      const endSort = mmddyyToSortable(wm[2]); // rank by the END of the week range
      const version = wm[3] ? Number(wm[3]) : 1;
      const sortKey = endSort * 10 + version; // prefer higher V for the same week
      if (!weekly || sortKey > weekly.sortKey) {
        weekly = { url: link.url, filename: name, sortKey, version };
      }
      continue;
    }

    const mm = monthlyRe.exec(name);
    if (mm) {
      const month = MONTHS[mm[1].toLowerCase()];
      if (!month) continue; // not a real month name (defensive)
      const year = Number(mm[2]);
      const version = mm[3] ? Number(mm[3]) : 1;
      const sortKey = (year * 100 + month) * 10 + version;
      if (!monthly || sortKey > monthly.sortKey) {
        monthly = { url: link.url, filename: name, sortKey, version };
      }
    }
  }

  return { monthly, weekly };
}
