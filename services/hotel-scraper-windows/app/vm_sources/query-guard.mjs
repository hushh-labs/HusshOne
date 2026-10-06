// Defense in depth for pinned SQL only, not a general SQL firewall.
export function protectQuery(input, vertical) {
  if (typeof input !== 'string') throw new Error('Unrecognised query blocked');
  let sql = input;
  const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\b(?:DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|VACUUM)\b/i.test(code))
    throw new Error('Destructive or schema-changing query blocked');
  if (vertical) {
    const allowed = {healthcare:['providers','ingest_runs'], ria:['firms','advisers','ingest_runs'], insurance:['producers','state_progress']}[vertical];
    const writes = [...code.matchAll(/\b(?:INSERT\s+INTO|UPDATE)\s+(\w+)/gi)];
    for (const write of writes) {
      // ON CONFLICT DO UPDATE SET is not an UPDATE table statement.
      if (write[1].toLowerCase() !== 'set' && !allowed?.includes(write[1].toLowerCase()))
        throw new Error('Write outside this directory contract blocked');
    }
  }
  const match = sql.match(/INSERT\s+INTO\s+(providers|firms|advisers|producers)\b/i);
  if (match && /ON CONFLICT/i.test(sql)) {
    const table = match[1];
    const split = sql.search(/ON CONFLICT/i);
    sql = sql.slice(0, split) + sql.slice(split).replace(
      /(\b\w+\s*=\s*)EXCLUDED\.(\w+)(?=\s*[,\n]|\s*$)/gi,
      (_, assignment, column) => `${assignment}COALESCE(EXCLUDED.${column}, ${table}.${column})`);
    sql = sql.replace(new RegExp(`raw\\s*=\\s*COALESCE\\(EXCLUDED\\.raw,\\s*${table}\\.raw\\)`, 'i'),
      `raw = COALESCE(${table}.raw, '{}'::jsonb) || COALESCE(EXCLUDED.raw, '{}'::jsonb)`);
    sql = sql.replace(new RegExp(`raw\\s*=\\s*COALESCE\\(EXCLUDED\\.raw::jsonb,\\s*${table}\\.raw\\)`, 'i'),
      `raw = COALESCE(${table}.raw, '{}'::jsonb) || COALESCE(EXCLUDED.raw::jsonb, '{}'::jsonb)`);
  }
  return sql;
}
