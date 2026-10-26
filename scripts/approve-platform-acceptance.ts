/** Apply the human's explicit one-off grant to matching pending requests only. Never starts a crawler. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {settings} from '../apps/server/settings.js';
import {Database,now} from '../packages/domain/db.js';
const cfg=settings(),saved=JSON.parse(readFileSync(join(cfg.dataDir,'diagnostics/platform-acceptance-20261021.json'),'utf8')),grant=saved.authorization;
const db=new Database(join(cfg.dataDir,'diting.sqlite3'),cfg.root),decisions=[];
try{
 const approvals=db.rows("SELECT * FROM approvals WHERE task_id=? AND operation='platform_keyword_crawl' ORDER BY rowid",saved.task_id);
 for(const row of approvals.filter(a=>a.status==='pending')){
  const scope=JSON.parse(row.request_json),used=approvals.filter(a=>a.status==='approved'),items=scope.platform==='weibo'?scope.max_posts:scope.max_videos,comments=scope.platform==='weibo'?scope.comments_per_post:scope.comments_per_video;
  const allowed=grant.platforms.includes(scope.platform)&&scope.access_mode==='saved_session'&&!!scope.session_version&&scope.query==='人工智能'&&items<=10&&comments<=3&&scope.max_requests<=15&&scope.max_pages===1&&scope.comment_pages===1&&!used.some(a=>JSON.parse(a.request_json).platform===scope.platform)&&used.reduce((n,a)=>n+JSON.parse(a.request_json).max_requests,0)+scope.max_requests<=30;
  const response=await fetch('http://127.0.0.1:'+cfg.port+'/api/approvals/'+row.id+'/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approved:allowed})});if(!response.ok)throw Error('审批未写入：'+response.status);
  const note={approval_id:row.id,approved:allowed,platform:scope.platform,scope,source:'explicit human grant recorded in task human_authorization artifact',checked_at:now()};db.event(saved.task_id,'acceptance.approval_applied',{message:allowed?'按用户明确授权批准精确平台范围':'请求超出本次明确授权，未批准扩大范围',...note});decisions.push(note);row.status=allowed?'approved':'rejected';
 }
 console.log(JSON.stringify({task_id:saved.task_id,decisions}));
}finally{db.close();}
