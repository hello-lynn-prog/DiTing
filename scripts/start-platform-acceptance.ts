/** One explicitly authorized ¥5 acceptance, without altering existing research or credentials. */
import {mkdirSync,readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {settings} from '../apps/server/settings.js';
import {Database,now,encode,uid} from '../packages/domain/db.js';
const cfg=settings(),origin='http://127.0.0.1:'+cfg.port,db=new Database(join(cfg.dataDir,'diting.sqlite3'),cfg.root);
try{
 if(db.one("SELECT id FROM tasks WHERE status IN ('running','queued')"))throw Error('已有任务执行，不再启动另一条收费验收');
 const previous=db.one("SELECT payload_json FROM events WHERE kind='acceptance.platform_authorized' ORDER BY id DESC LIMIT 1");
 if(previous)throw Error('本次人工授权已用于一个验收任务，不重复创建付费任务');
 const post=async(path:string,payload:unknown)=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!response.ok)throw Error('验收请求失败：'+response.status);return await response.json() as any;};
 const parent='task_47f49e8f60c547c38b55db927d2e58f2';
 const authorization={authorized_at:now(),source:'human reply in current Codex conversation',model_budget:5,window_days:7,platforms:['weibo','bilibili'],maximum_items_per_platform:10,comments_per_item:3,total_platform_requests:30,per_platform_request_cap:15,access_mode:'saved_session',one_batch_per_platform:true};
 const title='请深度研判近7天AI行业争议，覆盖AI Agent落地、世界模型与物理AI、融资预期、安全治理四个方面，模型预算上限5元。采用社会公共热点事件分析报告内置模板，保留六章及17个编号子节，按BettaFish约40000字规划，具体案例、多方观点、机制与行动建议充分展开。允许复用已归档公开原文，保留采集时间并更新检索。用户现已明确授权纳入近7天微博/B站真实主题样本：Media必须先各申请一次crawl_deep，access_mode=saved_session，query=人工智能；weibo选max_posts=10/comments_per_post=3/include_long_text=true，bilibili选max_videos=10/comments_per_video=3/order=pubdate；两者max_pages=1/comment_pages=1/max_requests=15。两平台合计最多30次请求，每平台只运行一个批准批次，不擅自重试新增批次或扩大日期。等待范围审批后复用同一请求执行，不要绕过审批。平台取证和公开网页调查并行推进，结束前Insight读取本任务平台样本、执行本地情感/统计，Report使用真实互动与样本统计，不把新闻情感当公众情感。全部原文、评论、指标、过程与失败均须保存；0样本如实说明，不扩大历史窗口。报告以中文分析为主，图表采用认证底表，溯源集中在文末。';
 const files:Record<string,string>={};function walk(dir:string){for(const name of readdirSync(dir)){const path=join(dir,name);if(statSync(path).isDirectory())walk(path);else files[relative(cfg.root,path).replaceAll('\\','/')]=createHash('sha256').update(readFileSync(path)).digest('hex');}}for(const part of ['dist/apps','dist/packages','web','assets/report-templates'])walk(join(cfg.root,part));
 const session=await post('/api/sessions',{title:'真实平台样本 · 完整研判验收',parent_task_id:parent}),sent=await post('/api/sessions/'+session.id+'/messages',{text:title,request_id:'authorized-platform-acceptance-20261021',parent_id:parent});if(!sent.task_id)throw Error('研究未入队');
 const artifact=uid('artifact');db.transaction(()=>{db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',artifact,sent.task_id,'human_authorization','system',encode(authorization),now());db.event(sent.task_id,'acceptance.platform_authorized',{message:'用户在当前对话明确批准真实平台样本范围与新增¥5模型预算',authorization,artifact_id:artifact});});
 const file=join(cfg.dataDir,'diagnostics','platform-acceptance-20261021.json');mkdirSync(join(cfg.dataDir,'diagnostics'),{recursive:true});const saved={task_id:sent.task_id,session_id:session.id,parent_task_id:parent,started_at:now(),authorization,condition:'first publication retained; no paid auto-restart; human-approved bounded platform batches; no operator prose edits',clean:true,code_fingerprints:files};writeFileSync(file,JSON.stringify(saved,null,2));console.log(JSON.stringify({file,...saved,code_fingerprints:Object.keys(files).length}));
}finally{db.close();}
