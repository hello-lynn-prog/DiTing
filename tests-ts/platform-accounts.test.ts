import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../apps/server/app.js';
import {PlatformAccounts} from '../packages/domain/platform-accounts.js';
import {DeepCrawl} from '../packages/domain/deep-crawl.js';
const cookie='SUB=explicit-weibo-session-fixture; marker=explicit-marker-fixture';
const wait=async()=>{};
const scope={platform:'weibo',query:'明确登录测试',max_posts:1,comments_per_post:0,include_long_text:false,access_mode:'saved_session'};
async function setup(){const app=await createApp({dataDir:mkdtempSync(join(tmpdir(),'diting-session-'))},false),accounts=new PlatformAccounts(app.config),task=app.service.createTask('调查明确的登录态合成材料',null),lease=app.service.claim('account-test')!;return {...app,accounts,task,token:lease.lease_owner as string};}

test('platform cookies remain encrypted and write-only; format, expiry, platform origin and endpoint scope are enforced',async()=>{
 const s=await setup();try{
  const put=(input:Record<string,unknown>)=>s.app.inject({method:'PUT',url:'/api/config/platform-sessions/weibo',payload:input});
  assert.equal((await put({enabled:true,cookie:'api_key=wrong-field'})).statusCode,400);
  assert.equal((await put({enabled:true,cookie:'SUB=fixture\r\nInjected=bad'})).statusCode,400);
  assert.equal((await put({enabled:true,cookie,expires_at:'2020-01-01T00:00:00Z'})).statusCode,400);
  const saved=await put({enabled:true,cookie});assert.equal(saved.statusCode,200);assert.ok(!saved.body.includes('explicit-weibo-session-fixture'));assert.equal(saved.json().health.status,'not_tested');
  const snapshot=s.accounts.freeze(s.service,s.task,s.token,'weibo'),stored=s.db.one('SELECT ciphertext FROM secrets WHERE id=?',snapshot.cookie_ref)!;assert.ok(!stored.ciphertext.includes('explicit-weibo'));
  assert.ok(!JSON.stringify(s.service.task(s.task)).includes('explicit-weibo'));
  const access=s.accounts.access(snapshot);assert.equal(access.headers('https://m.weibo.cn/api/config').Cookie,cookie);
  const structure=JSON.parse(access.scrubJson(JSON.stringify({ok:true,numeric:1234,echo:cookie})));assert.equal(structure.ok,true);assert.equal(structure.numeric,1234);assert.ok(!structure.echo.includes('explicit-weibo-session-fixture'));
  for(const url of ['https://api.bilibili.com/x/web-interface/nav','https://m.weibo.cn.evil.example/api/config','http://m.weibo.cn/api/config','https://m.weibo.cn/account/delete'])assert.throws(()=>access.headers(url),/只读接口/);
  const listed=(await s.app.inject({url:'/api/config/platform-sessions'})).body;assert.ok(!listed.includes('cookie_ref'));assert.ok(!listed.includes('explicit-weibo'));
  assert.equal((await s.app.inject({method:'POST',url:'/api/config/platform-sessions/bilibili/check',payload:{}})).statusCode,400,'missing credentials cannot trigger a probe');
 }finally{await s.app.close();}
});

test('login probes distinguish explicit login, explicit logout and blocked access without storing account payloads',async()=>{
 const s=await setup();try{
  s.accounts.save('weibo',{enabled:true,cookie});let calls=0;
  const run=(payload:any)=>s.accounts.probe('weibo',new AbortController().signal,async(url,_signal,_public,init)=>{calls++;assert.equal(url,'https://m.weibo.cn/api/config');assert.equal(init?.headers?.Cookie,cookie);assert.deepEqual(init?.allowedOrigins,['https://m.weibo.cn']);return {url,text:JSON.stringify(payload)};});
  assert.equal((await run({ok:1,data:{login:true,private_account_field:'never-store-this-field'}})).status,'authenticated');
  assert.equal((await run({ok:1,data:{login:false}})).status,'not_authenticated');
  const blocked=await s.accounts.probe('weibo',new AbortController().signal,async()=>{throw Error('来源 HTTP 432');});assert.equal(blocked.status,'access_blocked');assert.ok(!blocked.message.includes('失效'));
  assert.equal((await run({ok:1,data:{unknown:true}})).status,'unavailable');assert.equal(calls,3);
  const persisted=s.db.rows("SELECT value_json FROM configuration WHERE key LIKE 'platform.session.health.%'");assert.ok(!JSON.stringify(persisted).includes('never-store-this-field'));
 }finally{await s.app.close();}
});

test('saved-session collection binds approval to a frozen version; rotation preserves active tasks and revocation stops future requests',async()=>{
 const s=await setup();let calls=0;const sent:string[]=[];
 try{
  s.accounts.save('weibo',{enabled:true,cookie});const crawl=new DeepCrawl(s.service,{wait,fetcher:async(url,_signal,_public,init)=>{calls++;sent.push(init?.headers?.Cookie||'');return {url,text:'{"ok":1,"data":{"cards":[]}}'};}},s.accounts);
  const pending:any=await crawl.request(s.task,s.token,scope,new AbortController().signal);assert.equal(calls,0);assert.ok(pending.scope.session_version);assert.ok(!JSON.stringify(pending).includes('explicit-weibo'));
  const frozen=s.accounts.freeze(s.service,s.task,s.token,'weibo');s.accounts.save('weibo',{enabled:true,cookie:'SUB=rotated-session-fixture'});assert.equal(s.accounts.freeze(s.service,s.task,s.token,'weibo').version,frozen.version);
  s.db.run("UPDATE approvals SET status='approved' WHERE id=?",pending.approval_id);await crawl.request(s.task,s.token,scope,new AbortController().signal);assert.equal(sent[0],cookie);
  await crawl.request(s.task,s.token,{...scope,query:'公开模式',access_mode:'public'},new AbortController().signal);const publicApproval=s.db.one("SELECT id FROM approvals WHERE status='pending' ORDER BY rowid DESC LIMIT 1")!;s.db.run("UPDATE approvals SET status='approved' WHERE id=?",publicApproval.id);
  await crawl.request(s.task,s.token,{...scope,query:'公开模式',access_mode:'public'},new AbortController().signal);assert.equal(sent[1],'','public mode must not silently attach the saved session');
  s.accounts.revoke('weibo');assert.throws(()=>s.accounts.access(frozen),/撤销/);await assert.rejects(crawl.request(s.task,s.token,scope,new AbortController().signal),/撤销/);assert.equal(calls,2);
 }finally{await s.app.close();}
});

