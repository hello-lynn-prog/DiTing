import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { Database, uid, now, encode, hash, type Row } from './db.js';
import { Configuration } from './configuration.js';
import { Service } from './service.js';
import { Hotlists } from '../collectors/hotlists.js';
import { ResearchLexicon, lookupLexicon } from './research-lexicon.js';

const DAILY_SIGNAL_LIMIT=20;
const localDay=(date:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date));
const norm=(s:string)=>s.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const timestampBefore=(value:unknown,cutoff:unknown)=>{const time=typeof value==='string'?Date.parse(value):NaN,limit=typeof cutoff==='string'?Date.parse(cutoff):NaN;return Number.isFinite(time)&&Number.isFinite(limit)&&time<limit;};
export function isHistoricalArchiveEvidence(evidence:Row,monitorCreatedAt:string|null|undefined){return evidence.type==='archived_post'&&!!monitorCreatedAt&&(timestampBefore(evidence.captured_at,monitorCreatedAt)||timestampBefore(evidence.published_at,monitorCreatedAt));}
function titleSimilarity(a:string,b:string){const tokens=(s:string)=>new Set((s.normalize('NFKC').toLocaleLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu)||[]).flatMap(t=>/^[\p{Script=Han}]+$/u.test(t)?Array.from({length:Math.max(1,t.length-1)},(_,i)=>t.slice(i,i+2)): [t])),x=tokens(a),y=tokens(b);if(!x.size||!y.size)return norm(a)===norm(b)?1:0;const overlap=[...x].filter(t=>y.has(t)).length;return overlap/(x.size+y.size-overlap);}

export const monitorSchema = z.object({ title: z.string().trim().min(1).max(100), keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(30), enabled: z.boolean().default(false),
  interval_minutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).default(15), cron: z.string().max(100).optional(),
  rule: z.enum(['keyword', 'keyword_growth']).default('keyword_growth'), growth: z.number().min(1).max(100).default(2), action: z.enum(['notify','confirm','auto']).optional(),
  auto_research: z.boolean().default(false), budget: z.number().positive().max(10000).default(20), max_daily_tasks: z.number().int().min(0).max(20).default(3), daily_budget: z.number().min(0).max(10000).default(60) }).strict();
