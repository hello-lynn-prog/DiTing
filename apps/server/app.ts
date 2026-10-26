import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Database, now, hash, type Row } from '../../packages/domain/db.js';
import { Service } from '../../packages/domain/service.js';
import { Configuration } from '../../packages/domain/configuration.js';
import {LocalSentiment} from '../../packages/sentiment/service.js';
import {readSoakStatus} from '../../packages/domain/soak-status.js';
import {semanticStatus} from '../../packages/sampling/semantic.js';
import {ResearchLexicon} from '../../packages/domain/research-lexicon.js';
import {HistoricalResearch} from '../../packages/domain/historical-research.js';
import {NativeSentimentEngine} from '../../packages/sentiment/engine.js';
import { Chat } from '../../packages/domain/chat.js';
import { Monitoring, isHistoricalArchiveEvidence } from '../../packages/domain/monitoring.js';
import { Notifications, notificationEvents } from '../../packages/domain/notifications.js';
import { Hotlists } from '../../packages/collectors/hotlists.js';
import { CollectionSchedule } from '../../packages/domain/collection.js';
import {DailyDigest,dailyDigestHtml} from '../../packages/domain/daily-digest.js';
import { Skills } from '../../packages/domain/skills.js';
import { Mcp } from '../../packages/domain/mcp.js';
import { DeepCrawl } from '../../packages/domain/deep-crawl.js';
import {PlatformAccounts,platformIds} from '../../packages/domain/platform-accounts.js';
import {PlatformBrowserLogin} from '../../packages/domain/platform-browser-login.js';
import {verifyVisualFiles} from '../../packages/domain/visual-evidence.js';
import { templates, renderReport, validateTemplateMarkdown } from '../../packages/reporting/report.js';
import { Runtime, Worker } from '../../packages/dsh-diting/runtime.js';
import { ReportPipeline } from '../../packages/reporting/pipeline.js';
import { reviseReport } from '../../packages/reporting/revision.js';
import { searchWeb } from '../../packages/collectors/search.js';
import { settings as loadSettings, type Settings } from './settings.js';

