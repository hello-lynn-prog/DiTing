import {encode,uid,now,type Database,type Row} from '../domain/db.js';
import type {Service} from '../domain/service.js';

/** Assemble persisted paragraph results; do not mark a wide-topic engine finished after only its first sections. */
export function finalizeInvestigatorSections(db:Database,service:Service,taskId:string,role:string,token:string,childSessionId:string,minimum:number){
 service.requireRun(taskId,token);const latest=new Map<string,Row>();
 for(const a of db.rows("SELECT id,data_json FROM artifacts WHERE task_id=? AND role=? AND kind='investigation_section' ORDER BY rowid",taskId,role)){const data=JSON.parse(a.data_json);latest.set(data.section_id,{...data,artifact_id:a.id});}
 const expected=new Set(db.rows("SELECT data_json FROM artifacts WHERE task_id=? AND role=? AND kind='investigation_reflection' ORDER BY rowid",taskId,role).map(a=>JSON.parse(a.data_json).section_id).filter(Boolean));
 for(const id of latest.keys())expected.add(id);const missing=[...expected].filter(id=>!latest.has(id)),needs=Math.max(0,minimum-latest.size);
 if(missing.length||needs)return {role_completed:false,sections_saved:latest.size,minimum_sections:minimum,missing_sections:missing,additional_sections_needed:needs,next:'本段已保存；继续其他缺少段落的检索/反思和带引文结论提交，不要结束成员。'};
 const sections=[...latest.values()],claimIds=[...new Set(sections.flatMap(s=>s.claim_ids||[]))];
 if(!claimIds.length)return {role_completed:false,sections_saved:latest.size,next:'尚无任何带引文结论，不能把空段落集合当作完整调查成果'};
 const id=uid('artifact'),data={claim_ids:claimIds,gaps:[...new Set(sections.flatMap(s=>s.gaps||[]))],sections:sections.map(s=>({section_id:s.section_id,title:s.section_title,claim_ids:s.claim_ids,gaps:s.gaps,artifact_id:s.artifact_id})),section_contract:true,child_session_id:childSessionId};
 db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',id,taskId,'investigation',role,encode(data),now());db.event(taskId,'investigation.sections_completed',{message:'按段汇总完整引擎成果，后半子题不再被扁平提交遗漏',role,sections:sections.length,claims:claimIds.length,artifact_id:id});
 return {role_completed:true,artifact_id:id,claim_ids:claimIds,sections_saved:sections.length,next:'全部要求段落已保存，可以结束本成员，主Agent将使用完整分段成果'};
}
