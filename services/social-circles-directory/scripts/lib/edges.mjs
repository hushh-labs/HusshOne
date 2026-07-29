// Edge derivation for the social-circles graph.
//
// Given resolved graph NODES (persons/orgs, each with a DB id + normalized
// attributes) this derives the relationship edges between them:
//
//   shared_address      same normalized street + zip           weight 0.9
//   same_org            same normalized employer/firm          weight 0.7
//   same_zip_profession same zip + same profession bucket       weight 0.2  (low, coarse)
//   name_alias          same name_key across >=2 verticals      weight 0.95 (merge candidate)
//   social_follow       directed, from social-scraper data      weight 0.5
//   social_mention      directed, from social-scraper data      weight 0.3
//
// Undirected types are normalized so src_person_id < dst_person_id and de-duped;
// the two social types keep their direction. Pure function — unit-tested with
// fixtures, no DB.

export const EDGE_WEIGHTS = {
  shared_address: 0.9,
  same_org: 0.7,
  same_zip_profession: 0.2,
  name_alias: 0.95,
  social_follow: 0.5,
  social_mention: 0.3,
};

// Group node indices by a keying function; skip null/empty keys.
function groupBy(nodes, keyFn) {
  const groups = new Map();
  for (const node of nodes) {
    const k = keyFn(node);
    if (k == null || k === "") continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(node);
  }
  return groups;
}

// Emit an undirected edge with src<dst normalization into the accumulator.
function addUndirected(map, a, b, edgeType, evidence) {
  if (a.id == null || b.id == null || a.id === b.id) return;
  const [src, dst] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  const key = `${edgeType}:${src}:${dst}`;
  if (map.has(key)) return; // idempotent within a pass
  map.set(key, {
    srcPersonId: src,
    dstPersonId: dst,
    edgeType,
    weight: EDGE_WEIGHTS[edgeType],
    evidence: evidence || {},
  });
}

// All unordered pairs of a group emit one edge each.
function pairsIntoEdges(map, group, edgeType, evidenceFn) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      addUndirected(map, group[i], group[j], edgeType, evidenceFn(group[i], group[j]));
    }
  }
}

// nodes: [{ id, nameKey, zip, state, profession, orgKey, addressKey, verticals }]
// socialRelations: [{ srcId, dstId, type: 'follow'|'mention', evidence }]
export function deriveEdges(nodes, socialRelations = [], { maxSameZipGroup = 0 } = {}) {
  const edges = new Map();

  // shared_address — strongest co-location signal.
  for (const group of groupBy(nodes, (n) => n.addressKey).values()) {
    if (group.length > 1) {
      pairsIntoEdges(edges, group, "shared_address", (a) => ({ addressKey: a.addressKey }));
    }
  }

  // same_org — colleagues / adviser↔firm.
  for (const group of groupBy(nodes, (n) => n.orgKey).values()) {
    if (group.length > 1) {
      pairsIntoEdges(edges, group, "same_org", (a) => ({ orgKey: a.orgKey }));
    }
  }

  // same_zip_profession — coarse, low-weight neighborhood-of-peers signal. Capped
  // so a dense ZIP full of one profession can't blow up into an O(n^2) hairball.
  for (const [key, group] of groupBy(nodes, (n) =>
    n.zip && n.profession ? `${n.zip}|${n.profession}` : null,
  )) {
    if (group.length < 2) continue;
    if (maxSameZipGroup && group.length > maxSameZipGroup) continue;
    const [zip, profession] = key.split("|");
    pairsIntoEdges(edges, group, "same_zip_profession", () => ({ zip, profession }));
  }

  // name_alias — same normalized name spanning DIFFERENT verticals: likely the
  // same real person the resolver kept separate (no shared zip/org). A high-weight
  // merge candidate, NOT an automatic merge.
  for (const group of groupBy(nodes, (n) => n.nameKey).values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const verticals = new Set([...(a.verticals || []), ...(b.verticals || [])]);
        if (verticals.size < 2) continue; // same vertical, same name => likely distinct people
        addUndirected(edges, a, b, "name_alias", {
          nameKey: a.nameKey,
          verticals: [...verticals].sort(),
        });
      }
    }
  }

  // Directed social edges (only present when a social connector yielded data).
  for (const rel of socialRelations) {
    if (rel.srcId == null || rel.dstId == null || rel.srcId === rel.dstId) continue;
    const edgeType = rel.type === "mention" ? "social_mention" : "social_follow";
    const key = `${edgeType}:${rel.srcId}:${rel.dstId}`;
    if (edges.has(key)) continue;
    edges.set(key, {
      srcPersonId: rel.srcId,
      dstPersonId: rel.dstId,
      edgeType,
      weight: EDGE_WEIGHTS[edgeType],
      evidence: rel.evidence || {},
    });
  }

  return [...edges.values()].sort(
    (a, b) =>
      a.edgeType.localeCompare(b.edgeType) ||
      a.srcPersonId - b.srcPersonId ||
      a.dstPersonId - b.dstPersonId,
  );
}
