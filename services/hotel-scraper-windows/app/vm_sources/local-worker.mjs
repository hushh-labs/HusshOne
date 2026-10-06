// Local bootstrap for the imported registry VMs. Never invokes server.mjs,
// apply-schema, deploy, photo or mail commands.
import pg from 'pg';
import os from 'node:os';
import { protectQuery } from './query-guard.mjs';

const services = { healthcare: 'healthcare-directory', ria: 'ria-directory', insurance: 'insurance-directory' };
const vertical = process.argv[2];
if (!services[vertical] || process.env.PGDATABASE !== vertical) throw new Error('Invalid directory target');
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}

const NativePool = pg.Pool;
pg.Pool = class SafePool extends NativePool {
  constructor(options) {
    super({ ...options, max: 2, connectionTimeoutMillis: 8000,
      options: '-c statement_timeout=30000 -c lock_timeout=5000 -c application_name=husshone-local-vm' });
  }
};
const nativeQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (input, ...args) {
  // A registry query marks the beginning of active work. The lock heartbeat
  // is the only query that may run while the source worker sleeps.
  if ((typeof input === 'string' ? input : input?.text) !== 'SELECT 1') idle = false;
  const sql = protectQuery(typeof input === 'string' ? input : input?.text, vertical);
  return nativeQuery.call(this, typeof input === 'string' ? sql : { ...input, text: sql }, ...args);
};

// A reload request never interrupts an ingest. Exit only when the imported
// worker announces its between-cycle idle/sleep boundary (ledger committed).
let draining = false, idle = false;
const originalLog = console.log;
console.log = (...args) => {
  try {
    const item = JSON.parse(args[0]);
    idle = ['worker.sleep', 'worker.idle', 'worker.stop'].includes(item.event);
    if (draining && idle) { originalLog(JSON.stringify({event:'local.drained'})); process.exit(0); }
  } catch {}
  originalLog(...args);
};
process.stdin.setEncoding('utf8');
let control = '';
process.stdin.on('data', chunk => {
  control += chunk;
  if (control.length > 1024) process.exit(1);
  if (control.includes('drain\n')) {
    draining = true;
    originalLog(JSON.stringify({event:'local.update_pending'}));
    if (idle) { originalLog(JSON.stringify({event:'local.drained'})); process.exit(0); }
  }
});

// A dedicated session lock survives across batches and releases on abrupt exit.
const lock = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 8000, options: '-c statement_timeout=30000 -c lock_timeout=5000' });
await lock.connect();
const result = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [`husshone-local-vm:${vertical}`]);
if (!result.rows[0].acquired) { await lock.end(); throw new Error('Another local directory worker owns this target'); }
lock.on('error', () => process.exit(1));
setInterval(() => lock.query('SELECT 1').catch(() => process.exit(1)), 30_000).unref();
console.log(JSON.stringify({event:'local.imported_worker',vertical,transport:'official_registry_feed'}));
await import(`./${services[vertical]}/worker.mjs`);