const text = (max = 20000) => z.string().trim().min(1).max(max);
export async function createApp(overrides: Partial<Settings> = {}, startWorker = true) {
  const settings = loadSettings(overrides), db = new Database(join(settings.dataDir, 'diting.sqlite3'), settings.root);
  const service = new Service(db, settings.defaultBudget), config = new Configuration(db, settings.dataDir), chat = new Chat(service, config), hotlists = new Hotlists(db);
  const localSentiment=new LocalSentiment(service,config),dailyDigest=new DailyDigest(db,()=>new Date(),config);
  const researchLexicon=new ResearchLexicon(config),historicalResearch=new HistoricalResearch(db,settings.dataDir);
  const platformLogin=new PlatformBrowserLogin(config,settings.dataDir);
  const runtime = new Runtime(service, config, settings), worker = new Worker(service, runtime, settings.workerInterval);
  const monitoring = new Monitoring(db, config, service, hotlists), notifications = new Notifications(db, config);
  const collection = new CollectionSchedule(config, hotlists,()=>new Date(),async result=>{
    const successful=result.snapshots.filter((s:Row)=>s.status==='succeeded').map((s:Row)=>s.id);
    if(successful.length){try{monitoring.evaluate(undefined,successful);}catch(error){db.event(null,'monitoring.followup_failed',{collection_run_id:result.run_id,message:error instanceof Error?error.message:'采集后信号评估失败'});}}
    if(!result.succeeded){db.event(null,'daily_digest.schedule_skipped',{collection_run_id:result.run_id,reason:'本轮全源采集没有成功快照，未生成日报'});return;}
    const digest=await dailyDigest.generatePreviousDayIfMissing({referenceTime:new Date(result.started_at)});
    db.event(null,digest?'daily_digest.schedule_finished':'daily_digest.schedule_skipped',{collection_run_id:result.run_id,report_date:new Date(Date.parse(result.started_at)-86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),digest_id:digest?.id||null,quality_status:digest?.quality_status||null,reason:digest?null:'该日已生成日报，或前一自然日没有成功的归档快照'});
  });
  const morningCollection = new CollectionSchedule(config,hotlists,()=>new Date(),async result=>{
    const successful=result.snapshots.filter((s:Row)=>s.status==='succeeded').map((s:Row)=>s.id);
    if(successful.length){try{monitoring.evaluate(undefined,successful);}catch(error){db.event(null,'monitoring.followup_failed',{collection_run_id:result.run_id,message:error instanceof Error?error.message:'早报采集后信号评估失败'});}}
    if(!result.succeeded){db.event(null,'daily_brief.schedule_skipped',{collection_run_id:result.run_id,reason:'本轮采集没有成功快照，未生成今日早报'});return;}
    const started=new Date(result.started_at),date=started.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
    const noon=new Date(`${date}T12:00:00+08:00`);
    const through=new Date(Math.min(Date.now(),noon.getTime()-1));
    const brief=await dailyDigest.generateMorningBriefIfMissing({referenceTime:started,through});
    db.event(null,brief?'daily_brief.schedule_finished':'daily_brief.schedule_skipped',{collection_run_id:result.run_id,report_date:new Date(result.started_at).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),digest_id:brief?.id||null,quality_status:brief?.quality_status||null,reason:brief?null:'今日早报已存在，或没有成功的当日上午快照'});
  },'collection.morning_schedule','collection.morning_active',30*60_000);
  if(!config.get('collection.morning_schedule',null))morningCollection.save({enabled:collection.get().enabled,interval_minutes:60,cron:'30 11 * * *',source_ids:collection.get().source_ids});
  const wakeReadyTasks=()=>{const capability=runtime.capabilities();db.transaction(()=>{for(const task of db.rows("SELECT id,block_reason FROM tasks WHERE status='waiting_runtime'")){if(capability.ready){db.run("UPDATE tasks SET status='queued',block_reason=NULL,revision=revision+1,updated_at=? WHERE id=?",now(),task.id);db.event(task.id,'runtime.recheck',{message:'执行配置已更新，自动重新排队检查'});}else if(task.block_reason!==capability.reason){db.run("UPDATE tasks SET block_reason=?,revision=revision+1,updated_at=? WHERE id=?",capability.reason,now(),task.id);db.event(task.id,'runtime.waiting_refresh',{message:'任务等待原因已按当前执行配置刷新',reason:capability.reason});}}});};
  wakeReadyTasks();
  const app = Fastify({ bodyLimit: 2_000_000, logger: false });
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host || ''; if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return reply.code(400).send({ detail: '仅接受本机 Host' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return reply.code(403).send({ detail: '仅接受同源写操作' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return reply.code(415).send({ detail: '写请求必须使用 application/json' });
    }
  });
  app.addHook('onSend', async (_req, reply) => { reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as any; const status = e instanceof z.ZodError ? 400 : e.statusCode || 400;
    reply.code(status).send({ detail: e instanceof z.ZodError ? e.issues.map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`).join('；') : e.message || '请求失败' });
  });
  const id = (req: any, key = 'id') => z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(req.params[key]);
  app.get('/api/health', async () => ({ status: 'ok', mode: 'typescript_control_plane', schema_version: 5, ui_revision:'v5-topic-research-20261024', runtime: runtime.capabilities() }));
  app.get('/api/integrations', async () => runtime.capabilities());
  app.get('/api/diagnostics/soak', async () => readSoakStatus(join(settings.dataDir,'qa','soak-latest.json')));
  app.get('/api/sessions', async () => db.rows('SELECT * FROM sessions ORDER BY created_at DESC').map(s => {const report=s.report_id?db.one('SELECT task_id FROM reports WHERE id=?',s.report_id):null;const allowed=new Set(report?db.rows('SELECT evidence_id FROM task_evidence WHERE task_id=?',report.task_id).map(e=>e.evidence_id):[]);return {...s,messages:db.rows('SELECT * FROM messages WHERE session_id=? ORDER BY rowid',s.id).map(m=>({...m,refs:[...new Set((m.content.match(/evidence_[a-f0-9]{32}/g)||[]) as string[])].filter(id=>allowed.has(id))}))};}));
  app.post('/api/sessions', async (req, reply) => { const b = z.object({ title: text(100).default('新的对话'), report_id: text(100).nullable().optional(), parent_task_id: text(100).nullable().optional() }).strict().parse(req.body); reply.code(201); return { id: service.session(b.title, b.report_id, b.parent_task_id) }; });
  app.post('/api/sessions/:id/messages', async req => { const b = z.object({ text: text(), request_id: z.string().min(8).max(100), parent_id: text(100).nullable().optional(), template_selection:z.object({mode:z.enum(['auto','user_import','co_created']),template_id:z.string().min(1).max(100).optional()}).strict().optional() }).strict().parse(req.body); return chat.send(id(req), b.text, b.request_id, b.parent_id || undefined,b.template_selection); });
  app.get('/api/tasks', async () => service.tasks());
  app.get('/api/tasks/:id', async req => { const tid = id(req); return { ...service.task(tid), events: db.rows('SELECT * FROM events WHERE task_id=? ORDER BY id', tid),
    evidence: db.rows('SELECT e.* FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? ORDER BY e.captured_at', tid), claims: db.rows('SELECT * FROM claims WHERE task_id=? ORDER BY created_at', tid),
    usage: [...db.rows('SELECT * FROM usage WHERE task_id=?', tid), ...db.rows('SELECT * FROM model_calls WHERE task_id=?', tid)], agents: db.rows('SELECT * FROM agent_runs WHERE task_id=? ORDER BY created_at', tid), reviews: db.rows('SELECT * FROM reviews WHERE task_id=?', tid), artifacts: db.rows('SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at', tid) }; });
  app.post('/api/tasks/:id/actions', async req => { const b = z.object({ action: z.enum(['pause', 'resume', 'cancel']), revision: z.number().int().positive() }).strict().parse(req.body); const result = service.action(id(req), b.action, b.revision); if (b.action !== 'resume') await worker.cancel(id(req)); return result; });
  app.post('/api/tasks/:id/supplements', async (req, reply) => { const b = z.object({ text: text() }).strict().parse(req.body); service.supplement(id(req), b.text); reply.code(201); return { saved: true }; });
  app.post('/api/tasks/:id/evidence', async (req, reply) => { const b = z.object({ url: z.string().url().refine(u => /^https?:/.test(u)), title: text(500), content: z.string().trim().min(5).max(1_000_000) }).strict().parse(req.body); reply.code(201); return { id: service.archive(id(req), b.url, b.title, b.content), origin: 'user_import' }; });
  app.get('/api/events', async req => db.rows('SELECT * FROM events WHERE id>? ORDER BY id LIMIT 500', z.coerce.number().int().nonnegative().default(0).parse((req.query as any).after_id)));
  app.get('/api/acquisitions', async () => db.rows('SELECT * FROM acquisitions ORDER BY created_at DESC LIMIT 1000'));
  app.get('/api/acquisitions/:id', async req => {
    const row = db.one('SELECT * FROM acquisitions WHERE id=?', id(req));
    if (!row) throw Object.assign(new Error('采集记录不存在'), { statusCode: 404 });
    const response = db.one('SELECT request_json,response_json,status_code FROM acquisition_responses WHERE acquisition_id=?', row.id);
    return { ...row, raw_response_saved: !!response, request: response ? JSON.parse(response.request_json) : null, response: response?.response_json ? JSON.parse(response.response_json) : null, http_status: response?.status_code ?? null };
  });
  app.get('/api/tasks/:id/report-draft', async req => new ReportPipeline(db, service, id(req)).preview());
  app.get('/api/tasks/:id/report-draft/:format', async (req, reply) => {
    const format = z.enum(['html', 'md']).parse((req.params as any).format), preview = new ReportPipeline(db, service, id(req)).preview();
    const rendered = renderReport(db, id(req), preview.document);
    if (format === 'md') return reply.type('text/markdown; charset=utf-8').send('> 未发布草稿：尚未通过最终报告校验。\n\n' + rendered.markdown);
    return reply.type('text/html; charset=utf-8').send(rendered.html.replace('<body>', '<body><aside style="padding:16px;background:#fff3d6;border:1px solid #d9a441;border-radius:10px"><b>未发布草稿</b>：这是已保存章节的过程预览，尚未通过最终报告校验。请结合任务中的校验问题核对，不能视为已验收结论。</aside>'));
  });
  app.get('/api/usage', async () => { const calls = [...db.rows('SELECT * FROM usage'), ...db.rows('SELECT * FROM model_calls')].sort((a, b) => a.created_at.localeCompare(b.created_at)); const costs = calls.filter(c => c.cost !== null); return { calls, known_input: calls.reduce((n, c) => n + (c.input_tokens || 0), 0), known_output: calls.reduce((n, c) => n + (c.output_tokens || 0), 0), known_cache: calls.reduce((n, c) => n + (c.cache_tokens || 0), 0), unknown_usage_calls: calls.filter(c => c.input_tokens === null || c.output_tokens === null).length, unknown_cost_calls: calls.filter(c => c.cost === null).length, known_cost: costs.length ? costs.reduce((n, c) => n + c.cost, 0) : null }; });
  app.get('/api/reports', async () => { const archived = new Set(config.get<string[]>('reports.archived', [])); return db.rows('SELECT * FROM reports ORDER BY created_at DESC').map(({ document_json, ...r }) => ({ ...r, archived: archived.has(r.id), document: JSON.parse(document_json) })); });
  app.post('/api/reports/:id/archive', async req => { const rid = id(req), b = z.object({ archived: z.boolean() }).strict().parse(req.body); if (!db.one('SELECT id FROM reports WHERE id=?', rid)) throw Object.assign(new Error('报告不存在'), { statusCode: 404 }); const current = config.get<string[]>('reports.archived', []), next = new Set(current); b.archived ? next.add(rid) : next.delete(rid); config.set('reports.archived', [...next]); return { saved: true, archived: b.archived }; });
  app.post('/api/reports/:id/revisions', async req => {
    const body = z.object({ document: z.record(z.any()) }).strict().parse(req.body);
    return reviseReport(db, service, id(req), body.document, settings.dataDir);
  });
  app.get('/api/reports/:id/export/:format', async (req, reply) => {
    const r = db.one('SELECT * FROM reports WHERE id=?', id(req)); if (!r) return reply.code(404).send({ detail: '报告不存在' });
    const format = z.enum(['html', 'md', 'pdf']).parse((req.params as any).format), document = JSON.parse(r.document_json);
    if (format !== 'pdf') { const output = renderReport(db, r.task_id, document); reply.type(format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8'); return format === 'html' ? output.html : output.markdown; }
    const path = document.exports?.dir ? resolve(document.exports.dir, 'report.pdf') : '';
    if (!path.startsWith(resolve(settings.dataDir, 'exports') + sep) || !existsSync(path)) return reply.code(409).send({ detail: '该报告版本尚无可用 PDF 文件' });
    return reply.type('application/pdf').send(readFileSync(path));
  });
  app.get('/api/notifications', async () => db.rows('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 500'));
  app.get('/api/hotlists/sources', async () => hotlists.status());
  app.get('/api/collection/schedule', async () => collection.get());
  app.put('/api/collection/schedule', async req => db.transaction(()=>{
    const daily=collection.save(req.body),morning=morningCollection.get();
    morningCollection.save({enabled:daily.enabled,interval_minutes:morning.interval_minutes,cron:morning.cron,source_ids:daily.source_ids});
    return daily;
  }));
  app.get('/api/collection/morning-schedule', async () => morningCollection.get());
  app.get('/api/hotlists/snapshots/:id', async req => {const snapshot=db.one('SELECT * FROM hotlist_snapshots WHERE id=?',id(req)); if(!snapshot)throw Object.assign(new Error('快照不存在'),{statusCode:404});return {...snapshot,items:db.rows('SELECT * FROM hotlist_items WHERE snapshot_id=? ORDER BY rank',snapshot.id),response:db.one('SELECT * FROM hotlist_responses WHERE snapshot_id=?',snapshot.id)};});
  app.get('/api/tasks/:id/evidence/:evidence', async req => {const evidence=db.one('SELECT e.* FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? AND e.id=?',id(req),id(req,'evidence'));if(!evidence)throw Object.assign(new Error('证据不属于本任务'),{statusCode:404});return evidence;});
  app.get('/api/tasks/:id/visual',async req=>({assets:db.rows('SELECT * FROM visual_assets WHERE task_id=? ORDER BY created_at',id(req)).map(({frames_json,...r})=>({...r,frames:JSON.parse(frames_json)})),observations:db.rows('SELECT o.*,c.model,c.input_tokens,c.output_tokens,c.cache_tokens,c.cost FROM visual_observations o JOIN model_calls c ON c.id=o.call_id WHERE o.task_id=? ORDER BY o.created_at',id(req)).map(({observation_json,...r})=>({...r,observation:JSON.parse(observation_json)}))}));
  app.get('/api/tasks/:id/visual/:asset/file',async(req,reply)=>{const a=db.one('SELECT * FROM visual_assets WHERE task_id=? AND id=?',id(req),id(req,'asset'));if(!a)return reply.code(404).send({detail:'视觉素材不属于本任务'});verifyVisualFiles(db,a);const ext=a.media_type==='image/png'?'png':a.media_type==='image/jpeg'?'jpg':a.media_type==='video/mp4'?'mp4':'webm';return reply.header('X-Content-Type-Options','nosniff').header('Content-Disposition','inline; filename="'+a.content_hash+'.'+ext+'"').type(a.media_type).send(readFileSync(join(settings.dataDir,'media',a.content_hash+'.'+ext)));});
  app.get('/api/tasks/:id/visual/:asset/frame/:frame',async(req,reply)=>{const a=db.one('SELECT * FROM visual_assets WHERE task_id=? AND id=?',id(req),id(req,'asset'));if(!a)return reply.code(404).send({detail:'视觉素材不属于本任务'});verifyVisualFiles(db,a);const index=z.coerce.number().int().min(0).max(5).parse((req.params as any).frame),frame=JSON.parse(a.frames_json)[index];if(!frame)return reply.code(404).send({detail:'输入帧不存在'});return reply.header('X-Content-Type-Options','nosniff').type('image/jpeg').send(readFileSync(join(settings.dataDir,'media',frame.hash+'.jpg')));});
  app.get('/api/collectors/platforms',async()=>new DeepCrawl(service).directory(config));
  app.get('/api/tasks/:id/platform-data',async req=>{const tid=id(req);service.rawTask(tid);const q=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),offset:z.coerce.number().int().min(0).max(100000).default(0),platform:z.enum(['weibo','bilibili']).optional(),kind:z.enum(['post','comment','video_metadata']).optional()}).parse(req.query),where='c.task_id=?'+(q.platform?' AND c.platform=?':'')+(q.kind?' AND c.record_type=?':''),params=[tid,...q.platform?[q.platform]:[],...q.kind?[q.kind]:[]];return {batches:new DeepCrawl(service).runs(tid),limit:q.limit,offset:q.offset,total_records:db.one('SELECT COUNT(*) n FROM content_records c WHERE '+where,...params)!.n,counts:db.rows('SELECT platform,record_type,COUNT(*) count FROM content_records WHERE task_id=? GROUP BY platform,record_type',tid),records:db.rows('SELECT c.id,c.platform,c.record_id,c.record_type,c.url,c.title,c.text,c.author,c.published_at,c.metrics_json,c.evidence_id,c.captured_at,p.parent_record_id,p.query FROM content_records c LEFT JOIN content_provenance p ON p.content_id=c.id WHERE '+where+' ORDER BY c.captured_at DESC,c.id LIMIT ? OFFSET ?',...params,q.limit,q.offset).map(({metrics_json,...r})=>({...r,metrics:JSON.parse(metrics_json)}))};});
  app.get('/api/tasks/:id/platform-data/:record',async req=>{const row=db.one('SELECT c.*,p.parent_record_id,p.page_url,p.query,p.batch_id FROM content_records c LEFT JOIN content_provenance p ON p.content_id=c.id WHERE c.task_id=? AND c.id=?',id(req),id(req,'record'));if(!row)throw Object.assign(new Error('平台样本不属于本任务'),{statusCode:404});const {raw_json,metrics_json,...record}=row;return {...record,raw:JSON.parse(raw_json),metrics:JSON.parse(metrics_json)};});
  app.get('/api/tasks/:id/crawl-batches/:batch',async req=>{const batch=db.one('SELECT id,task_id,approval_id,platform,scope_json,status,created_at,updated_at FROM crawl_batches WHERE task_id=? AND id=?',id(req),id(req,'batch'));if(!batch)throw Object.assign(new Error('采集批次不属于本任务'),{statusCode:404});return {...batch,scope:JSON.parse(batch.scope_json),pages:db.rows('SELECT id,operation,url,status,error,attempts,created_at,updated_at,payload_json FROM crawl_pages WHERE batch_id=? ORDER BY created_at,id',batch.id).map(({payload_json,...p})=>({...p,response_hash:payload_json?hash(payload_json):null,response_bytes:payload_json?Buffer.byteLength(payload_json):0}))};});
  app.get('/api/tasks/:id/crawl-batches/:batch/pages/:page',async req=>{const page=db.one('SELECT p.* FROM crawl_pages p JOIN crawl_batches b ON b.id=p.batch_id WHERE b.task_id=? AND b.id=? AND p.id=?',id(req),id(req,'batch'),id(req,'page'));if(!page)throw Object.assign(new Error('原始页面不属于本任务或批次'),{statusCode:404});const {payload_json,...metadata}=page;return {...metadata,response_hash:payload_json?hash(payload_json):null,response:payload_json?JSON.parse(payload_json):null};});
  app.get('/api/tasks/:id/crawl-batches/:batch/pages/:page/export',async(req,reply)=>{const page=db.one('SELECT p.id,p.payload_json FROM crawl_pages p JOIN crawl_batches b ON b.id=p.batch_id WHERE b.task_id=? AND b.id=? AND p.id=?',id(req),id(req,'batch'),id(req,'page'));if(!page)throw Object.assign(new Error('原始页面不属于本任务或批次'),{statusCode:404});if(!page.payload_json)return reply.code(409).send({detail:'本次请求未取得可下载的原始响应'});return reply.type('application/json; charset=utf-8').header('Content-Disposition',`attachment; filename="${page.id}.json"`).send(page.payload_json);});
  app.post('/api/crawl-runs/:id/retry-approval',async req=>{z.object({}).strict().parse(req.body);return new DeepCrawl(service).retryApproval(id(req));});
  app.get('/api/reports/:id/data/:format', async(req,reply)=>{const report=db.one('SELECT * FROM reports WHERE id=?',id(req));if(!report)throw Object.assign(new Error('报告不存在'),{statusCode:404});const document=JSON.parse(report.document_json),format=z.enum(['json','csv']).parse((req.params as any).format),tables=document.tables||[];reply.header('Content-Disposition',`attachment; filename="report-data.${format}"`);if(format==='json')return {report_id:report.id,input_hash:report.input_hash,tables,limitations:document.limitations};const cell=(v:unknown)=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';return reply.type('text/csv; charset=utf-8').send('\uFEFF'+tables.map((t:Row)=>[[t.title,t.metric],t.columns,...t.rows].map(r=>r.map(cell).join(',')).join('\r\n')).join('\r\n\r\n'));});
  app.get('/api/hotlists/latest', async req => hotlists.latest(z.coerce.number().int().min(1).max(500).default(100).parse((req.query as any).limit)));
  app.post('/api/hotlists/collect', async req => { const b = z.object({ provider: z.enum(['newsnow', 'dailyhot', 'both']).default('both'), source_ids: z.union([z.array(text(80)).min(1).max(30), z.record(z.array(text(80)).min(1).max(30))]).optional() }).strict().parse(req.body); const result = await hotlists.collect(b.provider, b.source_ids); return { ...result, signals: monitoring.evaluate(undefined,result.snapshots.filter((s:Row)=>s.status==='succeeded').map((s:Row)=>s.id)) }; });
  app.get('/api/config/llm', async () => config.publicRoutes());
  app.put('/api/config/llm/:id', async req => { if ((req.body as any)?.id !== id(req)) throw new Error('模型槽编号不一致'); const result=config.saveRoute(req.body);wakeReadyTasks();return result; });
  app.post('/api/config/llm/seed-research-from-chat', async () => config.seedResearchRoutesFromChat());
  app.get('/api/config/services', async () => config.publicServices());
  app.post('/api/config/services/:id/check', async req => {
    const provider = z.enum(['tavily', 'bocha', 'anspire']).parse(id(req)); z.object({}).strict().parse(req.body);
    const result = await searchWeb(config, null, '人工智能 官方公告', AbortSignal.timeout(35000), fetch, undefined, { providers: [provider], force: true });
    return { ...result.sources[0], checked_at: now(), evidence: false };
  });
  app.get('/api/config/platform-sessions',async()=>new PlatformAccounts(config).public());
  app.get('/api/config/platform-sessions/login',async()=>platformLogin.list());
  app.post('/api/config/platform-sessions/:id/login',async req=>{z.object({}).strict().parse(req.body);return platformLogin.start(z.enum(platformIds).parse(id(req)));});
  app.get('/api/config/platform-sessions/login/:loginId',async req=>platformLogin.get(id(req,'loginId')));
  app.put('/api/config/platform-sessions/:id',async req=>new PlatformAccounts(config).save(z.enum(platformIds).parse(id(req)),req.body));
  app.post('/api/config/platform-sessions/:id/check',async req=>{z.object({}).strict().parse(req.body);return new PlatformAccounts(config).probe(z.enum(platformIds).parse(id(req)),AbortSignal.timeout(25000));});
  app.post('/api/config/platform-sessions/:id/revoke',async req=>{z.object({}).strict().parse(req.body);return new PlatformAccounts(config).revoke(z.enum(platformIds).parse(id(req)));});
  app.post('/api/tasks/:id/platform-sessions/:platform/refresh',async req=>{const b=z.object({revision:z.number().int().positive()}).strict().parse(req.body);return new PlatformAccounts(config).refreshTask(service,id(req),z.enum(platformIds).parse(id(req,'platform')),b.revision);});
  app.put('/api/config/services/:id', async req => {
    const key = z.enum(['tavily', 'bocha', 'anspire', 'firecrawl', 'feishu', 'wecom']).parse(id(req));
    const b = z.object({ base_url: z.string().url(), enabled: z.boolean(), api_key: z.string().max(16000).optional() }).strict().parse(req.body);
    if (!/^https?:/.test(b.base_url)) throw new Error('服务地址只允许 HTTP/HTTPS');
    config.db.transaction(() => {
      if (['feishu', 'wecom'].includes(key)) {
        const webhook = b.api_key?.trim() || b.base_url;
        if (/^https:\/\//.test(webhook) && new URL(webhook).pathname.length > 20) config.putSecret(`service.${key}`, webhook);
        config.set(`service.${key}`, { base_url: new URL(b.base_url).origin, enabled: b.enabled });
      } else { if (b.api_key?.trim()) config.putSecret(`service.${key}`, b.api_key.trim()); config.set(`service.${key}`, { base_url: b.base_url, enabled: b.enabled }); }
      config.set(`service.health.${key}`,{status:'not_tested'});
    }); return config.publicServices().find(s => s.id === key);
  });
  app.post('/api/config/services/:id/test', async req => { const key = z.enum(['feishu', 'wecom']).parse(id(req)); z.object({}).strict().parse(req.body); return notifications.test(key); });
  app.get('/api/config/runtime', async () => config.get('runtime.policy', { enabled: settings.runtimeEnabled, max_calls: 120, max_minutes: 45 }));
  app.put('/api/config/runtime', async req => { const policy = z.object({ enabled: z.boolean(), max_calls: z.number().int().min(5).max(2000), max_minutes: z.number().int().min(1).max(120) }).strict().parse(req.body); config.set('runtime.policy', policy);wakeReadyTasks();return policy; });
  app.get('/api/subscriptions', async () => config.get('notification.subscription', { enabled: false, channels: [], events: ['daily_digest.completed','signal.high_priority','approval.required'], quiet: true, public_base_url:'' }));
  app.put('/api/subscriptions', async req => { const b = z.object({ enabled: z.boolean(), channels: z.array(z.enum(['feishu', 'wecom'])).max(2), events: z.array(z.enum(notificationEvents)).max(notificationEvents.length), quiet: z.boolean(), public_base_url:z.string().max(500).default('') }).strict().parse(req.body);if(b.public_base_url){const u=new URL(b.public_base_url),host=u.hostname.toLocaleLowerCase();if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||host==='localhost'||host==='::1'||host==='127.0.0.1'||host.endsWith('.localhost'))throw new Error('请填写可被企微客户端访问的平台基础地址；不要填写 localhost');} const value = { ...b, public_base_url:b.public_base_url.replace(/\/+$/,''), starts_at: now() }; config.set('notification.subscription', value);config.set('notification.public_base_url',value.public_base_url); return value; });
  app.get('/api/config/extensions/:id', async req => { const key = z.enum(['mcp', 'skills', 'tools']).parse(id(req)); if(key==='skills')return new Skills(config).status();if(key==='mcp')return new Mcp(config).status();return { items: config.get(key, []), status: 'saved_configuration_only', note: '保存不会执行或挂载第三方程序；须逐项核对权限与启动配置' }; });
  app.put('/api/config/extensions/:id', async req => { const key = z.enum(['mcp', 'skills', 'tools']).parse(id(req)); if(key==='skills')return {saved:true,...new Skills(config).save(req.body)};if(key==='mcp')return {saved:true,...new Mcp(config).save(req.body)};const b = z.object({ items: z.array(z.object({ id: text(100), name: text(100), description: z.string().max(4000).default(''), enabled: z.boolean().default(false) }).strict()).max(100) }).strict().parse(req.body); config.set(key, b.items); return { saved: true, runtime_mounted: false }; });
  app.get('/api/templates', async () => [...templates, ...config.get<Row[]>('templates.custom', [])]);
  app.post('/api/templates', async req => { const b = z.object({ name: text(100), markdown: text(50000), origin:z.enum(['user_import','co_created']).default('user_import'),session_id:z.string().optional() }).strict().parse(req.body); if(b.session_id&&!db.one('SELECT id FROM sessions WHERE id=?',b.session_id))throw new Error('共创会话不存在'); const entry = validateTemplateMarkdown(b.name, b.markdown,b.origin,b.session_id); config.set('templates.custom', [...config.get<Row[]>('templates.custom', []).filter(t => t.id !== entry.id), entry]); return entry; });
  const signalRows=(limit?:number)=>db.rows(`SELECT s.*,m.created_at monitor_created_at FROM signals s LEFT JOIN monitors m ON m.id=s.monitor_id ORDER BY s.created_at DESC${limit?` LIMIT ${Math.max(1,Math.floor(limit))}`:''}`).map((signal:Row)=>{let evidence:Row={};try{evidence=JSON.parse(signal.evidence_json||'{}');}catch{}return{...signal,historical_archive:isHistoricalArchiveEvidence(evidence,signal.monitor_created_at)};});
  app.get('/api/dashboard', async () => ({ events: db.rows('SELECT * FROM events ORDER BY id DESC LIMIT 10'), trends: db.rows("SELECT provider,source_id,item_count,observed_at FROM hotlist_snapshots WHERE status='succeeded' ORDER BY created_at DESC LIMIT 100").reverse(), signals: signalRows(10) }));
  app.get('/api/daily-digests',async req=>{const q=req.query as any;return dailyDigest.list(Number(q.limit)||30);});
  app.get('/api/daily-digests/:date',async req=>{const edition=z.enum(['daily','morning']).default('daily').parse((req.query as any).edition);return dailyDigest.getEdition((req.params as any).date,edition)||{detail:'该日期尚无此版日报'};});
  app.post('/api/daily-digests/:date/generate',async req=>{const b=z.object({preview:z.boolean().default(false),acceptance_test:z.boolean().default(false),additional_page_fetch_approval:z.union([z.literal(6),z.literal(12),z.literal(16),z.literal(20)]).optional(),max_model_calls:z.literal(2).optional()}).strict().parse(req.body||{});const date=(req.params as any).date;if((b.additional_page_fetch_approval===12||b.additional_page_fetch_approval===20)&&date!=='2026-10-22')throw new Error('该追加来源页抓取审批仅适用于2026-10-22');if(b.additional_page_fetch_approval===20&&(!b.preview||!b.acceptance_test))throw new Error('追加至30次来源页抓取仅限本轮不推送的验收预览');if(b.additional_page_fetch_approval===16&&(date!=='2026-10-23'||!b.preview||!b.acceptance_test||b.max_model_calls!==2))throw new Error('追加至26次来源页抓取仅限2026-10-23本轮最多两次模型调用的不推送预览');return dailyDigest.generateNarrated(date,{notify:!b.preview,acceptanceTest:b.acceptance_test,additionalPageFetches:b.additional_page_fetch_approval||0,disableCardRepair:b.max_model_calls===2});});
  app.get('/api/daily-digests/:date/export/html',async(req,reply)=>{const edition=z.enum(['daily','morning']).default('daily').parse((req.query as any).edition),d=dailyDigest.getEdition((req.params as any).date,edition);if(!d)return reply.code(404).send({detail:'该日期尚无此版日报'});return reply.type('text/html; charset=utf-8').send(dailyDigestHtml(d));});
  app.get('/api/approvals', async () => db.rows('SELECT * FROM approvals ORDER BY created_at DESC'));
  app.post('/api/approvals/:id/decision', async req => { const b = z.object({ approved: z.boolean() }).strict().parse(req.body); const aid = id(req); db.transaction(() => {
    const row = db.one('SELECT * FROM approvals WHERE id=?', aid); if (!row) throw Object.assign(new Error('审批不存在'), { statusCode: 404 }); if (row.status !== 'pending') throw Object.assign(new Error('此审批已经处理'), { statusCode: 409 });
    db.run('UPDATE approvals SET status=?,decided_at=? WHERE id=?', b.approved ? 'approved' : 'rejected', now(), aid);
    if (row.task_id) { const task = service.rawTask(row.task_id); if (task.status === 'waiting_approval') db.run("UPDATE tasks SET status='queued',revision=revision+1,updated_at=? WHERE id=?", now(), row.task_id); db.event(row.task_id, 'approval.decided', { message: b.approved ? '用户批准了列明范围' : '用户拒绝了列明范围', approval_id: aid }); }
  }); return { saved: true }; });
  app.get('/api/monitors', async () => monitoring.list());
  app.post('/api/monitors', async req => monitoring.save(req.body));
  app.put('/api/monitors/:id', async req => monitoring.save(req.body, id(req)));
  app.get('/api/signals', async () => signalRows());
  app.post('/api/signals/:id/read',async req=>{const signal=db.one('SELECT id FROM signals WHERE id=?',id(req));if(!signal)throw Object.assign(new Error('信号不存在'),{statusCode:404});db.run('UPDATE signals SET read_at=COALESCE(read_at,?) WHERE id=?',now(),signal.id);return {saved:true};});
  app.post('/api/signals/read-all',async()=>{db.run('UPDATE signals SET read_at=COALESCE(read_at,?) WHERE read_at IS NULL',now());return {saved:true};});
  app.post('/api/signals/:id/research',async req=>db.transaction(()=>{const signal=db.one('SELECT * FROM signals WHERE id=?',id(req));if(!signal)throw Object.assign(new Error('信号不存在'),{statusCode:404});if(signal.task_id)return {task_id:signal.task_id,reused:true};const taskId=service.createTask('调查'+signal.title+'，核实这条监测线索并形成完整报告',null,null,'chat');db.run('UPDATE signals SET task_id=? WHERE id=?',taskId,signal.id);db.event(taskId,'signal.linked',{message:'由用户确认监测信号建立研究',signal_id:signal.id});return {task_id:taskId,reused:false};}));
  app.get('/api/config/sentiment',async()=>localSentiment.status());
  app.get('/api/config/sampling',async()=>semanticStatus(settings.dataDir));
  app.get('/api/config/lexicon',async()=>researchLexicon.status());
  app.put('/api/config/lexicon',async req=>researchLexicon.save(req.body));
  app.get('/api/history/similar',async req=>{const q=z.object({query:text(500),limit:z.coerce.number().int().min(1).max(10).default(5)}).strict().parse(req.query);return historicalResearch.lookup(q.query,undefined,q.limit);});
  app.put('/api/config/sentiment',async req=>{const value=z.object({enabled:z.boolean(),min_confidence:z.number().min(0).max(1).default(0.5)}).strict().parse(req.body);if(value.enabled&&!localSentiment.status().installed)throw new Error('独立情感模型文件尚未安装');config.set('sentiment.local',value);return localSentiment.status();});
  app.post('/api/config/sentiment/test',async req=>{z.object({}).strict().parse(req.body);const engine=new NativeSentimentEngine(localSentiment.directory),texts=['这个产品很好，我很满意！','太差了，非常失望。','该公司今天发布公告。'];return {model_id:'tabularisai/multilingual-sentiment-analysis',cloud_tokens:0,results:(await engine.predict(texts)).map((result,i)=>({text:texts[i],...result}))};});
  app.get('/api/agents', async () => runtime.roles());
  app.get('/', async (_req, reply) => {
    let html = readFileSync(join(settings.root, 'prototypes/diting-v5/dist/index.html'), 'utf8');
    html = html.replace('<head>', '<head><base href="/prototype/"><style>body:not([data-live-ready]) main.main,body:not([data-live-ready]) aside{visibility:hidden}</style>').replace('<body>', '<body><div id="live-loading-mask" role="status" style="position:fixed;inset:0;z-index:999999;background:#f5f6fb;display:grid;place-items:center;color:#756697;font:15px system-ui">正在连接 TypeScript 持久任务服务…</div>');
    return reply.type('text/html; charset=utf-8').send(html.replace('</body>', '<script src="/app/live-bridge.js"></script><script src="/app/native-controls.js"></script><script src="/app/product-controls.js"></script><script src="/app/skill-controls.js"></script><script src="/app/mcp-controls.js"></script><script src="/app/platform-controls.js"></script><script src="/app/platform-account-controls.js"></script><script src="/app/research-recovery.js"></script><script src="/app/research-library-controls.js"></script><script src="/app/tool-controls.js"></script><script src="/app/notification-policy.js"></script></body>'));
  });
  await app.register(fastifyStatic, { root: join(settings.root, 'web'), prefix: '/app/', decorateReply: false });
  await app.register(fastifyStatic, { root: join(settings.root, 'prototypes/diting-v5/dist'), prefix: '/prototype/', decorateReply: false });
  app.addHook('onClose', async () => { await collection.stop(); await morningCollection.stop(); await monitoring.stop(); await notifications.stop(); await worker.stop(); await platformLogin.closeAll(); db.close(); });
  if (startWorker) { worker.start(); monitoring.start(); notifications.start(); collection.start(); morningCollection.start(); }
  return { app, db, service, config, runtime, hotlists, worker, monitoring, notifications, platformLogin };
}
