import type {Database} from './db.js';

/** Trusted workflow state, separate from untrusted source content. Never exposes cookies or key refs. */
export function platformApprovalUpdates(db:Database,taskId:string){
 const rows=db.rows("SELECT a.id,a.status,a.request_json,b.id batch_id,b.status batch_status FROM approvals a LEFT JOIN crawl_batches b ON b.approval_id=a.id WHERE a.task_id=? AND a.operation='platform_keyword_crawl' ORDER BY a.rowid DESC LIMIT 20",taskId);
 return rows.flatMap(row=>{
  let scope;try{scope=JSON.parse(row.request_json);}catch{return [];}
  if(!['weibo','bilibili'].includes(scope.platform))return [];
  const options=Object.fromEntries(['access_mode','session_version','max_pages','comment_pages','max_requests',...(scope.platform==='weibo'?['max_posts','comments_per_post','include_long_text']:['max_videos','comments_per_video','order'])].filter(k=>Object.hasOwn(scope,k)).map(k=>[k,scope[k]]));
  const state=row.status==='approved'?(row.batch_status||'approved_not_started'):row.status;
  return [{approval_id:row.id,platform:scope.platform,state,batch_id:row.batch_id||null,...state==='approved_not_started'?{next_action:'本范围已批准但尚未执行；用以下crawl_deep参数原样执行，无需重新申请或扩大范围。',crawl_deep:{platform:scope.platform,query:scope.query,options}}:{}}];
 });
}

export function assertApprovedPlatformWorkFinished(db:Database,taskId:string){
 const pending=platformApprovalUpdates(db,taskId).filter(a=>a.state==='approved_not_started'||a.state==='running');
 if(pending.length)throw Error('已批准的平台取证尚未执行完：'+pending.map(a=>a.platform+' / '+a.state).join('、')+'。主Agent只让DiTing Prism执行这些已批准批次；不要重做已完成的公开调查。实际失败或0样本须保留结果，不等于必须采到数据。');
}
