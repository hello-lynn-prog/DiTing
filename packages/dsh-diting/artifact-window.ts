import type { Row } from '../domain/db.js';
import {stagePayload} from '../reporting/stage-payload.js';
function checkpointChapter(data:unknown){try{return stagePayload('chapter',data);}catch{return {};}}

export function summarizeArtifact(kind: string, role: string, data: any) {
  if(kind==='report_chapter_submission'){const chapter=checkpointChapter(data.data);return {chapter_id:chapter?.id,title:chapter?.title,chars:chapter?.text?.length||0,error:String(data.error||'').slice(0,700),note:'完整章节已保留，report_chapter_repair仅改具体字段'};}
  if(kind==='investigation_submission')return {status:data.status,claims_count:data.claims?.length||0,error:String(data.error||'').slice(0,1200),note:'失败提交全文已保存；用artifact_read分段读取，仅修错误条目，不得当作已核验结论'};
  if(kind==='visual_observation')return {visual_id:data.visual_id,visual_hash:data.visual_hash,evidence_id:data.evidence_id,asset_id:data.asset_id,scope:data.scope,summary:data.observation?.summary,frame_count:data.frames?.length,note:data.note};
  if(kind==='investigation_section')return {section_id:data.section_id,title:data.section_title,claim_ids:data.claim_ids,gaps:data.gaps,source_backed_stop:data.source_backed_stop};
  if(kind==='investigation')return {claim_ids:Array.isArray(data.claim_ids)?data.claim_ids.slice(0,20):[],gaps:Array.isArray(data.gaps)?data.gaps.slice(0,3).map((gap:string)=>String(gap).slice(0,180)):[]};
  if(kind==='forum')return {summary:String(data.summary||'').slice(0,320),disagreements:Array.isArray(data.disagreements)?data.disagreements.slice(0,4).map((item:string)=>String(item).slice(0,180)):[],supplements:Array.isArray(data.supplements)?data.supplements.slice(0,4).map((item:string)=>String(item).slice(0,180)):[]};
  if(kind==='investigation_reflection')return {section_id:data.section_id,cycle:data.cycle,round:data.round,assessment:String(data.assessment||'').slice(0,260),findings:String(data.findings||'').slice(0,260),decision:data.decision,next_queries:Array.isArray(data.next_queries)?data.next_queries.slice(0,4):[]};
  if(kind==='media_discovery')return {query:data.query,kind:data.kind,result_count:Array.isArray(data.results)?data.results.length:0,results:(data.results||[]).slice(0,5).map((r:Row)=>({title:r.title,url:r.url,provider:r.provider})),evidence:false};
  if(kind==='media_assets')return {evidence_id:data.evidence_id,page_url:data.page_url,assets:(data.assets||[]).slice(0,5).map((a:Row)=>({type:a.type,url:a.url,description:a.description})),extraction:data.extraction};
  if(kind==='dataset')return {dimension:data.dimension,title:data.title,metric:data.metric,sample_size:data.sample_size,denominator:data.denominator,row_count:Array.isArray(data.rows)?data.rows.length:0};
  if(kind==='sample_annotation')return {evidence_id:data.evidence_id,sentiment:data.sentiment,topics:data.topics,quote:String(data.quote||'').slice(0,180)};
  if(kind==='report_stage'){const stageData=data.data||data;return {stage:data.stage,template_id:stageData.template_id,chapter_id:stageData.id,title:stageData.title,chars:stageData.text?.length};}
  return {available:true,role};
}

/** Keep only the newest useful index entry per evidence/role/table/stage. Full history remains addressable in storage. */
export function compactArtifactIndex(rows: any[]) {
  const chosen=new Map<string,any>(),counts:Record<string,number>={};
  for(const row of rows){counts[row.kind]=(counts[row.kind]||0)+1;let data:any={};try{data=JSON.parse(row.data_json||'{}');}catch{}
    const key=row.kind==='visual_observation'||row.kind==='media_assets'?`${row.kind}:${row.id}`:row.kind==='dataset'?`${row.kind}:${data.dimension||'unknown'}`:
      row.kind==='investigation_section'?`${row.kind}:${row.role}:${data.section_id||row.id}`:
      row.kind==='sample_annotation'?`${row.kind}:${data.evidence_id||row.role}`:
      row.kind==='report_chapter_submission'?`${row.kind}:${checkpointChapter(data.data)?.id||row.id}`:
      row.kind==='investigation_reflection'?`${row.kind}:${row.role}:${data.root_session_id||''}:${data.cycle||0}:${data.section_id||'overall'}:${data.round||1}`:
      row.kind==='investigation'||row.kind==='forum'||row.kind==='platform_collection'?`${row.kind}:${row.role}:${data.platform||''}`:
      row.kind==='report_stage'?`${row.kind}:${data.stage||'unknown'}:${data.stage==='chapter'?(data.data?.id||data.id||row.id):''}`:
      `${row.kind}:${row.role}`;
    const prior=chosen.get(key);if(!prior||String(row.created_at)>=String(prior.created_at))chosen.set(key,row);
  }
  return {rows:[...chosen.values()].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))),counts};
}

export function artifactWindow(serialized: string, offset: number, limit: number) {
  const nextOffset=offset+limit,hasMore=nextOffset<serialized.length;
  return {total_chars:serialized.length,offset,content:serialized.slice(offset,nextOffset),has_more:hasMore,next_offset:hasMore?nextOffset:null};
}
