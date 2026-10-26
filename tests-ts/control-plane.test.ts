import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../apps/server/settings.js';
import { Database, now } from '../packages/domain/db.js';
import { Service, Conflict } from '../packages/domain/service.js';
import { createApp } from '../apps/server/app.js';
import { Configuration } from '../packages/domain/configuration.js';
import { Chat } from '../packages/domain/chat.js';
import { Hotlists } from '../packages/collectors/hotlists.js';
import { scrapePublicPage } from '../packages/collectors/search.js';
import { statistics, validateReport, renderReport, templates, validateTemplateMarkdown } from '../packages/reporting/report.js';
import { ReportPipeline } from '../packages/reporting/pipeline.js';
import { searchWeb } from '../packages/collectors/search.js';
import { reportQuestionContext } from '../packages/domain/chat.js';
import { assertReviewPrerequisites } from '../packages/reporting/quality.js';
import { recordBudgetState } from '../packages/domain/notifications.js';

function setup() { const dir = mkdtempSync(join(tmpdir(), 'diting-ts-')), db = new Database(join(dir, 'diting.sqlite3'), ROOT), service = new Service(db); return { dir, db, service }; }
function make(s: Service, title = '调查近7天 AI 行业，预算30元，给我完整报告') { const sid = s.session(); return { sid, id: s.send(sid, title, 'request-0001').task_id as string }; }
function prepared(s: Service, title?: string) {
  const id = title ? s.createTask(title, null) : make(s).id, run = s.claim('test')!;
  const eid = s.archive(id, 'https://example.org/notice', '明确测试原文', '测试原文：机构发布了公开资料，仅用于自动测试。');
  const cid = s.addClaim(id, '测试机构发布公开资料', [{ evidence_id: eid, quote: '机构发布了公开资料' }], run.lease_owner);
  return { id, token: run.lease_owner as string, cid };
}
function gates(s: Service, id: string, token: string) { for (const gate of ['sufficiency', 'verifier', 'advocate']) s.review(id, gate, true, '自动测试用例中的明确审查记录，不是线上事实验证', token, s.reviewInput(id)); }

