import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {Configuration} from '../packages/domain/configuration.js';
import {LocalSentiment} from '../packages/sentiment/service.js';
import {logitsPrediction,BatchedSentimentEngine} from '../packages/sentiment/engine.js';
import {statistics} from '../packages/reporting/report.js';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'diting-sentiment-')),db=new Database(join(dir,'db.sqlite3'),process.cwd()),service=new Service(db),config=new Configuration(db,dir),task=service.createTask('研究本地情感的合成测试',null),run=service.claim('fixture')!;config.set('sentiment.local',{enabled:true,min_confidence:0.5});const evidence=service.archive(task,'https://example.org/sample','测试内容','这个产品太差了，售后完全不解决问题。','user_import',run.lease_owner);return {db,service,config,task,run,evidence};}

test('stable softmax retains all five classes and a neutral label is not forced positive/negative',()=>{
  const p=logitsPrediction([1000,1001,1010,1002,1000],42,5);assert.equal(p.label,'neutral');assert.equal(p.sentiment,'neutral');assert.ok(Math.abs(Object.values(p.probabilities).reduce((a,b)=>a+b,0)-1)<1e-8);assert.throws(()=>logitsPrediction([NaN,0,0,0,0],1,0));
});

test('native batches coalesce concurrent requests and preserve each request ordering',async()=>{
  const calls:string[][]=[],engine=new BatchedSentimentEngine({version:'fixture',predict:async texts=>{calls.push(texts);return texts.map(text=>logitsPrediction(text==='bad'?[9,0,0,0,0]:[0,0,0,0,9],10,1));}});
  const [one,two]=await Promise.all([engine.predict(['good']),engine.predict(['bad'])]);assert.equal(calls.length,1);assert.equal(one[0].sentiment,'positive');assert.equal(two[0].sentiment,'negative');
});

test('local inference is idempotent, keeps confidence/provenance and creates five-level certified statistics without paid model calls',async()=>{
  const s=fixture();try{let calls=0;const local=new LocalSentiment(s.service,s.config,{version:'model-fixture',predict:async texts=>{calls++;return texts.map(()=>logitsPrediction([10,1,0,0,0],18,2));}}),guard=()=>s.service.requireRun(s.task,s.run.lease_owner);
    const [first,second]=await Promise.all([local.annotate(s.task,[s.evidence],guard),local.annotate(s.task,[s.evidence],guard)]);assert.equal(calls,1);assert.equal(first.results[0].label,'very_negative');assert.equal(second.results[0].model_version,'model-fixture');
    const revision=s.service.rawTask(s.task).evidence_revision;await local.annotate(s.task,[s.evidence],guard);assert.equal(s.service.rawTask(s.task).evidence_revision,revision);assert.equal(s.db.one('SELECT COUNT(*) n FROM model_calls')!.n,0);
    const fine=statistics(s.db,s.task).datasets.find(t=>t.dimension==='sentiment_fine')!;assert.deepEqual(fine.rows,[['非常负面',1]]);assert.equal(s.db.one('SELECT COUNT(*) n FROM sentiment_inferences')!.n,1);
    const other=s.service.createTask('研究其他任务',null);await assert.rejects(local.annotate(other,[s.evidence],()=>{}),/不属于/);
  }finally{s.db.close();}
});

test('low confidence stays unknown and cancellation cannot attach late native predictions',async()=>{
  const s=fixture();try{let release!:()=>void;const wait=new Promise<void>(r=>release=r);const local=new LocalSentiment(s.service,s.config,{version:'slow-fixture',predict:async()=>{await wait;return [logitsPrediction([0,0,0,0,0],512,1)];}});const pending=local.annotate(s.task,[s.evidence],()=>s.service.requireRun(s.task,s.run.lease_owner));s.service.action(s.task,'cancel',s.service.rawTask(s.task).revision);release();await assert.rejects(pending);assert.equal(s.db.one('SELECT COUNT(*) n FROM sentiment_inferences')!.n,0);
  }finally{s.db.close();}
});

test('low-confidence fine labels remain unknown in certified charts, rather than being counted as a confident class',async()=>{
  const s=fixture();try{const local=new LocalSentiment(s.service,s.config,{version:'uncertain',predict:async()=>[logitsPrediction([0,0,0,0,0],512,1)]});const result=await local.annotate(s.task,[s.evidence],()=>s.service.requireRun(s.task,s.run.lease_owner));assert.equal(result.results[0].sentiment,'unknown');const fine=statistics(s.db,s.task).datasets.find(d=>d.dimension==='sentiment_fine')!;assert.deepEqual(fine.rows,[['未分类',1]]);}finally{s.db.close();}
});
