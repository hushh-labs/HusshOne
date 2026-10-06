// Per-state collection: run one adapter, upsert every producer it yields (merging
// repeated license rows onto one producers row), and return counts. This is the unit
// of work the 24/7 worker repeats across the configured states. Deps are injectable
// so the pipeline is unit-testable without network or DB.

// Run a single adapter to completion. For a `blocked` adapter, yield nothing and
// return its note so the caller can mark the state blocked. For a working adapter,
// stream records and upsert each. Returns:
//   { state, kind, blocked, note?, seen, upserted, inserted }
export async function runStateAdapter(adapter, deps = {}) {
  if (!adapter) throw new Error("runStateAdapter requires an adapter");
  // db.mjs (and its `pg` dependency) is imported lazily — only when no upsertProducer
  // is injected — so this module stays unit-testable without a live database.
  let upsert = deps.upsertProducer;
  if (!upsert) ({ upsertProducer: upsert } = await import("./db.mjs"));
  const log = deps.log;
  const fetchImpl = deps.fetchImpl;

  if (adapter.kind === "blocked") {
    return {
      state: adapter.code,
      kind: "blocked",
      blocked: true,
      note: adapter.note || "No accessible free data source.",
      seen: 0,
      upserted: 0,
      inserted: 0,
    };
  }

  let seen = 0;
  let upserted = 0;
  let inserted = 0;
  let firstFailure = null, progressAt = Date.now();
  const pending = new Set(), byIdentity = new Map();
  const concurrency = () => Math.max(1,Math.min(8,deps.upsertConcurrency || (process.env.SCRAPER_PERFORMANCE_MODE === 'throughput' ? 8 : 1)));
  try {
  for await (const rec of adapter.records({ log, fetchImpl })) {
    if (firstFailure) throw firstFailure;
    if (!rec) continue;
    seen++;
    while (pending.size >= concurrency()) await Promise.race(pending);
    const identity = JSON.stringify([rec.sourceState,rec.licenseNo]);
    const previous = byIdentity.get(identity);
    const task = (async () => {
      if (previous) await previous;
      const out = await upsert(rec);
      if (out) { upserted++; if(out.inserted) inserted++; }
      if (log && Date.now()-progressAt>=5000) {
        log({event:'pipeline.progress',state:adapter.code,rowsSeen:seen,upserted,inserted});
        progressAt=Date.now();
      }
    })();
    pending.add(task); byIdentity.set(identity,task);
    const clear=()=>{pending.delete(task);if(byIdentity.get(identity)===task)byIdentity.delete(identity);};
    task.then(clear,err=>{firstFailure ||= err;clear();});
  }
  await Promise.all(pending);
  if(firstFailure) throw firstFailure;
  return { state: adapter.code, kind: adapter.kind, blocked: false, seen, upserted, inserted };
  } catch(err) {await Promise.allSettled(pending);throw err;}
}
