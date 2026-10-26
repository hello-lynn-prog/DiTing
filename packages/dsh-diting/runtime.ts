import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { Settings } from '../../apps/server/settings.js';
import { Service } from '../domain/service.js';
import { Configuration } from '../domain/configuration.js';
import { encode, hash, now, uid, type Row } from '../domain/db.js';
import {LocalSentiment} from '../sentiment/service.js';
import {ResearchLexicon} from '../domain/research-lexicon.js';
import { roles, rootPersona } from './roles.js';
import { Skills } from '../domain/skills.js';
import { Mcp, mcpName } from '../domain/mcp.js';
import { ReportPipeline } from '../reporting/pipeline.js';
import { reasoningProfile, roleOutputLimit } from './model-policy.js';

export function runtimeStopReason(input:{budgetMessage?:string|null;modelFailure?:string|null;turnError?:string|null}){
  if(input.budgetMessage)return `研究预算已用尽：${input.budgetMessage}。已停止继续调用并保留检查点。`;
  if(input.modelFailure)return '本轮模型调用失败：'+input.modelFailure;
  if(input.turnError)return 'dsh 本轮执行异常：'+input.turnError.slice(0,500);
  return 'Agent 本轮已结束，报告尚未交付。已暂停并保留检查点，请查看具体校验错误后继续。';
}

