// Local bootstrap for the imported registry VMs. Never invokes server.mjs,
// apply-schema, deploy, photo or mail commands.
import pg from 'pg';
import os from 'node:os';
import { protectQuery } from './query-guard.mjs';

const services = { healthcare: 'healthcare-directory', ria: 'ria-directory', insurance: 'insurance-directory' };
const vertical = process.argv[2];
if (!services[vertical] || process.env.PGDATABASE !== vertical) throw new Error('Invalid directory target');
const pools = new Set();
// Legacy supervisors do not pass the new profile variable. This reviewed
// high-throughput release defaults those supervisors to the requested mode;
// current supervisors always pass their persisted explicit choice.
const profile = () => process.env.SCRAPER_PERFORMANCE_MODE || 'throughput';
const poolSize = () => profile() === 'throughput' ? 8 : profile() === 'training' ? 1 : 2;
function setProfile(mode) {
  if (!['training','balanced','throughput'].includes(mode)) return;
  process.env.SCRAPER_PERFORMANCE_MODE = mode;
  if (mode === 'throughput') process.env.NPPES_BATCH_SIZE = '1000';
  for (const pool of pools) pool.options.max = poolSize();
  try { os.setPriority(0, mode === 'throughput' ? os.constants.priority.PRIORITY_NORMAL : os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
}
setProfile(profile());

const NativePool = pg.Pool;
pg.Pool = class SafePool extends NativePool {
  constructor(options) {
    super({ ...options, max: poolSize(), connectionTimeoutMillis: 8000,
      options: '-c statement_timeout=30000 -c lock_timeout=5000 -c application_name=husshone-local-vm' });
    pools.add(this);
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
  while (control.includes('\n')) {
    const end = control.indexOf('\n'), command = control.slice(0,end);
    control = control.slice(end+1);
    if (command.startsWith('profile:')) setProfile(command.slice(8));
    if (command === 'drain') {
      draining = true;
      originalLog(JSON.stringify({event:'local.update_pending'}));
      if (idle) { originalLog(JSON.stringify({event:'local.drained'})); process.exit(0); }
    }
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
