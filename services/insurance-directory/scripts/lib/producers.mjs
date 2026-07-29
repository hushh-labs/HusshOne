// Normalize raw per-state licensee rows onto ONE producer shape (the `producers`
// table). Every adapter's `records()` yields objects of this shape; upsertProducer
// then geo-tags them by ZIP centroid. Pure helpers — no network, no DB.
//
// Producer record shape (all keys optional except sourceState + licenseNo):
//   {
//     sourceState, licenseNo, npn, fullName, firstName, lastName,
//     entityType: 'individual' | 'agency',
//     licenseTypes: string[], linesOfAuthority: string[], status: 'active'|'inactive',
//     addressLine1, addressLine2, city, state, zip, phone,
//     sources: string[], raw: object
//   }

import { normalizeZip } from "./zip.mjs";

export function normalizeState(value) {
  const s = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

const clean = (v) => {
  const s = String(v ?? "").trim();
  return s || null;
};

// Split a single name field into first/last, best-effort. Handles "LAST, FIRST M"
// and "FIRST MIDDLE LAST". Organizations pass through as last=null.
export function splitName(fullName) {
  const name = String(fullName ?? "").trim().replace(/\s+/g, " ");
  if (!name) return { firstName: null, lastName: null };
  if (name.includes(",")) {
    const [last, rest] = name.split(",", 2).map((s) => s.trim());
    return { firstName: rest || null, lastName: last || null };
  }
  const parts = name.split(" ");
  if (parts.length === 1) return { firstName: null, lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

// Derive active/inactive from an expiration date. Unparseable/blank -> null (unknown).
export function statusFromExpiration(expiration, now = new Date()) {
  if (!expiration) return null;
  const t = Date.parse(expiration);
  if (Number.isNaN(t)) return null;
  return t >= now.getTime() ? "active" : "inactive";
}

// Wrap a possibly-blank scalar as a deduped, non-empty string array.
export function toList(...values) {
  const out = [];
  for (const v of values.flat()) {
    const s = clean(v);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// Fill defaults + normalize types so every yielded record is DB-ready.
export function normalizeProducer(rec) {
  if (!rec || !rec.sourceState || !rec.licenseNo) return null;
  return {
    sourceState: normalizeState(rec.sourceState),
    licenseNo: String(rec.licenseNo).trim(),
    npn: clean(rec.npn),
    fullName: clean(rec.fullName),
    firstName: clean(rec.firstName),
    lastName: clean(rec.lastName),
    entityType: rec.entityType === "agency" ? "agency" : rec.entityType === "individual" ? "individual" : null,
    licenseTypes: Array.isArray(rec.licenseTypes) ? toList(rec.licenseTypes) : toList(rec.licenseTypes),
    linesOfAuthority: Array.isArray(rec.linesOfAuthority) ? toList(rec.linesOfAuthority) : toList(rec.linesOfAuthority),
    status: rec.status || null,
    addressLine1: clean(rec.addressLine1),
    addressLine2: clean(rec.addressLine2),
    city: clean(rec.city),
    state: normalizeState(rec.state),
    zip: normalizeZip(rec.zip),
    phone: clean(rec.phone),
    sources: toList(rec.sources),
    raw: rec.raw ?? null,
  };
}

// --- Texas (data.texas.gov) row mappers -------------------------------------
// The regulator is TX; the row's own state/pstl_cd are the licensee's MAILING
// address (often out-of-state — TDI licenses producers nationwide), which is what
// we geo-tag on.
const TX_INDIVIDUAL_SOURCE = "data.texas.gov/kxv3-diwf";
const TX_AGENCY_SOURCE = "data.texas.gov/3yqc-fcdt";

// kxv3-diwf: npn, license_number, name, license_type, qualification,
//            license_issue_date, expiration_date, city, state, pstl_cd, province
export function mapTxIndividualRow(row, now = new Date()) {
  if (!row) return null;
  const licenseNo = clean(row.license_number);
  if (!licenseNo) return null;
  const { firstName, lastName } = splitName(row.name);
  return normalizeProducer({
    sourceState: "TX",
    licenseNo,
    npn: row.npn,
    fullName: row.name,
    firstName,
    lastName,
    entityType: "individual",
    licenseTypes: toList(row.license_type),
    linesOfAuthority: toList(row.qualification),
    status: statusFromExpiration(row.expiration_date, now),
    city: row.city,
    state: row.state,
    zip: row.pstl_cd,
    sources: [TX_INDIVIDUAL_SOURCE],
    raw: row,
  });
}

// 3yqc-fcdt: npn, agency_license_number, org_name, agency_type, license_type,
//            qualification, license_issue_date, expiration_date, city, state,
//            pstl_cd, county
export function mapTxAgencyRow(row, now = new Date()) {
  if (!row) return null;
  const licenseNo = clean(row.agency_license_number);
  if (!licenseNo) return null;
  return normalizeProducer({
    sourceState: "TX",
    licenseNo,
    npn: row.npn,
    fullName: row.org_name,
    firstName: null,
    lastName: null,
    entityType: "agency",
    licenseTypes: toList(row.license_type, row.agency_type),
    linesOfAuthority: toList(row.qualification),
    status: statusFromExpiration(row.expiration_date, now),
    city: row.city,
    state: row.state,
    zip: row.pstl_cd,
    sources: [TX_AGENCY_SOURCE],
    raw: row,
  });
}
