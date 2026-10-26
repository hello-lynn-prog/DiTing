import {Service} from '../domain/service.js';
import {hash,type Row} from '../domain/db.js';

/** Explicitly attach only previously public-fetched pages; imported/private/session records stay isolated. */
export function attachPublicLibrary(service:Service,taskId:string,terms:string[],token:string){
  const task=service.rawTask(taskId),scope=JSON.parse(task.config_json);if(!scope.reuse_public_library)return [];
  const safe=terms.slice(0,21),clauses=safe.map(()=>'(e.title LIKE ? OR e.content LIKE ?)').join(' OR '),start=new Date(Date.parse(task.created_at)-(scope.window_days||7)*86400000).toISOString().slice(0,10),end=task.created_at.slice(0,10);
  if(!safe.length)return [];
  const rows=service.db.rows(`SELECT e.* FROM evidence e LEFT JOIN evidence_metadata m ON m.evidence_id=e.id WHERE e.origin IN ('web_fetch','firecrawl') AND NOT EXISTS(SELECT 1 FROM content_records c WHERE c.evidence_id=e.id) AND (m.published_at IS NULL OR substr(m.published_at,1,10) BETWEEN ? AND ?) AND e.captured_at>=? AND (${clauses}) ORDER BY e.captured_at DESC LIMIT 30`,start,end,start,...safe.flatMap(t=>['%'+t+'%','%'+t+'%']));
  const attached:Row[]=[];for(const row of rows){
    const canonical=service.db.one('SELECT id FROM evidence WHERE source_url=? AND content_hash=?',row.source_url,hash(row.content));
    if(service.db.one('SELECT 1 FROM task_evidence WHERE task_id=? AND evidence_id=?',taskId,canonical?.id||row.id))continue;
    const id=service.archive(taskId,row.source_url,row.title,row.content,row.origin,token);
    // Some legacy snapshots hash the raw response rather than its normalized text.
    // Keep the old record immutable, and use the ID actually returned by archive().
    if(!canonical&&id!==row.id){service.db.run('UPDATE evidence SET captured_at=? WHERE id=?',row.captured_at,id);const meta=service.db.one('SELECT * FROM evidence_metadata WHERE evidence_id=?',row.id);if(meta)service.db.run('INSERT OR IGNORE INTO evidence_metadata VALUES(?,?,?,?,?,?,?)',id,meta.published_at,meta.author,meta.publisher,meta.method,meta.raw_json,meta.updated_at);}
    attached.push({id,source_snapshot_id:row.id,url:row.source_url,captured_at:row.captured_at});
  }
  if(attached.length)service.db.event(taskId,'research.library_reused',{message:'按任务明确允许的范围复用已归档公开原文；保留原采集时间，不声称本轮重新抓取',pages:attached});return attached;
}
