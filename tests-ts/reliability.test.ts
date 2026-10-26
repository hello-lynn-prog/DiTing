import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {spawn,type ChildProcess} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,encode} from '../packages/domain/db.js';
import {Configuration} from '../packages/domain/configuration.js';
import {Service} from '../packages/domain/service.js';
import {CollectionSchedule} from '../packages/domain/collection.js';
import {Monitoring} from '../packages/domain/monitoring.js';
import {Notifications} from '../packages/domain/notifications.js';
import {Hotlists} from '../packages/collectors/hotlists.js';
import {Worker,type Runtime} from '../packages/dsh-diting/runtime.js';
import {ROOT} from '../apps/server/settings.js';

function setup(){const dir=mkdtempSync(join(tmpdir(),'diting-reliability-')),path=join(dir,'state.sqlite3'),db=new Database(path,ROOT);return {dir,path,db,config:new Configuration(db,dir),service:new Service(db)};}
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};}
const sample=(title='明确的 AI 测试线索')=>JSON.stringify({stories:[{id:title,title,url:'https://example.org/fixture'}]});
function oneSource(hot:Hotlists){const original=hot.collect.bind(hot);hot.collect=()=>original('dailyhot',['zhihu-daily']);return hot;}

test('overdue collection survives database reopen and coalesces missed periods without creating research',async()=>{
 const s=setup();let time=new Date('2026-10-18T16:05:00Z'),calls=0;
 const old=new CollectionSchedule(s.config,new Hotlists(s.db),()=>time);old.save({enabled:true,interval_minutes:5,source_ids:['dailyhot:zhihu-daily']});
 s.config.set('collection.schedule',{...old.get(),next_run_at:'2026-10-17T00:00:00Z'});s.config.set('collection.active',{run_id:'crashed-fixture',status:'running'});s.db.close();
 const db=new Database(s.path,ROOT),config=new Configuration(db,s.dir),schedule=new CollectionSchedule(config,new Hotlists(db,async url=>{calls++;return {url,text:sample()};}),()=>time);
 try{await Promise.all([schedule.tick(),schedule.tick()]);assert.equal(calls,1);assert.equal(schedule.get().last_status,'completed');assert.equal(schedule.get().next_run_at,'2026-10-18T16:10:00.000Z');assert.equal(db.one("SELECT COUNT(*) n FROM events WHERE kind='collection.recovered'")!.n,1);assert.equal(db.one('SELECT COUNT(*) n FROM tasks')!.n,0);await schedule.tick();assert.equal(calls,1);
 time=new Date('2026-10-18T16:10:00Z');await schedule.tick();assert.equal(calls,2);}finally{db.close();}
});

test('editing or disabling a collection plan during a request preserves the new plan and stop waits for in-flight archival',async()=>{
 const s=setup(),hold=gate();let calls=0,followups=0,stopped=false;const time=new Date('2026-10-18T00:00:00Z');
 const schedule=new CollectionSchedule(s.config,new Hotlists(s.db,async url=>{calls++;await hold.promise;return {url,text:sample()};}),()=>time,()=>{followups++;});
 try{schedule.save({enabled:true,source_ids:['dailyhot:zhihu-daily']});s.config.set('collection.schedule',{...schedule.get(),next_run_at:'2026-10-17T00:00:00Z'});const pending=schedule.tick();
 const revised=schedule.save({enabled:false,interval_minutes:30,source_ids:['dailyhot:guokr']});const stopping=schedule.stop().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);
 hold.release();await Promise.all([pending,stopping]);assert.deepEqual(schedule.get(),revised);assert.equal(followups,0,'a disabled or replaced plan cannot generate a digest after finishing');assert.equal(s.config.get<any>('collection.active',null).status,'completed');await schedule.tick();assert.equal(calls,1);assert.equal(s.db.one('SELECT COUNT(*) n FROM hotlist_snapshots')!.n,1);}finally{hold.release();s.db.close();}
});

