import type { Database, Row } from '../domain/db.js';
import { encode, now, uid } from '../domain/db.js';
import { Conflict, type Service } from '../domain/service.js';
import {z} from 'zod';

/** Reuse a rejected payload and change only explicitly indexed claims; all checks run again. */
export function repairInvestigationSubmission(db:Database,service:Service,taskId:string,role:string,submissionId:string,patches:unknown,removeIndexes:unknown,token:string,childSessionId:string){
  service.requireRun(taskId,token);const artifact=db.one("SELECT data_json FROM artifacts WHERE task_id=? AND id=? AND role=? AND kind='investigation_submission'",taskId,submissionId,role);if(!artifact)throw new Conflict('失败提交不存在或不属于当前任务与角色');
  const value=JSON.parse(artifact.data_json),reference=z.object({evidence_id:z.string(),quote:z.string().min(5),visual_id:z.string().optional(),visual_quote:z.string().min(5).optional(),visual_hash:z.string().optional()}).strict();
  const edits=z.array(z.object({index:z.number().int().min(0),text:z.string().min(5).max(10000).optional(),references:z.array(reference).min(1).optional(),dataset_refs:z.array(z.object({dataset_id:z.string(),row_key:z.string(),value:z.number().finite()}).strict()).optional()}).strict().refine(x=>x.text!==undefined||x.references!==undefined||x.dataset_refs!==undefined,'补丁须含具体修改')).max(30).parse(patches),removed=z.array(z.number().int().min(0)).max(30).parse(removeIndexes||[]),claims:Row[]=structuredClone(value.claims);
  if(new Set(edits.map(e=>e.index)).size!==edits.length)throw new Conflict('同一条目补丁重复');
  for(const edit of edits){if(edit.index>=claims.length||removed.includes(edit.index))throw new Conflict('补丁条目越界或同时被删除');const {index,...changes}=edit;claims[index]={...claims[index],...changes};}
  if(removed.some(i=>i>=claims.length))throw new Conflict('删除条目越界');
  const kept=claims.filter((_,i)=>!removed.includes(i));if(!kept.length)throw new Conflict('不能删除全部调查结论');
  const result=persistInvestigation(db,service,taskId,role,kept,[...(value.gaps||[]),...removed.map(i=>`修复时撤回原条目${i}，该判断未获核验支持`)],token,childSessionId,value.submission_options||{});
  db.event(taskId,'investigation.repaired',{message:'复用已保存提交，仅修指定条目并重新完成全部引用/数字校验',role,submission_id:submissionId,patched_indexes:edits.map(e=>e.index),removed_indexes:removed});return result;
}

/** Persist claims and their role artifact as one atomic, retry-safe operation. */
export function persistInvestigation(
  db: Database,
  service: Service,
  taskId: string,
  role: string,
  claims: Row[],
  gaps: string[],
  token: string,
  childSessionId: string,
  options:{kind?:'investigation'|'investigation_section';metadata?:Row}={},
): Row {
  try{return db.transaction(() => {
    const errors:string[]=[];
    const claimIds = claims.map((claim,index) => {
      const referencesJson = encode(claim.references);
      const existing = db.one('SELECT id FROM claims WHERE task_id=? AND text=? AND references_json=? ORDER BY created_at LIMIT 1', taskId, claim.text, referencesJson);
      try{return existing?.id || service.addClaim(taskId, claim.text, claim.references, token, claim.dataset_refs || []);}
      catch(error){if(!(error instanceof Conflict))throw error;service.requireRun(taskId,token);errors.push(`claims[${index}]：${error.message}`);return null;}
    });
    if(errors.length)throw new Conflict('本批结论未保存，请仅修正列出的条目后重交（其余条目不必改写）：\n'+errors.join('\n'));
    const artifactId = uid('artifact');
    const data = { ...options.metadata,claim_ids: claimIds, gaps, child_session_id: childSessionId };
    db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)', artifactId, taskId, options.kind||'investigation', role, encode(data), now());
    return { artifact_id: artifactId, claim_ids: claimIds, gaps };
  });}catch(error){
    service.requireRun(taskId,token);
    if(error instanceof Conflict){
      const artifactId=uid('artifact'),root=db.one('SELECT root_session_id FROM agent_runs WHERE child_session_id=? AND task_id=?',childSessionId,taskId)?.root_session_id;
      db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',artifactId,taskId,'investigation_submission',role,encode({claims,gaps,submission_options:options,error:error.message,child_session_id:childSessionId,root_session_id:root||null,input_version:service.reviewInput(taskId),status:'rejected'}),now());
      db.event(taskId,'investigation.submission_rejected',{message:'已保留失败提交全文和逐条错误；恢复时仅修具体条目，不必重做检索',role,artifact_id:artifactId});
    }throw error;
  }
}
