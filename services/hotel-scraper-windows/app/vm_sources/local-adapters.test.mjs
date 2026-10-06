import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {protectQuery} from './query-guard.mjs';
import {runIngestCycle,ingestXmlFile} from './ria-directory/scripts/lib/pipeline.mjs';
import {runStateAdapter} from './insurance-directory/scripts/lib/pipeline.mjs';

test('local SQL policy rejects destructive and schema operations', () => {
  for (const sql of ['DELETE FROM providers', 'TRUNCATE hotels', 'DROP TABLE producers', 'CREATE TABLE x(a int)', 'ALTER ROLE directories'])
    assert.throws(() => protectQuery(sql));
  assert.equal(protectQuery('SELECT 1'), 'SELECT 1');
  assert.throws(() => protectQuery('INSERT INTO email_reports (ok) VALUES(true)', 'healthcare'));
  assert.throws(() => protectQuery('UPDATE zips SET city=$1', 'ria'));
  assert.throws(() => protectQuery('INSERT INTO providers (npi) VALUES($1)', 'insurance'));
  for (const ending of ['FOR UPDATE', 'FOR UPDATE SKIP LOCKED', 'FOR UPDATE NOWAIT'])
    assert.equal(protectQuery('SELECT state FROM state_progress LIMIT 1 ' + ending, 'insurance'), 'SELECT state FROM state_progress LIMIT 1 ' + ending);
  assert.throws(() => protectQuery('SELECT state FROM state_progress FOR UPDATE SKIP LOCKED; UPDATE zips SET city=$1', 'insurance'));
});

test('insurance overlaps distinct licenses but never races a shared identity', async () => {
  const events=[], rows=[['TX','1'],['CA','1'],['TX','2'],['TX','1']];
  let active=0,peak=0;
  const adapter={code:'TX',kind:'fixture',async *records(){for(let i=0;i<rows.length;i++)yield{sourceState:rows[i][0],licenseNo:rows[i][1],version:i}}};
  const result=await runStateAdapter(adapter,{upsertConcurrency:3,upsertProducer:async r=>{
    active++;peak=Math.max(peak,active);events.push('start:'+r.version);
    await new Promise(resolve=>setTimeout(resolve,10));events.push('done:'+r.version);active--;return {inserted:false};
  }});
  assert.equal(result.upserted,4);assert.equal(result.inserted,0);assert.ok(peak>1 && peak<=3);
  assert.ok(events.indexOf('done:0')<events.indexOf('start:3'));
  await assert.rejects(runStateAdapter(adapter,{upsertConcurrency:3,upsertProducer:async()=>{throw new Error('fixture failure')}}));
});

test('RIA overlaps independent CRDs but preserves repeated identity order', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),'husshone-ria-parallel-'));
  try {
    const filePath=path.join(folder,'fixture.xml');
    await fs.writeFile(filePath,'<Firms>' + [1,2,3,1,4,5].map((id,i)=>`<Firm><Info FirmCrdNb="${id}" LegalNm="Version ${i}"/></Firm>`).join('') + '</Firms>');
    let active=0, peak=0;
    const events=[];
    const result=await ingestXmlFile({filePath,kind:'firms',deps:{upsertConcurrency:3,
      startIngestRun:async()=>1,finishIngestRun:async()=>{},
      upsertFirm:async rec=>{ active++; peak=Math.max(peak,active); events.push('start:'+rec.firmName); await new Promise(r=>setTimeout(r,10)); events.push('done:'+rec.firmName);active--;return true; }
    }});
    assert.equal(result.rowsUpserted,6);
    assert.ok(peak>1 && peak<=3);
    assert.ok(events.indexOf('done:Version 0')<events.indexOf('start:Version 3'));
    let ledger;
    await assert.rejects(ingestXmlFile({filePath,kind:'firms',deps:{upsertConcurrency:3,
      startIngestRun:async()=>1,finishIngestRun:async(_,out)=>{ledger=out},
      upsertFirm:async()=>{throw new Error('fixture failure')}
    }}));
    assert.equal(ledger.ok,false);
  } finally {await fs.rm(folder,{recursive:true,force:true});}
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