test('partial and complete source failure remain visible in collection status and retain the next scheduled attempt',async()=>{
 const s=setup();let allFail=false;const time=new Date('2026-10-18T00:00:00Z'),schedule=new CollectionSchedule(s.config,new Hotlists(s.db,async url=>{if(allFail||url.includes('guokr'))throw Error('explicit offline network failure');return {url,text:sample()};}),()=>time);
 try{schedule.save({enabled:true,source_ids:['dailyhot:zhihu-daily','dailyhot:guokr']});s.config.set('collection.schedule',{...schedule.get(),next_run_at:'2026-10-17T00:00:00Z'});await schedule.tick();assert.equal(schedule.get().last_status,'partial');assert.deepEqual(schedule.get().last_result,{succeeded:1,failed:1});assert.ok(schedule.get().last_error?.includes('1 个来源'));assert.ok(schedule.get().next_run_at!>time.toISOString());
 allFail=true;s.config.set('collection.schedule',{...schedule.get(),next_run_at:'2026-10-17T00:00:00Z'});await schedule.tick();assert.equal(schedule.get().last_status,'failed');assert.equal(schedule.get().last_result?.failed,2);assert.equal(s.db.one("SELECT COUNT(*) n FROM hotlist_snapshots WHERE status='failed'")!.n,3);}finally{s.db.close();}
});

test('08:00 collection archives first, then invokes its follow-up exactly once; manual refresh does not',async()=>{
 const s=setup(),time=new Date('2026-10-25T00:00:00Z'),calls:any[]=[];
 const hot=new Hotlists(s.db,async url=>({url,text:sample()}));
 const schedule=new CollectionSchedule(s.config,hot,()=>time,result=>{assert.equal(s.db.one('SELECT COUNT(*) n FROM hotlist_snapshots')!.n,1);calls.push(result);});
 try{schedule.save({enabled:true,cron:'0 8 * * *',source_ids:['dailyhot:zhihu-daily']});s.config.set('collection.schedule',{...schedule.get(),next_run_at:time.toISOString()});
 await Promise.all([schedule.tick(),schedule.tick()]);assert.equal(calls.length,1);assert.equal(calls[0].scheduled_for,time.toISOString());assert.equal(calls[0].snapshots[0].status,'succeeded');assert.equal(schedule.get().next_run_at,'2026-10-26T00:00:00.000Z');
 await hot.collect('dailyhot',['zhihu-daily']);assert.equal(calls.length,1,'manual collection cannot implicitly generate a second digest');
 }finally{s.db.close();}
});

test('11:30 early-brief schedule has a separate clock and never catches up after noon',async()=>{
 const s=setup(),time=new Date('2026-10-25T04:10:00Z');let requests=0,followups=0;
 const morning=new CollectionSchedule(s.config,new Hotlists(s.db,async url=>{requests++;return {url,text:sample()};}),()=>time,()=>{followups++;},'collection.morning_schedule','collection.morning_active',30*60_000);
 try{morning.save({enabled:true,interval_minutes:60,cron:'30 11 * * *',source_ids:['dailyhot:zhihu-daily']});s.config.set('collection.morning_schedule',{...morning.get(),next_run_at:'2026-10-25T03:30:00.000Z'});
 await morning.tick();assert.equal(requests,0);assert.equal(followups,0);assert.equal(morning.get().last_status,'missed');assert.equal(morning.get().next_run_at,'2026-10-26T03:30:00.000Z');assert.equal(s.config.get('collection.schedule',null),null);
 }finally{s.db.close();}
});

test('overlapping full and single-source requests share the in-flight source request and one archived snapshot',async()=>{
 const s=setup(),hold=gate();let calls=0;const hot=new Hotlists(s.db,async url=>{calls++;await hold.promise;return {url,text:url.includes('guokr')?'{"data":[{"id":1,"title":"明确的果壳测试"}]}':sample()};});
 try{const group=hot.collect('dailyhot',['zhihu-daily','guokr']),single=hot.collect('dailyhot',['zhihu-daily']);assert.equal(calls,2);hold.release();const [a,b]=await Promise.all([group,single]);assert.equal(a.snapshots.find((r:any)=>r.source_id==='zhihu-daily')!.id,b.snapshots[0].id);assert.equal(s.db.one('SELECT COUNT(*) n FROM hotlist_snapshots')!.n,2);await hot.collect('dailyhot',['zhihu-daily']);assert.equal(calls,3);}finally{hold.release();s.db.close();}
});

