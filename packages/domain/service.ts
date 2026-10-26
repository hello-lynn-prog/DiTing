import { Database, encode, hash, now, uid, type Row } from './db.js';
import { classify, scope } from './intent.js';
import {validateVisualReference} from './visual-evidence.js';
import {canonicalNumericText} from './numeric-equivalence.js';
import {programAppendix} from '../reporting/program-appendices.js';

export class Conflict extends Error { statusCode = 409; }
export class Missing extends Error { statusCode = 404; }
function contentSimilarity(a:string,b:string){const tokens=(v:string)=>{const text=v.toLocaleLowerCase().normalize('NFKC').replace(/https?:\/\/\S+/g,' ').replace(/[\p{P}\p{S}\s]+/gu,' '),out=new Set<string>();for(const word of text.match(/[\u3400-\u9fff]+|[a-z0-9]+/g)||[]){if(/[\u3400-\u9fff]/.test(word)){for(let i=0;i<word.length-1;i++)out.add(word.slice(i,i+2));}else if(word.length>1)out.add(word);}return out;};const x=tokens(a),y=tokens(b);if(!x.size||!y.size)return 0;let common=0;for(const t of x)if(y.has(t))common++;return common/(x.size+y.size-common);}
export class Service {
  constructor(readonly db: Database, readonly defaultBudget = 20) {}
  rawTask(id: string): Row { const t = this.db.one('SELECT * FROM tasks WHERE id=?', id); if (!t) throw new Missing('任务不存在'); return t; }
  task(id: string): Row { const t = this.rawTask(id); t.config = JSON.parse(t.config_json); delete t.config_json; delete t.lease_owner; delete t.lease_until; return t; }
  tasks() { return this.db.rows('SELECT id FROM tasks ORDER BY created_at DESC').map(t => this.task(t.id)); }
  session(title = '新的对话', report: string | null = null, parent: string | null = null) {
    return this.db.transaction(() => {
      if (report && !this.db.one('SELECT id FROM reports WHERE id=?', report)) throw new Missing('报告不存在');
      if (parent) this.rawTask(parent);
      const id = uid('session'); this.db.run('INSERT INTO sessions VALUES(?,?,?,?,?)', id, title, report, parent, now()); return id;
    });
  }
  createTask(title: string, session: string | null, parent: string | null = null, source = 'chat', templateSelection: {mode:'auto'|'user_import'|'co_created';template_id?:string} = {mode:'auto'}) {
    const config:Row = { ...scope(title, this.defaultBudget), executor: 'dsh', pipeline: 'diting-native-v1', config_version: 2,
      engine_reflection_policy:{version:1,mode:'bettafish-fixed',initial_summaries:1,reflection_rounds:{insight:3,media:2,query:2}},
      max_supplement_rounds: 3, max_searches:32, max_fetches:60, max_deep_requests:3, delivery: ['html', 'markdown', 'pdf'], gates: ['sufficiency', 'verifier', 'advocate'] };
    const custom=this.db.one("SELECT value_json FROM configuration WHERE key='templates.custom'");
    const options=[{id:'public-event',name:'公共热点事件研判'},{id:'brand',name:'品牌声誉研究'},{id:'competition',name:'行业竞争研究'},{id:'monitoring',name:'定期监测报告'},{id:'policy',name:'政策与行业研究'},{id:'crisis',name:'突发事件研究'},...(custom?JSON.parse(custom.value_json):[])];
    const builtins:Record<string,string>={'社会公共热点事件分析报告模板':'public-event','企业品牌声誉分析报告模板':'brand','市场竞争格局舆情分析报告模板':'competition','日常或定期舆情监测报告模板':'monitoring','特定政策或行业动态舆情分析报告模板':'policy','突发事件与危机公关舆情报告模板':'crisis'};
    const selected=options.find((t:Row)=>title.includes(t.name))||Object.entries(builtins).filter(([name])=>title.includes(name)).map(([,id])=>({id}))[0];if(selected)config.template=selected.id;
    if(templateSelection.mode==='auto')config.template_selection={mode:'auto',selected_by:selected?'explicit_template_name_in_request':'report_agent'};
    else {
      const template=options.find((t:Row)=>t.id===templateSelection.template_id);
      if(!template||template.origin!==templateSelection.mode)throw new Error(templateSelection.mode==='user_import'?'请先上传并选择一份用户模板':'请先共创并保存模板，再选择使用');
      config.template=template.id;config.template_selection={mode:templateSelection.mode,template_id:template.id,template_name:template.name};
    }
    if (parent) this.rawTask(parent);
    const id = uid('task'), stamp = now();
    this.db.run(`INSERT INTO tasks(id,title,source,status,parent_id,session_id,budget,config_json,created_at,updated_at)
      VALUES(?,?,?,'queued',?,?,?,?,?,?)`, id, title, source, parent, session, config.budget, encode(config), stamp, stamp);
    this.db.event(id, 'task.created', { message: '独立研究任务已入队', config }); return id;
  }
  send(sessionId: string, text: string, requestId: string, parent: string | null = null, templateSelection: {mode:'auto'|'user_import'|'co_created';template_id?:string} = {mode:'auto'}): Row {
    const fingerprint = hash(encode(templateSelection.mode==='auto'&&!templateSelection.template_id?[text,parent]:[text,parent,templateSelection]));
    return this.db.transaction(() => {
      const s = this.db.one('SELECT * FROM sessions WHERE id=?', sessionId); if (!s) throw new Missing('对话不存在');
      const previous = this.db.one('SELECT * FROM requests WHERE session_id=? AND request_id=?', sessionId, requestId);
      if (previous) { if (previous.content_hash !== fingerprint) throw new Conflict('相同请求编号不能用于不同内容'); return JSON.parse(previous.result_json); }
      const prior=this.db.one('SELECT result_json FROM requests WHERE session_id=? ORDER BY rowid DESC LIMIT 1',sessionId);
      const awaitingTopic=!!prior&&JSON.parse(prior.result_json).intent==='clarify';
      const previousPrompt=awaitingTopic?this.db.one("SELECT content FROM messages WHERE session_id=? AND role='user' ORDER BY rowid DESC LIMIT 1",sessionId)?.content:null;
      const intent = classify(text, !!s.report_id,awaitingTopic); let taskId: string | null = null;
      let answer = '对话已保存。请先在定制中心配置问答模型；普通提问不会自动启动采集。';
      if (intent === 'research') {
        parent ||= s.parent_task_id || (s.report_id ? this.db.one('SELECT task_id FROM reports WHERE id=?', s.report_id)?.task_id : null);
        taskId = this.createTask(previousPrompt?previousPrompt+'\n研究主题补充：'+text:text, sessionId, parent,'chat',templateSelection);
        answer = '研究任务已保存并入队。主 Agent 将组织独立调查；执行条件缺失时会明确等待。';
      } else if (intent === 'clarify') answer = '请说明研究主题、对象或时间范围，例如“调查近7天 AI 行业争议，给我完整报告”。';
      else if (intent === 'template') answer = '请说明报告面向谁、主题及必备章节。模板共创不会启动采集。';
      else if (intent === 'report_question') answer = '已关联报告版本。追问只使用该报告及已归档证据；不会自动重新采集。';
      const stamp = now(), userId = uid('message'), assistantId = uid('message');
      this.db.run('INSERT INTO messages VALUES(?,?,?,?,?,?)', userId, sessionId, 'user', text, null, stamp);
      this.db.run('INSERT INTO messages VALUES(?,?,?,?,?,?)', assistantId, sessionId, 'assistant', answer, taskId, stamp);
      if (this.db.one('SELECT COUNT(*) n FROM messages WHERE session_id=?', sessionId)?.n === 2) this.db.run('UPDATE sessions SET title=? WHERE id=?', text.slice(0, 35), sessionId);
      const result = { intent, task_id: taskId, answer, assistant_id: assistantId, model_pending: ['question', 'report_question', 'template'].includes(intent) };
      this.db.run('INSERT INTO requests VALUES(?,?,?,?)', sessionId, requestId, fingerprint, encode(result)); return result;
    });
  }
  finishAnswer(session: string, request: string, result: Row, answer: string) {
    return this.db.transaction(() => {
      const final = { ...result, answer, model_pending: false };
      this.db.run('UPDATE messages SET content=? WHERE id=? AND session_id=?', answer, result.assistant_id, session);
      this.db.run('UPDATE requests SET result_json=? WHERE session_id=? AND request_id=?', encode(final), session, request); return final;
    });
  }
  action(id: string, action: string, revision: number) {
    const rules: Record<string, [string[], string]> = {
      pause: [['queued', 'running', 'waiting_runtime', 'waiting_evidence'], 'paused'],
      resume: [['paused', 'waiting_runtime', 'failed', 'waiting_input', 'waiting_evidence'], 'queued'],
      cancel: [['queued', 'running', 'paused', 'waiting_runtime', 'waiting_evidence', 'waiting_input', 'waiting_approval', 'review', 'failed'], 'cancelled'] };
    if (!rules[action]) throw new Error('未知任务操作');
    this.db.transaction(() => {
      const t = this.rawTask(id); if (t.revision !== revision) throw new Conflict('任务已变化，请刷新后操作');
      const [states, target] = rules[action]; if (!states.includes(t.status)) throw new Conflict('当前任务状态不支持此操作');
      this.db.run(`UPDATE tasks SET status=?,updated_at=?,revision=revision+1,attempt=attempt+?,lease_owner=NULL,lease_until=NULL,block_reason=NULL WHERE id=?`, target, now(), Number(t.status === 'failed' && action === 'resume'), id);
      this.db.event(id, `task.${action}`, { message: `任务状态更新为 ${target}，已取得材料保留` });
    }); return this.task(id);
  }
  claim(owner: string, seconds = 90): Row | undefined {
    return this.db.transaction(() => {
      const stamp = now();
      for (const t of this.db.rows("SELECT id FROM tasks WHERE status='running' AND lease_until<?", stamp)) {
        this.db.run("UPDATE tasks SET status='queued',attempt=attempt+1,revision=revision+1,lease_owner=NULL,lease_until=NULL WHERE id=?", t.id);
        this.db.event(t.id, 'task.recovered', { message: '执行租约过期，保留材料重新排队' });
      }
      if (this.db.one("SELECT id FROM tasks WHERE status='running'")) return;
      const t = this.db.one("SELECT * FROM tasks WHERE status='queued' ORDER BY CASE source WHEN 'chat' THEN 0 ELSE 1 END,created_at,id LIMIT 1"); if (!t) return;
      const deadline = new Date(Date.now() + seconds * 1000).toISOString().replace('Z', '000+00:00');
      this.db.run("UPDATE tasks SET status='running',lease_owner=?,lease_until=?,updated_at=?,revision=revision+1 WHERE id=?", `${owner}:${uid('lease')}`, deadline, stamp, t.id);
      this.db.event(t.id, 'task.claimed', { message: '任务获得执行槽' }); return this.rawTask(t.id);
    });
  }
  requireRun(id: string, token: string) {
    const t = this.rawTask(id);
    if (t.status !== 'running' || !token || t.lease_owner !== token || !t.lease_until || t.lease_until <= now()) throw new Conflict('执行租约已失效，不能写入迟到的研究结果');
    return t;
  }
  heartbeat(id: string, token: string) {
    this.requireRun(id, token); this.db.run('UPDATE tasks SET lease_until=? WHERE id=? AND lease_owner=?', new Date(Date.now() + 90000).toISOString().replace('Z', '000+00:00'), id, token);
  }
  waitRuntime(id: string, token: string, reason: string, status = 'waiting_runtime') {
    return this.db.transaction(() => {
      const r = this.db.run("UPDATE tasks SET status=?,block_reason=?,lease_owner=NULL,lease_until=NULL,updated_at=?,revision=revision+1 WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?", status, reason, now(), id, token, now());
      if (r.changes) { this.db.event(id, 'runtime.unavailable', { message: reason }); this.db.notify(id,'task.attention_required',{title:this.rawTask(id).title,reason,status},this.rawTask(id).revision); } return !!r.changes;
    });
  }
  supplement(id: string, text: string) {
    this.db.transaction(() => { const t = this.rawTask(id); if (['completed', 'cancelled'].includes(t.status)) throw new Conflict('已结束任务需创建补充研究'); this.db.event(id, 'task.supplement', { message: text }); if(['waiting_input','waiting_evidence'].includes(t.status)){this.db.run("UPDATE tasks SET status='queued',block_reason=NULL,revision=revision+1,updated_at=? WHERE id=?",now(),id);this.db.event(id,'task.requeued',{message:'补充材料已保存，自动重新排队继续研究'});} });
  }
  requestCrawlApproval(id:string,operation:'platform_keyword_crawl'|'public_keyword_crawl',request:Row,token?:string){
    return this.db.transaction(()=>{
      const task=token?this.requireRun(id,token):this.rawTask(id),max=JSON.parse(task.config_json).max_deep_requests||3;
      const count=this.db.one("SELECT COUNT(*) n FROM approvals WHERE task_id=? AND operation IN ('platform_keyword_crawl','public_keyword_crawl')",id)!.n;
      if(count>=max)throw new Conflict('本任务已达到采集范围审批上限；请保留现有证据并创建关联研究');
      const approval=uid('approval');this.db.run('INSERT INTO approvals VALUES(?,?,?,?,?,?,NULL)',approval,id,operation,encode(request),'pending',now());
      this.db.event(id,'crawl.approval_requested',{message:'新采集范围等待审批；未执行网络采集',approval_id:approval,operation});
      this.db.notify(id,'approval.required',{approval_id:approval},approval);return approval;
    });
  }
  archive(id: string, url: string, title: string, content: string, origin = 'user_import', token?: string, metadata?: {published_at?:string|null;author?:string|null;publisher?:string|null;method?:string}) {
    return this.db.transaction(() => {
      const t = this.rawTask(id); if (token) this.requireRun(id, token);
      if (['completed', 'cancelled'].includes(t.status)) throw new Conflict('已结束任务的材料不能改写');
      const digest = hash(content), stamp = now();
      this.db.run('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?,?,?)', uid('evidence'), url, title, content, digest, origin, stamp);
      const eid = this.db.one('SELECT id FROM evidence WHERE source_url=? AND content_hash=?', url, digest)!.id;
      if(metadata){const value={published_at:metadata.published_at||null,author:metadata.author||null,publisher:metadata.publisher||null,method:metadata.method||'publisher_page_metadata'};this.db.run('INSERT INTO evidence_metadata(evidence_id,published_at,author,publisher,method,raw_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(evidence_id) DO UPDATE SET published_at=COALESCE(excluded.published_at,evidence_metadata.published_at),author=COALESCE(excluded.author,evidence_metadata.author),publisher=COALESCE(excluded.publisher,evidence_metadata.publisher),method=excluded.method,raw_json=excluded.raw_json,updated_at=excluded.updated_at',eid,value.published_at,value.author,value.publisher,value.method,encode(value),stamp);}
      if (this.db.run('INSERT OR IGNORE INTO task_evidence VALUES(?,?)', id, eid).changes) {
        this.db.run('UPDATE tasks SET evidence_revision=evidence_revision+1,revision=revision+1 WHERE id=?', id);
        this.db.event(id, 'evidence.archived', { message: origin === 'user_import' ? '已归档用户提供的原文；未声称联网核验' : '已归档抓取原文；事实真实性仍需核实', evidence_id: eid });
        this.db.run('INSERT INTO acquisitions VALUES(?,?,?,?,?,?,?)', uid('acq'), id, url, origin, 'saved', '原文与内容哈希已保存', stamp);
        const prior=this.db.rows('SELECT e.id,e.content,e.content_hash FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? AND e.id<>? ORDER BY e.captured_at DESC LIMIT 200',id,eid);
        for(const p of prior){const exact=p.content_hash===digest,similarity=exact?1:contentSimilarity(content,p.content);if(exact||content.length>=120&&p.content.length>=120&&similarity>=0.92){const [a,b]=[eid,p.id].sort();this.db.run('INSERT OR IGNORE INTO evidence_relations VALUES(?,?,?,?,?,?,?)',id,a,b,exact?'same_content':'near_duplicate',similarity,exact?'sha256':'word-bigram-jaccard-v1',stamp);}}
      } return eid;
    });
  }
  addClaim(id: string, text: string, references: { evidence_id: string; quote: string;visual_id?:string;visual_quote?:string;visual_hash?:string }[], token: string, datasetRefs: { dataset_id:string; row_key:string; value:number }[] = []) {
    return this.db.transaction(() => {
      this.requireRun(id, token); if (!references.length) throw new Conflict('结论必须挂证据');
      for (const ref of references) {
        const e = this.db.one('SELECT e.content FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? AND e.id=?', id, ref.evidence_id);
        if (!e || ref.quote.trim().length < 5 || !e.content.includes(ref.quote)) throw new Conflict('引用必须来自本任务已归档的原文片段');
        validateVisualReference(this.db,id,ref);
        if(ref.visual_id&&!/视觉|画面|抽帧|图片|截图|影像/.test(text))throw new Conflict('视觉结论必须明确标为画面/图片观察，不能冒充已确认事件事实');
      }
      const cited = references.map(r => r.quote+' '+(r.visual_quote||'')).join('\n');
      for(const ref of datasetRefs){const row=this.db.one("SELECT data_json FROM artifacts WHERE id=? AND task_id=? AND kind='dataset'",ref.dataset_id,id);if(!row)throw new Conflict('统计事实必须引用本任务代码生成的底表');const data=JSON.parse(row.data_json);if(!data.rows.some((r:unknown[])=>r[0]===ref.row_key&&typeof r[1]==='number'&&r[1]===ref.value)||!text.includes(ref.row_key)||!numbers(text).includes(String(ref.value)))throw new Conflict('统计事实的主体、行标签和数值必须与所引用底表行完全对应');}
      const unsupported=unsupportedNumericRelations(text,cited).filter(f=>!datasetRefs.some(ref=>String(ref.value)===f.value&&text.includes(ref.row_key)));
      if (unsupported.length) {
        const details=unsupported.slice(0,6).map(claim=>{
          const matches=numericContexts(cited).filter(source=>source.value===claim.value);
          const value=`${claim.value}${claim.unit}`;
          if(!matches.length)return `“${value}”：引文没有同值数字`;
          if(claim.unit&&matches.every(source=>source.unit&&source.unit!==claim.unit))return `“${value}”：单位与引文不一致`;
          if(claim.subject&&matches.every(source=>source.subject&&source.subject!==claim.subject))return `“${value}”：结论主体“${claim.subject}”与引文主体“${matches[0].subject}”不同`;
          return `“${value}”：不能从引文确认对应关系`;
        });
        throw new Conflict(`结论数字归属校验未通过（${details.join('；')}）。请删除该数字或收窄措辞；程序统计须将 text 中的底表行标签和值与 dataset_refs 同一行绑定。不得改写引文或借用其他行。`);
      }
      const cid = uid('claim'); this.db.run('INSERT INTO claims VALUES(?,?,?,?,?)', cid, id, text, encode(references), now());for(const ref of datasetRefs)this.db.run('INSERT INTO claim_dataset_refs VALUES(?,?,?,?,?)',cid,ref.dataset_id,ref.row_key,ref.value,now()); this.db.event(id, 'claim.created', { message: '已建立待审结论', claim_id: cid,dataset_references:datasetRefs.length }); return cid;
    });
  }
  reviewInput(id: string) {
    const t = this.rawTask(id); const claims = this.db.rows('SELECT id,text,references_json FROM claims WHERE task_id=? ORDER BY id', id).map(c=>{const refs=this.db.rows('SELECT dataset_id,row_key,value FROM claim_dataset_refs WHERE claim_id=? ORDER BY dataset_id,row_key',c.id);return refs.length?{...c,dataset_refs:refs}:c;});
    return { evidence_revision: t.evidence_revision, claims_hash: hash(encode(claims)) };
  }
  review(id: string, gate: string, passed: boolean, reason: string, token: string, version: Row) {
    if (!['sufficiency', 'verifier', 'advocate'].includes(gate)) throw new Error('未知审查门禁');
    this.db.transaction(() => {
      this.requireRun(id, token); const current = this.reviewInput(id); if (encode(version) !== encode(current)) throw new Conflict('审查期间输入已变化，必须重新审查');
      if(passed)for(const c of this.db.rows('SELECT references_json FROM claims WHERE task_id=?',id))for(const ref of JSON.parse(c.references_json))validateVisualReference(this.db,id,ref);
      this.db.run('INSERT OR REPLACE INTO reviews VALUES(?,?,?,?,?,?,?)', id, gate, current.evidence_revision, current.claims_hash, Number(passed), reason, now());
      this.db.event(id, 'review.recorded', { message: reason, gate, passed });
    });
  }
  publishReport(id: string, document: Row, token: string) {
    return this.db.transaction(() => {
      const t = this.requireRun(id, token), claims = new Set(this.db.rows('SELECT id FROM claims WHERE task_id=?', id).map(c => c.id));
      if (!claims.size || !Array.isArray(document.sections) || !document.sections.length) throw new Conflict('缺少结论或完整章节');
      for (const s of document.sections) {
        const coverage=Array.isArray(s.claim_ids)&&s.claim_ids.length===0&&s.text===programAppendix(this.db,id,s.title)&&!s.visuals?.length&&!s.references?.length;
        if(!coverage&&(!s.claim_ids?.length||!s.claim_ids.every((c:string)=>claims.has(c))))throw new Conflict('每个事实章节必须引用本任务结论；仅当前程序生成的覆盖说明可用空引用');
      }
      const current = this.reviewInput(id), reviews = this.db.rows('SELECT * FROM reviews WHERE task_id=?', id).filter(r => r.passed && r.evidence_revision === current.evidence_revision && r.claims_hash === current.claims_hash);
      if (new Set(reviews.map(r => r.gate)).size !== 3) throw new Conflict('三道门禁未通过，或证据/结论已变化');
      let rootTask=t;for(let depth=0;rootTask.parent_id&&depth<64;depth++)rootTask=this.rawTask(rootTask.parent_id);
      const rid = uid('report'), version = (this.db.one('WITH RECURSIVE family(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN family f ON t.parent_id=f.id) SELECT MAX(r.version) n FROM reports r JOIN family f ON r.task_id=f.id', rootTask.id)?.n || 0) + 1;
      const bundle = { config: JSON.parse(t.config_json), ...current, document };
      const title=typeof document.title==='string'&&document.title.trim()?document.title.trim():t.title;
      this.db.run('INSERT INTO reports VALUES(?,?,?,?,?,?,?)', rid, id, version, title, encode(document), hash(encode(bundle)), now());
      this.db.run("UPDATE tasks SET status='completed',stage=8,revision=revision+1,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?", now(), id);
      this.db.event(id, 'report.stored', { message: version>1?'报告新版本已通过门禁并入库':'报告已通过门禁并入库', report_id: rid,version }); this.db.notify(id, version>1?'report.updated':'report.completed', { report_id: rid,version }, version); return rid;
    });
  }
  recordUsage(taskId: string, role: string, provider: string, input: number | null, output: number | null, cache: number | null, rates?: Row, attempt = 1) {
    const cost = calculateCost(input, output, cache, rates); this.rawTask(taskId);
    this.db.run('INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?,?)', uid('usage'), taskId, role, provider, input, output, cache, cost, attempt, now());
  }
}
/** Technical reference keys are links, not asserted measurements or dates. */
export function factualText(text: string) {
  return text.replace(/\b(?:task|artifact|dataset|evidence|claim|agent|call|run)_[a-f0-9]{8,}\b/g, ' ')
    // These exact publication names are entities, not claimed counts. Preserve
    // every adjacent quantity; source identity still needs semantic review.
    .replace(/(?<!\d)21世纪经济报道/g,'世纪经济报道媒体')
    .replace(/(?<!\d)36氪/g,'氪媒体')
    .replace(/\b(?:claims_hash|input_hash)\s*[=:：]\s*[a-f0-9.…]+/gi, ' ')
    .replace(/\bevidence_revision\s*[=:：]\s*\d+/g, ' ')
    .replace(/(^|\n)\s*(?:【section-\d+】|\[section-\d+\]|section-\d+[｜|：:])/gi,'$1');
}
export function numbers(text: string) { return factualText(text).match(/\d+(?:[.,]\d+)*(?:%|万|亿)?/g)?.map(n => n.replaceAll(',', '')) || []; }
function numericContexts(text: string) {
  text = canonicalNumericText(factualText(text));
  const out: { value: string; unit: string; subject: string }[] = [];
  const pattern = /\d+(?:[.,]\d+)*(?:%|万|亿)?/g; let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const raw = match[0], unit = raw.match(/(?:%|万|亿)$/)?.[0] || '', value = raw.replaceAll(',', '').replace(/(?:%|万|亿)$/, '');
    const start = Math.max(text.lastIndexOf('\n', match.index), text.lastIndexOf('。', match.index), text.lastIndexOf('；', match.index), text.lastIndexOf('，', match.index), text.lastIndexOf(',', match.index), text.lastIndexOf(';', match.index), 0);
    let subject = text.slice(start, match.index).replace(/[\s：:、，,；;。()（）\[\]【】]/g, '').slice(-16);
    subject = subject.replace(/(?:据统计|统计显示|数据显示|总计|合计|增长至|下降至|增加至|减少至|达到|超过|不足|约|共|有|为|是|发布了?|称|表示|提到|指出|显示|包含|出现|记录|数据|数量)+$/g, '');
    // Generic grammatical context cannot identify an entity. Compare only explicit residual labels.
    if (!/[\u3400-\u9fffA-Za-z]/.test(subject) || /^(?:截至|其中|目前|当前|本次|此次|该|这些|相关|平台|用户|网友|有人|共有|累计|新增|同比|环比|超过|不足|达到|大约|约)$/.test(subject)) subject = '';
    out.push({ value, unit, subject });
  }
  return out;
}
export function unsupportedNumericRelations(statement: string, sourceText: string) {
  const facts = numericContexts(sourceText);
  return numericContexts(statement).filter(claim => {
    const matches = facts.filter(source => source.value === claim.value);
    if (!matches.length) return true;
    // Reject same-number substitutions between explicit subjects, and unit changes.
    if (claim.unit && matches.every(source => source.unit && source.unit !== claim.unit)) return true;
    // Cross-language lexical contexts cannot prove an entity mismatch. The
    // independent Verifier must check translated entity/value attribution.
    // Still reject explicit different labels in the same writing system.
    const explicitEntity=(subject:string)=>{
      const cleaned=subject.replace(/(?:has|have|holds|contains|reported|published|total)$/i,'');
      const english=cleaned.match(/(?:Company|Group|Team|Agency)[A-Za-z0-9_-]+$/i)?.[0];
      const chinese=cleaned.match(/^[\u3400-\u9fffA-Za-z0-9_-]{1,12}(?:公司|集团|机构|团队|部门|小组|组|地区|省|市)$/)?.[0];
      return english||chinese||'';
    };
    const entity=explicitEntity(claim.subject);
    return !!entity && matches.every(source=>{const candidate=explicitEntity(source.subject);return !!candidate&&/[\u3400-\u9fff]/.test(candidate)===/[\u3400-\u9fff]/.test(entity)&&candidate!==entity;});
  });
}
export function calculateCost(input: number | null, output: number | null, cache: number | null, rates?: Row) {
  for (const n of [input, output, cache]) if (n !== null && (!Number.isSafeInteger(n) || n < 0)) throw new Error('usage 必须是非负整数或未知');
  if (input !== null && cache !== null && cache > input) throw new Error('缓存命中不能大于总输入');
  if (rates && ['input', 'cache', 'output'].some(k => !Number.isFinite(rates[k]) || rates[k] < 0)) throw new Error('费率必须是非负有限数');
  return rates && input !== null && output !== null && cache !== null ? ((input - cache) * rates.input + cache * rates.cache + output * rates.output) / 1e6 : null;
}
