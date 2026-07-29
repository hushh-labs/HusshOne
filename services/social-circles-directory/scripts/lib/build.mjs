// One full rebuild PASS of the social-circles graph, shared by worker.mjs (the
// 24/7 loop) and server.mjs (the manual POST /run kick).
//
// Pipeline:
//   1. open one pg Pool per SOURCE database (Postgres can't cross-DB query)
//   2. pull normalized entities + social relations from every source connector
//   3. resolve entities into graph nodes (conservative union-find)          [pure]
//   4. upsert nodes (persons), then re-point provenance links (person_sources)
//   5. derive relationship edges from the resolved nodes                    [pure]
//   6. upsert edges; optionally prune edges not seen this pass
//   7. record the build_run audit row
//
// Every step tolerates EMPTY or ABSENT source DBs: connectors return [] and log
// rather than throw, so a pass over zero data completes cleanly (0 nodes, 0 edges)
// instead of crashing the service.

import { config } from "./config.mjs";
import { gatherAllSources } from "./source-connectors.mjs";
import { resolveEntities } from "./resolve.mjs";
import { deriveEdges } from "./edges.mjs";
import {
  makeSourcePool,
  startBuildRun,
  finishBuildRun,
  upsertPersonsBatch,
  upsertPersonSourcesBatch,
  upsertEdgesBatch,
  pruneStaleEdges,
} from "./db.mjs";

const log = (event, extra = {}) => console.log(JSON.stringify({ event, ...extra }));

// Lazily open (and cache) one Pool per distinct source DATABASE. Two roles that map
// to the same database name (they don't today) would share a pool.
function makePoolProvider() {
  const byDb = new Map();
  const roleToDb = config.sources.names;
  const poolFor = (role) => {
    const dbName = roleToDb[role];
    if (!dbName) return null;
    if (!byDb.has(dbName)) byDb.set(dbName, makeSourcePool(dbName));
    return byDb.get(dbName);
  };
  const closeAll = async () => {
    for (const p of byDb.values()) await p.end().catch(() => {});
    byDb.clear();
  };
  return { poolFor, closeAll };
}

// Resolve social follow/mention relations (handle -> handle, within one platform)
// to node id pairs, using the resolver's source->cluster map + the cluster->id map.
// Relations whose endpoint we never ingested (e.g. a followee with no scraped
// profile) are silently skipped — we do NOT fabricate a node for them.
function resolveSocialRelations(relations, sourceMap, idByCluster) {
  const out = [];
  for (const rel of relations) {
    const srcCluster = sourceMap.get(`${rel.vertical}:${rel.srcHandle}`);
    const dstCluster = sourceMap.get(`${rel.vertical}:${rel.dstHandle}`);
    if (!srcCluster || !dstCluster) continue;
    const srcId = idByCluster.get(srcCluster);
    const dstId = idByCluster.get(dstCluster);
    if (srcId == null || dstId == null) continue;
    out.push({
      srcId,
      dstId,
      type: rel.type,
      evidence: { vertical: rel.vertical, srcHandle: rel.srcHandle, dstHandle: rel.dstHandle },
    });
  }
  return out;
}

// Run one full rebuild pass. Returns a summary; never throws for expected data
// problems (empty/missing sources) — only truly unexpected failures reject.
export async function runBuildPass(opts = {}) {
  const t0 = Date.now();
  const buildStart = new Date();
  const batchSize = opts.batchSize ?? config.sources.batchSize;
  const maxEntities = opts.maxEntities ?? config.sources.maxEntitiesPerSource;
  const maxSameZipGroup = opts.maxSameZipGroup ?? config.worker.maxSameZipGroup;
  const prune = opts.prune ?? config.worker.pruneStaleEdges;

  const runId = await startBuildRun();
  const { poolFor, closeAll } = makePoolProvider();

  try {
    // 2. gather from all sources (SQL connectors + social stubs).
    const { entities, relations, scanned, available } = await gatherAllSources(poolFor, {
      batchSize,
      maxEntities,
    });
    log("build.sources_scanned", { scanned, available, entities: entities.length, relations: relations.length });

    // 3. resolve into nodes (pure).
    const { clusters, sourceMap } = resolveEntities(entities, { maxSameZipGroup });

    // 4. upsert nodes, then provenance links.
    const idByCluster = await upsertPersonsBatch(clusters);
    const sourceRows = [];
    for (const c of clusters) {
      const personId = idByCluster.get(c.clusterKey);
      if (personId == null) continue;
      for (const s of c.sources) {
        sourceRows.push({
          personId,
          sourceVertical: s.sourceVertical,
          sourceKey: s.sourceKey,
          sourceRef: s.sourceRef,
        });
      }
    }
    const sourcesLinked = await upsertPersonSourcesBatch(sourceRows);

    // 5. derive edges (pure) from resolved nodes + social relations.
    const nodes = clusters.map((c) => ({
      id: idByCluster.get(c.clusterKey),
      nameKey: c.nameKey,
      zip: c.zip,
      state: c.state,
      profession: c.profession,
      orgKey: c.orgKey,
      addressKey: c.addressKey,
      verticals: c.verticals,
    }));
    const socialRelations = resolveSocialRelations(relations, sourceMap, idByCluster);
    const derived = deriveEdges(nodes, socialRelations, { maxSameZipGroup });

    // 6. upsert edges; prune only when enabled AND we actually produced nodes.
    const edgesInserted = await upsertEdgesBatch(derived);
    let edgesPruned = 0;
    if (prune && idByCluster.size > 0) {
      edgesPruned = await pruneStaleEdges(buildStart);
    }

    const summary = {
      ok: true,
      runId,
      personsUpserted: idByCluster.size,
      edgesUpserted: derived.length,
      edgesInserted,
      edgesPruned,
      sourcesLinked,
      sourcesScanned: scanned,
      sourcesAvailable: available,
      durationMs: Date.now() - t0,
    };
    await finishBuildRun(runId, {
      personsUpserted: summary.personsUpserted,
      edgesUpserted: summary.edgesUpserted,
      sourcesScanned: { ...scanned, _available: available, _edgesPruned: edgesPruned },
      ok: true,
    });
    log("build.pass_done", summary);
    return summary;
  } catch (err) {
    await finishBuildRun(runId, { ok: false, error: err.message }).catch(() => {});
    log("build.pass_error", { runId, message: err.message });
    throw err;
  } finally {
    await closeAll();
  }
}
