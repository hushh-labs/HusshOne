import test from 'node:test';
import assert from 'node:assert/strict';
import {executeUpsertBatch} from './batch-upsert.mjs';
const build = async r => ({sql:'INSERT INTO firms (crd, firm_name) VALUES ($1,$2) ON CONFLICT (crd) DO UPDATE SET firm_name=EXCLUDED.firm_name RETURNING crd, (xmax=0) AS inserted',params:[r.id,r.name]});
test('batch shifts placeholders and acknowledges committed rows', async () => {
  const calls=[];
  const result=await executeUpsertBatch([{id:1,name:'A'},{id:2,name:'B'}],build,r=>r.id,async(sql,params)=>{
    calls.push({sql,params}); return {rows:[{inserted:true},{inserted:false}]};
  });
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/VALUES \(\$1,\$2\),\(\$3,\$4\)/);
  assert.deepEqual(calls[0].params,[1,'A',2,'B']);
  assert.deepEqual(result,{written:2,inserted:1});
});
test('duplicates flush in order rather than causing ON CONFLICT cardinality errors',async()=>{
  const calls=[];
  await executeUpsertBatch([{id:1,name:'A'},{id:1,name:'B'}],build,r=>r.id,async(sql,params)=>{
    calls.push(params);return {rows:[{}]};
  });
  assert.deepEqual(calls,[[1,'A'],[1,'B']]);
});
test('batches stay bounded and include final partial batch',async()=>{
  const sizes=[];
  await executeUpsertBatch(Array.from({length:405},(_,id)=>({id,name:'A'})),build,r=>r.id,async(sql,params)=>{
    sizes.push(params.length/2);return {rows:Array.from({length:params.length/2},()=>({}))};
  });
  assert.deepEqual(sizes,[200,200,5]);
});
test('failure stops subsequent batches and is not acknowledged',async()=>{
  let calls=0;
  await assert.rejects(executeUpsertBatch([{id:1},{id:1},{id:2}],build,r=>r.id,async()=>{
    calls++;throw new Error('offline');
  }),/offline/);
  assert.equal(calls,1);
});
