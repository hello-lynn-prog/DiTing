import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {cachedSearch,ContextReuse,evidenceIndex} from '../packages/dsh-diting/research-cache.js';

test('successful searches share in-flight requests and persist by task/window; failures are retried',async()=>{
  const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-search-cache-')),'db.sqlite3'),process.cwd()),service=new Service(db),task=service.createTask('研究检索缓存测试',null);try{
    let calls=0;const success=async()=>{calls++;return {results:[{url:'https://example.org'}],sources:[{provider:'fixture',error:null}]};};
    await Promise.all([cachedSearch(db,task,{query:'AI',window:'week'},success),cachedSearch(db,task,{query:'AI',window:'week'},success)]);assert.equal(calls,1);assert.equal((await cachedSearch(db,task,{query:'AI',window:'week'},success)).cache_hit,true);
    await cachedSearch(db,task,{query:'AI',window:'day'},success);assert.equal(calls,2);
    let failed=0;const failure=async()=>{failed++;return {results:[],sources:[{provider:'fixture',error:'denied'}]};};await cachedSearch(db,task,{query:'failure'},failure);await cachedSearch(db,task,{query:'failure'},failure);assert.equal(failed,2);
  }finally{db.close();}
});

test('unchanged context reuses only that agent snapshot; explicit force and new evidence restore full material',()=>{
  const reuse=new ContextReuse(),full={task:{id:'t'},review_input:{evidence_revision:1},report_checkpoint:{},evidence:[{id:'e'}],claims:[{id:'c'}],artifacts:[],agents:[]};assert.equal(reuse.project('a',full).unchanged,false);const cached=reuse.project('a',full);assert.equal(cached.unchanged,true);assert.equal(cached.counts.evidence,1);assert.equal(cached.evidence,undefined);assert.equal(reuse.project('b',full).unchanged,false);assert.equal(reuse.project('a',full,true).unchanged,false);assert.equal(reuse.project('a',{...full,evidence:[{id:'e'},{id:'e2'}]}).unchanged,false);
});

test('database search returns bounded matching previews rather than thirty complete source documents',()=>{
  const records=evidenceIndex([{id:'e',title:'测试',source_url:'https://example.org',content:'开头'.repeat(1000)+'关键字'+'后文'.repeat(1000),content_hash:'hash'}],'关键字');assert.equal('content' in records[0],false);assert.ok(records[0].preview.length<=500);assert.ok(records[0].preview.includes('关键字'));assert.equal(records[0].content_chars,4003);
});

test('context deltas retain stable material, transmit changed entries and explicitly remove superseded IDs',()=>{
  const reuse=new ContextReuse(),base={task:{id:'t'},review_input:{evidence_revision:1},report_checkpoint:{},evidence:[{id:'e1',preview:'old'}],claims:[],artifacts:[{id:'a1'}],agents:[]};
  const first=reuse.project('a',base);const delta=reuse.project('a',{...base,evidence:[...base.evidence,{id:'e2',preview:'new'}],artifacts:[{id:'a2'}]});
  assert.equal(delta.delta,true);assert.equal(delta.base_context_version,first.context_version);assert.deepEqual(delta.evidence,[{id:'e2',preview:'new'}]);assert.deepEqual(delta.removed.artifacts,['a1']);assert.equal(delta.counts.evidence,2);
  const changed=reuse.project('a',{...base,evidence:[{id:'e1',preview:'changed'},{id:'e2',preview:'new'}],artifacts:[{id:'a2'}]});assert.deepEqual(changed.evidence,[{id:'e1',preview:'changed'}]);
  assert.equal(reuse.project('a',base,true).delta,false);
});
