import { Database, type Row } from '../domain/db.js';
import {assertApprovedPlatformWorkFinished} from '../domain/platform-approval-updates.js';

/** Mechanical prerequisites for an LLM review; this validates evidence wiring, not real-world truth. */
export function assertReviewPrerequisites(db:Database,taskId:string,gate:'sufficiency'|'verifier'|'advocate',reason:string){
  assertApprovedPlatformWorkFinished(db,taskId);
  const investigations=db.rows("SELECT role,data_json FROM artifacts WHERE task_id=? AND kind='investigation' ORDER BY created_at",taskId);
  const required=['insight','media','query'];
  for(const role of required){const result=investigations.filter(x=>x.role===role).flatMap(x=>JSON.parse(x.data_json).claim_ids||[]);if(!result.length)throw new Error(`${role} 调查成员尚未提交带证据的结论，门禁不能通过`);for(const id of result)if(!db.one('SELECT id FROM claims WHERE id=? AND task_id=?',id,taskId))throw new Error(`${role} 调查产物引用了其他任务结论`);}
  const forum=db.rows("SELECT data_json FROM artifacts WHERE task_id=? AND kind='forum' ORDER BY created_at",taskId).at(-1);
  if(!forum||String(JSON.parse(forum.data_json).summary||'').trim().length<30)throw new Error('ForumHost 尚未形成有内容的共识与分歧记录');
  const normalized=reason.toLocaleLowerCase();
  const criteria:Record<typeof gate,RegExp>={sufficiency:/范围|覆盖|缺口|充分/,verifier:/原文|来源|交叉|独立|单一/,advocate:/反例|替代|局限|偏差|稳健|风险/};
  if(!criteria[gate].test(normalized))throw new Error(`${gate} 门禁理由必须明确记录该门禁检查项`);
  if(gate==='sufficiency'){
    const task=db.one('SELECT title FROM tasks WHERE id=?',taskId), title=String(task?.title||'');
    if(/行业|舆情|全网|近期|热点|趋势/.test(title)){
      const count=db.one('SELECT COUNT(DISTINCT e.id) n FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=?',taskId)?.n||0;
      const hosts=new Set(db.rows('SELECT e.source_url FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=?',taskId).flatMap(r=>{try{return [new URL(r.source_url).hostname]}catch{return []}}));
      if(count<30||hosts.size<10)throw new Error(`宽主题最低覆盖未达到：当前 ${count} 条去重原文、${hosts.size} 个来源域名；门槛为至少 30 条原文、10 个来源域名。若预算或平台限制无法达到，须先把研究范围明确收窄，不能按完整行业研判通过。`);
      const assessments=investigations.filter(x=>['insight','media','query'].includes(x.role)).flatMap(x=>JSON.parse(x.data_json).gaps||[]);
      if(assessments.length>0&&assessments.every(g=>String(g).trim().length<8))throw new Error('调查成员的待补问题记录无效；请明确记录未解决的具体覆盖缺口或说明无缺口的依据');
    }
  }
}

export function reportCoverage(db:Database,taskId:string){
  const claims=db.rows('SELECT id,references_json FROM claims WHERE task_id=?',taskId),evidence=new Set(db.rows('SELECT evidence_id FROM task_evidence WHERE task_id=?',taskId).map(r=>r.evidence_id));
  return claims.map((claim:Row)=>{const refs=JSON.parse(claim.references_json);return {claim_id:claim.id,reference_count:refs.length,valid_reference_count:refs.filter((r:Row)=>evidence.has(r.evidence_id)).length,source_hosts:[...new Set(refs.flatMap((r:Row)=>{const row=db.one('SELECT source_url FROM evidence WHERE id=?',r.evidence_id);try{return row?[new URL(row.source_url).hostname]:[]}catch{return []}}))]};});
}