test('monitor timer scans archives without making another hotlist request; new snapshots are evaluated after collection',async()=>{
 const s=setup();let requests=0;const time=new Date('2026-10-18T00:00:00Z'),hot=oneSource(new Hotlists(s.db,async url=>{requests++;return {url,text:sample()};})),monitor=new Monitoring(s.db,s.config,s.service,hot,()=>time);
 try{const due=monitor.save({title:'到期',keywords:['AI'],rule:'keyword',enabled:true,action:'notify'})!,later=monitor.save({title:'未到期',keywords:['AI'],rule:'keyword',enabled:true,action:'auto'})!;s.db.run('UPDATE monitors SET next_run_at=? WHERE id=?','2026-10-17T00:00:00Z',due.id);
 await monitor.tick();assert.equal(requests,0);assert.equal(s.db.one('SELECT COUNT(*) n FROM signals')!.n,0);
 const result=await hot.collect();assert.equal(requests,1);assert.equal(monitor.evaluate(undefined,result.snapshots.filter((snapshot:any)=>snapshot.status==='succeeded').map((snapshot:any)=>snapshot.id)).created,2);assert.equal(s.db.one('SELECT COUNT(*) n FROM signals WHERE monitor_id=?',due.id)!.n,1);assert.equal(s.db.one('SELECT COUNT(*) n FROM signals WHERE monitor_id=?',later.id)!.n,1);assert.equal(s.service.tasks().length,0);
 await monitor.tick();assert.equal(requests,1);}finally{s.db.close();}
});

test('monitor edits preserve the replacement cron and do not start research',async()=>{
 const s=setup(),time=new Date('2026-10-18T00:00:00Z'),hot=new Hotlists(s.db),monitor=new Monitoring(s.db,s.config,s.service,hot,()=>time);
 try{const rule=monitor.save({title:'原规则',keywords:['AI'],rule:'keyword',enabled:true,action:'auto'})!;s.db.run('UPDATE monitors SET next_run_at=? WHERE id=?','2026-10-17T00:00:00Z',rule.id);const edited=monitor.save({title:'已停用的新规则',keywords:['AI'],enabled:false,cron:'0 8 * * *',action:'auto'},rule.id)!;await monitor.tick();const actual=monitor.list().find(m=>m.id===rule.id)!;assert.equal(actual.version,edited.version);assert.equal(actual.next_run_at,edited.next_run_at);assert.equal(s.service.tasks().length,0);assert.equal(s.db.one('SELECT COUNT(*) n FROM signals')!.n,0);}finally{s.db.close();}
});

test('monitoring never auto-starts research; keyword leads remain available across days',async()=>{
 const s=setup();let time=new Date('2026-10-18T15:55:00Z'),title='AI 测试第一条';const hot=oneSource(new Hotlists(s.db,async url=>({url,text:sample(title)}))),monitor=new Monitoring(s.db,s.config,s.service,hot,()=>time);
 try{monitor.save({title:'人工决定是否研判',keywords:['AI'],rule:'keyword',enabled:true,action:'auto',max_daily_tasks:1,budget:10,daily_budget:10});await hot.collect();assert.equal(monitor.evaluate().created,1);assert.equal(s.service.tasks().length,0);assert.equal(monitor.list()[0].auto_research,false);
 title='AI 测试第二条';await hot.collect();assert.equal(monitor.evaluate().created,1);assert.equal(s.service.tasks().length,0);
 time=new Date('2026-10-18T16:05:00Z');title='AI 测试第三条';await hot.collect();assert.equal(monitor.evaluate().created,1);assert.equal(s.service.tasks().length,0);assert.equal(monitor.next({interval_minutes:15,cron:'0 8 * * *'},time),'2026-10-19T00:00:00.000Z');}finally{s.db.close();}
});

test('manual research waits for the active task then takes priority; cancelling an in-flight worker fences late writes',async()=>{
 const s=setup(),hold=gate();const launched:string[]=[];let active=0,maxActive=0;
 const runtime={capabilities:()=>({ready:true}),launch:async(task:any)=>{launched.push(task.id);maxActive=Math.max(maxActive,++active);try{if(launched.length===1)await hold.promise;s.service.archive(task.id,'https://example.org/late','明确的隔离材料','这是明确的自动测试材料，不是真实新闻。','fixture',task.lease_owner);s.service.waitRuntime(task.id,task.lease_owner,'本轮已结束','waiting_evidence');}finally{active--; }},cancel:async()=>{},close:async()=>{hold.release();}} as unknown as Runtime;
 const worker=new Worker(s.service,runtime);
 try{const auto=s.service.createTask('自动研究一',null,null,'sentinel'),running=worker.tick();assert.deepEqual(launched,[auto]);const other=s.service.createTask('自动研究二',null,null,'sentinel'),manual=s.service.createTask('用户明确研究',null);await Promise.all([worker.tick(),worker.tick()]);assert.equal(launched.length,1);
 s.service.action(auto,'cancel',s.service.task(auto).revision);await worker.cancel(auto);hold.release();await running;assert.equal(s.service.task(auto).status,'cancelled');assert.equal(s.db.one('SELECT COUNT(*) n FROM task_evidence WHERE task_id=?',auto)!.n,0);
 await worker.tick();assert.deepEqual(launched,[auto,manual]);await worker.tick();assert.deepEqual(launched,[auto,manual,other]);assert.equal(maxActive,1);assert.equal(s.service.task(auto).status,'cancelled');}finally{hold.release();await worker.stop();s.db.close();}
});