test('cookie echoes and errors are scrubbed before evidence, raw pages, acquisitions or artifacts are stored',async()=>{
 const s=await setup();try{
  s.accounts.save('weibo',{enabled:true,cookie});const crawl=new DeepCrawl(s.service,{wait,fetcher:async(url)=>({url,text:JSON.stringify({ok:1,data:{cards:[{card_type:9,mblog:{id:'100',text:'正文 explicit-weibo-session-fixture',created_at:'未知',echo:cookie}}]}})})},s.accounts);
  const pending:any=await crawl.request(s.task,s.token,scope,new AbortController().signal);s.db.run("UPDATE approvals SET status='approved' WHERE id=?",pending.approval_id);const result:any=await crawl.request(s.task,s.token,scope,new AbortController().signal);
  for(const table of ['evidence','content_records','crawl_pages','crawl_batches','acquisitions','events'])assert.ok(!JSON.stringify(s.db.rows('SELECT * FROM '+table)).includes('explicit-weibo-session-fixture'),table);
  assert.ok(result.records[0].text.includes('[redacted]'));
 }finally{await s.app.close();}
});

test('refreshing a stopped task selects the new account version, rejects stale login approvals and queues only that task',async()=>{
 const s=await setup();try{
  s.accounts.save('weibo',{enabled:true,cookie});const crawl=new DeepCrawl(s.service,{wait},s.accounts),old:any=await crawl.request(s.task,s.token,scope,new AbortController().signal);
  s.service.waitRuntime(s.task,s.token,'等待用户提供更新登录态','waiting_approval');s.accounts.save('weibo',{enabled:true,cookie:'SUB=new-session-fixture'});const revision=s.service.task(s.task).revision;
  const refresh=await s.app.inject({method:'POST',url:`/api/tasks/${s.task}/platform-sessions/weibo/refresh`,payload:{revision}});assert.equal(refresh.statusCode,200);
  assert.equal(s.db.one('SELECT status FROM approvals WHERE id=?',old.approval_id)!.status,'rejected');assert.equal(s.service.task(s.task).status,'queued');
  assert.equal((await s.app.inject({method:'POST',url:`/api/tasks/${s.task}/platform-sessions/weibo/refresh`,payload:{revision}})).statusCode,409);
  const next=s.service.claim('after-refresh')!,pending:any=await crawl.request(s.task,next.lease_owner,scope,new AbortController().signal);assert.notEqual(pending.scope.session_version,old.scope.session_version);assert.equal(pending.status,'pending');
 }finally{await s.app.close();}
});

test('revocation during a request fences the response, and malformed JSON cannot leak a cookie in parser errors',async()=>{
 const s=await setup();let finish!:()=>void,started!:()=>void;
 try{
  s.accounts.save('weibo',{enabled:true,cookie});const arrived=new Promise<void>(resolve=>started=resolve),hold=new Promise<void>(resolve=>finish=resolve);
  const crawl=new DeepCrawl(s.service,{wait,fetcher:async(url)=>{started();await hold;return {url,text:'{"ok":1,"data":{"cards":[]}}'};}},s.accounts);
  const p:any=await crawl.request(s.task,s.token,scope,new AbortController().signal);s.db.run("UPDATE approvals SET status='approved' WHERE id=?",p.approval_id);
  const pending=crawl.request(s.task,s.token,scope,new AbortController().signal),rejected=assert.rejects(pending,/撤销/);await arrived;s.accounts.revoke('weibo');finish();await rejected;
  assert.equal(s.db.one('SELECT COUNT(*) n FROM acquisitions')!.n,0);assert.equal(s.db.one("SELECT COUNT(*) n FROM crawl_pages WHERE status='succeeded'")!.n,0);
  s.accounts.save('weibo',{enabled:true,cookie});s.service.waitRuntime(s.task,s.token,'更新登录版本','waiting_evidence');s.accounts.refreshTask(s.service,s.task,'weibo',s.service.task(s.task).revision);const next=s.service.claim('new-version')!;
  const bad=new DeepCrawl(s.service,{wait,fetcher:async(url)=>({url,text:'<html>'+cookie+'</html>'})},s.accounts),approval:any=await bad.request(s.task,next.lease_owner,scope,new AbortController().signal);s.db.run("UPDATE approvals SET status='approved' WHERE id=?",approval.approval_id);
  const result:any=await bad.request(s.task,next.lease_owner,scope,new AbortController().signal);assert.equal(result.status,'failed');assert.ok(result.errors[0].error.includes('JSON'));assert.ok(!JSON.stringify(s.db.rows('SELECT * FROM acquisitions')).includes('explicit-weibo'));
 }finally{finish?.();await s.app.close();}
});