test('questions do not create tasks, research persists, duplicate request conflicts', () => {
  const { db, service: s } = setup(), sid = s.session();
  for (const [i, q] of ['舆情研判是什么？', '怎么配置模型', '能不能分析报告'].entries()) assert.equal(s.send(sid, q, `question-${i}`).task_id, null);
  const a = s.send(sid, '调查近7天 AI，预算30元', 'same-request-key'), b = s.send(sid, '调查近7天 AI，预算30元', 'same-request-key');
  assert.equal(a.task_id, b.task_id); assert.equal(s.tasks().length, 1); assert.equal(s.task(a.task_id).budget, 30);
  assert.throws(() => s.send(sid, '调查另一主题', 'same-request-key'), Conflict); assert.ok(!('lease_owner' in s.task(a.task_id))); db.close();
});
test('conversation template mode is frozen as auto, user upload, or co-created template on each research task',()=>{
 const {db,service:s,dir}=setup(),config=new Configuration(db,dir),sid=s.session();
 try{const imported=validateTemplateMarkdown('测试上传模板','# 测试模板\n## 报告摘要\n## 事实背景\n## 多方观点\n## 影响分析\n## 风险研判\n## 结论建议','user_import'),created=validateTemplateMarkdown('测试共创模板','# 共创模板\n## 报告摘要\n## 事件脉络\n## 观点分析\n## 影响评估\n## 风险研判\n## 行动建议','co_created');config.set('templates.custom',[imported,created]);
  const auto=s.send(sid,'调查近期AI行业争议','template-auto-req');assert.equal(s.task(auto.task_id).config.template_selection.mode,'auto');
  const upload=s.createTask('研究品牌声誉',sid,null,'chat',{mode:'user_import',template_id:imported.id});assert.equal(s.task(upload).config.template,imported.id);assert.equal(s.task(upload).config.template_selection.mode,'user_import');
  const co=s.createTask('研究突发事件',sid,null,'chat',{mode:'co_created',template_id:created.id});assert.equal(s.task(co).config.template_selection.template_name,created.name);assert.throws(()=>s.createTask('研究错误模板',sid,null,'chat',{mode:'user_import',template_id:created.id}),/上传并选择/);
 }finally{db.close();}
});
test('single slot, user priority, expired lease and pause fence late callbacks', () => {
  const { db, service: s } = setup(); s.createTask('调查自动主题', null, null, 'sentinel'); const user = make(s);
  const old = s.claim('old', -1)!; assert.equal(old.id, user.id);
  const fresh = s.claim('new')!; assert.notEqual(old.lease_owner, fresh.lease_owner); assert.equal(s.claim('another'), undefined);
  assert.equal(s.waitRuntime(user.id, old.lease_owner, 'late'), false);
  s.action(user.id, 'pause', fresh.revision); assert.throws(() => s.requireRun(user.id, fresh.lease_owner), Conflict);
  assert.throws(() => s.action(user.id, 'resume', fresh.revision), Conflict); db.close();
});
test('evidence deduplication does not permit cross-task references', () => {
  const { db, service: s } = setup(), a = make(s), b = make(s, '调查第二个主题'); const run = s.claim('test')!;
  const eid = s.archive(a.id, 'https://example.org/a', '测试', '这是测试原文材料；不代表联网核验。');
  assert.equal(eid, s.archive(a.id, 'https://example.org/a', '测试', '这是测试原文材料；不代表联网核验。'));
  s.action(a.id, 'cancel', s.task(a.id).revision); const rb = s.claim('test')!;
  assert.throws(() => s.addClaim(b.id, '错误跨任务结论', [{ evidence_id: eid, quote: '测试原文材料' }], rb.lease_owner), Conflict);
  assert.equal(s.archive(b.id, 'https://example.org/a', '测试', '这是测试原文材料；不代表联网核验。'), eid); db.close();
});
test('evidence archive links identical copies across URLs without merging the source records',()=>{
  const {db,service:s}=setup(),{id}=make(s),text='同一篇公开报道中的长文本，用于证明相同内容可被关系表标记，但不能把来源身份或独立性假设成已核实。'.repeat(4);
  const a=s.archive(id,'https://publisher-a.example/story','报道副本A',text),b=s.archive(id,'https://publisher-b.example/repost','转载副本B',text);
  const relation=db.one('SELECT * FROM evidence_relations WHERE task_id=?',id);assert.ok(relation);assert.equal(relation.relation,'same_content');assert.equal(db.one('SELECT COUNT(*) n FROM task_evidence WHERE task_id=?',id)!.n,2);db.close();
});
test('report gates bind evidence and claim revisions and commit notification atomically', () => {
  const { db, service: s } = setup(), { id, token, cid } = prepared(s), doc = { title:'可读的研究报告标题',sections: [{ title: '事实', text: '测试事实', claim_ids: [cid] }] };
  assert.throws(() => s.publishReport(id, doc, token), Conflict); gates(s, id, token);
  s.archive(id, 'https://example.org/b', '新增原文', '新增原文会使旧版审查失效，必须重新核查。');
  assert.throws(() => s.publishReport(id, doc, token), Conflict); gates(s, id, token);
  const rid = s.publishReport(id, doc, token); assert.ok(rid); assert.equal(s.task(id).status, 'completed'); assert.equal(db.rows('SELECT * FROM outbox').length, 1);
  assert.equal(db.one('SELECT title FROM reports WHERE id=?',rid)!.title,doc.title,'report center uses the report title, not the full research instruction');
  assert.throws(() => s.archive(id, 'https://example.org/c', '错误追加', '成稿后不应追加'), Conflict); db.close();
});
test('known cache is part of input and unknown fees remain unknown', () => {
  const { db, service: s } = setup(), { id } = make(s); s.recordUsage(id, 'query', 'fixture', 1000, 100, 400, { input: 2, cache: .2, output: 8 }); s.recordUsage(id, 'query', 'fixture', null, null, null);
  const calls = db.rows('SELECT * FROM usage'); assert.ok(Math.abs(calls[0].cost - .00208) < 1e-10); assert.equal(calls[1].cost, null); assert.throws(() => s.recordUsage(id, 'q', 'x', 1, 1, 2)); db.close();
});
test('encrypted model credentials are not returned by config; model reply is saved once', async () => {
  const { db, dir, service: s } = setup(), c = new Configuration(db, dir);
  c.saveRoute({ id: 'chat', provider: 'fixture', model: 'explicit-test-model', base_url: 'http://127.0.0.1:9999/v1', api_key: 'fixture-key-not-real', enabled: true });
  assert.ok(!JSON.stringify(c.publicRoutes()).includes('fixture-key-not-real'));
  assert.ok(!db.one('SELECT ciphertext FROM secrets')!.ciphertext.includes('fixture-key-not-real'));
  let calls = 0; const fetcher = (async () => { calls++; await new Promise(r => setTimeout(r, 5)); return new Response(JSON.stringify({ choices: [{ message: { content: '明确的自动测试答复，不是研究结论。' } }], usage: { prompt_tokens: 12, completion_tokens: 10 } }), { headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
  const chat = new Chat(s, c, fetcher), sid = s.session();
  const [a, b] = await Promise.all([chat.send(sid, '舆情是什么？', 'same-chat-request'), chat.send(sid, '舆情是什么？', 'same-chat-request')]);
  assert.equal(calls, 1); assert.equal(a.answer, b.answer); assert.equal(s.tasks().length, 0); assert.equal(db.one('SELECT COUNT(*) n FROM model_calls')!.n, 1); assert.equal(db.one('SELECT cost FROM model_calls')!.cost, null); db.close();
});
test('Anthropic Messages routes use native endpoint, headers, body and usage fields', async () => {
  const { db, dir, service: s } = setup(), c = new Configuration(db, dir);
  c.saveRoute({ id: 'chat', protocol: 'anthropic-messages', provider: '智谱 Anthropic', model: 'GLM-5.3-Flash', base_url: 'https://open.bigmodel.cn/api/anthropic', api_key: 'fixture-key-not-real', enabled: true });
  let request: Request | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '明确的协议测试答复。' }], usage: { input_tokens: 18, output_tokens: 7, cache_read_input_tokens: 2 } }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const chat = new Chat(s, c, fetcher), sid = s.session();
  const result = await chat.send(sid, '解释舆情分析是什么', 'anthropic-request');
  assert.equal(new URL(request!.url).pathname, '/api/anthropic/v1/messages');
  assert.equal(request!.headers.get('x-api-key'), 'fixture-key-not-real');
  assert.equal(request!.headers.get('anthropic-version'), '2023-06-01');
  const body = await request!.json() as any;
  assert.equal(body.model, 'GLM-5.3-Flash'); assert.ok(body.system); assert.equal(body.messages.at(-1).content, '解释舆情分析是什么');
  assert.equal(result.answer, '明确的协议测试答复。');
  const call = db.one('SELECT * FROM model_calls')!;
  assert.equal(call.input_tokens, 20); assert.equal(call.output_tokens, 7); assert.equal(call.cache_tokens, 2); assert.equal(call.cost, null);
  const seeded = c.seedResearchRoutesFromChat(); assert.equal(seeded.created.length, 7); assert.equal(c.route('planner')?.protocol, 'anthropic-messages'); assert.equal(c.route('keyword')?.protocol, 'anthropic-messages');
  assert.equal(c.get<any>('llm.planner', {}).key_ref, c.get<any>('llm.chat', {}).key_ref); assert.equal(c.route('insight')?.rates, undefined);
  db.close();
});

test('empty chat output retains actual vendor usage rather than losing billed tokens',async()=>{
  const {db,dir,service:s}=setup(),c=new Configuration(db,dir);
  c.saveRoute({id:'chat',provider:'fixture',model:'fixture',base_url:'https://model.example/v1',api_key:'explicit-fixture',enabled:true,rates:{input:1,cache:0.1,output:2}});
  const chat=new Chat(s,c,async()=>new Response(JSON.stringify({choices:[{message:{content:''}}],usage:{prompt_tokens:100,completion_tokens:200,prompt_tokens_details:{cached_tokens:0}}}))),sid=s.session();
  const result=await chat.send(sid,'舆情分析是什么？','empty-output-usage-test');
  assert.match(result.answer,/模型未返回文本/);const call=db.one('SELECT * FROM model_calls')!;
  assert.equal(call.status,'failed');assert.equal(call.output_tokens,200);assert.ok(call.cost>0);db.close();
});
test('chat marks provider-truncated answers incomplete while retaining billed usage',async()=>{
  const {db,dir,service:s}=setup(),c=new Configuration(db,dir);
  c.saveRoute({id:'chat',protocol:'anthropic-messages',provider:'fixture',model:'GLM-5.3-Flash',base_url:'https://model.example/api/anthropic',api_key:'explicit-fixture',enabled:true,rates:{input:1,cache:0.1,output:2}});
  const chat=new Chat(s,c,async()=>new Response(JSON.stringify({content:[{type:'text',text:'部分答复'}],stop_reason:'max_tokens',usage:{input_tokens:100,output_tokens:4096,cache_read_input_tokens:0}}))),sid=s.session();
  const result=await chat.send(sid,'报告问题','truncated-chat-answer-test');
  assert.match(result.answer,/内容不完整/);assert.match(result.answer,/不可视为完整答复/);
  const call=db.one('SELECT * FROM model_calls')!;assert.equal(call.status,'failed');assert.equal(call.output_tokens,4096);assert.ok(call.cost>0);db.close();
});
test('DiTing extracts public article text in-process without a Firecrawl service and rejects verification pages',async()=>{
  const {db,dir}=setup(),config=new Configuration(db,dir),url='https://news.example/article';
  const html=`<html><head><title>公开事项办理安排</title></head><body><nav>${'导航栏链接'.repeat(100)}</nav><article>${'<p>主管部门公布公开事项的办理安排和咨询方式，申请人员可根据公告提交材料。</p>'.repeat(30)}</article><footer>相关推荐</footer></body></html>`;
  const noRemote=(async()=>{throw new Error('不得调用独立抓取服务');}) as typeof fetch;
  const pageFetcher=(async(target:string,_signal:AbortSignal,publicOnly:boolean,init:{allowedOrigins:string[]})=>{assert.equal(target,url);assert.equal(publicOnly,true);assert.deepEqual(init.allowedOrigins,['https://news.example']);return{text:html,url,headers:{'content-type':'text/html; charset=utf-8'}};}) as any;
  try{
    const result=await scrapePublicPage(config,url,new AbortController().signal,noRemote,pageFetcher);
    assert.equal(result.provider,'diting-native');assert.ok(result.content.length>=800);assert.match(result.content,/办理安排和咨询方式/);assert.doesNotMatch(result.content,/导航栏链接|相关推荐/);
    const blocked=(async()=>({text:'<html><title>安全检测</title><main><p>火山引擎正在进行安全检测，请完成安全验证。</p></main></html>',url,headers:{'content-type':'text/html'}})) as any;
    await assert.rejects(scrapePublicPage(config,url,new AbortController().signal,noRemote,blocked),/安全检测|足够的新闻正文/);
  }finally{db.close();}
});
test('configured Firecrawl integration scrapes and returns normalized source content', async () => {
  const { db, dir } = setup(), config = new Configuration(db, dir);
  config.putSecret('service.firecrawl', 'fixture-firecrawl-key'); config.set('service.firecrawl', { enabled: true, base_url: 'https://crawl.example/v1' });
  let seen = '';
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => { seen = String(input); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-firecrawl-key'); return new Response(JSON.stringify({ success: true, data: { markdown: '# 已抓取\n'.padEnd(200, '真实正文。'), metadata: { title: '公开页面', sourceURL: 'https://news.example/article' } } }), { headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
  const result = await scrapePublicPage(config, 'https://news.example/article', new AbortController().signal, fetcher);
  assert.equal(seen, 'https://crawl.example/v1/scrape'); assert.equal(result.provider, 'firecrawl'); assert.equal(result.title, '公开页面'); assert.equal(result.url, 'https://news.example/article'); assert.ok(result.content.length > 150); db.close();
});
test('loopback self-hosted Firecrawl works without an API key', async () => {
  const { db, dir } = setup(), config = new Configuration(db, dir);
  config.set('service.firecrawl', { enabled: true, base_url: 'http://127.0.0.1:3002' });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'http://127.0.0.1:3002/v2/scrape');
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    return new Response(JSON.stringify({ success: true, data: { markdown: '新闻正文。'.repeat(200), metadata: { sourceURL: 'https://news.example/article' } } }), { status: 200 });
  }) as typeof fetch;
  const result = await scrapePublicPage(config, 'https://news.example/article', new AbortController().signal, fetcher);
  assert.equal(result.provider, 'firecrawl'); assert.ok(result.content.length > 800); db.close();
});
test('web search passes a date window, removes known out-of-window results and labels unknown dates',async()=>{
  const {db,dir,service}=setup(),config=new Configuration(db,dir),task=service.createTask('固定窗口检索测试',null);config.set('service.tavily',{enabled:true,base_url:'https://api.tavily.example/search'});config.putSecret('service.tavily','fixture-key');let body:any={};
  const fetcher=(async(_url:RequestInfo|URL,init?:RequestInit)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({results:[{title:'窗口内',url:'https://example.org/in',content:'发现摘要',published_date:'2026-10-17'},{title:'窗口外',url:'https://example.org/out',content:'旧摘要',published_date:'2026-09-01'},{title:'日期未知',url:'https://example.org/unknown',content:'无日期摘要'}]}),{headers:{'Content-Type':'application/json'}})}) as typeof fetch;
  const result=await searchWeb(config,task,'明确的测试主题',new AbortController().signal,fetcher,{start_date:'2026-10-10',end_date:'2026-10-18'});
  assert.equal(body.start_date,'2026-10-10');assert.equal(body.end_date,'2026-10-18');assert.deepEqual(result.results.map(r=>r.date_status),['in_window','unknown']);assert.equal(result.window.unknown_date_policy,'保留并标记 unknown；不将采集时间当发布时间');await assert.rejects(searchWeb(config,task,'明确的测试主题',new AbortController().signal,fetcher,{start_date:'2026-02-31'}),/有效的 YYYY-MM-DD/);db.close();
});
test('native collectors request original platform URL, preserve failure audits and raw responses', async () => {
  const { db } = setup(); const urls: string[] = [];
  const collector = new Hotlists(db, async url => { urls.push(url); return { url, text: JSON.stringify({ data: { realtime: [{ word: '明确测试条目', num: 0 }] } }) }; });
  const result = await collector.collect('dailyhot', ['weibo']); assert.equal(result.succeeded, 1); assert.equal(new URL(urls[0]).hostname, 'weibo.com');
  assert.equal(collector.latest()[0].items[0].heat_value, 0); assert.equal(db.rows('SELECT * FROM hotlist_responses').length, 1);
  const broken = new Hotlists(db, async () => { throw new Error('explicit fixture failure'); }); await broken.collect('dailyhot', ['weibo']);
  assert.equal(broken.latest()[0].status, 'failed'); assert.equal(db.rows("SELECT * FROM acquisitions WHERE status='failed'").length, 1); db.close();
});
test('report tables are computed from archived samples; stale tables and unsafe content are handled', () => {
  const { db, service: s } = setup(), { id, cid } = prepared(s); const data = statistics(db, id);
  const input = { title: '<script>test</script>', template_id: 'public-event', sections: templates.find(t=>t.id==='public-event')!.sections.map(title => ({ title, text: '这是足够长度的明确测试章节内容，不是线上研究。', claim_ids: [cid] })), dataset_ids: [data.id], limitations: ['此处只是明确的自动测试材料。'] };
  const doc = validateReport(db, id, input), rendered = renderReport(db, id, doc); assert.ok(!rendered.html.includes('<script>test</script>')); assert.ok(rendered.html.includes('<table>')); assert.ok(rendered.html.includes('<svg'));assert.ok(rendered.html.includes(`href="#${cid}"`));assert.ok(rendered.markdown.includes(`[${cid}](#${cid})`));
  s.archive(id, 'https://different.example/a', '新增', '新增资料将改变样本数和统计底表。'); assert.throws(() => validateReport(db, id, input), /底表/); db.close();
});
test('report enforces the selected template chapters and rejects incomplete uploaded templates', async () => {
  const { db, service:s } = setup(), { id, cid } = prepared(s), data = statistics(db, id), brand = templates.find(t=>t.id==='brand')!;
  const sections = brand.sections.filter(title=>title!==brand.main_sections[1]).map(title=>({title,text:'这是足够长度的明确测试章节内容，不是线上研究。',claim_ids:[cid]}));
  const input={title:'模板约束测试报告',template_id:'brand',sections,dataset_ids:[data.id],limitations:['测试资料不能证明真实世界事实。']};
  assert.throws(()=>validateReport(db,id,input),/模板必需章节/);
  assert.throws(()=>validateTemplateMarkdown('无标题模板','没有章节的纯文本模板'),/至少需要 6 个/);
  assert.throws(()=>validateTemplateMarkdown('缺少摘要',['# 背景','# 范围','# 事实','# 样本','# 风险','# 建议'].join('\n')),/摘要/);
  assert.equal(validateTemplateMarkdown('完整模板',['# 摘要','# 范围与方法','# 事实与时间线','# 样本分析','# 观点与分歧','# 风险研判','# 应对建议','# 局限与待核实事项','# 来源与统计附录'].join('\n')).sections.length,9);
  await (async()=>{const dir=mkdtempSync(join(tmpdir(),'diting-template-api-')),app=await createApp({dataDir:dir},false);const invalid=await app.app.inject({method:'POST',url:'/api/templates',payload:{name:'坏模板',markdown:'纯文本没有章节'}});assert.equal(invalid.statusCode,400);await app.app.close();})();
  db.close();
});
test('report finalization assembles saved chapters and keeps the selected template contract frozen',()=>{
  const {db,service:s}=setup(),{id,cid}=prepared(s),table=statistics(db,id),pipeline=new ReportPipeline(db,s,id),selected=templates.find(t=>t.id==='public-event')!;
  pipeline.record('template',{template_id:selected.id,reason:'使用完整公共事件研究骨架并逐章附证据'});
  pipeline.record('evidence_map',{claim_ids:[cid],evidence_ids:[db.one('SELECT evidence_id FROM task_evidence WHERE task_id=?',id)!.evidence_id]});
  const chapters=selected.sections.map((title,index)=>({id:`chapter-${index}`,title,goal:'解释本章节需要核对的证据、研究范围和局限'}));
  const minChars=(title:string)=>/摘要|概览/.test(title)?700:/来源|附录/.test(title)?100:/范围|方法|局限/.test(title)?300:/样本|平台/.test(title)?500:900;
  pipeline.record('layout',{chapters});pipeline.record('length',{chapters:chapters.map(c=>({id:c.id,min_chars:minChars(c.title),max_chars:3000}))});
  for(const c of chapters)pipeline.record('chapter',{id:c.id,title:c.title,text:`### ${c.title}需要放在本章讨论\n\n本章围绕${c.title}展开独立测试分析。公开材料可以支持有限判断，但不能替代更多来源核实。研究者应比较不同主体的说法，说明证据可以证明什么、还不能证明什么，并给出下一步需要检查的具体事项。${('围绕本章节主题继续核对原文、主体回应与适用条件。'.repeat(100))}`,claim_ids:[cid]});
  pipeline.record('repair',{issues:[],actions:[]});
  const assembled=pipeline.finalize({title:'已保存章节装配测试',template_id:selected.id,dataset_ids:[table.id],limitations:['本测试内容为合成资料，不代表真实研究。']});
  assert.ok(assembled.artifact_id);const candidate=JSON.parse(db.one("SELECT data_json FROM artifacts WHERE id=?",assembled.artifact_id)!.data_json);
  assert.equal(candidate.document.sections.length,selected.sections.length);assert.equal(candidate.template_contract.sections.length,selected.sections.length);db.close();
});
test('report follow-up retrieves the matching evidence from the bound report version instead of truncating the evidence tail',()=>{
  const {db,service:s}=setup(),task=s.createTask('固定报告追问检索测试',null),run=s.claim('followup-test')!,first=s.archive(task,'https://example.org/first','普通资料','普通背景资料。'.repeat(900)),last=s.archive(task,'https://example.org/last','尾部特殊线索','尾部特殊线索说明了关键变化及其公开回应。'.repeat(500));
  const c1=s.addClaim(task,'普通背景资料说明了基本情况',[{evidence_id:first,quote:'普通背景资料'}],run.lease_owner),c2=s.addClaim(task,'尾部特殊线索说明了关键变化',[{evidence_id:last,quote:'尾部特殊线索说明了关键变化'}],run.lease_owner);
  const report={id:'report-fixed-v2',task_id:task,version:2,title:'固定版本报告',document_json:JSON.stringify({sections:[{title:'一般背景',text:'一般背景介绍。'.repeat(1800),claim_ids:[c1]},{title:'关键变化',text:'尾部特殊线索说明了关键变化。'.repeat(1800),claim_ids:[c2]},{title:'补充背景',text:'补充背景材料。'.repeat(1800),claim_ids:[c1]}],tables:[{title:'尾部特殊线索统计表',metric:'归档样本计数，不代表总体声量',columns:['类型','数量'],rows:[['特殊线索',7]]}]})};
  const query='尾部特殊线索是什么？',context=reportQuestionContext(db,report,query,6000),defaultContext=reportQuestionContext(db,report,query);assert.equal(context.version,2);assert.equal(context.sections[0].title,'关键变化');assert.equal(context.evidence[0].id,last);assert.ok(context.evidence[0].content.includes('尾部特殊线索'));assert.equal(defaultContext.sections[0].title,'关键变化');assert.ok(defaultContext.evidence.some(e=>e.id===last),'default-size context must retain query-matching evidence after long report sections');assert.equal(defaultContext.tables[0].rows[0][1],7,'report Q&A should include matching frozen report tables');assert.ok(JSON.stringify(defaultContext).length<=16000);
  db.run('INSERT INTO approvals VALUES(?,?,?,?,?,?,?)','approval-followup',task,'crawl.deep','{}','approved','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z');
  db.run('INSERT INTO crawl_batches VALUES(?,?,?,?,?,?,?,?,?,?)','crawl-followup',task,'approval-followup','bilibili','{}','completed','fixture','{}','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z');
  for(let i=0;i<3;i++)db.run('INSERT INTO crawl_pages VALUES(?,?,?,?,?,?,?,?,?,?,?)',`page-followup-${i}`,'crawl-followup',`hash-followup-${i}`,'video','https://example.org/video','succeeded','{}',null,1,'2026-10-23T00:00:00Z','2026-10-23T00:00:00Z');
  const processContext=reportQuestionContext(db,report,'B站采集实际请求几次？');assert.equal(processContext.platform_batches[0].id,'crawl-followup');assert.equal(processContext.platform_batches[0].request_records,3);assert.equal(processContext.platform_batches[0].request_attempts,3);assert.ok(JSON.stringify(processContext).length<=16000);
  assert.equal(reportQuestionContext(db,{...report,created_at:'2026-10-22T00:00:00Z'},'B站采集实际请求几次？').platform_batches.length,0,'发布后的批次不得进入旧报告追问');db.close();
});
test('report Q&A fails closed when citations are missing or outside the bound report evidence',async()=>{
 for(const cited of ['', '[evidence_not-in-report]']){
  const {db,dir,service:s}=setup(),{id,token,cid}=prepared(s,'报告追问引用门禁测试');
  try{
   gates(s,id,token);const reportId=s.publishReport(id,{title:'报告追问测试报告',sections:[{title:'关键结论',text:'测试结论引用证据。',claim_ids:[cid]}]},token),sid=s.session('追问',reportId);
   const config=new Configuration(db,dir);config.saveRoute({id:'chat',provider:'fixture',model:'chat-test',base_url:'https://model.example/v1',api_key:'test-secret',enabled:true,max_tokens:2048});
   const chat=new Chat(s,config,(async()=>new Response(JSON.stringify({choices:[{message:{content:`测试答复${cited}`}}],usage:{prompt_tokens:30,completion_tokens:12}}),{headers:{'Content-Type':'application/json'}})) as typeof fetch);
   const result=await chat.send(sid,'报告的关键结论是什么？',`citation-gate-${cited?'bad':'missing'}`);
   assert.match(result.answer,/无法核验|不存在/);assert.equal(db.one('SELECT status FROM model_calls WHERE role=?','chat')!.status,'failed');
  }finally{db.close();}
 }
});
test('passing quality gates requires three evidence-bearing member results, substantive Forum notes and gate-specific review rationale',()=>{
  const {db,service:s}=setup(),{id,cid}=prepared(s,'核对单条监管公告');assert.throws(()=>assertReviewPrerequisites(db,id,'sufficiency','范围覆盖已经完成'),/insight 调查成员尚未提交/);
  for(const role of ['insight','media','query'])db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',`fixture-${role}`,id,'investigation',role,JSON.stringify({claim_ids:[cid]}),now());
  db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)','fixture-forum',id,'forum','forum',JSON.stringify({summary:'三个成员已完成独立调查，现记录一致观点、分歧以及尚未核实的材料边界。'}),now());
  assert.doesNotThrow(()=>assertReviewPrerequisites(db,id,'sufficiency','研究范围覆盖到本次材料，仍有一个缺口需要说明。'));
  assert.throws(()=>assertReviewPrerequisites(db,id,'verifier','材料看起来没有问题'),/检查项/);
  assert.doesNotThrow(()=>assertReviewPrerequisites(db,id,'verifier','逐条核对原文与来源；独立交叉来源不足处已明确披露。'));
  assert.doesNotThrow(()=>assertReviewPrerequisites(db,id,'advocate','已检查反例、替代解释与样本局限。'));
  db.close();
});
test('broad industry topics cannot pass the sufficiency gate on a thin evidence sample',()=>{
  const {db,service:s}=setup(),{id,cid}=prepared(s,'研究近期 AI 行业舆情并分析趋势');
  for(const role of ['insight','media','query'])db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',`broad-${role}`,id,'investigation',role,JSON.stringify({claim_ids:[cid]}),now());
  db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)','broad-forum',id,'forum','forum',JSON.stringify({summary:'已梳理当前材料的主要共识、核心争议、重复来源及仍待补证的覆盖缺口。'}),now());
  assert.throws(()=>assertReviewPrerequisites(db,id,'sufficiency','范围覆盖和缺口已经核对'),/至少 30 条原文/);db.close();
});
test('budget warning and exhaustion create deduplicated notification events',()=>{
  const {db,service}=setup(),task=service.createTask('预算通知测试',null);recordBudgetState(db,task,10,8.2,'usage');recordBudgetState(db,task,10,8.9,'usage');recordBudgetState(db,task,10,9,'usage');recordBudgetState(db,task,10,9.7,'usage');recordBudgetState(db,task,10,10.2,'usage');recordBudgetState(db,task,10,11,'reservation');
  assert.equal(db.rows("SELECT id FROM outbox WHERE task_id=? AND event_type='budget.warning'",task).length,2);assert.equal(db.rows("SELECT id FROM outbox WHERE task_id=? AND event_type='budget.exhausted'",task).length,1);assert.deepEqual(db.rows("SELECT json_extract(payload_json,'$.threshold_percent') threshold FROM events WHERE task_id=? AND kind='budget.warning' ORDER BY id",task).map(row=>row.threshold),[80,90]);assert.equal(db.rows("SELECT id FROM events WHERE task_id=? AND kind='budget.exhausted'",task).length,1);db.close();
});
test('unsupported numerical claims and skipped report stages cannot be accepted', () => {
  const { db, service: s } = setup(), { id, token, cid } = prepared(s), eid = db.one('SELECT evidence_id FROM task_evidence WHERE task_id=?', id)!.evidence_id;
  assert.throws(() => s.addClaim(id, '测试机构发布了999份资料', [{ evidence_id: eid, quote: '机构发布了公开资料' }], token), /数字/);
  const numericEvidence=s.archive(id,'https://example.org/numeric','数字主体对照原文','甲组共有42条记录，乙组共有7条记录；样本占比为12%。');
  assert.throws(()=>s.addClaim(id,'甲组共有7条记录',[{evidence_id:numericEvidence,quote:'甲组共有42条记录，乙组共有7条记录'}],token),/“7”：结论主体“甲组”与引文主体“乙组”不同/);
  assert.throws(()=>s.addClaim(id,'样本占比为12%',[{evidence_id:numericEvidence,quote:'甲组共有42条记录'}],token),/数字/);
  assert.equal(s.addClaim(id,'乙组共有7条记录',[{evidence_id:numericEvidence,quote:'甲组共有42条记录，乙组共有7条记录'}],token).startsWith('claim_'),true);
  const pipeline = new ReportPipeline(db, s, id);
  assert.throws(() => pipeline.finalize({ sections: [] }), /阶段/);
  assert.throws(() => pipeline.record('chapter', { id: 'x', title: '跳过前置规划', text: '直接写作不应跳过前置阶段。', claim_ids: [cid] }), /规划/);
  db.close();
});
test('statistical claims bind the exact generated table row instead of accepting any dataset number',()=>{
  const {db,service:s}=setup(),{id,token}=prepared(s),eid=db.one('SELECT evidence_id FROM task_evidence WHERE task_id=?',id)!.evidence_id,quote='测试材料仅用于绑定一项代码统计结果。';s.archive(id,'https://example.org/stats-note','统计说明原文',quote);const dataset=statistics(db,id).datasets.find(d=>d.dimension==='sentiment')!,row=dataset.rows.find((r:any[])=>r[0]==='未分类')!;
  assert.throws(()=>s.addClaim(id,`未分类归档文档共有${row[1]+1}条`,[{evidence_id:eid,quote:'机构发布了公开资料'}],token,[{dataset_id:dataset.id,row_key:'未分类',value:row[1]}]),/完全对应/);
  const claim=s.addClaim(id,`未分类归档文档共有${row[1]}条`,[{evidence_id:eid,quote:'机构发布了公开资料'}],token,[{dataset_id:dataset.id,row_key:'未分类',value:row[1]}]);assert.equal(db.one('SELECT row_key FROM claim_dataset_refs WHERE claim_id=?',claim)!.row_key,'未分类');
  const doc=validateReport(db,id,{title:'统计事实引用验收',template_id:'public-event',sections:templates.find(t=>t.id==='public-event')!.sections.map(title=>({title,text:'此章内容以已引用的合成样本说明结构，未增加数字结论。',claim_ids:[claim]})),dataset_ids:[dataset.id],limitations:['本例只证明代码字段关联，不证明现实数据。']});const rendered=renderReport(db,id,doc);assert.ok(rendered.html.includes(`href="#${dataset.id}"`));assert.ok(rendered.markdown.includes(`未分类=${row[1]}`));
  assert.throws(()=>s.addClaim(id,`正向归档文档共有${row[1]}条`,[{evidence_id:eid,quote:'机构发布了公开资料'}],token,[{dataset_id:dataset.id,row_key:'未分类',value:row[1]}]),/主体、行标签和数值/);db.close();
});
test('HTTP validation, same origin and v5 UI baseline work without executing research', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diting-api-')), { app, db, service } = await createApp({ dataDir: dir }, false);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).json().mode, 'typescript_control_plane');
  assert.equal((await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/sessions', payload: {}, headers: { origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/sessions', payload: { extra: true } })).statusCode, 400);
  const subscriptions=await app.inject({method:'PUT',url:'/api/subscriptions',payload:{enabled:true,channels:['feishu'],events:['report.updated','budget.warning','budget.exhausted'],quiet:false}});
  assert.equal(subscriptions.statusCode,200);assert.deepEqual(subscriptions.json().events,['report.updated','budget.warning','budget.exhausted']);
  const digest=await app.inject({method:'POST',url:'/api/daily-digests/2026-10-20/generate',payload:{}});assert.equal(digest.statusCode,200);assert.deepEqual(digest.json().sections.map((s:any)=>s.title),['今日总览','重点事件','趋势观察','值得继续关注','编辑总结']);assert.equal((await app.inject({url:'/api/daily-digests/2026-10-20/export/html'})).statusCode,200);
  const digestSubscription=await app.inject({method:'PUT',url:'/api/subscriptions',payload:{enabled:true,channels:['wecom'],events:['daily_digest.completed'],quiet:false}});assert.equal(digestSubscription.statusCode,200);
  const localWecomLink=await app.inject({method:'PUT',url:'/api/subscriptions',payload:{enabled:true,channels:['wecom'],events:['daily_digest.completed','approval.required'],quiet:false,public_base_url:'http://127.0.0.1:8090'}});assert.equal(localWecomLink.statusCode,400);
  db.run('INSERT INTO signals(id,event_key,title,reason,evidence_json,created_at) VALUES(?,?,?,?,?,?)','read-fixture','read-fixture','未读测试信号','测试','{}',now());assert.equal((await app.inject({url:'/api/signals'})).json()[0].read_at,null);assert.equal((await app.inject({method:'POST',url:'/api/signals/read-fixture/read',payload:{}})).statusCode,200);assert.ok((await app.inject({url:'/api/signals'})).json()[0].read_at);assert.equal((await app.inject({method:'POST',url:'/api/signals/read-all',payload:{}})).statusCode,200);
  const page = await app.inject({ url: '/' }); assert.ok(page.body.includes('native-controls.js')); assert.ok(page.body.includes('研判'));
  const controls=await app.inject({url:'/app/product-controls.js'});assert.equal(controls.statusCode,200);assert.ok(controls.body.includes('系统自选'));assert.ok(controls.body.includes('用户上传'));assert.ok(controls.body.includes('人机共创'));assert.ok(controls.body.includes('多主题热点日报'));
  const { id } = make(service); const response = await app.inject({ method: 'POST', url: `/api/tasks/${id}/evidence`, payload: { url: 'javascript:alert(1)', title: 'x', content: 'abcdef' } }); assert.equal(response.statusCode, 400);
  await app.close();
});
test('report archive state is persistent server configuration and can be restored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diting-archive-')), { app, db, service } = await createApp({ dataDir: dir }, false);
  const task = service.createTask('档案测试用任务', null, null, 'chat'), reportId = 'archive-fixture-report';
  db.run('INSERT INTO reports VALUES(?,?,?,?,?,?,?)', reportId, task, 1, '测试报告', JSON.stringify({ sections: [] }), 'fixture', now());
  const archived = await app.inject({ method: 'POST', url: `/api/reports/${reportId}/archive`, payload: { archived: true } });
  assert.equal(archived.statusCode, 200); assert.equal((await app.inject({ url: '/api/reports' })).json()[0].archived, true);
  await app.inject({ method: 'POST', url: `/api/reports/${reportId}/archive`, payload: { archived: false } });
  assert.equal((await app.inject({ url: '/api/reports' })).json()[0].archived, false); await app.close();
});
