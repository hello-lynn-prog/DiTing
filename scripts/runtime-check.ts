/** Offline native dsh transport test. --full exports a clearly labelled synthetic report only. */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { settings, ROOT } from '../apps/server/settings.js';
import { Database } from '../packages/domain/db.js';
import { Service } from '../packages/domain/service.js';
import { Configuration } from '../packages/domain/configuration.js';
import { Runtime } from '../packages/dsh-diting/runtime.js';
import { Skills } from '../packages/domain/skills.js';
import { Mcp } from '../packages/domain/mcp.js';
import { PlatformAccounts } from '../packages/domain/platform-accounts.js';
import { templates } from '../packages/reporting/report.js';

const full = process.argv.includes('--full');
const sectionCheck=process.argv.includes('--engine-sections');
const largeMaterials=process.argv.includes('--large-materials');let fullReportMaterialsObserved=false,fullVerifierMaterialsObserved=false;
const fixtureQuote=largeMaterials?'这是一份合成验收资料，不是真实新闻。'+'完整引文仅供原生传递验收。'.repeat(500)+'FIXTURE_FULL_MATERIAL_MIDDLE_PROBE':'这是一份合成验收资料，不是真实新闻';
const glmProfile = process.argv.includes('--glm-profile');
const cancelCheck=process.argv.includes('--cancel');
let requestArrived!:()=>void;const firstRequest=new Promise<void>(resolve=>requestArrived=resolve);
const failClosed=process.argv.includes('--fail-closed');
const followup=process.argv.includes('--followup');
const skillsCheck=process.argv.includes('--skills');
const approvalFeedback=process.argv.includes('--approval-feedback');let approvalFeedbackObserved=false;
const crawlSession=process.argv.includes('--crawl-session')||approvalFeedback;
const crawlApproval=process.argv.includes('--crawl-approval')||crawlSession;
const sessionFixture='SUB=explicit-native-session-fixture-not-real';
let secretObserved=false;
const skillCatalogs:Record<string,string>={};
let skillBodyObserved=false;
const mcpStdio=process.argv.includes('--mcp-stdio');
const mcpCheck=process.argv.includes('--mcp')||mcpStdio,mcpFail=process.argv.includes('--mcp-fail');
let mcpCalls=0,mcpBodyObserved=false;
const counts: Record<string, number> = {}, notifications: any[] = [], observedTools: Record<string, string[]> = {};
let fixtureDb: Database | undefined, fixtureTask: string | undefined, fixtureEvidence: string | undefined;
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if(req.url==='/mcp'){
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    const call=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(call.id===undefined){res.writeHead(202);res.end();return;}
    let result:any={};
    if(call.method==='initialize')result={protocolVersion:call.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'explicit-local-mcp-fixture',version:'1.0'}};
    if(call.method==='tools/list')result={tools:[{name:'lookup',description:'Explicit synthetic fixture only',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}},{name:'status',description:'Explicit local fixture status',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
    if(call.method==='tools/call'){mcpCalls++;assert.equal(req.headers.authorization,'Bearer explicit-mcp-fixture-not-real');result={content:[{type:'text',text:'FIXTURE_MCP_RESULT_20261018 — synthetic, not archived evidence.'}]};}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result}));return;
  }
  if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'diting-offline-fixture', object: 'model' }] })); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(glmProfile){assert.equal(body.reasoning_effort,'low');assert.equal(body.thinking?.type,'enabled');assert.ok((body.max_tokens??body.max_completion_tokens)<=16384);}
  if(cancelCheck){counts.root=(counts.root||0)+1;requestArrived();return;}
  if(crawlSession&&JSON.stringify(body).includes('explicit-native-session-fixture-not-real'))secretObserved=true;
  const names: string[] = (body.tools || []).map((t: any) => t.function?.name);
  const stageGuide=body.tools?.find((t:any)=>t.function?.name==='report_stage')?.function?.parameters?.properties?.data?.description;
  if(names.includes('report_stage')){assert.ok(stageGuide?.includes('定量visual仅{kind:"dataset"'),'Report must see the dataset wire shape before attempting chapter generation');assert.ok(stageGuide?.includes('repair:{issues:[],actions:[]}'),'Report must see repair arrays in its actual provider schema');}
  const reflectionGuide=body.tools?.find((t:any)=>t.function?.name==='investigation_reflect')?.function;
  if(reflectionGuide){assert.ok(reflectionGuide.description.includes('Insight共4次总结')&&reflectionGuide.description.includes('Media/Query共3次'),'model-facing tool counts must agree with the fixed loop guard');assert.ok(reflectionGuide.parameters.properties.findings.description.includes('800–1200'),'engine latest-state analysis must not be described as a short progress note');}
  const submission=body.tools?.find((t:any)=>t.function?.name==='investigation_submit')?.function?.parameters?.properties?.claims;
  if(submission){assert.equal(submission.type,'array');assert.equal(submission.items.properties.text.type,'string');assert.equal(submission.items.properties.references.type,'array');assert.deepEqual([...submission.items.required].sort(),['references','text']);}
  const system = body.messages.filter((m: any) => ['system','developer'].includes(m.role)).map((m: any) => m.content).join('\n');
  const isRoot = names.includes('research_delegate');
  const role = isRoot ? 'root' : names.includes('report_draft') ? 'report' : names.includes('forum_submit') ? 'forum' : names.includes('review_submit') ? system.includes('主动检查反例') ? 'advocate' : system.includes('逐条核对') ? 'verifier' : 'planner' : names.includes('db_ro_query') ? 'insight' : names.includes('crawl_deep') ? 'media' : 'query';
  if(largeMaterials&&['report','verifier'].includes(role))for(const message of body.messages){if(message.role!=='tool')continue;const content=typeof message.content==='string'?message.content:JSON.stringify(message.content);if(!content.includes('FIXTURE_FULL_MATERIAL_MIDDLE_PROBE'))continue;assert.ok(!content.includes('Full formatted result stored at:'),'material packets must not be replaced by inaccessible spill-file previews');const data=JSON.parse(content);if(role==='report'&&Array.isArray(data.claims)){assert.equal(data.claims.length,12);fullReportMaterialsObserved=true;}if(role==='verifier'&&data.verification_packet){assert.equal(data.verification_packet.claim_count,12);fullVerifierMaterialsObserved=true;}}
  observedTools[role] = names; const n = counts[role] || 0; counts[role] = n + 1;
  if(approvalFeedback&&role==='media'&&n===1)fixtureDb!.run("UPDATE approvals SET status='approved' WHERE task_id=?",fixtureTask!);
  if(approvalFeedback&&role==='media'&&n===2){const updates=body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>{try{return JSON.parse(m.content).platform_approval_updates||[];}catch{return [];}});assert.ok(updates.some((a:any)=>a.state==='approved_not_started'&&a.crawl_deep?.options?.max_requests===2&&a.crawl_deep?.options?.session_version),'approval transition and exact retry args must reach the real model-facing tool response');approvalFeedbackObserved=true;}
  if(n===0)skillCatalogs[role]=JSON.stringify(body.messages);
  if(skillsCheck&&JSON.stringify(body.messages).includes('FIXTURE_SKILL_BODY_20261018'))skillBodyObserved=true;
  if(mcpCheck&&JSON.stringify(body.messages).includes('FIXTURE_MCP_RESULT_20261018'))mcpBodyObserved=true;
  let tool: { name: string; arguments: any } | null = null;
  if(crawlApproval)tool=isRoot?n===0?{name:'research_delegate',arguments:{role:'media',assignment:'明确的审批集成验收，只申请微博最小范围，不执行未经批准的网络操作。'}}:n===1?{name:'research_wait',arguments:{}}:n===2?{name:'research_finish',arguments:{reason:'等待明确测试范围审批，尚未实际采集。'}}:null:n===0?{name:'crawl_deep',arguments:{platform:'weibo',query:'明确测试',options:{max_posts:1,comments_per_post:1,max_pages:1,comment_pages:1,max_requests:2,include_long_text:false,...(crawlSession?{access_mode:'saved_session'}:{})}}}:approvalFeedback&&n===1?{name:'task_context',arguments:{}}:n===(approvalFeedback?2:1)?{name:'investigation_submit',arguments:{claims:[],gaps:['审批通信验收未执行采集，未取得平台原文。']}}:null;
  else if(mcpCheck)tool=isRoot?n===0?{name:'mcp__fixture__lookup',arguments:{query:'unauthorized fixture'}}:n===1?{name:'research_delegate',arguments:{role:'insight',assignment:'仅执行本机 MCP 合成通信验收，不把返回值当成原文证据。'}}:n===2?{name:'research_wait',arguments:{}}:n===3?{name:'research_finish',arguments:{reason:'明确的 MCP 验收结束，无真实新闻或报告。'}}:null:n===0||n===1?{name:'mcp__fixture__lookup',arguments:{query:'explicit bounded fixture'}}:n===2?{name:'task_context',arguments:{}}:n===3?{name:'investigation_submit',arguments:{claims:[],gaps:['MCP 返回值不是归档原文，无真实材料。']}}:null;
  else if(skillsCheck)tool=isRoot?n===0?{name:'skill',arguments:{name:'fixture-insight-only'}}:n===1?{name:'research_delegate',arguments:{role:'insight',assignment:'明确的技能挂载验收，读取 fixture-insight-only 后提交缺口，不联网。'}}:n===2?{name:'research_wait',arguments:{}}:n===3?{name:'research_finish',arguments:{reason:'明确的技能验收结束，无真实材料和报告。'}}:null:n===0?{name:'skill',arguments:{name:'fixture-insight-only'}}:n===1?{name:'task_context',arguments:{}}:n===2?{name:'investigation_submit',arguments:{claims:[],gaps:['技能验收没有真实材料。']}}:null;
  else if (!full) {
    if(isRoot)tool=followup?n===0?{name:'research_delegate',arguments:{role:'insight',assignment:'只执行本机离线验收，完成有结果的两轮查询、反思及空结论缺口记录。'}}:n===1?{name:'research_delegate',arguments:{role:'forum',assignment:'只主持本机离线验收的滚动流程，不形成现实结论。'}}:n===2?{name:'research_wait',arguments:{}}:n===3?{name:'send_message',arguments:{agent_id:fixtureDb!.one("SELECT child_session_id FROM agent_runs WHERE task_id=? AND role='insight'",fixtureTask!)!.child_session_id,message:'明确的原成员补证通信验收，请查询合成材料并完成新一轮两次反思后提交缺口。'}}:n===4?{name:'send_message',arguments:{agent_id:fixtureDb!.one("SELECT child_session_id FROM agent_runs WHERE task_id=? AND role='forum'",fixtureTask!)!.child_session_id,message:'为本次补证重新主持两轮，等待本次调查成员反思。'}}:n===5?{name:'research_wait',arguments:{}}:n===6?{name:'research_finish',arguments:{reason:'离线验收结束，缺少真实舆情证据，不能生成现实报告。'}}:null:n===0?{name:'research_delegate',arguments:{role:'insight',assignment:'只执行本机离线验收，完成有结果的两轮查询、反思及空结论缺口记录。'}}:n===1?{name:'research_delegate',arguments:{role:'forum',assignment:'只主持本机离线验收的滚动流程，不形成现实结论。'}}:n===2?{name:'research_wait',arguments:{}}:n===3?{name:'research_finish',arguments:{reason:'离线验收结束，缺少真实舆情证据，不能生成现实报告。'}}:null;
    // One investigator emits fewer than five new summaries per cycle. HOST observes and exits without inventing a forum batch.
    else if(role==='forum')tool=n===0||followup&&n===3?{name:'task_context',arguments:{}}:n===1||followup&&n===4?{name:'forum_read',arguments:{after_round:0,wait:true}}:null;
    else if(role==='insight'){
      const step=followup&&n>=8?n-8:n;
      const actions:Array<{name:string;arguments:any}|null>=[
        {name:'task_context',arguments:{}},
        {name:'db_ro_query',arguments:{query:'合成验收资料'}},
        {name:'investigation_reflect',arguments:{section_id:'overall',assessment:'本轮仅查询合成测试资料，当前不能推断真实舆情，需要继续核对。',findings:'当前本地样本明确标注为测试输入，真实来源与社会观点均未覆盖。',decision:'search_more',next_queries:['按主持意见复核合成验收资料']}},
        {name:'forum_read',arguments:{after_round:followup&&n>=8?2:0,wait:true}},
        {name:'db_ro_query',arguments:{query:'合成验收资料'}},
        {name:'investigation_reflect',arguments:{section_id:'overall',assessment:'已按主持意见复核本任务资料，仍只有合成样本，因此停止现实判断。',findings:'本轮只证明读取与状态流转可运行，不能推断任何真实事件或公众观点。',decision:'stop',next_queries:[]}},
        {name:'investigation_submit',arguments:{claims:[],gaps:['离线夹具不是现实新闻，没有真实来源，不能生成现实报告。']}},
        null
      ];tool=actions[step]||null;
    }
  }
  else {
    const db = fixtureDb!, tid = fixtureTask!;
    if (isRoot) {
      const order: Record<number, string> = { 0: 'insight', 1: 'media', 2: 'query', 3: 'forum', 5: 'planner', 7: 'verifier', 9: 'advocate', 11: 'report' };
      if (order[n]) tool = { name: 'research_delegate', arguments: { role: order[n], assignment: '只处理明确的合成测试材料，验证本机流程，不作真实舆情判断。' } };
      else if ([4, 6, 8, 10, 12].includes(n)) tool = { name: 'research_wait', arguments: {} };
      else if (n === 13) tool = { name: 'task_context', arguments: {} };
      else if (n === 14) tool = { name: 'report_publish', arguments: { artifact_id: db.one("SELECT id FROM artifacts WHERE task_id=? AND kind='report_candidate' ORDER BY created_at DESC LIMIT 1", tid)?.id || 'missing-test-candidate' } };
    } else if(sectionCheck&&['insight','media','query'].includes(role)){
      const summaries=role==='insight'?4:3,width=summaries*2+1,index=Math.floor(n/width),step=n%width,section='section-'+(index+1);
      if(index<4)tool=step===summaries*2?{name:'investigation_submit',arguments:{section_id:section,section_title:['甲子题','乙子题','丙子题','丁子题'][index],claims:[{text:role+'对'+['甲','乙','丙','丁'][index]+'段的合成资料进行引用核对，不是现实研究判断。',references:[{evidence_id:fixtureEvidence,quote:fixtureQuote}]}],gaps:['合成资料不具备现实代表性，真实平台和外部来源未覆盖。']}}:step%2===0?{name:'evidence_read',arguments:{evidence_id:fixtureEvidence,section_id:section,offset:Math.floor(step/2)}}:{name:'investigation_reflect',arguments:{section_id:section,assessment:'本段实际读取了合成原文，仅用于检验原生状态流转，不判断现实舆情。',findings:'该段原文提供了可逐字核对的测试句子，其他资料明确没有覆盖。',decision:step===summaries*2-1?'stop':'search_more',next_queries:step===summaries*2-1?[]:['核对下一处合成原文上下文']}};
      else if(n===width*4)tool={name:'forum_read',arguments:{after_round:0,wait:true}};
    } else if (['insight', 'media', 'query'].includes(role)) tool = n===0?{name:'evidence_read',arguments:{evidence_id:fixtureEvidence}}:n===1?{name:'investigation_reflect',arguments:{section_id:'overall',assessment:'本轮只读取明确标记为合成的离线测试材料，不能用来判断现实舆情。',findings:'本地任务已有一条测试原文；缺少独立真实来源、平台样本和发布时间字段。',decision:'search_more',next_queries:['根据主持人意见复核已有合成样本']}}:n===2?{name:'forum_read',arguments:{after_round:0,wait:true}}:n===3?{name:'evidence_read',arguments:{evidence_id:db.rows('SELECT evidence_id FROM task_evidence WHERE task_id=?',tid).find(e=>e.evidence_id!==fixtureEvidence)!.evidence_id}}:n===4?{name:'investigation_reflect',arguments:{section_id:'overall',assessment:'已在主持意见后再次核对任务材料，仍然只有合成样本，停止现实判断。',findings:'第二轮确认流程可读取材料，但不能证明外部事实或公众情绪。',decision:'stop',next_queries:[]}}:n===5?{name:'investigation_submit',arguments:{claims:[{text:`${role} 对合成测试原文的引用验证，不代表真实研究事实。`,references:[{evidence_id:fixtureEvidence,quote:fixtureQuote}]}],gaps:['所有原文为测试输入，不能用于实际舆情判断。']}}:null;
    else if (n === 0) tool = { name: role==='report'?'report_materials':'task_context', arguments: {} };
    else if (n === 1 && role === 'forum') tool = { name: 'forum_read', arguments: { after_round: 0, wait: true } };
    else if (n === 2 && role === 'forum') tool = { name: 'forum_submit', arguments: { summary: '三名调查成员各自完成第一轮检索与反思；本机离线测试仅供验证流程，所有资料都明确不是现实舆情来源。', disagreements: ['测试样本不能用来证明真实世界结论。'], supplements: ['请再核对一次本任务材料，并说明真实来源缺口。'] } };
    else if (n === 1 && ['planner', 'verifier', 'advocate'].includes(role)) tool = { name: 'review_submit', arguments: { passed: true, reason: role==='planner'?'合成输入仅覆盖测试范围，缺少现实材料的缺口已经记录；此处仅验收流程。':role==='verifier'?'逐条核对合成原文与来源编号；这些材料不是现实独立信源，不能作为真实核验。':'已考虑反例、替代解释和样本局限；合成输入只用于流程测试，不代表报告质量通过。', input_version: service.reviewInput(tid) } };
    else if (n === 1 && ['planner', 'verifier', 'advocate'].includes(role)) tool = { name: 'review_submit', arguments: { passed: true, reason: role==='planner'?'合成输入仅覆盖测试范围，缺少现实材料的缺口已经记录；此处仅验收流程。':role==='verifier'?'逐条核对合成原文与来源编号；这些材料不是现实独立信源，不能作为真实核验。':'已考虑反例、替代解释和样本局限；合成输入只用于流程测试，不代表报告质量通过。', input_version: service.reviewInput(tid) } };
    else if (n === 1 && role === 'report') tool = { name: 'statistics_compute', arguments: {} };
    else if (role === 'report') {
      const sections = templates.find(t=>t.id==='public-event')!.sections.map((title,i) => {const judgments=['离线样本只验证流程，不能说明现实舆情','合成资料只用于核对离线时间线链路','样本未覆盖真实传播路径或引爆因素','不同角色引用相同夹具，不代表社会观点分布','合成输入不能支持现实动因推断','本次测试不形成现实风险或行动判断','本机流程验收不构成真实平台采样','当前两条夹具不代表任何平台的真实舆情','真实来源和真实平台样本仍待验收','附录只列本机生成的合成资料与派生表'];const statement=`### 判断：${judgments[i]}\n\n本章节只验证持久化、结论引用、门禁和导出链路。材料明确标记为合成测试输入，不能据此推断真实事件、公众态度、传播范围或行业趋势。`;return {title,text:(statement+'\n\n').repeat(18),claim_ids:db.rows('SELECT id FROM claims WHERE task_id=?',tid).map(c=>c.id)};});
      const stage = (stage: string, data: any) => ({ name: 'report_stage', arguments: { stage, data } });
      if (n === 2) tool = stage('template', { template_id: 'public-event', reason: '用于明确的合成流程验收，不是真实研究。' });
      if (n === 3) tool = stage('evidence_map', { claim_ids: db.rows('SELECT id FROM claims WHERE task_id=?', tid).map(c => c.id), evidence_ids: db.rows('SELECT evidence_id FROM task_evidence WHERE task_id=?', tid).map(e => e.evidence_id) });
      if (n === 4) tool = stage('layout', { chapters: sections.map((s, i) => ({ id: `chapter-${i}`, title: s.title, goal: '明确验证本章节的持久化与引用，不作为实际事实。' })) });
      if (n === 5) tool = stage('length', { chapters: sections.map((_s, i) => ({ id: `chapter-${i}`, min_chars: 900, max_chars: 10000 })) });
      if (n >= 6 && n < 6 + sections.length) tool = stage('chapter', { id: `chapter-${n - 6}`, ...sections[n - 6] });
      if (n === 6 + sections.length) tool = stage('repair', { issues: [], actions: ['只验证合成材料的结构与引用。'] });
      if (n === 7 + sections.length) tool = { name: 'report_draft', arguments: { document: { title: '明确的合成验收报告：不可用于真实舆情判断', template_id: 'public-event',
        dataset_ids: db.rows("SELECT id FROM artifacts WHERE task_id=? AND kind='dataset'", tid).map(d => d.id), limitations: ['全部材料是人为构造的自动测试输入，不能用于任何现实舆情结论。'] } } };
    }
  }
  const delta = tool ? { tool_calls: [{ index: 0, id: `fixture-${isRoot ? 'root' : 'insight'}-${n}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: '明确的离线测试结束。没有真实事实和报告。' };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ id: `fixture-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: `fixture-${Date.now()}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as any).port;
mkdirSync(join(ROOT, 'tmp'), { recursive: true }); const dir = mkdtempSync(join(ROOT, 'tmp/runtime-check-'));
const db = new Database(join(dir, 'diting.sqlite3'), ROOT), service = new Service(db), config = new Configuration(db, dir);
// This compatibility fixture exercises the legacy single-section wire contract; section completeness has separate tests and real baseline.
config.set('model.queue',{max_concurrency:8,min_interval_ms:0}); // isolated synthetic provider, no external account quota
if(sectionCheck)config.set('runtime.policy',{enabled:true,max_calls:300,max_minutes:10}); // 40 persisted source-backed summary nodes, synthetic tokens only
fixtureDb = db;
if(crawlSession)new PlatformAccounts(config).save('weibo',{enabled:true,cookie:sessionFixture});
if(skillsCheck)new Skills(config).save({items:[...new Skills(config).items(),{id:'fixture-insight-only',name:'显式技能测试',description:'仅 Insight 可以读取的合成测试技能',roles:['insight'],content:'FIXTURE_SKILL_BODY_20261018。无真实新闻，提交证据缺口，不生成报告。',enabled:true}]});
if(mcpCheck||mcpFail){
  const fixturePath=join(dir,'fixture-mcp.mjs'),countPath=join(dir,'stdio-calls.txt');
  if(mcpStdio)writeFileSync(fixturePath,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
const lines=createInterface({input:process.stdin});lines.on('line',line=>{try{const call=JSON.parse(line);if(call.id===undefined)return;let result={};
if(call.method==='initialize')result={protocolVersion:call.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'explicit-local-stdio-fixture',version:'1.0'}};
if(call.method==='tools/list')result={tools:[{name:'lookup',description:'Explicit fixture',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}},{name:'status',description:'Fixture status',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
if(call.method==='tools/call'){const isolated=process.env.FIXTURE_TOKEN==='explicit-stdio-token'&&!Object.keys(process.env).some(k=>k.startsWith('DITING_MODEL_')||k.startsWith('DITING_MCP_SECRET_'));appendFileSync(${JSON.stringify(countPath)},'call\\n');result={isError:!isolated,content:[{type:'text',text:isolated?'FIXTURE_MCP_RESULT_20261018 — synthetic stdio only.':'Credential isolation failed'}]};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:call.id,result})+'\\n');}catch{}});`);
  new Mcp(config).save({items:[{config:{id:'fixture',name:'显式本机 MCP 测试',transport:mcpStdio?'stdio':'streamable-http',url:mcpStdio?'':`http://127.0.0.1:${port}/mcp`,command:mcpStdio?process.execPath:'',args:mcpStdio?[fixturePath]:[],enabled:true,max_calls:1,tools:[{name:mcpFail?'not_available':'lookup',roles:['insight']},{name:'status',roles:['main']}]},credentials:mcpStdio?{env:{FIXTURE_TOKEN:'explicit-stdio-token'}}:{headers:{Authorization:'Bearer explicit-mcp-fixture-not-real'}}}]});
}
for (const id of ['planner', 'insight', 'media', 'query', 'forum', 'report']) config.saveRoute({ id, provider: 'offline-fixture-only', model: glmProfile?'glm-5.3-flash':'diting-offline-fixture', base_url: `http://127.0.0.1:${port}/v1`, api_key: 'offline-fixture-not-real', enabled: true, max_tokens: 4096, rates: { input: 0, cache: 0, output: 0 } });
const sid = service.session('明确的本机离线运行时验收'), task = service.send(sid, '调查明确的离线测试主题；没有真实材料，不得生成报告', 'runtime-fixture-key'), claimed = service.claim('runtime-check')!;
const fixtureConfig=JSON.parse(claimed.config_json);fixtureConfig.engine_section_contract=sectionCheck;fixtureConfig.min_engine_sections=sectionCheck?4:1;if(!sectionCheck)delete fixtureConfig.engine_reflection_policy;claimed.config_json=JSON.stringify(fixtureConfig);db.run('UPDATE tasks SET config_json=? WHERE id=?',claimed.config_json,claimed.id);
fixtureTask = claimed.id;
if(!cancelCheck&&!crawlApproval)fixtureEvidence = service.archive(claimed.id, 'https://example.org/fixture-a', '明确的合成测试材料', fixtureQuote+'。所有内容仅用于测试引用和导出功能。', 'fixture', claimed.lease_owner);
if (full) service.archive(claimed.id, 'https://example.net/fixture-b', '另一份合成测试材料', '这是另一份合成验收资料，不是真实新闻。只用于测试来源分布统计。', 'fixture', claimed.lease_owner);
let runtimeRoot=ROOT;
if(failClosed){runtimeRoot=join(dir,'broken-root');const path=join(runtimeRoot,'dist/packages/dsh-diting');mkdirSync(path,{recursive:true});writeFileSync(join(runtimeRoot,'package.json'),'{"type":"module"}');writeFileSync(join(path,'plugin.js'),"export const name='diting-domain';export async function apply(){throw new Error('explicit broken profile fixture');}");}
const runtime = new Runtime(service, config, settings({ root:runtimeRoot,dataDir: dir, runtimeEnabled: true }));
try {
  if(failClosed){await assert.rejects(runtime.launch(claimed),/领域插件未成功挂载/);assert.equal(Object.values(counts).reduce((n,c)=>n+c,0),0,'a failed domain profile must not make even one model request');console.log(JSON.stringify({test:'domain-profile-failure-stops-before-model',passed:true,model_calls:0}));}
  else if(mcpFail){await assert.rejects(runtime.launch(claimed),/领域插件未成功挂载/);assert.equal(Object.values(counts).reduce((n,c)=>n+c,0),0);assert.ok(db.one("SELECT id FROM events WHERE kind='mcp.failed'"));console.log(JSON.stringify({test:'mcp-missing-tool-fails-before-model',passed:true,model_calls:0}));}
  else if(cancelCheck){
    const launched=runtime.launch(claimed),settled=launched.then(()=>({status:'finished'}),()=>({status:'rejected'}));let timeout:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([firstRequest,settled.then(()=>{throw Error('runtime ended before the cancellation fixture request');}),new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>reject(Error('runtime did not reach the cancellation fixture within 60 seconds')),60000);})]);}
    finally{if(timeout)clearTimeout(timeout);service.action(claimed.id,'cancel',service.task(claimed.id).revision);await runtime.cancel(claimed.id);await settled;}
    assert.equal(service.task(claimed.id).status,'cancelled');assert.equal(db.one('SELECT COUNT(*) n FROM reports')!.n,0);assert.equal(db.one('SELECT COUNT(*) n FROM artifacts')!.n,0);assert.equal(db.one('SELECT COUNT(*) n FROM task_evidence')!.n,0);assert.equal(service.waitRuntime(claimed.id,claimed.lease_owner,'late completion'),false);assert.throws(()=>service.archive(claimed.id,'https://example.org/late','迟到测试','不得归档的迟到合成材料','fixture',claimed.lease_owner),/租约/);
    const summary={test:'native-dsh-cancel-during-pending-model-request',passed:true,model_fixture_calls:counts,reports:0,evidence:0,production_certified:false};writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
  }
  else {
  const runtimeResult=await runtime.launch(claimed, n => notifications.push(n));
  const agents = db.rows('SELECT * FROM agent_runs'), results = db.rows('SELECT * FROM artifacts');
  if(!agents.length){writeFileSync(join(dir,'failure.json'),JSON.stringify({runtimeResult,notifications},null,2));console.log(JSON.stringify({response:runtimeResult.finalResponse,diagnostic_file:join(dir,'failure.json')}));}
  assert.equal(agents.length, full ? 8 : (!crawlApproval&&!mcpCheck&&!mcpFail&&!skillsCheck ? 2 : 1), 'must create real dsh child sessions'); assert.equal(agents[0].role, crawlApproval?'media':'insight');
  assert.ok(notifications.some(n => n.method === 'subagent.started'), 'native SDK start notification required');
  assert.ok(notifications.some(n => n.method === 'subagent.finished'), 'native SDK end notification required');
  if(sectionCheck){assert.equal(db.one("SELECT COUNT(*) n FROM artifacts WHERE task_id=? AND kind='investigation_section'",claimed.id)!.n,12);assert.equal(db.one("SELECT COUNT(*) n FROM artifacts WHERE task_id=? AND kind='investigation'",claimed.id)!.n,3);}
  if(largeMaterials){assert.ok(fullReportMaterialsObserved,'full report materials must actually reach the provider');assert.ok(fullVerifierMaterialsObserved,'full verifier packet must actually reach the provider');}
  if(full)assert.equal(db.one("SELECT COUNT(*) n FROM events WHERE kind='tool.completed' AND json_extract(payload_json,'$.tool')='forum_read' AND json_extract(payload_json,'$.summary.wait_ignored')=1")!.n,3,'investigators must read Forum opinions without waiting on the host');
  if(!crawlApproval&&!skillsCheck&&!mcpCheck)assert.ok(results.some(r => r.kind === 'investigation'), 'child must execute the domain submit tool');
  if(skillsCheck||mcpCheck){assert.equal(results.filter(r=>r.kind==='investigation').length,0,'permission-only checks cannot bypass investigation reflection gates');assert.ok(db.one("SELECT id FROM events WHERE kind='tool.failed' AND json_extract(payload_json,'$.tool')='investigation_submit'"));}
  if(skillsCheck){
    assert.ok(!skillCatalogs.root.includes('fixture-insight-only'),'main catalog must not expose Insight-only skill');
    assert.ok(skillCatalogs.insight.includes('fixture-insight-only'),'native child catalog must expose its authorized skill');
    assert.equal(db.one("SELECT COUNT(*) n FROM events WHERE kind='skill.denied'")!.n,1,'main cannot load an unauthorized skill even when calling it directly');
    assert.equal(db.one("SELECT COUNT(*) n FROM events WHERE kind='skill.loaded' AND json_extract(payload_json,'$.skill_id')='fixture-insight-only'")!.n,1,'native child must successfully load and audit the authorized body');
    assert.ok(skillBodyObserved,'the loaded skill body must actually reach the model through the native tool result');
    const frozen=JSON.parse(service.rawTask(claimed.id).config_json).skills;assert.ok(frozen.find((s:any)=>s.id==='fixture-insight-only')?.version);
  }
  if(mcpCheck){const calls=mcpStdio?(existsSync(join(dir,'stdio-calls.txt'))?readFileSync(join(dir,'stdio-calls.txt'),'utf8').trim().split('\n').length:0):mcpCalls;assert.equal(calls,1,'unauthorized and over-limit calls must not reach the MCP server');assert.ok(mcpBodyObserved,'the official MCP tool result must reach the child model');assert.ok(db.one("SELECT id FROM events WHERE kind='mcp.mounted'"));assert.equal(db.one("SELECT COUNT(*) n FROM events WHERE kind='mcp.called' AND json_extract(payload_json,'$.status')='succeeded'")!.n,1);assert.ok(!observedTools.root.includes('mcp__fixture__lookup'));assert.ok(observedTools.insight.includes('mcp__fixture__lookup'));assert.ok(!readFileSync(join(dir,'dsh',claimed.id,'profiles/diting/cordis.patch.yml'),'utf8').includes('explicit-stdio-token'),'credentials must not appear in the generated profile');}
  if(followup){assert.equal(results.filter(r=>r.kind==='investigation').length,2,'the same child must submit a second investigation');assert.equal(db.one("SELECT COUNT(*) n FROM events WHERE kind='agent.followup'")!.n,2);assert.ok(db.one("SELECT COUNT(*) n FROM events WHERE kind='agent.turn_started'")!.n>=2,'resumed native turns must update member status');}
  assert.equal(db.rows('SELECT * FROM reports').length, full ? 1 : 0, 'only the full explicitly synthetic fixture may create an explicitly synthetic report');
  if(crawlApproval){assert.equal(db.one('SELECT COUNT(*) n FROM approvals WHERE status=?',approvalFeedback?'approved':'pending')!.n,1);if(approvalFeedback)assert.ok(approvalFeedbackObserved);assert.equal(db.one('SELECT COUNT(*) n FROM acquisitions')!.n,0);assert.equal(db.one('SELECT COUNT(*) n FROM crawl_batches')!.n,0,'approval alone must not start collection');const approvedScope=JSON.parse(db.one('SELECT request_json FROM approvals')!.request_json);assert.equal(approvedScope.platform,'weibo');assert.equal(approvedScope.max_requests,2);
    if(crawlSession){const snapshot=service.task(task.task_id).config.platform_sessions.weibo;assert.equal(approvedScope.access_mode,'saved_session');assert.equal(approvedScope.session_version,snapshot.version);assert.ok(snapshot.cookie_ref);assert.equal(secretObserved,false,'cookie plaintext must never enter any model request');assert.ok(!readFileSync(join(dir,'dsh',claimed.id,'profiles/diting/cordis.patch.yml'),'utf8').includes(sessionFixture),'cookie plaintext must not enter the generated profile');}
  }
  assert.equal(service.task(task.task_id).status, full ? 'completed' : crawlApproval&&!approvalFeedback?'waiting_approval':'waiting_evidence');
  for (const [role, names] of Object.entries(observedTools)) { assert.ok(!names.includes('bash') && !names.includes('pwsh') && !names.includes('exec_command')); if (role !== 'root') assert.ok(!names.includes('research_delegate')); }
  const summary = { ...(largeMaterials?{oversized_materials:{report_received_complete_json:fullReportMaterialsObserved,verifier_received_complete_json:fullVerifierMaterialsObserved}}:{}),test: full ? 'explicit-synthetic-full-pipeline-not-real-research' : crawlSession?'native-media-session-version-approval-no-cookie-in-model':crawlApproval?'native-media-crawl-approval-with-zero-network':mcpCheck?'native-dsh-mcp-permissions-caps-and-audit':skillsCheck?'native-dsh-skill-role-isolation-and-audit':followup?'explicit-native-continuable-child-followup':'explicit-offline-native-dsh-subagent', child_sessions: agents.length, event_methods: [...new Set(notifications.map(n => n.method))], model_fixture_calls: counts, artifacts: results.map(r => r.kind), reports: full ? 1 : 0, production_certified: false };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
  }
} finally { await runtime.close(); db.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
