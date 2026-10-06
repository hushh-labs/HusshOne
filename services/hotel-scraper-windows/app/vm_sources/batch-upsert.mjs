// Multi-row execution of pinned native upserts. Each statement commits atomically.
// Repeated identities are flushed in source order, never silently discarded.
export async function executeUpsertBatch(records, build, identity, query) {
  let entries = [], keys = new Set(), written = 0, inserted = 0;
  async function flush() {
    if (!entries.length) return;
    const first = entries[0].sql;
    const start = first.indexOf('VALUES (');
    const end = first.indexOf('ON CONFLICT');
    if (start < 0 || end < start || entries.some(e => e.sql !== first))
      throw new Error('Unrecognised batch upsert template');
    const tuple = first.slice(start + 7, end).trim();
    const params = [];
    const tuples = entries.map(entry => {
      const offset = params.length;
      params.push(...entry.params);
      return tuple.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) + offset));
    });
    const result = await query(first.slice(0, start) + 'VALUES ' + tuples.join(',') + '\n' + first.slice(end), params);
    if (result.rows.length !== entries.length) throw new Error('Batch acknowledgement mismatch');
    written += result.rows.length;
    inserted += result.rows.filter(row => row.inserted).length;
    entries = []; keys = new Set();
  }
  for (const record of records) {
    const entry = await build(record, true);
    if (!entry) continue;
    const key = identity(record);
    if (keys.has(key) || entries.length >= 200) await flush();
    keys.add(key); entries.push(entry);
  }
  await flush();
  return {written, inserted};
}
