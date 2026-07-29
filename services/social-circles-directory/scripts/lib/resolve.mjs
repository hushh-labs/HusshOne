// Entity resolution for the social-circles graph.
//
// Input: normalized "entities" from the source connectors (one per source row).
// Output: resolved clusters (graph NODES) + the source->node mapping.
//
// Design goal: be CONSERVATIVE — never merge two distinct real people just because
// they share a common name. Two entities are merged into ONE node only when they
// share a normalized name AND a corroborating discriminator (same ZIP or same
// org). Entities that only share a name (no shared zip/org) stay SEPARATE nodes;
// a `name_alias` edge (derived later) flags them as likely-same-person merge
// candidates without silently collapsing them.
//
// All functions here are PURE (no DB, no clock, no env) so they are unit-tested
// with fixtures only.

// ---- string normalization --------------------------------------------------

// Lowercase, strip diacritics + punctuation, expand "&", collapse whitespace.
export function normalizeName(value) {
  if (value == null) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining diacritical marks
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Honorifics/credentials/generational suffixes we drop from a person name so that
// "Dr. Jane A. Smith, MD" and "Jane Smith" collapse to the same key.
const NAME_NOISE = new Set([
  "dr", "mr", "mrs", "ms", "miss", "prof",
  "md", "do", "dds", "dmd", "rn", "np", "pa", "phd", "esq", "cfp", "cfa", "cpa",
  "jr", "sr", "ii", "iii", "iv", "v",
]);

// Normalized key for a PERSON. Prefers explicit first/last; falls back to a full
// name with honorifics/suffixes and lone middle initials removed.
export function personNameKey({ firstName, lastName, name } = {}) {
  let tokens;
  if (firstName || lastName) {
    tokens = normalizeName(`${firstName || ""} ${lastName || ""}`).split(" ");
  } else {
    tokens = normalizeName(name).split(" ");
  }
  tokens = tokens
    .filter(Boolean)
    .filter((t) => !NAME_NOISE.has(t))
    .filter((t) => t.length > 1); // drop lone middle initials
  return tokens.join(" ");
}

// Corporate suffixes stripped so "Acme Advisors, LLC" and "Acme Advisors" match.
const ORG_SUFFIX = new Set([
  "llc", "inc", "incorporated", "corp", "corporation", "co", "company", "ltd",
  "lp", "llp", "pllc", "pc", "pa", "group", "grp", "associates", "assoc",
  "partners", "holdings", "capital", "advisors", "advisers", "the",
]);

// Normalized key for an ORG / firm / employer name.
export function normalizeOrg(value) {
  const tokens = normalizeName(value).split(" ").filter(Boolean);
  const kept = tokens.filter((t) => !ORG_SUFFIX.has(t));
  // If stripping suffixes removed everything (e.g. "The Co"), fall back to the raw
  // normalized tokens so we still have *something* to match on.
  return (kept.length ? kept : tokens).join(" ");
}

// Common USPS street-type expansions so "12 Lake Street" and "12 Lake St" match.
const STREET_ABBR = new Map([
  ["street", "st"], ["avenue", "ave"], ["av", "ave"], ["boulevard", "blvd"],
  ["drive", "dr"], ["road", "rd"], ["lane", "ln"], ["court", "ct"],
  ["place", "pl"], ["suite", "ste"], ["highway", "hwy"], ["parkway", "pkwy"],
  ["north", "n"], ["south", "s"], ["east", "e"], ["west", "w"],
]);

// A normalized street key (no zip). Empty string when nothing usable.
export function normalizeStreet(value) {
  return normalizeName(value)
    .split(" ")
    .filter(Boolean)
    .map((t) => STREET_ABBR.get(t) || t)
    .join(" ");
}

// A 5-digit ZIP or null.
export function cleanZip(value) {
  if (value == null) return null;
  const digits = String(value).replace(/[^\d]/g, "");
  if (digits.length < 5) return null;
  return digits.slice(0, 5);
}

// A 2-letter state or null.
export function cleanState(value) {
  const s = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

// Combined address key used for shared_address edges: street + zip. Requires BOTH
// a street and a zip (a bare zip is far too coarse for a "shared address").
export function addressKey(street, zip) {
  const s = normalizeStreet(street);
  const z = cleanZip(zip);
  if (!s || !z) return null;
  return `${s}|${z}`;
}

// ---- entity resolution -----------------------------------------------------

// Pick the most frequent non-empty value; ties broken by first-seen order.
function mode(values) {
  const counts = new Map();
  for (const v of values) {
    if (v == null || v === "") continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

// Union-Find (disjoint set) over entity indices.
function makeUF(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  return { find, union };
}

// Normalize one raw connector entity into the internal shape used for clustering.
export function normalizeEntity(e) {
  const isOrg = e.kind === "org";
  const nameKey = isOrg ? normalizeOrg(e.name) : personNameKey(e);
  const zip = cleanZip(e.zip);
  const orgKey = normalizeOrg(e.org) || (isOrg ? nameKey : "");
  return {
    sourceVertical: e.sourceVertical,
    sourceKey: String(e.sourceKey),
    kind: isOrg ? "org" : "person",
    profession: e.profession || null,
    name: e.name || null,
    nameKey,
    org: e.org || null,
    orgKey: orgKey || null,
    address: e.address || null,
    addressKey: addressKey(e.address, e.zip),
    zip,
    state: cleanState(e.state),
    attributes: e.attributes || {},
  };
}

// Resolve a list of raw entities into clusters (graph nodes).
// Returns { clusters, sourceMap } where sourceMap is
//   `${vertical}:${sourceKey}` -> clusterKey.
export function resolveEntities(rawEntities, { maxSameZipGroup } = {}) {
  const entities = rawEntities.map(normalizeEntity);
  const n = entities.length;
  const uf = makeUF(n);

  // Merge entities that share a corroborated identity key: name + zip, or name + org.
  // Every candidate key embeds the entity's own nameKey, so a connected component
  // always shares ONE nameKey (we never bridge across different names).
  const byKey = new Map();
  entities.forEach((e, i) => {
    if (!e.nameKey) return; // no usable name -> stays a singleton
    const keys = [];
    if (e.zip) keys.push(`n:${e.nameKey}|z:${e.zip}`);
    if (e.orgKey) keys.push(`n:${e.nameKey}|o:${e.orgKey}`);
    for (const k of keys) {
      if (byKey.has(k)) uf.union(byKey.get(k), i);
      else byKey.set(k, i);
    }
  });

  // Gather members per root.
  const groups = new Map();
  entities.forEach((e, i) => {
    const root = e.nameKey ? uf.find(i) : `single:${i}`;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  });

  const clusters = [];
  const sourceMap = new Map();

  for (const members of groups.values()) {
    const nameKey = mode(members.map((m) => m.nameKey)) || "";
    const zip = mode(members.map((m) => m.zip));
    const state = mode(members.map((m) => m.state));
    const orgKey = mode(members.map((m) => m.orgKey));
    const org = mode(members.map((m) => m.org));
    const address = mode(members.map((m) => m.address));
    const addr = mode(members.map((m) => m.addressKey));
    const canonicalName = mode(members.map((m) => m.name)) || nameKey || null;
    const profession = mode(members.map((m) => m.profession));
    const kind = members.some((m) => m.kind === "person") ? "person" : "org";
    const verticals = [...new Set(members.map((m) => m.sourceVertical))].sort();

    // Deterministic idempotency anchor. Prefer name + smallest discriminator; a
    // discriminator-less singleton is keyed by its (unique) source identity.
    const discriminators = [];
    for (const m of members) {
      if (m.zip) discriminators.push(`z:${m.zip}`);
      if (m.orgKey) discriminators.push(`o:${m.orgKey}`);
    }
    discriminators.sort();
    let clusterKey;
    if (nameKey && discriminators.length) {
      clusterKey = `n:${nameKey}|${discriminators[0]}`;
    } else if (nameKey) {
      clusterKey = `n:${nameKey}|s:${members[0].sourceVertical}:${members[0].sourceKey}`;
    } else {
      clusterKey = `s:${members[0].sourceVertical}:${members[0].sourceKey}`;
    }

    const sources = members.map((m) => ({
      sourceVertical: m.sourceVertical,
      sourceKey: m.sourceKey,
      sourceRef: {
        name: m.name,
        org: m.org,
        address: m.address,
        zip: m.zip,
        state: m.state,
      },
    }));

    for (const s of sources) sourceMap.set(`${s.sourceVertical}:${s.sourceKey}`, clusterKey);

    clusters.push({
      clusterKey,
      canonicalName,
      nameKey,
      zip: zip || null,
      state: state || null,
      profession: profession || null,
      kind,
      org: org || null,
      orgKey: orgKey || null,
      address: address || null,
      addressKey: addr || null,
      verticals,
      sources,
      attributes: {
        kind,
        verticals,
        sourceCount: sources.length,
      },
    });
  }

  // Two clusters can collide on clusterKey only if they share nameKey + the same
  // smallest discriminator, i.e. they are genuinely the same node — but they came
  // from different connected components (should not happen given the union rules).
  // Guard defensively by de-duping on clusterKey (merge sources) to keep the
  // downstream UNIQUE(cluster_key) upsert safe.
  const byCluster = new Map();
  for (const c of clusters) {
    const existing = byCluster.get(c.clusterKey);
    if (!existing) {
      byCluster.set(c.clusterKey, c);
    } else {
      existing.sources.push(...c.sources);
      existing.verticals = [...new Set([...existing.verticals, ...c.verticals])].sort();
      existing.attributes.verticals = existing.verticals;
      existing.attributes.sourceCount = existing.sources.length;
    }
  }

  const deduped = [...byCluster.values()].sort((a, b) => (a.clusterKey < b.clusterKey ? -1 : 1));

  // Optional guard exposed for callers that want to skip pathologically large
  // same-zip cohorts downstream (edges), passed through unchanged here.
  return { clusters: deduped, sourceMap, maxSameZipGroup: maxSameZipGroup ?? null };
}
