import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const VERTICALS = ["healthcare", "insurance", "advisory", "hotel"];

export const VERTICAL_CONFIG = {
  healthcare: {
    label: "healthcare providers and clinics",
    database: "healthcare",
    table: "providers",
    queries: ["healthcare providers", "doctors clinics", "medical practice"],
  },
  insurance: {
    label: "insurance agents and agencies",
    database: "insurance",
    table: "producers",
    queries: ["insurance agents", "insurance agencies", "insurance brokers"],
  },
  advisory: {
    label: "RIA firms and financial advisors",
    database: "ria",
    table: "firms/advisers",
    queries: ["RIA firms", "financial advisors", "wealth management firms"],
  },
  hotel: {
    label: "hotels and local businesses",
    database: "hotel_scraper",
    table: "hotels",
    queries: ["hotels", "local businesses"],
  },
};

export function cleanText(value, max = 1000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeName(value) {
  return cleanText(value, 300)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeZip(value) {
  const match = String(value ?? "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return match?.[1] || null;
}

export function domainFor(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

export function stableKey(record) {
  const identity = [
    record.vertical,
    normalizeName(record.name),
    normalizeZip(record.postalCode || record.queryZip) || "",
    record.phone?.replace(/\D/g, "") || "",
    domainFor(record.website || record.sourceUrl) || "",
  ].join("|");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

export function taskKey({ vertical, zip, query, source = "google_search" }) {
  return `${vertical}#${zip}#${source}#${crypto.createHash("sha1").update(query).digest("hex").slice(0, 12)}`;
}

export function buildQueries(vertical, zip, city, state) {
  const place = [city, state, zip].filter(Boolean).join(", ");
  return VERTICAL_CONFIG[vertical].queries.map((query) => `${query} in ${place}`);
}

export function normalizeObservation(raw) {
  const name = cleanText(raw.name, 300);
  if (!name || !raw.sourceUrl || !raw.vertical || !raw.queryZip) return null;
  const record = {
    stableKey: raw.stableKey || stableKey(raw),
    vertical: raw.vertical,
    queryZip: normalizeZip(raw.queryZip) || raw.queryZip,
    name,
    normalizedName: normalizeName(name),
    address: cleanText(raw.address, 500) || null,
    city: cleanText(raw.city, 120) || null,
    state: cleanText(raw.state, 2).toUpperCase() || null,
    postalCode: normalizeZip(raw.postalCode) || null,
    phone: cleanText(raw.phone, 80) || null,
    website: cleanText(raw.website, 1200) || null,
    source: cleanText(raw.source || "google_search", 80),
    sourceDomain: domainFor(raw.sourceUrl),
    sourceUrl: cleanText(raw.sourceUrl, 2000),
    sourceRank: Number.isInteger(raw.sourceRank) ? raw.sourceRank : null,
    categories: Array.isArray(raw.categories) ? raw.categories.map((v) => cleanText(v, 80)).filter(Boolean).slice(0, 20) : [],
    rating: Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : null,
    raw: raw.raw && typeof raw.raw === "object" ? raw.raw : {},
    canonicalDatabase: VERTICAL_CONFIG[raw.vertical]?.database || null,
    canonicalTable: VERTICAL_CONFIG[raw.vertical]?.table || null,
  };
  return record;
}

export function extractJsonLd(documentJson) {
  const out = [];
  for (const item of documentJson || []) {
    if (!item || typeof item !== "object") continue;
    const graph = Array.isArray(item["@graph"]) ? item["@graph"] : [item];
    for (const node of graph) {
      if (!node || typeof node !== "object") continue;
      const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      if (type.some((v) => /organization|localbusiness|medicalbusiness|professionalservice|lodgingbusiness/i.test(String(v)))) {
        out.push(node);
      }
    }
  }
  return out;
}

export function jsonLdToObservation(node, context) {
  const address = typeof node.address === "string" ? node.address : node.address?.streetAddress;
  const city = typeof node.address === "object" ? node.address.addressLocality : null;
  const state = typeof node.address === "object" ? node.address.addressRegion : null;
  const postalCode = typeof node.address === "object" ? node.address.postalCode : null;
  const website = typeof node.url === "string" ? node.url : null;
  return normalizeObservation({
    ...context,
    name: node.name,
    address,
    city,
    state,
    postalCode,
    phone: node.telephone,
    website,
    rating: node.aggregateRating?.ratingValue,
    categories: Array.isArray(node.category) ? node.category : node.category ? [node.category] : [],
    raw: node,
  });
}

export async function readJsonLines(file) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function ensureDir(dir) {
  await fs.mkdir(path.resolve(dir), { recursive: true });
}