export type MonitorInput = z.infer<typeof monitorSchema>;
export function attentionPriority(title:string,growth:number|null,scope='标题'){
  const value=title.normalize('NFKC').toLocaleLowerCase();
  const high=['伤亡','死亡','爆炸','泄露','数据泄漏','召回','停产','重大事故','袭击','诈骗','欺诈','违法','爆雷','资金链断裂','加沙','俄乌'];
  const medium=['风险','争议','投诉','处罚','下架','裁员','延误','涨价','融资','回调','备案','监管','安全','危机'];
  const matchedHigh=high.filter(w=>value.includes(w));if(matchedHigh.length||growth!==null&&growth>=5)return {level:'high',label:'高优先级线索',rule:matchedHigh.length?`${scope}命中高危词：${matchedHigh.join('、')}`:'同源榜单指标增长≥500%',basis:'deterministic_rule'};
  const matchedMedium=medium.filter(w=>value.includes(w));if(matchedMedium.length||growth!==null&&growth>=2)return {level:'medium',label:'中优先级线索',rule:matchedMedium.length?`${scope}命中风险词：${matchedMedium.join('、')}`:'同源榜单指标增长≥200%',basis:'deterministic_rule'};
  return {level:'low',label:'一般关注线索',rule:'未命中预设风险词或热度跃升阈值',basis:'deterministic_rule'};
}
export class Monitoring {
  private busy = false; private timer?: ReturnType<typeof setInterval>;
  constructor(readonly db: Database, readonly config: Configuration, readonly service: Service, readonly hotlists: Hotlists,readonly clock=()=>new Date()) {}
  private matches(text:string,keywords:string[]){
    const lexicon=new ResearchLexicon(this.config).freeze(), normalized=norm(text), hits:{configured:string;canonical:string;matched:string}[]=[];
    const qualifierAliases:Record<string,string[]>={
      '备案':['备案','已备案','登记','备案登记'],
      '落地':['落地','部署','应用','上线','投入使用','商业化'],
      '风险防控':['风险防控','风险治理','安全治理','风险','防控','安全'],
      '融资':['融资','募资','筹资','估值','投资'],
    };
    for(const configured of keywords){
      const compact=norm(configured),expansion=lookupLexicon(lexicon,configured),entries=expansion.matches as Row[];
      let entry=entries.sort((a,b)=>Math.max(norm(b.term).length,...b.variants.map((v:string)=>norm(v).length))-Math.max(norm(a.term).length,...a.variants.map((v:string)=>norm(v).length)))[0];
      let candidates=entry?[entry.term,...entry.variants]:[];
      // Standalone AI is too broad as a complete keyword, but can anchor a
      // compound user rule when its second concept is also present.
      if(!entry&&/^ai/.test(compact)&&compact.length>2)candidates=['AI','人工智能'];
      const concept=candidates.filter(t=>norm(t)&&compact.includes(norm(t))).sort((a,b)=>norm(b).length-norm(a).length)[0];
      if(concept){
        const qualifier=compact.replace(norm(concept),'');
        const matchedConcept=candidates.find(term=>normalized.includes(norm(term)));
        if(!matchedConcept)continue;
        if(qualifier){
          const aliases=qualifierAliases[qualifier]||[qualifier],matchedQualifier=aliases.find(term=>normalized.includes(norm(term)));
          if(!matchedQualifier)continue;
          hits.push({configured,canonical:entry?.term||configured,matched:norm(matchedConcept).includes(norm(matchedQualifier))?matchedConcept:`${matchedConcept} + ${matchedQualifier}`});
        }else hits.push({configured,canonical:entry?.term||configured,matched:matchedConcept});
        continue;
      }
      const literal=[configured,...expansion.keywords].find(term=>term&&normalized.includes(norm(term)));
      if(literal)hits.push({configured,canonical:entry?.term||configured,matched:literal});
    }
    return hits;
  }
  private upsertSignal(monitor:Row,key:string,title:string,reason:string,evidence:Row,taskId:string|null,priority:Row){
    const day=localDay(this.clock().toISOString()), start=new Date(`${day}T00:00:00+08:00`).toISOString(), end=new Date(`${day}T23:59:59.999+08:00`).toISOString();
    const candidate=this.db.rows('SELECT * FROM signals WHERE monitor_id=? AND created_at>=? AND created_at<=? ORDER BY created_at DESC',monitor.id,start,end)
      .find(s=>s.event_key===key||titleSimilarity(s.title,title)>=0.72);
    if(candidate){
      const old=JSON.parse(candidate.evidence_json||'{}'),observationId=evidence.snapshot_id||evidence.evidence_id||`${evidence.provider}:${evidence.source_id}:${evidence.item_key}`,seen=[...(old.observation_ids||[])],isNew=!seen.includes(observationId), merged={...old,...evidence,occurrences:(old.occurrences||1)+(isNew?1:0),observation_ids:isNew?[...seen,observationId].slice(-100):seen,source_urls:[...new Set([...(old.source_urls||[]),...(evidence.source_url?[evidence.source_url]:[])])].slice(0,20),sources:[...new Set([...(old.sources||[]),...(evidence.source?[evidence.source]:[])])].slice(0,20),keywords:[...new Set([...(old.keywords||[]),...(evidence.keywords||[])])],priority};
      this.db.run('UPDATE signals SET reason=?,evidence_json=?,title=?,read_at=CASE WHEN ? THEN NULL ELSE read_at END WHERE id=?',reason,encode(merged),title,priority.level==='high'?1:0,candidate.id);
      if(priority.level==='high'&&JSON.parse(candidate.evidence_json||'{}').priority?.level!=='high')this.db.notify(taskId,'signal.high_priority',{signal_id:candidate.id,title,reason,priority,evidence:merged},`${candidate.id}:high`);
      return false;
    }
    const isHigh=priority.level==='high',count=this.db.one('SELECT COUNT(*) n FROM signals WHERE monitor_id=? AND created_at>=? AND created_at<=?',monitor.id,start,end)?.n||0;
    // Keep a hard cap for routine leads; urgent leads bypass it so the cap cannot hide a high-risk item.
    if(count>=DAILY_SIGNAL_LIMIT&&!isHigh)return false;
    const id=uid('signal'),eventKey=hash(encode([monitor.id,day,key]));
    this.db.run('INSERT INTO signals(id,monitor_id,event_key,title,reason,evidence_json,task_id,created_at,read_at) VALUES(?,?,?,?,?,?,?,?,NULL)',id,monitor.id,eventKey,title,reason,encode({...evidence,occurrences:1,observation_ids:[evidence.snapshot_id||evidence.evidence_id||`${evidence.provider}:${evidence.source_id}:${evidence.item_key}`],source_urls:evidence.source_url?[evidence.source_url]:[],sources:evidence.source?[evidence.source]:[],priority}),taskId,now());
    this.db.event(taskId,'signal.created',{message:reason,signal_id:id,priority:priority.level});this.db.notify(taskId,'signal.created',{signal_id:id,title,reason,priority,evidence},id);
    if(priority.level==='high')this.db.notify(taskId,'signal.high_priority',{signal_id:id,title,reason,priority,evidence},id);
    return true;
  }
  list(): Row[] { return this.db.rows('SELECT * FROM monitors ORDER BY created_at DESC').map(m => ({ ...m, keywords: JSON.parse(m.keywords_json), ...this.config.get<Row>(`monitor.${m.id}`, {}), auto_research:false, action:this.config.get<Row>(`monitor.${m.id}`,{}).action==='confirm'?'confirm':'notify' })); }
  next(input: Pick<MonitorInput, 'cron' | 'interval_minutes'>, date = new Date()) { return input.cron?.trim() ? CronExpressionParser.parse(input.cron, { currentDate: date, tz: 'Asia/Shanghai' }).next().toISOString() : new Date(date.getTime() + input.interval_minutes * 60000).toISOString(); }
  save(input: unknown, id?: string) {
    const b = monitorSchema.parse(input), next = this.next(b,this.clock());
    // Monitoring may create leads, but a reader explicitly decides whether to start research.
    b.auto_research=false;if(b.action==='auto')b.action='confirm';id ||= uid('monitor');
    this.db.transaction(() => {
      this.db.run(`INSERT INTO monitors VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,keywords_json=excluded.keywords_json,enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,auto_research=excluded.auto_research,budget=excluded.budget,next_run_at=excluded.next_run_at`, id!, b.title, encode(b.keywords), Number(b.enabled), b.interval_minutes, Number(b.auto_research), b.budget, next, now());
      this.config.set(`monitor.${id}`, {...b,version:uid('monitor_config')});
    }); return this.list().find(m => m.id === id);
  }
  evaluate(only?:string[],snapshotIds?:string[]) {
    const snapshots = this.hotlists.latest(); let count = 0;
    for (const monitor of this.list().filter(m => m.enabled&&(!only||only.includes(m.id)))) for (const snapshot of snapshots.filter(s => s.status === 'succeeded'&&(!snapshotIds||snapshotIds.includes(s.id)))) for (const item of snapshot.items) {
      const matches=this.matches(item.title,monitor.keywords);const keywords=matches.map(x=>x.configured);if(!keywords.length)continue;
      const previous = this.db.one(`SELECT i.heat_value FROM hotlist_items i JOIN hotlist_snapshots s ON s.id=i.snapshot_id WHERE s.provider=? AND s.source_id=? AND s.status='succeeded' AND s.rowid<(SELECT rowid FROM hotlist_snapshots WHERE id=?) AND i.item_key=? ORDER BY s.created_at DESC,s.rowid DESC LIMIT 1`, snapshot.provider, snapshot.source_id, snapshot.id, item.item_key);
      const growth = previous && previous.heat_value > 0 && item.heat_value !== null ? (item.heat_value - previous.heat_value) / previous.heat_value : null;
      const priority=attentionPriority(item.title,growth);
      const canonical=matches.map(x=>x.canonical).sort().join('+'),topicKey=hash(encode([canonical,norm(item.title)]));
      this.db.transaction(() => {
        const id = uid('signal'),reason = `${priority.label}（规则初筛，不是事实定性）：监测关键词命中 ${keywords.join('、')}；触发规则：${priority.rule}` + (growth === null ? '；无基线，未计算增长率' : `；同源同口径榜单指标增长 ${(growth * 100).toFixed(1)}%，不代表全网讨论量`);
        const taskId: string | null = null;
        const raw=(()=>{try{return JSON.parse(item.raw_json||'{}')}catch{return {}}})();
        const published_at=raw.published_at||raw.publish_time||raw.created_at||raw.createdAt||null;
        const evidence={type:'hotlist',snapshot_id:snapshot.id,item_key:item.item_key,provider:snapshot.provider,source_id:snapshot.source_id,source:`${snapshot.provider}:${snapshot.source_id}`,source_url:item.url,rank:item.rank,current_heat:item.heat_value,previous_heat:previous?.heat_value??null,published_at,keywords,matched_terms:matches.map(x=>x.matched),canonical_topics:matches.map(x=>x.canonical),growth,priority,trigger_rule:priority.rule};
        if(this.upsertSignal(monitor,topicKey,item.title,reason,evidence,taskId,priority))count++;
      });
    }
    return { created: count + this.evaluateArchivedContent(only) };
  }
  /** Scan only already archived full text; this method never makes platform/network requests. */
  evaluateArchivedContent(only?:string[]) {
    let count=0;
    const archived=this.db.rows(`SELECT e.id evidence_id,e.source_url,e.title,e.content,e.captured_at,m.published_at,m.author,m.publisher,
      c.platform,c.record_type,c.metrics_json,c.published_at content_published_at
      FROM evidence e LEFT JOIN evidence_metadata m ON m.evidence_id=e.id
      LEFT JOIN content_records c ON c.evidence_id=e.id
      WHERE length(trim(e.content))>0 ORDER BY e.captured_at DESC LIMIT 10000`);
    const monitors=this.list().filter(m=>m.enabled&&(!only||only.includes(m.id)));
    for(const monitor of monitors)for(const item of archived){
      // Existing research archives are a baseline, not newly discovered leads.
      // Only content captured after this monitor was created may generate a signal.
      if(!item.captured_at||isHistoricalArchiveEvidence({type:'archived_post',captured_at:item.captured_at,published_at:item.content_published_at||item.published_at},monitor.created_at))continue;
      const full=`${item.title||''}\n${item.content||''}`,matches=this.matches(full,monitor.keywords),keywords=matches.map(x=>x.configured);if(!keywords.length)continue;
      const canonical=matches.map(x=>x.canonical).sort().join('+'),eventKey=hash(encode([canonical,norm(item.title||full.slice(0,120))]));
      this.db.transaction(()=>{
        let hostname='';try{hostname=item.source_url?new URL(item.source_url).hostname:'';}catch{}
        const priority=attentionPriority(full,null,'归档正文'),source=item.publisher||item.platform||hostname||'来源未提供';
        const published_at=item.content_published_at||item.published_at||null;
        const reason=`${priority.label}（归档正文关键词初筛，不是事实定性）：命中 ${keywords.join('、')}；触发规则：归档标题/正文命中监测关键词；无基线，未计算增长率`;
        const matchField=keywords.some((word:string)=>(item.title||'').normalize('NFKC').toLocaleLowerCase().includes(word.normalize('NFKC').toLocaleLowerCase()))?'title':'body';
        const evidence={type:'archived_post',evidence_id:item.evidence_id,source_url:item.source_url,source,platform:item.platform||null,record_type:item.record_type||null,rank:null,current_heat:null,previous_heat:null,published_at,captured_at:item.captured_at||null,author:item.author||null,keywords,matched_terms:matches.map(x=>x.matched),canonical_topics:matches.map(x=>x.canonical),match_field:matchField,priority,trigger_rule:`归档${matchField==='title'?'标题':'正文'}关键词命中`};
        if(this.upsertSignal(monitor,eventKey,item.title||full.slice(0,120),reason,evidence,null,priority))count++;
      });
    }
    return count;
  }
  async tick(date=this.clock()) {
    if (this.busy) return; const due = this.list().filter(m => m.enabled && m.next_run_at <= date.toISOString()); if (!due.length) return;
    this.busy = true;
    try { const unchanged=due.filter(m=>this.list().some(current=>current.id===m.id&&current.enabled&&current.version===m.version&&current.next_run_at===m.next_run_at));const created=this.evaluateArchivedContent(unchanged.map(m=>m.id));this.db.event(null,'monitoring.finished',{message:'值守定时器仅扫描已归档正文；热榜信号由采集完成时评估，不额外请求来源',rules:unchanged.map(m=>m.id),created}); }
    finally {try{for (const monitor of due) {const current=this.list().find(m=>m.id===monitor.id);if(current?.version===monitor.version)this.db.run('UPDATE monitors SET next_run_at=? WHERE id=? AND next_run_at=?', this.next(current as any,new Date(Math.max(date.getTime(),this.clock().getTime()))), monitor.id,monitor.next_run_at);}}finally{this.busy = false;} }
  }
  start() { this.timer = setInterval(() => void this.tick().catch(() => {}), 30000); this.timer.unref(); }
  async stop() { if (this.timer) clearInterval(this.timer); while (this.busy) await new Promise(resolve => setTimeout(resolve, 25)); }
}
