import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {protectQuery} from './query-guard.mjs';
import {runIngestCycle} from './ria-directory/scripts/lib/pipeline.mjs';

test('local SQL policy rejects destructive and schema operations', () => {
  for (const sql of ['DELETE FROM providers', 'TRUNCATE hotels', 'DROP TABLE producers', 'CREATE TABLE x(a int)', 'ALTER ROLE directories'])
    assert.throws(() => protectQuery(sql));
  assert.equal(protectQuery('SELECT 1'), 'SELECT 1');
  assert.throws(() => protectQuery('INSERT INTO email_reports (ok) VALUES(true)', 'healthcare'));
  assert.throws(() => protectQuery('UPDATE zips SET city=$1', 'ria'));
  assert.throws(() => protectQuery('INSERT INTO providers (npi) VALUES($1)', 'insurance'));
});

test('local upserts keep prior values when the feed is null and merge raw', () => {
  for (const table of ['providers', 'firms', 'advisers', 'producers']) {
    const sql = protectQuery(`INSERT INTO ${table}(raw) VALUES($1) ON CONFLICT(id) DO UPDATE SET phone = EXCLUDED.phone, raw = COALESCE(EXCLUDED.raw, ${table}.raw), last_seen = now()`);
    assert.ok(sql.includes(`COALESCE(EXCLUDED.phone, ${table}.phone)`));
    assert.ok(sql.includes(`COALESCE(${table}.raw, '{}'::jsonb) || COALESCE(EXCLUDED.raw, '{}'::jsonb)`));
  }
});

test('RIA compilation is not marked successful after only one successful XML part', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'husshone-ria-test-'));
  const finished = [], labels = [];
  try {
    await runIngestCycle({downloadDir: folder}, {
      discoverLatestCompilationUrls: async () => ({via:'fixture', individual:{name:'feed.zip',url:'https://fixture.invalid'}}),
      countFirms: async () => 1, lastSuccessfulIngest: async () => null,
      downloadToFile: async (_, dest) => ({path:dest,needsUnzip:true}),
      extractZip: async () => [path.join(folder,'one.xml'),path.join(folder,'two.xml')],
      startIngestRun: async args => { labels.push(args.sourceFile); return 1; },
      finishIngestRun: async (_, result) => finished.push(result),
      ingestFile: async args => { labels.push(args.sourceFile); if(args.filePath.endsWith('two.xml')) throw new Error('fixture crash'); return {ok:true,rowsSeen:1,rowsUpserted:1}; },
      log: () => {},
    });
    assert.equal(finished[0].ok, false);
    assert.deepEqual(labels, ['feed.zip','feed.zip/one.xml','feed.zip/two.xml']);
  } finally { await fs.rm(folder,{recursive:true,force:true}); }
});
