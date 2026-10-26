import {z} from 'zod';
import {Service,Conflict,Missing} from './service.js';
import {encode,now,uid,type Row} from './db.js';
import {bilibiliScope,crawlBilibili} from '../collectors/bilibili-keyword.js';
import {weiboScope,crawlWeibo} from '../collectors/weibo-keyword.js';
import {fetchText} from '../collectors/network.js';
import type {PlatformDependencies} from '../collectors/platform-session.js';
import type {Configuration} from './configuration.js';
import {PlatformAccounts,type PlatformAccess} from './platform-accounts.js';
export const platformScope=z.union([bilibiliScope,weiboScope]);
export class DeepCrawl{
 constructor(readonly service:Service,readonly deps:PlatformDependencies={},readonly accounts?:PlatformAccounts){}
 async request(taskId:string,token:string,input:unknown,signal:AbortSignal){
  signal.throwIfAborted();this.service.requireRun(taskId,token);
  const scope=platformScope.parse(input),db=this.service.db;let access:PlatformAccess|undefined;
  if(scope.access_mode==='saved_session'){
   if(!this.accounts)throw Error('平台登录态管理尚未连接；不会在公开模式中偷偷使用 Cookie');
   const snapshot=this.accounts.freeze(this.service,taskId,token,scope.platform);
   if(scope.session_version&&scope.session_version!==snapshot.version)throw Error('请求的登录版本与此任务冻结版本不一致，请更新任务登录态并重新审批');
   scope.session_version=snapshot.version;access=this.accounts.access(snapshot);
  }else if(scope.session_version)throw Error('公开模式不能引用平台登录版本');
  const encoded=encode(scope);
  const approval=db.one("SELECT * FROM approvals WHERE task_id=? AND operation='platform_keyword_crawl' AND request_json=? ORDER BY rowid DESC LIMIT 1",taskId,encoded);
  if(approval?.status==='rejected')return {executed:false,reason:'用户已拒绝本次精确范围',scope};
  if(!approval||approval.status!=='approved'){
   const id=approval?.id||this.service.requestCrawlApproval(taskId,'platform_keyword_crawl',scope,token);
   return {executed:false,approval_id:id,status:'pending',scope,note:'尚未采集，主 Agent 应记录等待审批'};
  }
  const batch=db.transaction<Row>(()=>{
   this.service.requireRun(taskId,token);const found=db.one('SELECT * FROM crawl_batches WHERE approval_id=?',approval.id);
   if(found&&['completed','partial','failed'].includes(found.status))return {...found,reuse:true};
   if(found?.status==='running'&&found.lease_token===token)return {...found,inflight:true};
   const stamp=now();
   if(found){db.run("UPDATE crawl_batches SET status='running',lease_token=?,updated_at=? WHERE id=?",token,stamp,found.id);db.event(taskId,'crawl.resumed',{message:'复用已成功取得的页面，继续批准范围内的采样',batch_id:found.id});return {...found,status:'running'};}
   const id=uid('crawl');db.run('INSERT INTO crawl_batches VALUES(?,?,?,?,?,?,?,NULL,?,?)',id,taskId,approval.id,scope.platform,encoded,'running',token,stamp,stamp);db.event(taskId,'crawl.started',{message:'开始已批准的有界平台取证批次',batch_id:id,platform:scope.platform,scope});return {id};
  });
  if(batch.reuse)return {executed:true,reused:true,batch_id:batch.id,...JSON.parse(batch.result_json)};
  if(batch.inflight)return {executed:false,status:'running',batch_id:batch.id,note:'同一批准范围已在执行，不启动重复采集'};
  try{
   const fetcher=this.deps.fetcher||fetchText,deps={...this.deps,access,batchId:batch.id};
   const result=scope.platform==='weibo'?await crawlWeibo(this.service,taskId,token,scope,signal,fetcher,deps):await crawlBilibili(this.service,taskId,token,scope,signal,fetcher,deps);
   signal.throwIfAborted();this.service.requireRun(taskId,token);
   const status=result.errors.length?(result.records.length?'partial':'failed'):'completed',summary={...result,status,total_requests:db.one('SELECT COALESCE(SUM(attempts),0) n FROM crawl_pages WHERE batch_id=?',batch.id)!.n};
   db.transaction(()=>{this.service.requireRun(taskId,token);db.run('UPDATE crawl_batches SET status=?,result_json=?,updated_at=? WHERE id=?',status,encode(summary),now(),batch.id);db.event(taskId,'crawl.finished',{message:'平台取证批次结束，保留范围、缺口和原始响应',batch_id:batch.id,platform:scope.platform,status,records:result.records.length,errors:result.errors.length});});
   return {executed:true,reused:false,batch_id:batch.id,...summary};
  }catch(error){
   try{this.service.requireRun(taskId,token);db.run("UPDATE crawl_batches SET status='interrupted',updated_at=? WHERE id=?",now(),batch.id);db.event(taskId,'crawl.interrupted',{message:'采集被中断；已成功页面保留，恢复后不重复请求',batch_id:batch.id});}catch{}
   throw error;
  }
 }
 runs(taskId?:string):Row[]{return this.service.db.rows('SELECT b.*,t.status task_status FROM crawl_batches b JOIN tasks t ON t.id=b.task_id'+(taskId?' WHERE b.task_id=?':'')+' ORDER BY b.created_at DESC,b.rowid DESC LIMIT 100',...(taskId?[taskId]:[])).map(({lease_token,scope_json,result_json,...b})=>{const result=result_json?JSON.parse(result_json):null;if(result){result.record_count=result.records.length;delete result.records;}return {...b,status:b.status==='running'&&b.task_status!=='running'?'interrupted':b.status,scope:JSON.parse(scope_json),result};});}
 retryApproval(batchId:string){
  const db=this.service.db;return db.transaction(()=>{
   const batch=db.one('SELECT * FROM crawl_batches WHERE id=?',batchId);if(!batch)throw new Missing('采集批次不存在');
   const task=this.service.rawTask(batch.task_id);if(['completed','cancelled','running','queued'].includes(task.status))throw new Conflict('运行中或已结束研究不能从此处重复申请；请先处理当前任务或新建补充研究');
   const current=db.one("SELECT * FROM approvals WHERE task_id=? AND operation='platform_keyword_crawl' AND request_json=? ORDER BY rowid DESC LIMIT 1",task.id,batch.scope_json);
   if(current?.status==='pending')return {approval_id:current.id,reused:true};
   const id=this.service.requestCrawlApproval(task.id,'platform_keyword_crawl',JSON.parse(batch.scope_json));
   db.run("UPDATE tasks SET status='waiting_approval',lease_owner=NULL,lease_until=NULL,block_reason=?,revision=revision+1,updated_at=? WHERE id=?",'用户申请重新采集，等待批准相同精确范围',now(),task.id);db.event(task.id,'crawl.retry_requested',{message:'用户申请重新采集；旧批次和证据保留，批准后建立新批次',batch_id:batchId,approval_id:id});return {approval_id:id,reused:false};
  });
 }
 directory(config?:Configuration){return [{id:'bilibili',name:'B 站公开关键词与评论',types:['video_metadata','comment']},{id:'weibo',name:'微博公开关键词与评论',types:['post','comment']}].map(p=>{const last=this.service.db.one('SELECT b.id,b.status,b.updated_at,b.result_json,t.status task_status FROM crawl_batches b JOIN tasks t ON t.id=b.task_id WHERE b.platform=? ORDER BY b.created_at DESC,b.rowid DESC LIMIT 1',p.id),result=last?.result_json?JSON.parse(last.result_json):null,probe=config?.get<Row|null>('collector.health.'+p.id,null),useProbe=probe&&(!last||probe.checked_at>last.updated_at);return {...p,implementation:'typescript_native',login_supported:true,login_method:'persistent_qr_browser_and_encrypted_cookie',session:config?new PlatformAccounts(config).public().find(s=>s.id===p.id):null,status:useProbe?probe.status:last?.status==='running'&&last.task_status!=='running'?'interrupted':last?.status||'not_tested',check_kind:useProbe?'isolated_preflight':last?'task_batch':null,last_batch_id:last?.id||null,last_checked_at:useProbe?probe.checked_at:last?.updated_at||null,record_count:useProbe?probe.records:result?.records.length??null,errors:useProbe?probe.errors:result?.errors||[],note:useProbe?'最近状态来自隔离公开 API 连通验收；样本未放入正式任务，不代表完整评论采集已验收。':'首次使用可在定制中心扫码登录；浏览器状态保存在本机 data/browser_data，采集使用加密冻结的登录态。真实可用性由实际批次判断'};});}
}
