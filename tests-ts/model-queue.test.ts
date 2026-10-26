import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT} from '../apps/server/settings.js';
import {Database} from '../packages/domain/db.js';
import {Configuration} from '../packages/domain/configuration.js';
import {Service} from '../packages/domain/service.js';
import {acquireModelSlot,recoverModelQueue,modelAccountScope} from '../packages/domain/model-queue.js';

test('Agent, keyword and vision share a persistent FIFO cap with pacing, cancellation and expired-slot recovery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'diting-model-queue-')),db=new Database(join(dir,'db.sqlite3'),ROOT),other=new Database(db.path,ROOT),config=new Configuration(db,dir),otherConfig=new Configuration(other,dir),task=new Service(db).createTask('共享限流测试',null);
  config.set('model.queue',{max_concurrency:2,min_interval_ms:20});let active=0,max=0;const order:number[]=[],starts:number[]=[];
  await Promise.all(['main','keyword','media-vision','query','report'].map(async(role,i)=>{const release=await acquireModelSlot(i%2?other:db,i%2?otherConfig:config,task,'call-'+i,role);active++;max=Math.max(max,active);order.push(i);starts.push(Date.now());await delay(250);active--;release();}));
  assert.equal(max,2);assert.deepEqual(order,[0,1,2,3,4]);assert.ok(starts.slice(1).every((n,i)=>n-starts[i]>=18));assert.equal(db.one('SELECT COUNT(*) n FROM model_queue')!.n,0);
  config.set('model.queue',{max_concurrency:1,min_interval_ms:0});const release=await acquireModelSlot(db,config,task,'held','main');const abort=new AbortController(),waiting=acquireModelSlot(other,otherConfig,task,'cancelled','keyword',abort.signal);abort.abort();await assert.rejects(waiting);release();assert.equal(db.one('SELECT COUNT(*) n FROM model_queue')!.n,0);
  db.run("INSERT INTO model_queue(call_id,task_id,role,state,expires_at) VALUES(?,?,?,'running',?)",'expired',task,'main',Date.now()-1);const recovered=await acquireModelSlot(db,config,task,'recovered','media-vision');recovered();assert.equal(db.one('SELECT COUNT(*) n FROM model_queue')!.n,0);other.close();db.close();
});

test('three investigators and ForumHost run together by default; independent accounts bypass a full account queue',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'diting-model-accounts-')),db=new Database(join(dir,'db.sqlite3'),ROOT),config=new Configuration(db,dir),task=new Service(db).createTask('并行账户验证',null);
  config.putSecret('account-a','synthetic-a');config.putSecret('alias-a','synthetic-a');config.putSecret('account-b','synthetic-b');
  const routeA={base_url:'https://example.org/api/anthropic',key_ref:'account-a'},routeAlias={base_url:'https://example.org/api/openai',key_ref:'alias-a'},routeB={base_url:'https://example.org/api/openai',key_ref:'account-b'};
  assert.equal(modelAccountScope(config,routeA),modelAccountScope(config,routeAlias));
  const releases=await Promise.all(['insight','media','query','forum'].map(role=>acquireModelSlot(db,config,task,role,role,undefined,undefined,routeA)));
  assert.equal(db.one("SELECT COUNT(*) n FROM model_queue WHERE state='running'")!.n,4);
  const abort=new AbortController();let blockedResolved=false;
  const blocked=acquireModelSlot(db,config,task,'keyword','keyword',abort.signal,undefined,routeAlias).then(r=>{blockedResolved=true;return r;});
  const independent=await acquireModelSlot(db,config,task,'other-account','report',undefined,undefined,routeB);
  assert.equal(blockedResolved,false);independent();abort.abort();await assert.rejects(blocked);
  releases.forEach(r=>r());assert.equal(db.one('SELECT COUNT(*) n FROM model_queue_scopes')!.n,0);db.close();
});

test('server boot recovery removes abandoned queue slots but preserves model billing history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'diting-model-queue-recovery-')),db=new Database(join(dir,'db.sqlite3'),ROOT),task=new Service(db).createTask('队列恢复测试',null);
  db.run("INSERT INTO model_queue(call_id,task_id,role,state,expires_at) VALUES(?,?,?,'running',?)",'orphan-call',task,'insight',Date.now()+360000);
  const call='billed-call';db.run('INSERT INTO model_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',call,task,null,'insight','test-provider','test-model',10,2,0,.01,'succeeded',1,new Date().toISOString());
  assert.equal(recoverModelQueue(db),1);assert.equal(db.one('SELECT COUNT(*) n FROM model_queue')!.n,0);assert.equal(db.one('SELECT status FROM model_calls WHERE id=?',call)?.status,'succeeded');db.close();
});
