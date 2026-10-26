import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {kmeans,clusteredSample} from '../packages/sampling/kmeans.js';import {SemanticSampler} from '../packages/sampling/semantic.js';
test('seeded KMeans separates semantic vectors, preserves heat-ranked representatives and validates malformed input',()=>{
 const vectors=[[0,0],[0,.1],[10,10],[10,10.1]],fit=kmeans(vectors,2);assert.equal(fit.labels[0],fit.labels[1]);assert.equal(fit.labels[2],fit.labels[3]);assert.notEqual(fit.labels[0],fit.labels[2]);assert.deepEqual(kmeans(vectors,2),fit);
 assert.throws(()=>kmeans([[NaN]],1));assert.throws(()=>kmeans([[1],[2,3]],1));
 const result=clusteredSample([{heat:1},{heat:3},{heat:2},{heat:4}],vectors,2,1,row=>row.heat);assert.deepEqual(result.items.map(x=>x.heat).sort(),[3,4]);assert.equal(new Set(result.indices).size,2);
 assert.equal(clusteredSample([1,2],[],3).sampled,false);
});
test('semantic sampling caches local vectors, reports fallback honestly and cancellation cannot attach late output',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-semantic-')),rows=Array.from({length:40},(_,i)=>({id:String(i),title:'主题'+i,content:'归档材料'+i}));let calls=0;
 const engine={version:'fixture-v1',embed:async(texts:string[])=>{calls++;return texts.map(t=>{const n=Number(t.match(/主题(\d+)/)![1]);return [n<20?0:10,n%20/100];});}},sampler=new SemanticSampler(dir,engine);
 const first=await sampler.sample(rows,()=>{});assert.equal(first.method,'multilingual-minilm-kmeans');assert.ok(first.rows.length<=30);assert.equal(calls,5);
 const second=await sampler.sample(rows,()=>{});assert.equal(second.cache_hits,40);assert.equal(calls,5);assert.deepEqual(first.rows,second.rows);
 const fallback=await new SemanticSampler(dir).sample(rows,()=>{});assert.equal(fallback.method,'ordered-truncation-fallback');assert.equal(fallback.rows.length,30);
 let cancelled=false;const slow=new SemanticSampler(dir,{version:'cancelled',embed:async texts=>{cancelled=true;return texts.map(()=>[0,1]);}});await assert.rejects(slow.sample(rows,()=>{if(cancelled)throw Error('任务已取消');}),/任务已取消/);
});