test('expired task leases survive database reopen; a new owner rejects old writes without losing archived evidence',()=>{
 const s=setup(),task=s.service.createTask('重启恢复的研究',null),old=s.service.claim('crashed-owner')!,evidence=s.service.archive(task,'https://example.org/before','重启前材料','这是一份明确的持久化测试资料。','fixture',old.lease_owner);s.db.run('UPDATE tasks SET lease_until=? WHERE id=?','2020-01-01T00:00:00Z',task);s.db.close();
 const db=new Database(s.path,ROOT),service=new Service(db);try{const fresh=service.claim('new-owner')!;assert.equal(fresh.id,task);assert.notEqual(fresh.lease_owner,old.lease_owner);assert.equal(fresh.attempt,old.attempt+1);assert.throws(()=>service.archive(task,'https://example.org/late','迟到写入','不得写入的旧租约材料','fixture',old.lease_owner),/租约/);assert.equal(db.one('SELECT evidence_id FROM task_evidence WHERE task_id=?',task)!.evidence_id,evidence);assert.equal(service.claim('third-owner'),undefined);}finally{db.close();}
});

test('notification acknowledgements must be explicit; each channel retries at most three times without changing research',async()=>{
 const s=setup(),task=s.service.createTask('通知失败不影响研究',null),sent:string[]=[];
 try{for(const channel of ['feishu','wecom']){s.config.set('service.'+channel,{enabled:true});s.config.putSecret('service.'+channel,channel==='feishu'?'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-not-real':'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-not-real');}
 s.config.set('notification.subscription',{enabled:true,channels:['feishu','wecom'],events:['signal.created'],quiet:false,starts_at:'2020-01-01'});
 const notifier=new Notifications(s.db,s.config,(async(url,init)=>{assert.equal(init?.redirect,'error');sent.push(String(url));return new Response(JSON.stringify(String(url).includes('feishu')?{}:{errcode:0}));}) as typeof fetch);
 s.db.notify(task,'signal.created',{title:'明确的本机通知测试'},'fixture');await notifier.tick();
 const first=s.db.one("SELECT attempts,status,next_attempt_ms,last_error FROM outbox WHERE channel='feishu'")!;
 assert.equal(first.attempts,1);assert.equal(first.status,'pending');assert.equal(first.last_error,'provider_rejected');assert.ok(first.next_attempt_ms>Date.now());
 await notifier.tick();assert.equal(sent.filter(u=>u.includes('feishu')).length,1,'冷却期不能立即重试');
 for(let i=0;i<2;i++){s.db.run("UPDATE outbox SET next_attempt_ms=0 WHERE channel='feishu'");await notifier.tick();}
 assert.equal(sent.filter(u=>u.includes('feishu')).length,3);assert.equal(sent.filter(u=>u.includes('weixin')).length,0);assert.equal(s.db.one("SELECT attempts FROM outbox WHERE channel='feishu'")!.attempts,3);assert.equal(s.db.one("SELECT status FROM outbox WHERE channel='feishu'")!.status,'failed');assert.equal(s.db.rows("SELECT * FROM events WHERE kind='notification.delivery_failed'").length,3);assert.equal(s.db.one("SELECT COUNT(*) n FROM outbox WHERE channel='wecom'")!.n,0);assert.equal(s.service.task(task).status,'queued');}finally{s.db.close();}
});