export class Runtime {
  private active = new Map<string, any>();
  constructor(readonly service: Service, readonly config: Configuration, readonly settings: Settings) {}
  roles() { const skills=new Skills(this.config).freeze(),mcp=new Mcp(this.config).freeze();return Object.entries(roles).map(([id, r]) => {const granted=skills.filter(s=>s.roles.includes(id as any)),external=mcp.flatMap(s=>s.tools.filter(t=>t.roles.includes(id as any)).map(t=>mcpName(s.id,t.name)));return { id, name: r.name, tools: [...r.tools,...(granted.length?['skill']:[]),...external],skills:granted.map(s=>({id:s.id,name:s.name,version:s.version})), route: r.route, kind: 'dsh_native_subagent', configured: !!this.config.route(r.route) };}); }
  capabilities() {
    const sdk = join(this.settings.dshRoot, 'packages/sdk/client/lib/index.js'), plugin = join(this.settings.root, 'dist/packages/dsh-diting/plugin.js');
    const missing = [...new Set(['planner', ...Object.values(roles).map(r => r.route)])].filter(r => !this.config.route(r));
    const missingRates = [...new Set(Object.values(roles).map(r => r.route))].filter(r => this.config.route(r) && !this.config.route(r)?.rates);
    const enabled = this.config.get<Row>('runtime.policy', {}).enabled ?? this.settings.runtimeEnabled;
    const ready = existsSync(sdk) && existsSync(plugin) && !missing.length && !missingRates.length && enabled;
    return { dsh: { source_found: existsSync(this.settings.dshRoot), sdk_installed: existsSync(sdk), profile_implemented: existsSync(plugin), certified_executor: false },
      sentiment:new LocalSentiment(this.service,this.config).status(),
      bettafish: { migrated: false, implementation: 'diting-independent-domain-logic', templates_found: 6 },
      ready, roles: this.roles(), missing_routes: missing, missing_rates: missingRates, reason: ready ? '执行条件具备；真实报告质量与供应商调用仍需实际运行验证' : `等待执行条件：${!existsSync(sdk) ? '本机 dsh 构建；' : ''}${!existsSync(plugin) ? 'npm run build；' : ''}${missing.length ? '配置并启用模型槽 ' + missing.join('、') + '；' : ''}${missingRates.length ? '填写研究槽费率以执行预算预留；' : ''}${!enabled ? '在系统配置启用研究执行；' : ''}` };
  }
  async launch(task: Row, onNotification?: (value: Row) => void) {
    const { settings, config } = this, taskId = task.id, rootSession = `${taskId}_${uid('root')}`, workspace = join(settings.dataDir, 'workspaces', taskId), home = join(settings.dataDir, 'dsh', taskId);
    const taskConfig = JSON.parse(task.config_json);
    if (!taskConfig.model_routes) {
      taskConfig.model_routes = Object.fromEntries(['planner', 'insight', 'media', 'query', 'forum', 'report', 'keyword'].map(id => [id, config.route(id)]));
      this.service.db.transaction(() => { this.service.requireRun(taskId, task.lease_owner); this.service.db.run('UPDATE tasks SET config_json=?,revision=revision+1 WHERE id=?', encode(taskConfig), taskId); this.service.db.event(taskId, 'config.frozen', { message: '已冻结本任务的模型配置与凭据引用；后续配置变更不覆盖本任务' }); });
    }
    if (!Object.hasOwn(taskConfig.model_routes, 'keyword')) {
      taskConfig.model_routes.keyword = config.route('keyword');
      this.service.db.run('UPDATE tasks SET config_json=?,revision=revision+1 WHERE id=?', encode(taskConfig), taskId);
      this.service.db.event(taskId, 'config.keyword_frozen', { message: taskConfig.model_routes.keyword ? '已冻结本任务的关键词优化模型配置' : '本任务未配置关键词优化模型，将使用可审计的本地回退' });
    }
    if(!Array.isArray(taskConfig.skills)){
      taskConfig.skills=new Skills(config).freeze();
      this.service.db.transaction(()=>{this.service.requireRun(taskId,task.lease_owner);this.service.db.run('UPDATE tasks SET config_json=?,revision=revision+1 WHERE id=?',encode(taskConfig),taskId);this.service.db.event(taskId,'skills.frozen',{message:'已冻结本任务启用的技能正文、角色与版本',skills:taskConfig.skills.map((s:Row)=>({id:s.id,version:s.version,roles:s.roles}))});});
    }
    if(!Array.isArray(taskConfig.mcp)){
      taskConfig.mcp=new Mcp(config).freeze();
      this.service.db.transaction(()=>{this.service.requireRun(taskId,task.lease_owner);this.service.db.run('UPDATE tasks SET config_json=?,revision=revision+1 WHERE id=?',encode(taskConfig),taskId);this.service.db.event(taskId,'mcp.frozen',{message:'已冻结本任务 MCP 服务、精确工具授权与凭据引用',servers:taskConfig.mcp.map((s:Row)=>({id:s.id,version:s.version,tools:s.tools}))});});
    }
    if(!taskConfig.sentiment){taskConfig.sentiment=new LocalSentiment(this.service,config).freeze();this.service.db.run('UPDATE tasks SET config_json=? WHERE id=?',encode(taskConfig),taskId);}
    if(!taskConfig.lexicon){taskConfig.lexicon=new ResearchLexicon(config).freeze();this.service.db.run('UPDATE tasks SET config_json=? WHERE id=?',encode(taskConfig),taskId);this.service.db.event(taskId,'lexicon.frozen',{message:'冻结本任务检索词库版本；只用于召回，不证明词义或事实',version:taskConfig.lexicon.version});}
    mkdirSync(workspace, { recursive: true }); const profile = join(home, 'profiles', 'diting'); mkdirSync(profile, { recursive: true });
    const providers: Row = {}, env: NodeJS.ProcessEnv = {};
    // Only runtime essentials and explicitly configured credentials reach the child.
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key];
    for(const server of taskConfig.mcp)if(server.key_ref)env['DITING_MCP_SECRET_'+hash(server.id).slice(0,12)]=config.secret(server.key_ref);
    for (const routeId of ['planner', 'insight', 'media', 'query', 'forum', 'report']) {
      const route = taskConfig.model_routes[routeId]; if (!route) throw new Error(`模型槽 ${routeId} 未配置`);
      const envKey = `DITING_MODEL_${routeId.toUpperCase()}_KEY`; env[envKey] = config.secret(route.key_ref);
      const reasoning = reasoningProfile(route);
      providers[`diting-${routeId}`] = { api: route.protocol || 'openai-completions', apiKeyEnv: envKey, baseURL: route.base_url, ...reasoning.provider,
        // GLM-5.3-Flash supports a 1M context window. The previous 64K
        // declaration caused dsh to compact/terminate long research runs far
        // below the model's documented capacity.
        streamIdleTimeoutMs: 120000,
        retryPolicy: { mode: 'normal', maxRetries: 1 }, models: [{ id: route.model, contextWindow: 1_000_000, maxTokens: roleOutputLimit(routeId,route.max_tokens), ...reasoning.model }] };
    }
    const plugin = join(settings.root, 'dist/packages/dsh-diting/plugin.js');
    // A tiny local re-export keeps the plugin a normal profile-local ESM module.
    writeFileSync(join(profile, 'diting-plugin.mjs'), `export * from ${JSON.stringify(pathToFileURL(plugin).href)};\n`);
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } } }, null, 2));
    const patch = [
      { id: 'system-prompt', config: { personaPrefix: rootPersona, personaSuffix: '使用中文。工作目录：{{cwd}}。' } },
      { id: 'tools', config: { mode: 'native' } },
      // Domain material packets and verifier quotes must reach the model intact.
      // Base's 12,500-token spill preview points to filesystem tools these roles
      // intentionally do not possess. Keep bounded readers and normal guards;
      // only enlarge the model-visible retention allowance for this profile.
      { id: 'spill-policy', config: { maxInlineTokens: 131072 } },
      { id: 'sdk-jsonrpc-server', config: { maxTokensAsSuccess: false } },
      { id: 'session-log-deepseek', disabled: true }, { id: 'plugin-package-inventory-deepseek', disabled: true },
      { id: 'skill-filesystem', disabled: true }, { id: 'skill-office', disabled: true },
      { id: 'llm-pi-ai', config: { providers } },
      { insert: [{ id: 'diting-domain', name: './diting-plugin.mjs' }] },
    ];
    writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2));
    Object.assign(env, { DSH_HOME: home, DITING_ROOT: settings.root, DITING_DSH_ROOT: settings.dshRoot, DITING_DATA_DIR: settings.dataDir,
      DITING_TASK_ID: taskId, DITING_ROOT_SESSION: rootSession, DITING_LEASE_TOKEN: task.lease_owner });
    const { DeepSeekHarness } = await import(pathToFileURL(join(settings.dshRoot, 'packages/sdk/client/lib/index.js')).href);
    this.service.requireRun(taskId,task.lease_owner);
    const route = taskConfig.model_routes.planner,maxMinutes=config.get<Row>('runtime.policy', {}).max_minutes || 45;
    const harness = new DeepSeekHarness({ profile: 'diting', cwd: workspace, processCwd: settings.dshRoot, dshHome: home, env,
      provider: 'diting-planner', model: route.model, maxTokens: roleOutputLimit('main',route.max_tokens), ...reasoningProfile(route).provider?{reasoningEffort:'low'}:{}, initializeTimeoutMs: 45000, requestTimeoutMs: (maxMinutes+1) * 60 * 1000 });
    this.active.set(taskId, harness);
    this.service.db.event(taskId,'runtime.started',{message:'已启动本轮独立 dsh 会话；从任务已归档产物继续研究，历史子会话保留',root_session_id:rootSession,attempt:task.attempt});
    const startedEvent=this.service.db.one('SELECT MAX(id) id FROM events WHERE task_id=?',taskId)!.id;
    let timer: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(() => { const checkpoint=new ReportPipeline(this.service.db,this.service,taskId).progress();this.service.waitRuntime(taskId, task.lease_owner, `本轮执行达到 ${maxMinutes} 分钟上限，已暂停。${checkpoint.chapters.length?`已保存 ${checkpoint.chapters.filter((c:Row)=>c.saved).length}/${checkpoint.chapters.length} 章；继续时从成稿检查点恢复。`:'已归档证据与成员成果保留，继续时只补未完成工作。'}`, 'paused'); void harness.close(); }, maxMinutes * 60000);
    try {
      timer = setInterval(() => { try {
        this.service.heartbeat(taskId, task.lease_owner);
        const overdue=this.service.db.one("SELECT s.payload_json FROM events s WHERE s.task_id=? AND s.id>? AND s.kind='model.started' AND NOT EXISTS(SELECT 1 FROM events f WHERE f.task_id=s.task_id AND f.id>s.id AND f.kind='model.finished' AND json_extract(f.payload_json,'$.call_id')=json_extract(s.payload_json,'$.call_id')) AND julianday(s.created_at)<julianday('now','-8 minutes') ORDER BY s.id LIMIT 1",taskId,startedEvent);
        if(overdue){const call=JSON.parse(overdue.payload_json);this.service.db.event(taskId,'model.timeout',{message:'单次模型调用超过八分钟；已停止本轮并保留原文和草稿',role:call.role,call_id:call.call_id});this.service.waitRuntime(taskId,task.lease_owner,'单次模型调用超过八分钟，已暂停；原文和草稿保留，可检查供应商后从检查点继续。','paused');void harness.close();}
      } catch { void harness.close(); } }, 20000);
      await harness.start();
      this.service.requireRun(taskId,task.lease_owner);
      const mounted=this.service.db.one("SELECT id FROM events WHERE task_id=? AND kind='runtime.profile_ready' AND json_extract(payload_json,'$.root_session_id')=?",taskId,rootSession);
      if(!mounted){const error=this.service.db.one("SELECT payload_json FROM events WHERE task_id=? AND kind='runtime.profile_error' AND json_extract(payload_json,'$.root_session_id')=? ORDER BY id DESC LIMIT 1",taskId,rootSession);throw new Error('DiTing 领域插件未成功挂载，已在模型调用前停止：'+(error?JSON.parse(error.payload_json).message:'未收到本轮挂载证明'));}
      const checkpoint = new ReportPipeline(this.service.db, this.service, taskId).progress();
      const resume = checkpoint.candidate_id?`\n恢复执行：报告候选 ${checkpoint.candidate_id} 已通过校验；读取 task_context 确认当前门禁版本后直接 report_publish，不要委派调查或重新成稿。`:checkpoint.chapters.length && checkpoint.chapters.every((c: Row) => c.saved)
        ? '\n恢复执行：全部报告章节已保存。先核对当前门禁版本；如已通过，只委派 Report 修订最终校验错误并提交 report_draft，随后 report_publish。严禁重启三引擎或重做布局、篇幅、已保存章节。正文数字需要所引结论或底表支持，内部编号与哈希留在结构化附录；统计细节直接引用程序附表。'
        : '\n从已保存阶段继续，只启动尚缺产物的成员。';
      const result = await harness.run(`研究主题：${task.title}\n任务编号：${taskId}\n必须使用本任务证据和预算。${resume}`, { sessionId: rootSession, onNotification: (n: Row) => { onNotification?.(n); } });
      // The SDK can return an idle session after a provider failure rather
      // than throwing. Preserve its result so that a generic waiting state
      // never hides the reason a research run ended.
      const response = String(result.finalResponse || '').slice(0,20000);
      const diagnosticDir=join(settings.dataDir,'diagnostics','research');mkdirSync(diagnosticDir,{recursive:true});
      writeFileSync(join(diagnosticDir,rootSession+'.json'),encode({task_id:taskId,root_session_id:rootSession,completed_at:now(),result}));
      this.service.db.event(taskId,'runtime.ended',{message:'本轮 dsh 会话已结束；完整会话通知已保存在本机诊断目录',root_session_id:rootSession,final_response:response,diagnostic_file:rootSession+'.json'});
      const current = this.service.rawTask(taskId);
      const failure=this.service.db.one("SELECT payload_json FROM events WHERE task_id=? AND kind='model.failed' AND id>(SELECT COALESCE(MAX(id),0) FROM events WHERE task_id=? AND kind='runtime.started') ORDER BY id DESC LIMIT 1",taskId,taskId);
      const budgetStop=this.service.db.one("SELECT payload_json FROM events WHERE task_id=? AND kind='budget.exhausted' AND id>(SELECT COALESCE(MAX(id),0) FROM events WHERE task_id=? AND kind='runtime.started') ORDER BY id DESC LIMIT 1",taskId,taskId);
      const turnError=result.events?.filter((e:Row)=>e.type==='turn/end'&&e.data?.reason?.kind==='error').at(-1)?.data?.reason?.error;
      if (current.status === 'running') this.service.waitRuntime(taskId, task.lease_owner, runtimeStopReason({budgetMessage:budgetStop?JSON.parse(budgetStop.payload_json).message:null,modelFailure:failure?JSON.parse(failure.payload_json).message:null,turnError:turnError?String(turnError.message||turnError.code):null}), 'paused');
      return result;
    } finally { clearTimeout(deadline); if (timer) clearInterval(timer); await harness.close(); this.service.db.run("UPDATE agent_runs SET status='stopped',updated_at=? WHERE task_id=? AND status IN ('starting','running')", now(), taskId); this.active.delete(taskId); }
  }
  async cancel(id: string) { const harness = this.active.get(id); if (harness) await harness.close(); }
  async close() { await Promise.all([...this.active.keys()].map(id => this.cancel(id))); }
}
export class Worker {
  private timer?: ReturnType<typeof setInterval>; private busy = false; private stopping = false;
  constructor(readonly service: Service, readonly runtime: Runtime, readonly interval = 1500) {}
  start() { this.timer = setInterval(() => { void this.tick().catch(()=>{}); }, this.interval); this.timer.unref(); }
  async tick() {
    if (this.busy || this.stopping) return; this.busy = true;
    try {
      const task = this.service.claim('typescript-worker'); if (!task) return;
      const cap = this.runtime.capabilities(); if (!cap.ready) { this.service.waitRuntime(task.id, task.lease_owner, cap.reason); return; }
      try { await this.runtime.launch(task); }
      catch (error) { this.service.waitRuntime(task.id, task.lease_owner, `执行未完成：${error instanceof Error ? error.message.slice(0, 500) : 'runtime failure'}`); }
    } finally { this.busy = false; }
  }
  async cancel(id: string) { await this.runtime.cancel(id); }
  async stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); await this.runtime.close(); while (this.busy) await new Promise(resolve => setTimeout(resolve, 25)); }
}
