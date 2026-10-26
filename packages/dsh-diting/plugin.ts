/** DiTing's own domain plugin; all Agent lifecycles are owned by dsh. */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Database, encode, hash, now, uid, type Row } from '../domain/db.js';
import { reserveModelCost } from '../domain/model-budget.js';
import { Service, calculateCost } from '../domain/service.js';
import { frozenResearchWindow } from '../domain/research-window.js';
import { Configuration } from '../domain/configuration.js';
import {verificationPacket} from './verification-packet.js';
import {LocalSentiment} from '../sentiment/service.js';
import {SemanticSampler} from '../sampling/semantic.js';
import {ResearchLexicon,lookupLexicon} from '../domain/research-lexicon.js';
import {HistoricalResearch} from '../domain/historical-research.js';
import {reportMaterials} from './report-materials.js';
import {reportStageDataGuide} from '../reporting/stage-contract.js';
import {platformApprovalUpdates} from '../domain/platform-approval-updates.js';
import {attachPublicLibrary} from './public-library.js';
import {cachedSearch,searchIdentity,evidenceIndex,ContextReuse} from './research-cache.js';
import { searchWeb, scrapePublicPage } from '../collectors/search.js';
import { DeepCrawl } from '../domain/deep-crawl.js';
import { PlatformAccounts } from '../domain/platform-accounts.js';
import {numericSupportHints} from '../reporting/support-hints.js';
import { statistics, validateReport, exportFiles, templates } from '../reporting/report.js';
import { ReportPipeline } from '../reporting/pipeline.js';
import { assertReviewPrerequisites, reportCoverage } from '../reporting/quality.js';
import { roles, rootTools, common, type Role } from './roles.js';
import type { FrozenSkill } from '../domain/skills.js';
import { mcpName, type McpServer } from '../domain/mcp.js';
import { recordBudgetState } from '../domain/notifications.js';
import {streamUsage} from './stream-accounting.js';
import {acquireModelSlot} from '../domain/model-queue.js';
import { normalizeJsonParameters } from './normalize.js';
import {finalizeInvestigatorSections} from './investigation-sections.js';
import { persistInvestigation,repairInvestigationSubmission } from './investigation-submit.js';
import { evidenceWindow } from './evidence-window.js';
import { artifactWindow, compactArtifactIndex, summarizeArtifact } from './artifact-window.js';
import { summarizeToolResult } from './tool-audit.js';
import { isForcedThinkingGlm, roleOutputLimit } from './model-policy.js';
import { optimizeKeywords } from './keyword-optimizer.js';
import {stopRepeatedReportFailures} from './report-retries.js';
import {VisualInvestigation} from '../collectors/visual.js';
import { forumCycleState, assertReflectionGate, investigatorRoles, latestForumMessages, latestForumRound, postForumMessage, reflectionHistory, submitReflection, type InvestigatorRole } from './investigation-reflection.js';

