import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database, now } from '../packages/domain/db.js';
import { Configuration } from '../packages/domain/configuration.js';
import { Service } from '../packages/domain/service.js';
import { Monitoring,attentionPriority } from '../packages/domain/monitoring.js';
import { Notifications } from '../packages/domain/notifications.js';
import { Hotlists } from '../packages/collectors/hotlists.js';
import { ROOT } from '../apps/server/settings.js';

function setup() { const dir = mkdtempSync(join(tmpdir(), 'diting-monitor-')), db = new Database(join(dir, 'state.sqlite3'), ROOT), config = new Configuration(db, dir), service = new Service(db); return { db, config, service }; }
test('monitor signal priority is explainable heuristic triage, not a factual risk verdict',()=>{assert.equal(attentionPriority('平台发生数据泄漏',null).level,'high');assert.equal(attentionPriority('AI 行业融资争议',null).level,'medium');assert.equal(attentionPriority('普通榜单条目',null).level,'low');assert.equal(attentionPriority('普通榜单条目',2).level,'medium');});
test('keyword hits create leads without a heat baseline; growth only raises priority and never auto-starts research', async () => {
  const { db, config, service } = setup(); let heat = 100;
  const hotlists = new Hotlists(db, async url => ({ url, text: JSON.stringify({ data: { realtime: [{ word: 'AI 明确测试主题', num: heat }] } }) }));
  const monitoring = new Monitoring(db, config, service, hotlists);
  monitoring.save({ title: '测试监测', keywords: ['AI'], enabled: true, rule:'keyword_growth', auto_research: true });
  await hotlists.collect('dailyhot', ['weibo']); assert.equal(monitoring.evaluate().created, 1);
  assert.equal(service.tasks().length,0);
  heat = 600; await hotlists.collect('dailyhot', ['weibo']); assert.equal(monitoring.evaluate().created, 0);
  assert.equal(monitoring.evaluate().created,0);assert.equal(db.rows('SELECT * FROM signals').length,1);assert.equal(JSON.parse(db.one('SELECT evidence_json FROM signals')!.evidence_json).occurrences,2);assert.equal(service.tasks().length,0);
  // De-dup is stable, while an independent matching item is classified using its same-source baseline.
  const {db:db2,config:config2,service:service2}=setup();let heat2=100;
  const lists2=new Hotlists(db2,async url=>({url,text:JSON.stringify({data:{realtime:[{word:'AI 另一个测试线索',num:heat2}]}})}));
  const monitor2=new Monitoring(db2,config2,service2,lists2);monitor2.save({title:'增长规则',keywords:['AI'],enabled:true,rule:'keyword_growth'});
  await lists2.collect('dailyhot',['weibo']);monitor2.evaluate();heat2=650;await lists2.collect('dailyhot',['weibo']);monitor2.evaluate();
  const signal=db2.one('SELECT * FROM signals ORDER BY created_at DESC LIMIT 1')!;const info=JSON.parse(signal.evidence_json);
  assert.equal(info.priority.level,'high');assert.equal(info.previous_heat,100);assert.equal(service2.tasks().length,0);
  assert.equal(JSON.parse(db2.one("SELECT payload_json FROM outbox WHERE event_type='signal.high_priority'")!.payload_json).evidence.previous_heat,100);
  db.close();db2.close();
});
test('monitoring expands configured terms through the retrieval lexicon and caps routine daily signals',async()=>{
 const {db,config,service}=setup();const rows=Array.from({length:25},(_,i)=>({word:`AI Agent 落地案例 ${i}`,num:100}));rows.push({word:'智能体落地重大事故通报',num:100});
 const hotlists=new Hotlists(db,async url=>({url,text:JSON.stringify({data:{realtime:rows}})})),monitor=new Monitoring(db,config,service,hotlists);
 monitor.save({title:'别称与限额测试',keywords:['AI Agent 落地'],enabled:true});await hotlists.collect('dailyhot',['weibo']);const result=monitor.evaluate();
 assert.equal(result.created,21);const signals=db.rows('SELECT * FROM signals WHERE monitor_id=?',monitor.list()[0].id);assert.equal(signals.length,21);assert.ok(signals.some(s=>JSON.parse(s.evidence_json).matched_terms.includes('智能体落地')));assert.equal(signals.filter(s=>JSON.parse(s.evidence_json).priority.level==='high').length,1);db.close();
});
test('compound keyword aliases require both the topic and its requested action',async()=>{
 const {db,config,service}=setup();
 const rows=[{word:'人工智能污染讨论',num:1},{word:'生成式人工智能备案通过',num:1},{word:'AI智能体安全风险',num:1},{word:'企业部署AI智能体并上线应用',num:1}];
 const hotlists=new Hotlists(db,async url=>({url,text:JSON.stringify({data:{realtime:rows}})})),monitor=new Monitoring(db,config,service,hotlists);
 monitor.save({title:'复合词准确性测试',keywords:['生成式AI 备案','AI Agent 落地'],enabled:true});await hotlists.collect('dailyhot',['weibo']);
 const result=monitor.evaluate(),signals=db.rows('SELECT title,evidence_json FROM signals ORDER BY created_at');
 assert.equal(result.created,2);assert.deepEqual(signals.map(s=>s.title),['生成式人工智能备案通过','企业部署AI智能体并上线应用']);
 const matched=signals.map(s=>JSON.parse(s.evidence_json).matched_terms[0]);assert.match(matched[0],/生成式人工智能 \+ 备案/);assert.match(matched[1],/AI智能体 \+ (部署|应用|上线)/);db.close();
});
test('cron uses Shanghai timezone and disabled rules do not collect or open research', async () => {
  const { db, config, service } = setup(); let calls = 0;
  const hotlists = new Hotlists(db, async () => { calls++; throw new Error('must not collect'); }), monitor = new Monitoring(db, config, service, hotlists);
  monitor.save({ title: '尚未启用', keywords: ['测试'], enabled: false, cron: '0 8 * * *' });
  assert.equal(monitor.next({ interval_minutes: 15, cron: '0 8 * * *' }, new Date('2026-10-17T23:00:00Z')), '2026-10-18T00:00:00.000Z');
  assert.throws(() => monitor.save({ title: '错误 cron', keywords: ['x'], cron: 'not a cron' }));
  await monitor.tick(); assert.equal(calls, 0); assert.equal(service.tasks().length, 0); db.close();
});
test('notifications need explicit subscription, deduplicate channels and do not send old events', async () => {
  const { db, config } = setup(); let sent = 0;
  config.putSecret('service.feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-not-real');
  config.set('service.feishu', { enabled: true, base_url: 'https://open.feishu.cn' });
  const notifier = new Notifications(db, config, (async () => { sent++; return new Response(JSON.stringify({ code: 0 })); }) as typeof fetch);
  db.notify(null, 'signal.created', { title: '旧的测试事件' }, 'old'); await notifier.tick(); assert.equal(sent, 0);
  config.set('notification.subscription', { enabled: true, channels: ['feishu'], events: ['signal.created'], quiet: false, starts_at: now() });
  db.notify(null, 'signal.created', { title: '新的测试事件' }, 'new'); await notifier.tick(); await notifier.tick();
  assert.equal(sent, 1); assert.equal(db.rows("SELECT * FROM outbox WHERE channel='feishu'").length, 1); db.close();
});
test('archived body keyword scan creates linked leads without making collection requests',()=>{
  const {db,config,service}=setup();const monitor=new Monitoring(db,config,service,new Hotlists(db,async()=>{throw Error('network must not be called')}));
  monitor.save({title:'正文提醒',keywords:['AI 风险防控'],enabled:true});
  const task=service.createTask('归档样本测试',null,null,'chat');
  service.archive(task,'https://example.org/post/1','普通标题','这段正文提到了 AI 风险防控，应当被已归档正文匹配。','crawler');
  service.archive(task,'','无来源链接的帖子','另一段正文也提到了 AI 风险防控。','crawler');
  assert.equal(monitor.evaluateArchivedContent(),2);
  const signal=db.rows('SELECT * FROM signals').find(s=>s.title==='普通标题')!,e=JSON.parse(signal.evidence_json);
  assert.equal(e.type,'archived_post');assert.equal(e.source_url,'https://example.org/post/1');assert.equal(e.match_field,'body');assert.equal(e.current_heat,null);assert.equal(e.previous_heat,null);assert.ok(e.captured_at);
  const noSource=db.rows('SELECT * FROM signals').find(s=>s.title==='无来源链接的帖子')!;assert.equal(JSON.parse(noSource.evidence_json).source,'来源未提供');
  assert.equal(monitor.evaluateArchivedContent(),0);db.close();
});
test('pre-existing archived research content is not emitted as a newly discovered monitoring signal',()=>{
  const {db,config,service}=setup();const monitor=new Monitoring(db,config,service,new Hotlists(db,async()=>{throw Error('network must not be called')}));
  const task=service.createTask('既有归档样本',null,null,'chat');service.archive(task,'https://example.org/old','旧帖子标题','旧正文提及 AI 风险防控。','crawler');
  monitor.save({title:'新建监测规则',keywords:['AI 风险防控'],enabled:true});
  assert.equal(monitor.evaluateArchivedContent(),0,'only archive captures made after the monitor was created can create leads');
  assert.equal(db.one('SELECT COUNT(*) n FROM signals')!.n,0);db.close();
});
test('newly archived copies of posts published before the monitor are classified as historical and do not alert',()=>{
  const {db,config,service}=setup();const monitor=new Monitoring(db,config,service,new Hotlists(db,async()=>{throw Error('network must not be called')}));
  monitor.save({title:'新建监测规则',keywords:['AI 风险防控'],enabled:true});const task=service.createTask('历史帖子归档',null,null,'chat');
  service.archive(task,'https://example.org/old-published','旧发布日期帖子','正文提及 AI 风险防控。','crawler',undefined,{published_at:'2026-10-18T00:00:00.000Z'});
  assert.equal(monitor.evaluateArchivedContent(),0,'a late archive import of an old post must not look like a fresh discovery');assert.equal(db.one('SELECT COUNT(*) n FROM signals')!.n,0);db.close();
});
test('notification channel test sends a harmless message and never returns the webhook', async () => {
  const { db, config } = setup(); let sent: any;
  config.putSecret('service.wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-not-real');
  config.set('service.wecom', { enabled: true, base_url: 'https://qyapi.weixin.qq.com' });
  const notifier = new Notifications(db, config, (async (url, init) => { sent = { url: String(url), body: JSON.parse(String(init?.body)) }; return new Response('{"errcode":0}'); }) as typeof fetch);
  const result = await notifier.test('wecom');
  assert.equal(result.success, true); assert.deepEqual(sent.body, { msgtype: 'text', text: { content: 'DiTing 通知通道连通测试：企业微信机器人已成功接收测试消息。' } });
  assert.ok(!JSON.stringify(result).includes('fixture-not-real')); assert.equal(config.get<any>('service.health.wecom', {}).status, 'healthy'); db.close();
});
test('WeCom receives digest, urgent leads and actionable approval requests, but not report events',async()=>{
  const {db,config}=setup();let sent:string[]=[];
  config.putSecret('service.wecom','https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-not-real');config.set('service.wecom',{enabled:true,base_url:'https://qyapi.weixin.qq.com'});
  config.set('notification.subscription',{enabled:true,channels:['wecom'],events:['report.completed','daily_digest.completed','signal.high_priority'],quiet:false,starts_at:now(),public_base_url:'https://diting.example.org'});config.set('notification.public_base_url','https://diting.example.org');
  const digest={date:'2026-10-20',title:'AI监管讨论进入榜单视野',coverage:{succeeded:10,failed:2,sources:8,observations:300},source_ids:['dailyhot:weibo'],narrative:{lead:'多个议题进入关注视野。',events:[{topic_id:'topic1',headline:'AI监管讨论进入榜单视野',conclusion:'建议继续观察原始来源。'}],trends:[{headline:'监管议题延续',body:'同一议题仍见于归档榜单。'}]},sections:[{title:'今日总览',text:'AI 与监管议题进入榜单。'},{title:'重点事件',items:[{id:'topic1',rank:1,title:'AI 监管讨论升温',best_rank:2,sources:['dailyhot:weibo'],url:'https://example.org/topic'}]},{title:'趋势观察',text:'较昨日延续。'}]};
  db.run('INSERT INTO daily_digests(id,report_date,title,data_json,created_at) VALUES(?,?,?,?,?)','digest-test','2026-10-20','测试日报',JSON.stringify(digest),now());
  db.run('INSERT INTO daily_digests(id,report_date,title,data_json,created_at) VALUES(?,?,?,?,?)','brief-test','2026-10-20','测试早报',JSON.stringify({...digest,edition:'morning',through:'2026-10-20T03:30:00.000Z'}),now());
  const notifier=new Notifications(db,config,(async(_url,init)=>{sent.push(JSON.parse(String(init?.body)).text.content);return new Response('{"errcode":0}');}) as typeof fetch);
  db.notify(null,'report.completed',{title:'这不应发群'},'r1');db.notify(null,'approval.required',{approval_id:'approval-123'},'a1');
  db.notify(null,'daily_digest.completed',{digest_id:'digest-test',date:'2026-10-20'},'2026-10-20');
  db.notify(null,'daily_digest.completed',{digest_id:'brief-test',date:'2026-10-20',edition:'morning'},'2026-10-20:morning');
  const evidence={keywords:['AI 风险防控'],trigger_rule:'标题命中高危词：泄露',source:'dailyhot:weibo',rank:3,current_heat:900,previous_heat:null,published_at:null,source_url:'https://example.org/risk'};
  db.notify(null,'signal.high_priority',{title:'AI 数据泄露',priority:{level:'high'},evidence},'s1');
  await notifier.tick();assert.equal(sent.length,4);const digestText=sent.find(x=>x.includes('热点日报'))!,briefText=sent.find(x=>x.includes('今日早报'))!,signalText=sent.find(x=>x.includes('命中关键词：AI 风险防控'))!,approvalText=sent.find(x=>x.includes('待处理审批'))!;assert.match(digestText,/8 个榜单入口/);assert.match(digestText,/AI监管讨论进入榜单视野/);assert.match(digestText,/建议继续观察原始来源/);assert.match(digestText,/趋势变化：监管议题延续/);assert.match(digestText,/example\.org\/topic/);assert.match(digestText,/diting\.example\.org\/api\/daily-digests\/2026-10-20\/export\/html/);assert.match(briefText,/截至11:30/);assert.match(briefText,/不代表当日完整情况/);assert.match(briefText,/export\/html\?edition=morning/);assert.doesNotMatch(digestText,/127\.0\.0\.1|localhost/);assert.match(signalText,/无基线/);assert.match(signalText,/榜内排名：第 3 名/);assert.match(signalText,/example\.org\/risk/);assert.match(approvalText,/去处理：https:\/\/diting\.example\.org\/\?page=approve&approval_id=approval-123/);assert.equal(sent.some(x=>x.includes('提示词')),false);db.close();
});
test('WeCom suppresses stale archived-post backfill alerts but keeps them in the platform inbox',async()=>{
 const {db,config}=setup();let sent=0;
 config.putSecret('service.wecom','https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-not-real');config.set('service.wecom',{enabled:true,base_url:'https://qyapi.weixin.qq.com'});
 config.set('notification.subscription',{enabled:true,channels:['wecom'],events:['signal.high_priority'],quiet:false,starts_at:now()});
 const notifier=new Notifications(db,config,(async()=>{sent++;return new Response('{"errcode":0}');}) as typeof fetch);
 const old={type:'archived_post',published_at:'2026-10-18T00:00:00.000Z',captured_at:'2026-10-18T00:00:00.000Z',source_url:'https://example.org/old'};
 db.notify(null,'signal.high_priority',{title:'旧归档线索',priority:{level:'high'},evidence:old},'old-archived');
 await notifier.tick();assert.equal(sent,0);assert.equal(db.one("SELECT status FROM outbox WHERE event_type='signal.high_priority' AND channel='wecom'")!.status,'suppressed');
 assert.equal(db.one("SELECT status FROM outbox WHERE event_type='signal.high_priority' AND channel='in_app'")!.status,'delivered');db.close();
});
test('restarting after an outage does not send expired high-priority signals to WeCom',async()=>{
 const {db,config}=setup();let sent=0;
 config.putSecret('service.wecom','https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-not-real');config.set('service.wecom',{enabled:true,base_url:'https://qyapi.weixin.qq.com'});
 config.set('notification.subscription',{enabled:true,channels:['wecom'],events:['signal.high_priority'],quiet:false,starts_at:new Date(Date.now()-72*60*60_000).toISOString()});
 const stale=new Date(Date.now()-48*60*60_000).toISOString();
 db.run('INSERT INTO outbox(id,dedupe_key,event_type,channel,payload_json,status,created_at) VALUES(?,?,?,?,?,?,?)','stale-wecom','stale-wecom','signal.high_priority','wecom',JSON.stringify({title:'过期热榜线索',priority:{level:'high'},evidence:{type:'hotlist',source_url:'https://example.org/stale'}}),'pending',stale);
 const notifier=new Notifications(db,config,(async()=>{sent++;return new Response('{"errcode":0}');}) as typeof fetch);
 await notifier.tick();assert.equal(sent,0);
 const row=db.one("SELECT status,last_error FROM outbox WHERE id='stale-wecom'")!;
 assert.equal(row.status,'suppressed');assert.equal(row.last_error,'expired_high_priority_signal');db.close();
});
test('model credential rotation keeps the old encrypted reference for frozen task configurations', () => {
  const { db, config } = setup(); const route = { id: 'planner', provider: 'fixture', model: 'test', base_url: 'http://127.0.0.1:1/v1', enabled: true };
  config.saveRoute({ ...route, api_key: 'first-test-key' }); const old = config.route('planner')!;
  config.saveRoute({ ...route, api_key: 'second-test-key' }); const newer = config.route('planner')!;
  assert.notEqual(old.key_ref, newer.key_ref); assert.equal(config.secret(old.key_ref), 'first-test-key'); assert.equal(config.secret(newer.key_ref), 'second-test-key');
  assert.ok(!JSON.stringify(config.publicRoutes()).includes('test-key')); db.close();
});