test('notification retries survive reopen, delivered events stay deduplicated, and removed event subscriptions suppress queued delivery',async()=>{
 const s=setup();let sent=0;
 s.config.set('service.feishu',{enabled:true});s.config.putSecret('service.feishu','https://open.feishu.cn/open-apis/bot/v2/hook/fixture-not-real');s.config.set('notification.subscription',{enabled:true,channels:['feishu'],events:['signal.created'],quiet:false,starts_at:'2020-01-01'});s.db.notify(null,'signal.created',{title:'明确的重启通知测试'},'restart');
 await new Notifications(s.db,s.config,(async()=>{sent++;throw Error('offline fixture');}) as typeof fetch).tick();assert.equal(sent,1);s.db.close();
 const db=new Database(s.path,ROOT),config=new Configuration(db,s.dir);try{const notifier=new Notifications(db,config,(async()=>{sent++;return new Response('{"code":0}');}) as typeof fetch);assert.ok(db.one("SELECT next_attempt_ms FROM outbox WHERE channel='feishu'")!.next_attempt_ms>Date.now());await notifier.tick();assert.equal(sent,1,'重启后仍遵守退避时间');db.run("UPDATE outbox SET next_attempt_ms=0 WHERE channel='feishu'");await notifier.tick();db.notify(null,'signal.created',{title:'同一事件'},'restart');await notifier.tick();assert.equal(sent,2);assert.equal(db.one("SELECT COUNT(*) n FROM outbox WHERE channel='feishu'")!.n,1);
 db.run('INSERT INTO outbox(id,dedupe_key,event_type,channel,payload_json,status,created_at) VALUES(?,?,?,?,?,?,?)','removed-fixture','removed-fixture','approval.required','feishu',encode({title:'已取消订阅的旧审批'}),'pending','2026-10-18T00:00:00Z');await notifier.tick();assert.equal(sent,2);assert.equal(db.one('SELECT status FROM outbox WHERE id=?','removed-fixture')!.status,'suppressed');}finally{db.close();}
});

test('the real API process survives hard termination and restart with its task, evidence, schedule and server lock intact', {timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-process-restart-'));let child:ChildProcess|undefined;
 const stop=async()=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;const current=child;await new Promise<void>(resolve=>{current.once('exit',()=>resolve());current.kill('SIGKILL');});};
 const start=async()=>{child=spawn(process.execPath,['--import','tsx',join(ROOT,'apps/server/main.ts')],{cwd:ROOT,env:{...process.env,DITING_DATA_DIR:dir,PORT:'0',DITING_PORT:'0',DITING_RUNTIME_ENABLED:'false'},stdio:['ignore','pipe','pipe'],windowsHide:true});const current=child;return new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>{reject(Error('isolated API did not start in 12 seconds'));},12000);current.stdout!.on('data',chunk=>{output+=chunk.toString();const match=output.match(/DiTing TypeScript console: (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});current.once('error',error=>{clearTimeout(timer);reject(error);});current.once('exit',code=>{clearTimeout(timer);reject(Error('isolated API exited before startup: '+code));});});};
 try{let base=await start();const call=async(path:string,body?:unknown,method='POST')=>{const response=await fetch(base+'/api'+path,body===undefined?undefined:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,`isolated API ${path}: ${response.status}`);return response.json() as Promise<any>;};
 const session=await call('/sessions',{title:'明确的进程重启测试'}),result=await call('/sessions/'+session.id+'/messages',{text:'调查明确的进程恢复测试，预算10元，给我报告',request_id:'restart-request-fixture'}),tid=result.task_id;assert.ok(tid);
 const evidence=await call('/tasks/'+tid+'/evidence',{url:'https://example.org/restart-fixture',title:'明确的隔离材料',content:'这是一份进程恢复的合成材料，不是真实新闻。'});const plan=await call('/collection/schedule',{enabled:false,interval_minutes:30,cron:'0 8 * * *',source_ids:['dailyhot:zhihu-daily']},'PUT');const oldPid=child!.pid!;assert.equal(Number(readFileSync(join(dir,'server.lock'),'utf8')),oldPid);
 await stop();base=await start();assert.notEqual(child!.pid,oldPid);assert.equal(Number(readFileSync(join(dir,'server.lock'),'utf8')),child!.pid);
 const restored=await call('/tasks/'+tid),schedule=await call('/collection/schedule'),sessions=await call('/sessions');assert.ok(['queued','waiting_runtime'].includes(restored.status));assert.equal(restored.evidence[0].id,evidence.id);assert.equal(restored.evidence[0].content,'这是一份进程恢复的合成材料，不是真实新闻。');assert.equal(schedule.version,plan.version);assert.equal(schedule.enabled,false);assert.equal(schedule.cron,'0 8 * * *');assert.equal(sessions[0].id,session.id);assert.equal((await call('/usage')).calls.length,0);assert.equal((await call('/reports')).length,0);
 }finally{await stop();}
});