export const name = 'diting-domain';
export const inject = ['tools', 'subagents', 'agents', 'skills'];
/** The narrow dynamic boundary is checked against the installed dsh runtime by the integration spike. */
export async function apply(ctx: any) {
  const root = process.env.DITING_ROOT!, dshRoot = process.env.DITING_DSH_ROOT!, dataDir = process.env.DITING_DATA_DIR!;
  const taskId = process.env.DITING_TASK_ID!, rootSession = process.env.DITING_ROOT_SESSION!, token = process.env.DITING_LEASE_TOKEN!;
  if (![root, dshRoot, dataDir, taskId, rootSession, token].every(Boolean)) throw new Error('DiTing domain runtime requires an isolated task environment');
  const db = new Database(join(dataDir, 'diting.sqlite3'), root), service = new Service(db), config = new Configuration(db, dataDir);
  const sentiment=new LocalSentiment(service,config),contextReuse=new ContextReuse(),semanticSampler=new SemanticSampler(dataDir),history=new HistoricalResearch(db,dataDir);
  const modelRoutes = JSON.parse(service.rawTask(taskId).config_json).model_routes || {};
  const frozenSkills:FrozenSkill[]=JSON.parse(service.rawTask(taskId).config_json).skills||[];
  const frozenMcp:(McpServer&{version:string})[]=JSON.parse(service.rawTask(taskId).config_json).mcp||[];
  const mcpGrants=(role:string)=>frozenMcp.flatMap(s=>s.tools.filter(t=>t.roles.includes(role as any)).map(t=>mcpName(s.id,t.name)));
  const skillsFor=(role:string)=>frozenSkills.filter(s=>s.enabled&&s.roles.includes(role as any));
  const toolsFor=(role:string):string[]=>[...(role==='main'?rootTools:roles[role as Role]?.tools||[]),...(role==='forum'?[]:['evidence_read']),'artifact_read',...(skillsFor(role).length&&role!=='forum'?['skill']:[]),...mcpGrants(role)];
  const routeFor = (id: string) => modelRoutes[id] || config.route(id);
  const reportPipeline = new ReportPipeline(db, service, taskId);
  const visuals=new VisualInvestigation(service,config);
  try {
  const { defineTool } = await import(pathToFileURL(join(dshRoot, 'packages/core/tools/lib/index.js')).href);
  const { createScope } = await import(pathToFileURL(join(dshRoot, 'packages/core/scope/lib/index.js')).href);
  for(const server of frozenMcp){
    try{
      const privateConfig=server.key_ref?JSON.parse(process.env['DITING_MCP_SECRET_'+hash(server.id).slice(0,12)]||'null'):{};
      if(!privateConfig)throw Error('MCP credential reference unavailable');
      const {apply:mountMcp}=await import(pathToFileURL(join(dshRoot,'packages/mcp/mcp-client/lib/index.js')).href);
      await mountMcp(ctx,{serverName:server.id,transport:server.transport,command:server.command,args:server.args,cwd:server.cwd||process.cwd(),url:server.url,
        env:privateConfig.env||{},headers:privateConfig.headers||{},toolCallTimeoutMs:server.timeout_ms,failOnStartupError:true,maxInstructionBytes:8192,reconnect:{enabled:false}});
      for(const tool of server.tools)if(!ctx.tools.get(mcpName(server.id,tool.name)))throw Error('Configured tool not available');
      db.event(taskId,'mcp.mounted',{message:'已连接 MCP 并核对授权工具',server_id:server.id,version:server.version,root_session_id:rootSession,tools:server.tools});
    }catch{db.event(taskId,'mcp.failed',{message:'MCP 启动/连接/授权工具检查失败，已停止本轮研究；请核对传输配置和服务端工具名',server_id:server.id,root_session_id:rootSession});throw Error('MCP '+server.id+' 未成功挂载');}
  }
  const binding = (id: string) => id === rootSession ? 'main' : db.one('SELECT role FROM agent_runs WHERE task_id=? AND child_session_id=?', taskId, id)?.role;
  const roleOf = (exec: Row) => { if (!exec.agent) throw new Error('缺少真实调用 Agent'); const role = binding(exec.agent.id); if (!role) throw new Error('调用 Agent 不属于此任务'); return role as Role | 'main'; };
  const artifact = (kind: string, role: string, data: Row) => { const id = uid('artifact'); db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)', id, taskId, kind, role, encode(data), now()); return id; };
  const context = (requestedRole?:string) => {
    const fullTask=service.task(taskId),cfg=fullTask.config||{},allArtifacts=db.rows('SELECT id,kind,role,data_json,created_at FROM artifacts WHERE task_id=? ORDER BY created_at',taskId),index=compactArtifactIndex(allArtifacts);
    const checkpoint=reportPipeline.progress();
    return {
      ...(requestedRole==='verifier'?{verification_packet:verificationPacket(db,taskId)}:{}),
      task:{id:fullTask.id,title:fullTask.title,status:fullTask.status,stage:fullTask.stage,attempt:fullTask.attempt,budget:fullTask.budget,created_at:fullTask.created_at,evidence_revision:fullTask.evidence_revision,config:{budget:cfg.budget,window_days:cfg.window_days,engine_section_contract:!!cfg.engine_section_contract,min_engine_sections:cfg.min_engine_sections||1,template:cfg.template,template_selection:cfg.template_selection||{mode:cfg.template==='auto'?'auto':'legacy',selected_by:cfg.template==='auto'?'report_agent':'task_configuration'},report_profile:cfg.report_profile||{mode:'legacy',target_chars:9000,advisory:true,source:'legacy_task_profile_preserved'},delivery:cfg.delivery,gates:cfg.gates,max_supplement_rounds:cfg.max_supplement_rounds}},
      counts:{evidence:Number(db.one('SELECT COUNT(*) n FROM task_evidence WHERE task_id=?',taskId)!.n),claims:Number(db.one('SELECT COUNT(*) n FROM claims WHERE task_id=?',taskId)!.n),source_domains:new Set(db.rows('SELECT e.source_url FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=?',taskId).map(e=>new URL(e.source_url).hostname)).size,scope:'归档原文/域名计数，域名不同不自动等于独立信源；不要手数目录后编造数量'},
      engine_reflection_policy:cfg.engine_reflection_policy||{mode:'legacy-adaptive'},
      ...(!requestedRole||requestedRole==='main'||requestedRole==='media'?{platform_approval_updates:platformApprovalUpdates(db,taskId)}:{}),
      review_input:service.reviewInput(taskId),report_checkpoint:{...checkpoint,...checkpoint.chapters.length&&checkpoint.chapters.every((c:Row)=>c.saved)?{validation_errors:reportPipeline.preview().validation_errors}:{}},platform_sessions:new PlatformAccounts(config).public(),
      evidence:db.rows('SELECT e.id,e.title,e.source_url AS url,e.captured_at,e.content,m.published_at,m.author,m.publisher FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id LEFT JOIN evidence_metadata m ON m.evidence_id=e.id WHERE te.task_id=? ORDER BY e.captured_at,e.id',taskId).map(e=>({id:e.id,title:e.title,url:e.url,captured_at:e.captured_at,published_at:e.published_at||null,author:e.author||null,publisher:e.publisher||null,content_chars:e.content.length,preview:e.content.slice(0,120)})),
      claims:db.rows('SELECT * FROM claims WHERE task_id=? ORDER BY created_at,rowid',taskId).map((c,i)=>({number:i+1,id:c.id,text:c.text.slice(0,800),references:JSON.parse(c.references_json).map((r:Row)=>({...r,quote:String(r.quote||'').slice(0,120)})),dataset_refs:db.rows('SELECT dataset_id,row_key,value FROM claim_dataset_refs WHERE claim_id=? ORDER BY dataset_id,row_key',c.id)})),
      artifacts:index.rows.map(a=>({id:a.id,kind:a.kind,role:a.role,created_at:a.created_at,summary:summarizeArtifact(a.kind,a.role,JSON.parse(a.data_json))})),artifact_history_counts:index.counts,
      templates:[...templates,...config.get<Row[]>('templates.custom',[])],
      supplements:db.rows("SELECT payload_json,created_at FROM events WHERE task_id=? AND kind='task.supplement' ORDER BY id",taskId).map(e=>({message:String(JSON.parse(e.payload_json).message||'').slice(0,500),created_at:e.created_at})),
      reviews:db.rows('SELECT gate,evidence_revision,claims_hash,passed,reason FROM reviews WHERE task_id=?',taskId).map(r=>({...r,reason:String(r.reason||'').slice(0,700)})),
      agents:db.rows('SELECT role,child_session_id,status FROM agent_runs WHERE task_id=? AND root_session_id=? ORDER BY created_at',taskId,rootSession),
    };
  };
  const register = (toolName: string, description: string, parameters: Row, fn: (args: Row, exec: Row) => any) => ctx.tools.register(defineTool({
    name: toolName, description, parameters, output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    execute: async (args: Row, exec: Row) => {
      exec.signal.throwIfAborted(); const task=service.requireRun(taskId, token),role=roleOf(exec),policy=JSON.parse(task.config_json);
      const publicCrawl=toolName==='crawl_deep'&&!['weibo','bilibili'].includes(args.platform);
      const limit=({source_search:policy.max_searches||12,media_search:policy.max_searches||12,source_fetch:policy.max_fetches||40,media_inspect:policy.max_visual_calls||12} as Row)[toolName]||(publicCrawl?(policy.max_deep_requests||3):0);
      if(limit)db.transaction(()=>{const searchFamily=['source_search','media_search'].includes(toolName);const count=searchFamily?db.one("SELECT COUNT(*) n FROM events WHERE task_id=? AND kind='tool.started' AND json_extract(payload_json,'$.tool') IN ('source_search','media_search')",taskId)!.n:db.one("SELECT COUNT(*) n FROM events WHERE task_id=? AND kind='tool.started' AND json_extract(payload_json,'$.tool')=?"+(publicCrawl?" AND json_extract(payload_json,'$.operation')='public_pages'":''),taskId,toolName)!.n;if(count>=limit)throw new Error('本任务该工具已达到执行次数上限，请停止补证并披露缺口');db.event(taskId,'tool.started',{message:`${role} 开始 ${toolName}`,role,tool:toolName,...publicCrawl?{operation:'public_pages'}:{}});});
      try {
        const result=JSON.parse(JSON.stringify(await fn(normalizeJsonParameters(args, parameters), exec)));
        if((role==='main'||role==='media')&&result&&typeof result==='object'&&!Array.isArray(result)){const approvals=platformApprovalUpdates(db,taskId);if(approvals.length)result.platform_approval_updates=approvals;}
        const summary=summarizeToolResult(result);
        if(typeof args.section_id==='string'&&investigatorRoles.includes(role as InvestigatorRole))Object.assign(summary,{section_id:args.section_id});
          if(toolName==='db_ro_query')Object.assign(summary,{query_executed:true,evidence_count:Array.isArray(result?.evidence)?result.evidence.length:0});
        if(toolName==='source_search'||toolName==='media_search')Object.assign(summary,{search_attempted:Array.isArray(result.sources)&&result.sources.some((s:Row)=>!s.skipped)});
        if(toolName==='evidence_read')Object.assign(summary,{evidence_id:result.id,read_chars:String(result.content||'').length,offset:result.offset});
        if(toolName==='forum_read'){const latest=result.messages?.at(-1);Object.assign(summary,{forum_round:latest?.round||0,forum_cycle:latest?.cycle||0,forum_cycle_round:latest?.cycle_round??latest?.round??0,wait_ignored:result.wait_ignored,investigators_finished:result.cycle_state?.investigators_finished});}
        if(toolName==='task_context'&&result&&typeof result==='object')Object.assign(summary,{evidence_count:result.counts?.evidence??result.evidence?.length??0,claim_count:result.counts?.claims??result.claims?.length??0,artifact_count:result.counts?.artifacts??result.artifacts?.length??0,context_unchanged:!!result.unchanged,context_delta:!!result.delta});
        if(toolName==='task_context'&&result.verification_packet)Object.assign(summary,{verification_packet:{hash:result.verification_packet.hash,input_version:result.review_input,claim_count:result.verification_packet.claim_count,reference_count:result.verification_packet.reference_count,source_count:result.verification_packet.source_count}});
        db.event(taskId,'tool.completed',{message:`${role} 完成 ${toolName}`,role,tool:toolName,child_session_id:exec.agent.id,summary});
        return result;
      } catch(error) {
        let reason=error instanceof z.ZodError?error.issues.slice(0,5).map(i=>i.path.join('.')+': '+i.message).join('；'):error instanceof Error?error.message:'调用异常';
        for(const item of db.rows('SELECT id FROM secrets')){const secret=config.secret(item.id);if(secret)reason=reason.split(secret).join('[credential]');}
        reason=reason.replace(/https?:\/\/\S+/g,'[endpoint]').replace(/(?:authorization|cookie|api[_-]?key)\s*[:=]\s*[^\r\n]+/gi,'[credential]').slice(0,800);
        db.event(taskId,'tool.failed',{message:`${role} 的 ${toolName} 未完成：${reason}`,role,tool:toolName,child_session_id:exec.agent.id,error_type:error instanceof Error?error.name:'Error'});
        if(role==='report'&&['report_stage','report_chapter_repair','report_draft'].includes(toolName))stopRepeatedReportFailures(db,service,taskId,token,exec.agent.id);
        throw error;
      }
    },
  }));
  register('task_context', '读取任务和研究材料；版本未变化时复用本子会话已有内容，full=true 可强制读取完整目录', {full:{type:'boolean'}}, (args,exec)=>contextReuse.project(exec.agent.id,context(roleOf(exec)),!!args.full));
  register('evidence_read','按证据编号分段读取本任务归档原文；默认最多 6000 字符，使用 offset 继续读取；引擎调查时填写当前段落 section_id',{evidence_id:{type:'string',required:true},section_id:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},args=>{
    const b=z.object({evidence_id:z.string().min(1),section_id:z.string().trim().min(1).max(100).optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(6000).default(6000)}).strict().parse(args);
    const e=db.one('SELECT e.id,e.title,e.source_url AS url,e.captured_at,e.content,m.published_at,m.author,m.publisher FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id LEFT JOIN evidence_metadata m ON m.evidence_id=e.id WHERE te.task_id=? AND e.id=?',taskId,b.evidence_id);
    if(!e)throw new Error('证据编号不存在或不属于本任务');
    return {id:e.id,title:e.title,url:e.url,captured_at:e.captured_at,published_at:e.published_at||null,author:e.author||null,publisher:e.publisher||null,...evidenceWindow(e.content,b.offset,b.limit)};
  });
  register('artifact_read','按产物编号分段读取本任务的完整调查、主持、统计或报告阶段数据；使用 next_offset 继续',{artifact_id:{type:'string',required:true},offset:{type:'integer'},limit:{type:'integer'}},args=>{
    const b=z.object({artifact_id:z.string().min(1),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(6000).default(6000)}).strict().parse(args);
    const row=db.one('SELECT id,kind,role,data_json,created_at FROM artifacts WHERE task_id=? AND id=?',taskId,b.artifact_id);
    if(!row)throw new Error('产物编号不存在或不属于本任务');
    return {id:row.id,kind:row.kind,role:row.role,created_at:row.created_at,...artifactWindow(row.data_json,b.offset,b.limit)};
  });
  register('db_ro_query', '先由关键词优化中间件生成贴近网民表达的检索词，再只读搜索本任务原文；无任意SQL；只有任务明确允许复用时，将匹配的历史公开采集原文归入本任务，排除用户导入与平台登录态材料；填写当前段落 section_id', { query: { type: 'string', required: true },section_id:{type:'string'} }, async args => {
    const query = z.string().trim().min(1).max(200).parse(args.query), optimized = await optimizeKeywords(db, config, taskId, query, routeFor('keyword'),fetch,()=>service.requireRun(taskId,token));
    const lexicon=lookupLexicon(JSON.parse(service.rawTask(taskId).config_json).lexicon||new ResearchLexicon(config).freeze(),query);
    const terms = [...new Set([query, ...optimized.keywords,...lexicon.keywords])].slice(0, 41), clauses = terms.flatMap(() => ['e.title LIKE ?', 'e.content LIKE ?']).join(' OR '), params = terms.flatMap(term => [`%${term}%`, `%${term}%`]);
    if(lexicon.matches.length)artifact('lexicon_usage','insight',{query,version:lexicon.version,keywords:lexicon.keywords,purpose:'query-expansion-not-evidence'});
    const library=attachPublicLibrary(service,taskId,terms,token);if(library.length)await sentiment.annotate(taskId,library.map(e=>e.id),()=>service.requireRun(taskId,token));
    const candidates=db.rows(`SELECT e.* FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? AND (${clauses}) ORDER BY e.captured_at DESC,e.id LIMIT 200`, taskId, ...params);
    const {rows:selected,...sampling}=await semanticSampler.sample(candidates,()=>service.requireRun(taskId,token));
    if(candidates.length>30)artifact('semantic_sampling','insight',{query,...sampling,candidate_limit:200,selected_evidence_ids:selected.map(e=>e.id),note:'只对本任务检索候选抽样，完整原文仍在库；无热度值时按候选原顺序选代表，q8不宣称与Python浮点结果逐位相同'});
    return { query,library_attached:library.length, keyword_method: optimized.method, keywords: optimized.keywords,lexicon_version:lexicon.version,lexicon_keywords:lexicon.keywords,optimization_note: optimized.reason,sampling, evidence: evidenceIndex(selected,query),read_policy:'仅返回命中目录；超过30条候选时采用本地MiniLM/KMeans抽样，失败明确回退；用 evidence_read 读取原文，不重复把全文塞进上下文' };
  });
  register('lexicon_lookup','读取本任务冻结的检索别称/暗语词库，返回适用语境、维护来源和相关查询词；不是事实证据',{query:{type:'string',required:true}},args=>lookupLexicon(JSON.parse(service.rawTask(taskId).config_json).lexicon||new ResearchLexicon(config).freeze(),z.string().trim().min(1).max(500).parse(args.query)));
  register('historical_lookup','按本机已发布报告检索历史相似研究，排除当前任务；MiniLM相似度只是排序，旧结论不能直接当当前证据',{query:{type:'string',required:true},limit:{type:'integer'}},async args=>{const result=await history.lookup(z.string().trim().min(1).max(500).parse(args.query),taskId,z.number().int().min(1).max(10).default(5).parse(args.limit),()=>service.requireRun(taskId,token));artifact('historical_lookup','insight',result);return result;});
  register('hotlist_lookup','查询已有榜单线索；条目不是已归档正文，不能据此声称全网声量或确认事实',{query:{type:'string',required:true}},args=>{const query=z.string().trim().min(1).max(200).parse(args.query);return {evidence:false,items:db.rows("SELECT s.provider,s.source_id,s.observed_at,i.title,i.url,i.rank,i.heat_value,i.heat_label FROM hotlist_items i JOIN hotlist_snapshots s ON s.id=i.snapshot_id WHERE i.title LIKE ? AND s.status='succeeded' ORDER BY s.created_at DESC LIMIT 50",`%${query}%`)};});
  register('statistics_compute', '用代码统计本任务归档样本，创建图表所需底表；不是平台总体声量', {}, () => statistics(db, taskId));
  register('sample_annotate','为一份本任务原文保存情感和主题标签，标签是待抽检的模型判断，不能冒充客观统计事实',{evidence_id:{type:'string',required:true},sentiment:{type:'string',required:true,enum:['positive','neutral','negative','mixed','unknown']},topics:{type:'json',required:true},quote:{type:'string',required:true},reason:{type:'string',required:true}},async(args,exec)=>{if(roleOf(exec)!=='insight')throw new Error('仅 Insight 可提交样本标签');const b=z.object({evidence_id:z.string(),sentiment:z.enum(['positive','neutral','negative','mixed','unknown']),topics:z.array(z.string().trim().min(1).max(80)).max(5),quote:z.string().min(5).max(3000),reason:z.string().min(5).max(2000)}).strict().parse(args),e=db.one('SELECT e.content FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? AND e.id=?',taskId,b.evidence_id);if(!e||!e.content.includes(b.quote))throw new Error('标签依据必须来自本任务原文片段');const local=await sentiment.annotate(taskId,[b.evidence_id],()=>service.requireRun(taskId,token));const prediction=local.results?.[0];if(prediction)b.sentiment=prediction.sentiment;return db.transaction(()=>{const artifact_id=artifact('sample_annotation','insight',{...b,...(prediction?{label:prediction.label,model_id:prediction.model_id,model_version:prediction.model_version,confidence:prediction.confidence,probabilities:prediction.probabilities,input_scope:prediction.input_scope}:{}),method:prediction?'local_sentiment_model':'model_annotation',label_version:prediction?.model_version||'diting-sentiment-topic-v1',child_session_id:exec.agent.id});db.run('UPDATE tasks SET evidence_revision=evidence_revision+1,revision=revision+1 WHERE id=?',taskId);db.event(taskId,'sample.annotated',{message:'保存待抽检文档标签，旧审查与底表须重新核对',artifact_id});return {artifact_id,review_input:service.reviewInput(taskId)};});});
  register('sentiment_analyze','用本地独立五级情感模型批量分析本任务原文，无云端Token费；可省略编号处理全部。超过512分词Token会截断，低置信度保留未知',{evidence_ids:{type:'json'}},async args=>{const ids=args.evidence_ids?z.array(z.string()).max(200).parse(args.evidence_ids):db.rows('SELECT evidence_id FROM task_evidence WHERE task_id=?',taskId).map(e=>e.evidence_id);return sentiment.annotate(taskId,ids,()=>service.requireRun(taskId,token));});
  register('investigation_reflect', '保存本段初次总结或追加反思总结。先读task_context.engine_reflection_policy：bettafish-fixed下Insight共4次总结（初次+3次反思），Media/Query共3次（初次+2次反思）；仅最后一次decision=stop，其余search_more。legacy-adaptive才用旧上限及提前停止。每次须有本段实际检索/读取；HOST不构成前置门槛。', { section_id:{type:'string',required:true,description:'使用大纲中的稳定段落 ID，例如 section-1'},assessment:{type:'string',required:true,description:'本轮发现的具体缺口、反例、查询理由和停止条件，不替代正文总结'},findings:{type:'string',required:true,description:'本段完整最新分析状态，而不是本轮差异或100字短记。对齐BettaFish初次段落总结约800–1200中文字符：事实节点/具体案例、多方观点比较、背景机制、影响判断，保留原有关键发现并整合新查询。不编数据、不靠重复填字；材料少时明确范围。Report直接使用这份段落分析。'},decision:{type:'string',required:true,enum:['search_more','stop'],description:'固定契约：Insight第1/2/3次search_more、第4次stop；Media/Query第1/2次search_more、第3次stop。若提前stop被拒，改为search_more重新保存同一份已取证总结，之后再补查，不要反复提交stop。'},next_queries:{type:'json',required:true} }, (args,exec)=>{
    const role=roleOf(exec);if(!investigatorRoles.includes(role as InvestigatorRole))throw new Error('仅 Insight、Media、Query 可提交调查反思');
    const b=z.object({section_id:z.string().trim().min(1).max(100),assessment:z.string().trim().min(20).max(3000),findings:z.string().trim().min(20).max(5000),decision:z.enum(['search_more','stop']),next_queries:z.array(z.string().trim().min(2).max(300)).max(10)}).strict().parse(args);
    if(b.decision==='search_more'&&!b.next_queries.length)throw new Error('决定继续调查时必须列出下一轮检索问题');
    return submitReflection(db,taskId,role as InvestigatorRole,b,exec.agent.id);
  });
  register('research_delegate', '主 Agent 创建指定角色的 dsh 原生可继续子 Agent；已存在时返回原 child_id，请用 send_message 补证', {
    role: { type: 'string', required: true, enum: Object.keys(roles) }, assignment: { type: 'string', required: true },
  }, async (args, exec) => {
    if (roleOf(exec) !== 'main') throw new Error('只有主 Agent 可以分配角色');
    const role = args.role as Role, definition = roles[role];
    const existing = db.one("SELECT child_session_id FROM agent_runs WHERE task_id=? AND root_session_id=? AND role=? AND status NOT IN ('failed','stopped') ORDER BY created_at DESC LIMIT 1", taskId, rootSession, role);
    if (existing) return { child_id: existing.child_session_id, reused: true, next: '使用 send_message 将补证任务发送到原成员' };
    if(role==='planner'&&sentiment.settings(taskId).enabled)await sentiment.annotate(taskId,db.rows('SELECT evidence_id FROM task_evidence WHERE task_id=?',taskId).map(e=>e.evidence_id),()=>service.requireRun(taskId,token));
    if (role === 'report') {
      const version = service.reviewInput(taskId), valid = db.rows('SELECT * FROM reviews WHERE task_id=?', taskId).filter(r => r.passed && r.evidence_revision === version.evidence_revision && r.claims_hash === version.claims_hash);
      if (new Set(valid.map(r => r.gate)).size !== 3) throw new Error('三道门禁未通过或输入已变化，不能创建正式成稿成员');
    }
    const route = routeFor(definition.route); if (!route) throw new Error('该角色模型尚未配置');
    const childId = uid('agent'), stamp = now();
    db.run('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?)', uid('run'), taskId, rootSession, childId, role, 'starting', null, stamp, stamp);
    try {
      const result = await ctx.subagents.startContinuable({ provider: 'spawn', childId, label: definition.name,
        request: { parent: exec.agent, prompt: [{ type: 'text', text: `任务 ${taskId}。${args.assignment}。先用 task_context 读取范围和已有证据。` }],
          persona: `${common}\n${definition.persona}${investigatorRoles.includes(role as InvestigatorRole)?'\n先读task_context.engine_reflection_policy。bettafish-fixed模式每段必须先一次首轮查询和总结，再完成Insight3次/Media与Query各2次反思查询和总结；investigation_reflect的round=1是初始总结，后续round才是追加反思。前面decision=search_more，最后一次decision=stop。每次补查针对不同的具体缺口、反例、主体回应或原始来源，不能重复同一查询凑轮数；无结果也记录实际执行和缺口。只有legacy-adaptive旧任务才可提前判断停止。主持仍并行旁路，不等待主持才补查。':''}${role==='report'?'\n按章保存写作进度；同一响应可以提交多个不同章节，不必为每个阶段额外输出解释。已有章节只按具体事实错误局部修订。篇幅、小标题等编辑提示不要求重写；不要长篇重复分析同一校验问题。':''}`, toolFilter: { allow: toolsFor(role) }, maxDepth: 1,
          agentOptions: { provider: `diting-${definition.route}`, model: route.model, maxTokens: roleOutputLimit(role,route.max_tokens), ...isForcedThinkingGlm(route.model)?{reasoningEffort:'low'}:{} } }, signal: exec.signal });
      db.run("UPDATE agent_runs SET status='running',updated_at=? WHERE child_session_id=? AND status='starting'", now(), result.childId);
      const stage = { insight: 1, media: 1, query: 1, forum: 3, planner: 4, verifier: 5, advocate: 6, report: 7 }[role];
      db.run('UPDATE tasks SET stage=MAX(stage,?),revision=revision+1 WHERE id=?', stage, taskId);
      db.event(taskId, 'agent.started', { message: `${definition.name} 已创建原生子会话`, role, child_session_id: result.childId }); return { child_id: result.childId };
    } catch (error) { db.run("UPDATE agent_runs SET status='failed',updated_at=? WHERE child_session_id=?", now(), childId); throw error; }
  });
  register('research_wait', '由后端等待本轮成员完成，每 30 秒保存进度；等待期间无需主 Agent 反复调用模型轮询。受总时间和预算限制', {}, async (_args, exec) => {
    const started=Date.now(); let checkpoint=started;
    const active=()=>db.rows("SELECT role,child_session_id,status,updated_at FROM agent_runs WHERE task_id=? AND root_session_id=? AND status IN ('starting','running') ORDER BY created_at",taskId,rootSession);
    while(active().length){
      await new Promise(r=>setTimeout(r,500));exec.signal.throwIfAborted();service.requireRun(taskId,token);
      if(Date.now()-checkpoint>=30000){const pending=active();db.event(taskId,'agent.wait_checkpoint',{message:`后台等待成员：${pending.map(a=>a.role).join('、')}；没有新增主 Agent 模型轮询`,root_session_id:rootSession,waited_ms:Date.now()-started,active_roles:pending.map(a=>a.role)});checkpoint=Date.now();}
    }
    const pending=active(),progress={waited_ms:Date.now()-started,active_agents:pending,completed_agents:db.rows("SELECT role,status,updated_at FROM agent_runs WHERE task_id=? AND root_session_id=? AND status NOT IN ('starting','running') ORDER BY updated_at DESC LIMIT 12",taskId,rootSession)};
    db.event(taskId,'agent.wait_checkpoint',{message:pending.length?`等待检查点：仍有 ${pending.length} 个成员运行中`:'等待检查点：本轮成员均已结束',root_session_id:rootSession,waited_ms:progress.waited_ms,active_roles:pending.map(a=>a.role)});
    return pending.length?{...progress,continue_waiting:true,note:'仍有成员运行；不要结束主 Agent 本轮。'}:{...progress,continue_waiting:false,...context()};
  });
  const reference = z.object({ evidence_id: z.string(), quote: z.string().min(5),visual_id:z.string().optional(),visual_quote:z.string().min(5).optional(),visual_hash:z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
  register('investigation_submit', '新任务按段提交：section_id用反思中的稳定段落编号、section_title写子题；逐段保存，不要用一次扁平列表遗漏后半题。只有role_completed=true才结束成员。调查成员提交结论与逐字原文引用。只有引文中明确出现且主体、单位一致的数字才能写进事实结论；程序统计数字必须在 text 写出底表行标签和值，并通过 dataset_refs 绑定同一行。若无法精确绑定，删除数字、收窄措辞或记为缺口。逐条短结论，避免把整份长报告塞进一次调用。并提交未覆盖缺口。', {
    section_id:{type:'string',description:'新任务必填，与本段反思section_id一致'},section_title:{type:'string'},
    claims: { type: 'array', required: true,description:'每条使用 text/references；不要改成 claim/quotes/source，不自行分配结论编号',items:{type:'object',additionalProperties:false,properties:{
      text:{type:'string',required:true,description:'有原文支持的事实或有边界的分析结论'},
      references:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{evidence_id:{type:'string',required:true},quote:{type:'string',required:true,description:'从此归档原文逐字复制，不翻译、不改写、不用省略号替换'},visual_id:{type:'string'},visual_hash:{type:'string'},visual_quote:{type:'string'}}}},
      dataset_refs:{type:'array',items:{type:'object',additionalProperties:false,properties:{dataset_id:{type:'string',required:true},row_key:{type:'string',required:true},value:{type:'number',required:true}}}}
    }}}, gaps: { type: 'array',items:{type:'string'},required: true },
  }, (args, exec) => {
    const role = roleOf(exec); if (!['insight', 'media', 'query'].includes(role)) throw new Error('只有调查成员可提交');
    const datasetRef=z.object({dataset_id:z.string(),row_key:z.string().min(1).max(150),value:z.number().finite()}).strict();
    const b = z.object({ section_id:z.string().trim().min(1).max(100).optional(),section_title:z.string().trim().min(1).max(200).optional(),claims: z.array(z.object({ text: z.string().min(5).max(10000), references: z.array(reference).min(1),dataset_refs:z.array(datasetRef).max(20).optional() }).strict()).max(30), gaps: z.array(z.string().max(1000)).max(30) }).parse(args);
    const cfg=JSON.parse(service.rawTask(taskId).config_json);if(cfg.engine_section_contract&&!b.section_id)throw Error('本任务按段保存，请填section_id并提交该段完整结论，不能只交前半题的扁平列表');
    assertReflectionGate(db,taskId,role as InvestigatorRole,exec.agent.id,cfg.engine_section_contract?b.section_id:undefined);
    if(cfg.engine_section_contract&&!b.claims.length&&!b.gaps.some(g=>g.trim().length>=20))throw Error('无结论段落须保留具体、可核对的资料缺口');
    const result=persistInvestigation(db,service,taskId,role,b.claims,b.gaps,token,exec.agent.id,cfg.engine_section_contract?{kind:'investigation_section',metadata:{section_id:b.section_id,section_title:b.section_title||b.section_id,source_backed_stop:true}}:{});
    return cfg.engine_section_contract?{...result,...finalizeInvestigatorSections(db,service,taskId,role,token,exec.agent.id,Number(cfg.min_engine_sections||1))}:result;
  });
  register('investigation_repair','对已保存失败提交仅修具体条目，避免重写全部结论。patches=[{index:0,text:"修正后的短结论"}]，可修改references/dataset_refs；remove_indexes仅用于撤回无依据条目。所有引用、数字和反思检查仍执行。',{submission_id:{type:'string',required:true},patches:{type:'json',required:true},remove_indexes:{type:'json'}},(args,exec)=>{const role=roleOf(exec);if(!investigatorRoles.includes(role as InvestigatorRole))throw Error('仅调查成员可修复');assertReflectionGate(db,taskId,role as InvestigatorRole,exec.agent.id);const result=repairInvestigationSubmission(db,service,taskId,role,String(args.submission_id),args.patches,args.remove_indexes,token,exec.agent.id),cfg=JSON.parse(service.rawTask(taskId).config_json);return cfg.engine_section_contract?{...result,...finalizeInvestigatorSections(db,service,taskId,role,token,exec.agent.id,Number(cfg.min_engine_sections||1))}:result;});
  register('forum_read', '读取本任务最新 ForumHost 滚动主持意见。它是并行旁路交流，可辅助调整调查，不会阻塞引擎自己的 BettaFish 检索—总结—反思循环。', { after_round:{type:'integer'},wait:{type:'boolean'} }, async (args,exec) => {
    const role=roleOf(exec),b=z.object({after_round:z.number().int().min(0).max(30).default(0),wait:z.boolean().default(false)}).strict().parse(args);
    if(role!=='forum'&&!investigatorRoles.includes(role as InvestigatorRole)&&role!=='main')throw new Error('当前角色不能读取 ForumHost 消息');
      if(role==='forum'&&b.wait){const deadline=Date.now()+90000;while(Date.now()<deadline){exec.signal.throwIfAborted();service.requireRun(taskId,token);const state=forumCycleState(db,taskId,rootSession),ready=role==='forum'?state.ready:latestForumMessages(db,taskId,100,rootSession).some(m=>m.round>b.after_round&&Number(m.cycle||0)===state.cycle);if(ready||state.investigators_finished)break;await new Promise(resolve=>setTimeout(resolve,500));}}
      const state=forumCycleState(db,taskId,rootSession);
      return {messages:latestForumMessages(db,taskId,10,rootSession),cycle_state:state,latest_round:latestForumRound(db,taskId,rootSession),waiting_for_forum_round:null,wait_ignored:role!=='forum'&&b.wait,
        reflections:Object.fromEntries(investigatorRoles.map(r=>[r,reflectionHistory(db,taskId,r,rootSession).filter(x=>Number(x.data.cycle||0)===state.cycle).slice(-3).map(x=>({id:x.id,...x.data}))])),
        current_counts:{evidence:db.one('SELECT COUNT(*) n FROM task_evidence WHERE task_id=?',taskId)!.n,claims:db.one('SELECT COUNT(*) n FROM claims WHERE task_id=?',taskId)!.n,evidence_revision:service.rawTask(taskId).evidence_revision},
        note:'反思与数量是本次调用时的最新归档状态；主持时根据这些新材料更新判断，不沿用启动时 task_context 的空资料判断。'};
  });
  register('forum_submit', 'ForumHost 按收到的引擎发言滚动发布共识、分歧和补证建议；不等待所有引擎齐步，不新增事实。', { summary: { type: 'string', required: true }, disagreements: { type: 'json', required: true }, supplements: { type: 'json', required: true } }, (args, exec) => {
    if (roleOf(exec) !== 'forum') throw new Error('仅主持成员可写论坛记录'); const b=z.object({ summary: z.string().min(30).max(10000), disagreements: z.array(z.string().min(5)).max(30), supplements: z.array(z.string().min(5)).max(30) }).parse(args); return postForumMessage(db,taskId,b,exec.agent.id);
  });
  register('review_submit', '独立审查成员提交当前版本的门禁判断，缺口必须说明，不得通过旧版本', { passed: { type: 'boolean', required: true }, reason: { type: 'string', required: true }, input_version: { type: 'json', required: true } }, (args, exec) => {
    const role = roleOf(exec), gate = { planner: 'sufficiency', verifier: 'verifier', advocate: 'advocate' }[role as 'planner' | 'verifier' | 'advocate'];
    if (!gate) throw new Error('仅对应审查成员可提交门禁');
    if (args.reason.trim().length < 15) throw new Error('请提供具体审查依据和局限，不能只写通过');
    if (args.passed && !db.one('SELECT id FROM claims WHERE task_id=?', taskId)) throw new Error('没有结论与证据，门禁不能通过');
    const investigations = new Set(db.rows("SELECT role FROM artifacts WHERE task_id=? AND kind='investigation'", taskId).map(a => a.role));
    if (args.passed && (investigations.size < 3 || !db.one("SELECT id FROM artifacts WHERE task_id=? AND kind='forum'", taskId))) throw new Error('调查成员成果和主持记录尚未齐备');
    if(args.passed&&role==='verifier'){const packet=db.one("SELECT payload_json FROM events WHERE task_id=? AND kind='tool.completed' AND json_extract(payload_json,'$.child_session_id')=? AND json_extract(payload_json,'$.tool')='task_context' AND json_extract(payload_json,'$.summary.verification_packet') IS NOT NULL ORDER BY id DESC LIMIT 1",taskId,exec.agent.id);if(!packet||encode(JSON.parse(packet.payload_json).summary.verification_packet.input_version)!==encode(service.reviewInput(taskId)))throw Error('须先读取当前版本全部引用的verification_packet，再核验并提交；原文预览或旧版本材料不足以通过');}
    if(args.passed){assertReviewPrerequisites(db,taskId,gate as 'sufficiency'|'verifier'|'advocate',args.reason);db.event(taskId,'review.mechanical_checks',{message:'研究成员、Forum记录及结论引用连线已通过结构检查；事实真伪仍由独立核验判断',gate,coverage:reportCoverage(db,taskId)});}
    service.review(taskId, gate, args.passed, args.reason, token, z.object({ evidence_revision: z.number().int(), claims_hash: z.string() }).strict().parse(args.input_version)); return { saved: true, gate };
  });
  register('source_search', '按任务创建时冻结的时间窗发现新闻与网页链接；不能按当前运行时间漂移窗口，也不能扩展到冻结范围以外；窗口外已知日期结果会过滤，日期未知会标记保留；搜索摘要不能直接作为归档证据；填写当前段落 section_id', { query: { type: 'string', required: true }, start_date:{type:'string'},end_date:{type:'string'},section_id:{type:'string'} }, async (args, exec) => {
    const task=service.rawTask(taskId),scope=JSON.parse(task.config_json),frozen=frozenResearchWindow(task.created_at,scope.window_days||7);
    const window={start_date:args.start_date||frozen.start_date,end_date:args.end_date||frozen.end_date};
    if(window.start_date<frozen.start_date||window.end_date>frozen.end_date)throw Error(`搜索时间窗必须位于任务冻结范围 ${frozen.start_date} 至 ${frozen.end_date} 内`);
    return cachedSearch(db,taskId,searchIdentity(config,args.query,window),()=>searchWeb(config,taskId,args.query,exec.signal,fetch,window));
  });
  register('media_search','按图像/视频线索定向发现公开媒体页面；返回的网页链接仅是线索，必须 source_fetch 归档原页；页面发布的图片/视频元数据不等于模型已观看或验证素材内容；填写当前段落 section_id',{query:{type:'string',required:true},kind:{type:'string',enum:['image','video','both']},section_id:{type:'string'}},async(args,exec)=>{
    if(roleOf(exec)!=='media')throw new Error('仅 Media 调查成员可调用多模态素材发现');
    const b=z.object({query:z.string().trim().min(2).max(400),kind:z.enum(['image','video','both']).default('both'),section_id:z.string().trim().min(1).max(100).optional()}).strict().parse(args);
    const suffix=b.kind==='image'?'图片 图像 照片':b.kind==='video'?'视频 采访 现场 影像':'图片 OR 视频 采访 现场';
    const query=`${b.query} ${suffix}`;
    const result=await cachedSearch(db,taskId,searchIdentity(config,query,{},['bocha','tavily','anspire']),()=>searchWeb(config,taskId,query,exec.signal,fetch,undefined,{providers:['bocha','tavily','anspire']}));
    const artifact_id=artifact('media_discovery','media',{query,kind:b.kind,results:result.results.map(({title,url,snippet,published_at,provider}:Row)=>({title,url,snippet,published_at,provider})),provider_status:result.sources,evidence:false,warning:'搜索列表与摘要仅用于发现；需取得原页面及媒体内容才能形成媒体证据'});
    return {...result,artifact_id,media_evidence:false};
  });
  register('media_inspect','识别 source_fetch 返回的 media_assets：归档原始图片/视频及实际输入帧，调用冻结的 Media 视觉模型并计入本任务预算。视频仅前90秒最多6帧且无音频。引用需保存 visual_id/visual_hash/visual_quote 并保留来源页原文引用；填写当前段落 section_id',{evidence_id:{type:'string',required:true},url:{type:'string',required:true},question:{type:'string',required:true},section_id:{type:'string'}},async(args,exec)=>{if(roleOf(exec)!=='media')throw Error('仅 Media 可请求视觉识别');const b=z.object({evidence_id:z.string(),url:z.string().url(),question:z.string().trim().min(5).max(2000),section_id:z.string().trim().min(1).max(100).optional()}).strict().parse(args);return visuals.inspect(taskId,token,b.evidence_id,b.url,b.question,routeFor('media'),exec.signal);});
  const pendingPages=new Map<string,Promise<Row>>();
  const archivePage = async (url: string, signal: AbortSignal, collectorRole='media') => {
    const linked=db.one('SELECT e.* FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? AND e.source_url=?',taskId,url);
    if(linked){db.event(taskId,'research.page_reused',{message:'复用本任务已归档原文',evidence_id:linked.id,url});return {evidence_id:linked.id,url,title:linked.title,content:linked.content.slice(0,1800),content_chars:linked.content.length,reused:true,read_policy:'原文已归档，使用 evidence_read 分段读取'};}
    try {
      const result = await scrapePublicPage(config, url, signal), content = result.content;
      if (content.length < 150) throw new Error('正文过短，可能是验证页或未取得正文');
      const evidence_id=service.archive(taskId, result.url, result.title, content, result.provider === 'firecrawl' ? 'firecrawl' : 'web_fetch', token,result.metadata);
      const metadata=result.metadata as Row,mediaAssets=Array.isArray(metadata?.media_assets)?metadata.media_assets.slice(0,20):[];
      const media_artifact_id=mediaAssets.length?artifact('media_assets',collectorRole,{evidence_id,page_url:result.url,assets:mediaAssets,extraction:'publisher-declared OpenGraph/Twitter metadata; not perceptual verification'}):null;
      const sentiment_result=await sentiment.annotate(taskId,[evidence_id],()=>service.requireRun(taskId,token)).catch(()=>({enabled:true,status:'failed'}));
      return { evidence_id,media_artifact_id,media_assets:mediaAssets, url: result.url, title: result.title, metadata:result.metadata, content: content.slice(0,1800),content_chars:content.length,read_policy:'正文已完整归档；使用 evidence_read 分段取得逐字引用',sentiment:sentiment_result }; 
    } catch (error) { db.run('INSERT INTO acquisitions VALUES(?,?,?,?,?,?,?)', uid('acq'), taskId, new URL(url).origin, 'web_fetch', 'failed', error instanceof Error ? error.message.slice(0, 300) : '抓取失败', now()); throw error; }
  };
  register('source_fetch', '取得公开网页正文并归档原文及哈希；提取页面公开声明的图片/视频元数据但不表示内容已被模型视觉核验；不访问本机和私有网络；填写当前段落 section_id', { url: { type: 'string', required: true },section_id:{type:'string'} }, async(args, exec) => {const url=z.string().url().parse(args.url);let page=pendingPages.get(url);if(!page){page=archivePage(url,exec.signal,roleOf(exec));pendingPages.set(url,page);page.finally(()=>pendingPages.delete(url)).catch(()=>{});}return page;});
  register('crawl_deep', '申请有界关键词深采。platform=weibo 时 options 可填 max_posts/comments_per_post/include_long_text；bilibili 填 max_videos/comments_per_video。两者可设 max_pages/comment_pages/max_requests、access_mode（public 默认不带Cookie，saved_session 使用已保存登录态并冻结版本）。先批准具体范围和访问模式。不绕过登录风控。公开网页填 urls', { query: { type: 'string', required: true }, urls: { type: 'json' },platform:{type:'string',enum:['bilibili','weibo','public_pages']},options:{type:'json'} }, async (args, exec) => {
    if(args.platform==='bilibili'||args.platform==='weibo'){
      const result=await new DeepCrawl(service,{},new PlatformAccounts(config)).request(taskId,token,{...(args.options||{}),query:args.query,platform:args.platform},exec.signal);
      const ids=result.executed?[...new Set(result.records.map((record:Row)=>record.evidence_id).filter(Boolean))] as string[]:[];
      const labels=ids.length?await sentiment.annotate(taskId,ids,()=>service.requireRun(taskId,token)).catch((error:unknown)=>{service.requireRun(taskId,token);db.event(taskId,'sentiment.platform_failed',{message:'平台原文已保存；本地情感标注未完成，样本保留未知，不伪造标签'});return {status:'failed',enabled:true};}):null;
      return {...result,...labels?{sentiment:labels}:{},...result.executed&&!('reused' in result&&result.reused)?{artifact_id:artifact('platform_collection',roleOf(exec),result)}:{}};
    }
    const request = z.object({ query: z.string().min(2).max(300), urls: z.array(z.string().url()).min(1).max(5) }).parse(args), encoded = encode(request);
    const approval = db.one("SELECT * FROM approvals WHERE task_id=? AND operation='public_keyword_crawl' AND request_json=? ORDER BY created_at DESC LIMIT 1", taskId, encoded);
    if (approval?.status === 'rejected') return { executed: false, reason: '用户已拒绝此范围' };
    if (approval?.status === 'approved') return { executed: true, pages: await Promise.allSettled(request.urls.map(url => archivePage(url, exec.signal,roleOf(exec)))).then(r => r.map(v => v.status === 'fulfilled' ? v.value : { error: '页面取证失败，查看采集流水' })) };
    const id = approval?.id||service.requestCrawlApproval(taskId,'public_keyword_crawl',request,token);
    return { executed: false, approval_id: approval?.id || id, status: 'pending', note: '主 Agent 应记录等待审批；没有执行爬取' };
  });
  register('report_stage', '按顺序保存成稿阶段：template/evidence_map/layout/length/chapter/repair；每个章节独立持久化', { stage: { type: 'string', required: true, enum: ['template','evidence_map','layout','length','chapter','repair'] }, data: { type: 'json', required: true, description:reportStageDataGuide } }, (args, exec) => {
    if (roleOf(exec) !== 'report') throw new Error('仅成稿成员可以写成稿阶段'); return reportPipeline.record(args.stage, args.data);
  });
  register('report_materials','一次读取完整引擎成果、逐字引文、冻结研究窗口、来源日期归类及平台样本/互动/情感汇总。窗口外与日期未知材料不可写成窗口内事实；有平台记录时必须进行引用支持的样本分析。首次offset=0；has_more时继续next_offset。',{offset:{type:'integer'},limit:{type:'integer'}},(args,exec)=>{if(roleOf(exec)!=='report')throw Error('仅Report可读取成稿材料包');return {input_version:service.reviewInput(taskId),...reportMaterials(db,taskId,z.number().int().min(0).default(0).parse(args.offset),z.number().int().min(1).max(100).default(80).parse(args.limit))};});
  register('report_support','只在具体数字报错时查询支持候选，不要成稿前盘点全部数字。每次values最多15项，使用字符串数组，例如["82亿美元","2.7%"]。同值只是候选，不能证明实体/单位/时间归属；无候选就收窄句子或补证。',{values:{type:'json',required:true}},(args,exec)=>{if(roleOf(exec)!=='report')throw Error('仅Report可查询成稿依据');return {input_version:service.reviewInput(taskId),hints:numericSupportHints(db,taskId,z.array(z.union([z.string().min(1).max(40),z.number().finite().transform(String)])).max(15).parse(args.values))};});
  register('report_chapter_repair','修复当前版本章节，仅传修改字段。单句修改优先patch.replacements=[{old:"已保存且仅出现一次的原句",new:"修正句"}]，按原文精确替换，不能与text一起传。claim_numbers按task_context精确绑定（与claim_ids二选一），也可只换visuals。所有事实检查仍执行。',{submission_id:{type:'string',required:true},patch:{type:'json',required:true}},(args,exec)=>{if(roleOf(exec)!=='report')throw Error('仅Report可修复章节');return reportPipeline.repairChapter(String(args.submission_id),args.patch);});
  register('report_draft', '装配已保存章节。document 必填 title/template_id/dataset_ids(字符串数组)/limitations(字符串数组)。frameworks 可选：swot 含 strengths/weaknesses/opportunities/threats，pest 含 political/economic/social/technological；每格都是 {text:"有依据的分析",claim_ids:["本任务结论ID"]} 对象数组，不是字符串数组。无需回传全文。编辑提示不阻止发布。', { document: { type: 'json', required: true } }, (args, exec) => {
    if (roleOf(exec) !== 'report') throw new Error('只有 Report 成员可以提交报告');
    return reportPipeline.finalize(args.document);
  });
  register('report_publish', '主 Agent 将经过门禁和结构验证的报告导出 HTML/MD/PDF 并入库', { artifact_id: { type: 'string', required: true } }, async (args, exec) => {
    if (roleOf(exec) !== 'main') throw new Error('仅主 Agent 可交付');
    const a = db.one("SELECT * FROM artifacts WHERE id=? AND task_id=? AND kind='report_candidate'", args.artifact_id, taskId); if (!a) throw new Error('报告候选不存在');
    const candidate = JSON.parse(a.data_json); if (encode(candidate.input_version) !== encode(service.reviewInput(taskId))) throw new Error('成稿后证据或结论已变化，需要重新审查与成稿');
    const { tables: _computedTables, ...rawDocument } = candidate.document;
    const document = validateReport(db, taskId, rawDocument, candidate.template_contract), files = await exportFiles(db, taskId, document, dataDir);
    service.requireRun(taskId, token); const report_id = service.publishReport(taskId, { ...document, exports: files }, token); exec.concludeTurn(); return { report_id, formats: files.formats };
  });
  register('research_finish', '主 Agent 说明为何等待审批、缺材料或证据不足；不产生通过门禁的报告', { reason: { type: 'string', required: true } }, (args, exec) => {
    if (roleOf(exec) !== 'main') throw new Error('仅主 Agent 可结束调查');
    const status = db.one("SELECT id FROM approvals WHERE task_id=? AND status='pending'", taskId) ? 'waiting_approval' : 'waiting_evidence';
    service.waitRuntime(taskId, token, args.reason, status); exec.concludeTurn(); return { status, reason: args.reason };
  });
  ctx.tools.guard((exec: Row) => {
    const role = exec.agent && binding(exec.agent.id), allowed: readonly string[] = role ? toolsFor(role) : [];
    if (!allowed.includes(exec.name)) {if(exec.name.startsWith('mcp__'))db.event(taskId,'mcp.denied',{message:'角色未获此 MCP 工具授权',role,tool:exec.name,child_session_id:exec.agent?.id});return 'DiTing 角色工具白名单拒绝此调用';}
    try { service.requireRun(taskId, token); } catch { return '研究任务已停止或执行租约失效'; }
    if(exec.name==='skill'&&!skillsFor(role).some(s=>s.id===exec.arguments?.name)){
      db.event(taskId,'skill.denied',{message:'拒绝读取未授权的技能',role,skill_id:String(exec.arguments?.name||'').slice(0,80),child_session_id:exec.agent.id});
      return '该技能未对当前角色启用或不属于本任务冻结版本';
    }
    if(exec.name.startsWith('mcp__')){
      const server=frozenMcp.find(s=>s.tools.some(t=>mcpName(s.id,t.name)===exec.name))!;
      const count=db.one("SELECT COUNT(*) n FROM events WHERE task_id=? AND kind='mcp.started' AND json_extract(payload_json,'$.server_id')=?",taskId,server.id)!.n;
      if(count>=server.max_calls)return '该 MCP 服务已达到本任务调用上限';
      db.event(taskId,'mcp.started',{message:'开始调用已授权 MCP 工具',server_id:server.id,role,tool:exec.name,version:server.version,child_session_id:exec.agent.id});
    }
    if (exec.name === 'send_message' && role === 'main') {
      const target = exec.arguments?.agent_id;
      const targetRun=target?db.one('SELECT root_session_id,status FROM agent_runs WHERE task_id=? AND child_session_id=?',taskId,target):undefined;
      if(!targetRun||targetRun.root_session_id!==rootSession)return '不能向旧运行会话的成员发送补证；请用 research_delegate 创建当前会话权限版本的角色';
      const count = db.one("SELECT COUNT(*) n FROM events WHERE task_id=? AND kind='agent.followup' AND json_extract(payload_json,'$.child_session_id')=?", taskId, target || '')!.n;
      if (count >= 3) return '该成员已达到三轮后续补证上限，请收窄结论或记录证据缺口';
      db.event(taskId, 'agent.followup', { message: '主 Agent 请求原成员继续补证', child_session_id: target || '', tool_call_id: exec.callId });
    }
    const used = db.one('SELECT SUM(cost) cost FROM model_calls WHERE task_id=?', taskId)?.cost || 0;
    if (used >= service.rawTask(taskId).budget) return '研究预算已达到上限，请停止或申请调整预算';
  });
  ctx.on('agent/created', ({ agent }: Row) => {
    const role = binding(agent.id); if (!role) throw new Error('拒绝创建未登记的 DiTing 研究 Agent');
    const skillContext=createScope(ctx,agent).ctx;
    for(const skill of skillsFor(role)){
      skillContext.skills.register({name:skill.id,description:skill.description,content:skill.content,source:'runtime',provider:'diting',invocation:{modelInvocable:true,userInvocable:false}});
      db.event(taskId,'skill.mounted',{message:`${role} 已挂载技能：${skill.name}`,role,skill_id:skill.id,version:skill.version,child_session_id:agent.id,root_session_id:rootSession});
    }
    agent.ctx.tools.restrict({ allow: toolsFor(role) });
  });
  const skillCalls=new Map<string,Row>();
  const mcpCalls=new Map<string,Row>();
  ctx.on('session/event',(session:Row,event:Row)=>{
    const role=binding(session.id);if(!role)return;
    if(event.type==='tool/call'&&event.data.name==='skill'){
      try{const args=JSON.parse(event.data.arguments),skill=skillsFor(role).find(s=>s.id===args.name);skillCalls.set(session.id+':'+event.data.callId,{role,skill_id:args.name,version:skill?.version,child_session_id:session.id});}catch{}
    }
    if(event.type==='tool/call'&&event.data.name.startsWith('mcp__'))mcpCalls.set(session.id+':'+event.data.callId,{role,tool:event.data.name,child_session_id:session.id});
    if(event.type==='tool/result'){
      const message=event.data.message,key=session.id+':'+message.toolCallId,mcp=mcpCalls.get(key);
      if(mcp){db.event(taskId,'mcp.called',{...mcp,message:message.isError?'MCP 调用失败或被拒绝':'MCP 工具已返回待核实资料',status:message.isError?'failed':'succeeded',cost:null,cost_status:'not_provided',result_hash:hash(JSON.stringify(message.content)),tool_call_id:message.toolCallId});mcpCalls.delete(key);}
      const call=skillCalls.get(key);if(!call)return;
      db.event(taskId,message.isError?'skill.failed':'skill.loaded',{...call,message:message.isError?'技能读取失败':'已通过 dsh 原生 skill 工具读取冻结技能正文',tool_call_id:message.toolCallId});skillCalls.delete(key);
    }
  });
  ctx.on('subagent/start',(info:Row)=>{try{service.requireRun(taskId,token);}catch{return;}const run=db.one('SELECT * FROM agent_runs WHERE task_id=? AND child_session_id=?',taskId,info.id);if(!run)return;db.run("UPDATE agent_runs SET status='running',updated_at=? WHERE id=?",now(),run.id);db.event(taskId,'agent.turn_started',{message:`${run.role} 开始本轮调查或补证`,role:run.role,child_session_id:info.id});});
  ctx.on('subagent/end', (info: Row) => {
    const run = db.one('SELECT * FROM agent_runs WHERE task_id=? AND child_session_id=?', taskId, info.id); if (!run) return;
    db.run('UPDATE agent_runs SET status=?,result_json=?,updated_at=? WHERE id=?', info.stopReason === 'completed' ? 'idle' : 'failed', encode({ stop_reason: info.stopReason }), now(), run.id);
    db.event(taskId, 'agent.finished', { message: `${roles[run.role as Role].name} 本轮结束`, role: run.role, child_session_id: info.id, stop_reason: info.stopReason });
  });
  ctx.on('llm/stream', async function* (options: Row, next: () => AsyncIterable<Row>) {
    const task = service.requireRun(taskId, token), role = binding(options.sessionId) || 'main';
    const route = routeFor(role === 'main' ? 'planner' : roles[role as Role].route);
    if (!route?.rates) throw new Error('研究路由缺少计费单价，无法执行预算预留');
    const rates = route.rates, callId = uid('call'), policy = config.get<Row>('runtime.policy', {});
    // A fixed 64k-token estimate under-reserved long multi-agent contexts.
    // Reserve against the actual prompt/tool payload before concurrent calls
    // are launched, then replace this conservative amount with provider usage.
    const reservation = reserveModelCost(options, options.maxTokens || route.max_tokens, rates);
    let budgetBlocked=false,limitMessage:string|null=null;
    db.transaction(() => {
      const totals = db.one('SELECT COUNT(*) n,COALESCE(SUM(COALESCE(actual_cost,reserved_cost)),0) cost FROM model_reservations WHERE task_id=?', taskId)!;
      if (totals.n >= (policy.max_calls || 120)) {
        limitMessage=`本地模型调用已达 ${totals.n}/${policy.max_calls||120} 次，当前阶段 ${task.stage}；已保存材料与章节，需调整调用上限后继续。`;
        return;
      }
      if (totals.cost + reservation > task.budget) {budgetBlocked=true;return;}
      db.run('INSERT INTO model_reservations VALUES(?,?,?,NULL,?,?)', callId, taskId, reservation, 'pending', now());
    });
    if(limitMessage){db.event(taskId,'runtime.call_limit',{message:limitMessage,max_calls:policy.max_calls||120,role});service.waitRuntime(taskId,token,limitMessage,'paused');throw new Error(limitMessage);}
    if(budgetBlocked){const spent=db.one('SELECT COALESCE(SUM(COALESCE(actual_cost,reserved_cost)),0) cost FROM model_reservations WHERE task_id=?',taskId)!.cost;recordBudgetState(db,taskId,task.budget,spent,'reservation');throw new Error('剩余研究预算不足以预留本次模型调用上限');}
    let usage: Row | undefined, status = 'failed', chunks=0,visibleChars=0,argumentChars=0,reasoningChars=0,lastProgress=Date.now(),failureRecorded=false;
    let release:(cooldownMs?:number)=>void=()=>{},cooldown=0,requestStarted=false,started=Date.now();
    const recordFailure=(failure:Row)=>{if(failureRecorded)return;failureRecorded=true;if(failure.status===429||failure.code==='RATE_LIMIT')cooldown=30000;const secret=config.secret(route.key_ref);let message=String(failure.message||'模型调用失败');if(secret)message=message.split(secret).join('[credential]');message=message.replace(/https?:\/\/\S+/g,'[endpoint]').slice(0,600);db.event(taskId,'model.failed',{message,code:failure.code||'MODEL_FAILURE',http_status:failure.status??null,role,call_id:callId,elapsed_ms:Date.now()-started});};
    db.event(taskId,'model.queued',{message:`${role} 等待当前模型服务账号的并发槽位；独立账号分别排队`,role,call_id:callId});
    try {
      release=await acquireModelSlot(db,config,taskId,callId,role,options.signal,()=>service.requireRun(taskId,token),route);
      started=Date.now();requestStarted=true;
      db.event(taskId,'model.started',{message:`${role} 正在请求模型；输出上限 ${options.maxTokens||route.max_tokens} Token`,role,call_id:callId,max_output_tokens:options.maxTokens||route.max_tokens});
      for await (const chunk of next()) {
      chunks++;
      if(chunks===1)db.event(taskId,'model.first_response',{message:`${role} 已收到模型首个响应`,role,call_id:callId,latency_ms:Date.now()-started});
      if(chunk.type==='text-delta')visibleChars+=String(chunk.text||'').length;
      if(chunk.type==='reasoning-delta')reasoningChars+=String(chunk.text||'').length;
      if(chunk.type==='tool-call-delta')argumentChars+=String(chunk.argumentsDelta||'').length;
      if(Date.now()-lastProgress>=15000){db.event(taskId,'model.progress',{message:`${role} 模型仍在生成：推理 ${reasoningChars} 字符、正文 ${visibleChars} 字符、工具参数 ${argumentChars} 字符；章节以保存事件为准`,role,call_id:callId,chunks,reasoning_chars:reasoningChars,visible_chars:visibleChars,argument_chars:argumentChars,elapsed_ms:Date.now()-started});lastProgress=Date.now();}
      if (chunk.type === 'usage') usage = chunk.usage;
      if (chunk.type === 'finish') {
        status = ['error','aborted'].includes(chunk.reason?.kind||chunk.reason) ? 'failed' : 'succeeded';
        if(status==='failed')recordFailure(chunk.reason?.failure||{message:'模型流异常结束'});
      }
      yield chunk;
    } }catch(error){recordFailure({message:error instanceof Error?error.message:'模型传输异常',code:'MODEL_TRANSPORT_ERROR'});throw error;}
    finally {
      release(cooldown);
      const {input,output,cache}=requestStarted?streamUsage(usage,status):{input:0,output:0,cache:0};
      const cost = calculateCost(input, output, cache, rates);
      db.transaction(() => {
        db.run('UPDATE model_reservations SET actual_cost=?,status=? WHERE id=?', cost, cost===null?'unknown':status, callId);
        db.run('INSERT OR IGNORE INTO model_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', callId, taskId, null, role, route.provider, route.model, input, output, cache, cost, status, task.attempt, now());
        db.event(taskId,'model.finished',{message:`${role} 模型调用已结束`,role,call_id:callId,status,cost,request_sent:requestStarted,usage_known:cost!==null,elapsed_ms:Date.now()-started});
      });
      if(cost!==null){const spent=db.one('SELECT COALESCE(SUM(COALESCE(actual_cost,reserved_cost)),0) cost FROM model_reservations WHERE task_id=?',taskId)!.cost;recordBudgetState(db,taskId,task.budget,spent,'usage');}
    }
  });
  db.event(taskId,'runtime.profile_ready',{message:'DiTing 领域工具、成员白名单与预算守则已挂载',root_session_id:rootSession});
  ctx.effect(() => () => db.close());
  }catch(error){db.event(taskId,'runtime.profile_error',{message:error instanceof Error?error.message.slice(0,500):'领域插件未完成初始化',root_session_id:rootSession});db.close();throw error;}
}
