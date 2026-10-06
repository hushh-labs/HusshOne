// Execute the imported VM's real per-ZIP pipeline. Only its Places transport
// and DB sink are injected; validated output returns to the desktop's durable,
// single-writer sink so recovery, CID checks and photo preservation remain.
import { processZip } from './hotel-scraper/scripts/lib/pipeline.mjs';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 2_000_000) throw new Error('Bridge input exceeds limit');
}
const payload = JSON.parse(input);
const records = [];
await processZip(payload.zipRow, {
  searchLodging: async () => ({ places: payload.places, calls: 0 }),
  upsertHotel: async record => { records.push(record); return { inserted: false }; },
  countHotelsForQueryZip: async () => records.length,
});
process.stdout.write(JSON.stringify(records));
