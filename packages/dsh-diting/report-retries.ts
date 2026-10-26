import {type Database,type Row} from '../domain/db.js';
import {type Service} from '../domain/service.js';

/** Stop a broken submission loop while keeping the original chapters and exact errors. */
export function stopRepeatedReportFailures(db:Database,service:Service,taskId:string,token:string,childId:string,limit=3){
  const events=db.rows("SELECT kind,payload_json FROM events WHERE task_id=? AND kind IN ('tool.failed','tool.completed') AND json_extract(payload_json,'$.child_session_id')=? AND json_extract(payload_json,'$.tool') IN ('report_stage','report_chapter_repair','report_draft') ORDER BY id DESC LIMIT ?",taskId,childId,limit);
  if(events.length<limit||events.some(e=>e.kind==='tool.completed'))return false;
  const errors=events.map(e=>JSON.parse(e.payload_json) as Row);
  const reason=`报告连续 ${limit} 次提交未通过校验，已暂停以防空转。已保存章节保留；请处理具体错误后从成稿继续：${errors[0].message}`;
  db.event(taskId,'report.retry_limit',{message:reason,child_session_id:childId,errors:errors.map(e=>e.message)});
  return service.waitRuntime(taskId,token,reason,'paused');
}
