import {encode,hash,type Database,type Row} from '../domain/db.js';
import {frozenResearchWindow} from '../domain/research-window.js';

function sampleCoverage(db:Database,taskId:string){
 const task=db.one('SELECT created_at,config_json FROM tasks WHERE id=?',taskId);if(!task)throw Error('任务不存在');
 const cfg=JSON.parse(task.config_json),window=frozenResearchWindow(task.created_at,cfg.window_days||7),annotations=new Map<string,Row>();
 for(const row of db.rows("SELECT data_json FROM artifacts WHERE task_id=? AND kind='sample_annotation' ORDER BY rowid",taskId)){const a=JSON.parse(row.data_json);annotations.set(a.evidence_id,a);}
 const records=db.rows('SELECT platform,record_type,published_at,metrics_json,evidence_id FROM content_records WHERE task_id=? ORDER BY captured_at,id',taskId);
 const platforms=new Map<string,Row>();let inWindow=0,beforeWindow=0,afterWindow=0,unknownDate=0;
 for(const r of records){const p=platforms.get(r.platform)||{platform:r.platform,records:0,by_type:{},publication_dates:{in_window:0,before_window:0,after_window:0,unknown:0},metrics:{},sentiment:{}};p.records++;p.by_type[r.record_type]=(p.by_type[r.record_type]||0)+1;
  const published=r.published_at?Date.parse(r.published_at):NaN;if(!Number.isFinite(published)){unknownDate++;p.publication_dates.unknown++;}else if(published<Date.parse(window.start)){beforeWindow++;p.publication_dates.before_window++;}else if(published>Date.parse(window.end)){afterWindow++;p.publication_dates.after_window++;}else{inWindow++;p.publication_dates.in_window++;}
  const metrics=JSON.parse(r.metrics_json);for(const [key,value] of Object.entries(metrics))if(typeof value==='number'&&Number.isFinite(value))p.metrics[key]=(p.metrics[key]||0)+value;
  const label=annotations.get(r.evidence_id)?.label||'unknown';p.sentiment[label]=(p.sentiment[label]||0)+1;platforms.set(r.platform,p);
 }
 const sources=db.rows('SELECT e.id,e.title,e.source_url,e.origin,e.captured_at,m.published_at,m.publisher FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id LEFT JOIN evidence_metadata m ON m.evidence_id=e.id WHERE te.task_id=? ORDER BY e.captured_at,e.id',taskId).map(e=>{
  const published=e.published_at?Date.parse(e.published_at):NaN,window_status=!Number.isFinite(published)?'unknown_publication_date':published<Date.parse(window.start)?'before_window':published>Date.parse(window.end)?'after_window':'within_window';
  return {evidence_id:e.id,title:e.title,url:e.source_url,publisher:e.publisher||null,origin:e.origin,published_at:e.published_at||null,captured_at:e.captured_at,window_status};
 });
 return {research_window:window,source_coverage:{total:sources.length,within_window:sources.filter(s=>s.window_status==='within_window').length,before_window:sources.filter(s=>s.window_status==='before_window').length,after_window:sources.filter(s=>s.window_status==='after_window').length,unknown_publication_date:sources.filter(s=>s.window_status==='unknown_publication_date').length},platform_samples:{total_records:records.length,in_window:inWindow,before_window:beforeWindow,after_window:afterWindow,unknown_publication_date:unknownDate,by_platform:[...platforms.values()]},source_catalog:sources};
}

/** ReportEngine-style input: complete saved engine findings and reviewed-claim quotes in one read. */
export function reportMaterials(db:Database,taskId:string,offset=0,limit=80){
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('成稿材料分页不合法');
 const all=db.rows('SELECT id,text,references_json FROM claims WHERE task_id=? ORDER BY created_at,rowid',taskId),evidence=new Map(db.rows('SELECT e.id,e.title,e.source_url,e.content,e.captured_at,m.published_at,m.author,m.publisher FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id LEFT JOIN evidence_metadata m ON m.evidence_id=e.id WHERE te.task_id=?',taskId).map(e=>[e.id,e]));
 const claims=all.slice(offset,offset+limit).map((c,i)=>({number:offset+i+1,id:c.id,text:c.text,references:JSON.parse(c.references_json).map((r:Row)=>{const source=evidence.get(r.evidence_id);if(!source||!source.content.includes(r.quote))throw Error('成稿材料引用不属于当前归档原文');return {...r,title:source.title,url:source.source_url,published_at:source.published_at||null,author:source.author||null,publisher:source.publisher||null,captured_at:source.captured_at};})}));
 const artifacts=db.rows("SELECT id,kind,role,data_json FROM artifacts WHERE task_id=? AND kind IN ('investigation_section','investigation','investigation_reflection','forum') ORDER BY rowid",taskId),sections=new Map<string,Row>(),engines=new Map<string,Row>(),reflections=new Map<string,Row>();
 const known=new Set(all.map(c=>c.id));
 for(const artifact of artifacts){const data=JSON.parse(artifact.data_json);
  if(['investigation','investigation_section'].includes(artifact.kind)){
   const ids=data.claim_ids||[];if(ids.some((id:string)=>!known.has(id)))continue;
   const item={artifact_id:artifact.id,role:artifact.role,...data};if(artifact.kind==='investigation')engines.set(artifact.role,item);else sections.set(artifact.role+':'+data.section_id,item);
  }else if(artifact.kind==='investigation_reflection'){
   const key=[artifact.role,data.section_id,data.cycle||0,data.round||0].join(':');reflections.set(key,{artifact_id:artifact.id,role:artifact.role,...data});
  }
 }
 const forum=artifacts.filter(a=>a.kind==='forum').slice(-6).map(a=>({artifact_id:a.id,...JSON.parse(a.data_json)}));
 const coverage=sampleCoverage(db,taskId),data={claims,...offset===0?{engine_results:[...engines.values()],section_results:[...sections.values()],reflections:[...reflections.values()],forum,...coverage}:{}},fingerprint=hash(encode(data));
 return {...data,hash:fingerprint,claim_count:all.length,offset,has_more:offset+claims.length<all.length,next_offset:offset+claims.length<all.length?offset+claims.length:null,note:'材料包按本任务冻结窗口、来源发布时间、平台记录类型、实际互动指标和本地情感标签整理；窗口外/日期未知材料需作背景或缺失标记，不得写成本窗口样本。结论正文与逐字引文完整返回，不截为120字符；调查/主持总结是分析材料，不自动成为来源事实。仅引用本任务结论序号，避免重复读取相同原文；缺少上下文时再按确切编号evidence_read。'};
}
