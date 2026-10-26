import {z} from 'zod';
import {Configuration} from './configuration.js';
import {Service,Conflict} from './service.js';
import {encode,now,uid,type Row} from './db.js';
import {fetchText} from '../collectors/network.js';
export const platformIds=['weibo','bilibili'] as const;
export type PlatformId=typeof platformIds[number];
export type SessionSnapshot={platform:PlatformId;cookie_ref:string;version:string;expires_at:string|null;created_at:string};
export type PlatformAccess={mode:'saved_session';version:string;check:()=>void;headers:(url:string)=>Record<string,string>;scrub:(text:string)=>string;scrubJson:(text:string)=>string};
const endpoints={weibo:{origin:'https://m.weibo.cn',probe:'/api/config',paths:['/api/container/getIndex','/statuses/extend','/comments/hotflow','/api/config']},bilibili:{origin:'https://api.bilibili.com',probe:'/x/web-interface/nav',paths:['/x/web-interface/search/type','/x/v2/reply','/x/web-interface/nav']}} as const;
const saveSchema=z.object({enabled:z.boolean(),cookie:z.string().max(16000).optional(),expires_at:z.string().datetime({offset:true}).nullable().optional()}).strict();
export class PlatformAccounts{
 constructor(readonly config:Configuration){}
 private stored(platform:PlatformId){return this.config.get<(SessionSnapshot&{enabled:boolean})|null>('platform.session.'+platform,null);}
 private revoked(ref:string){return this.config.get<boolean>('platform.revoked.'+ref,false);}
 private usable(s:SessionSnapshot){if(this.revoked(s.cookie_ref))throw Error('该平台登录态已撤销，请重新保存并为此任务更新登录版本');if(s.expires_at&&Date.parse(s.expires_at)<=Date.now())throw Error('平台登录态已超过设置的有效期，请更新后重新审批');if(!this.config.hasSecret(s.cookie_ref))throw Error('平台登录态凭据不可用，请重新保存');}
 public(){return platformIds.map(id=>{const s=this.stored(id),revoked=s?this.revoked(s.cookie_ref):false,expired=!!s?.expires_at&&Date.parse(s.expires_at)<=Date.now(),health=this.config.get<Row>('platform.session.health.'+id,{status:'not_tested'});return {id,name:id==='weibo'?'微博':'B 站',enabled:!!s?.enabled,cookie_configured:!!s&&this.config.hasSecret(s.cookie_ref),revoked,expired,version:s?.version||null,expires_at:s?.expires_at||null,updated_at:s?.created_at||null,health:health.version===s?.version?health:{status:'not_tested'},origin:endpoints[id].origin};});}
 save(platform:PlatformId,input:unknown){
  const b=saveSchema.parse(input),previous=this.stored(platform),cookie=b.cookie?.trim().replace(/^Cookie:\s*/i,''),expires_at=b.expires_at===undefined?previous?.expires_at||null:b.expires_at;
  if(expires_at&&Date.parse(expires_at)<=Date.now())throw Error('有效期必须晚于当前时间，未知时可留空');
  if(cookie){
   if(!/^[\x20-\x7E]+$/.test(cookie)||!cookie.split(';').every(c=>/^\s*[^=;\s]+=[^;]*\s*$/.test(c)))throw Error('Cookie 格式无效；只填写浏览器 Cookie 请求头，不包含换行或其他请求头');
   const required=platform==='weibo'?'SUB':'SESSDATA';if(!cookie.split(';').some(c=>c.trim().startsWith(required+'=')))throw Error('此平台登录态缺少 '+required+'，请核对对应平台的 Cookie');
  }
  if(b.enabled&&!cookie){if(!previous)throw Error('启用前请先填写此平台登录态');this.usable(previous);}
  this.config.db.transaction(()=>{
   if(cookie){const snapshot={platform,cookie_ref:'platform.'+platform+'.'+uid('cookie'),version:uid('session'),expires_at,created_at:now(),enabled:b.enabled};this.config.putSecret(snapshot.cookie_ref,cookie);this.config.set('platform.session.'+platform,snapshot);this.config.set('platform.session.health.'+platform,{status:'not_tested',version:snapshot.version});}
   else if(previous)this.config.set('platform.session.'+platform,{...previous,enabled:b.enabled,expires_at});
  });return this.public().find(s=>s.id===platform)!;
 }
 revoke(platform:PlatformId){this.config.db.transaction(()=>{for(const s of this.config.db.rows('SELECT id FROM secrets WHERE id LIKE ?',`platform.${platform}.%`))this.config.set('platform.revoked.'+s.id,true);const old=this.stored(platform);if(old)this.config.set('platform.session.'+platform,{...old,enabled:false});this.config.set('platform.session.health.'+platform,{status:'revoked',version:old?.version||null,checked_at:now(),message:'已撤销该平台已保存的全部版本，相关采集不再携带它们发出新请求'});this.config.db.event(null,'platform_session.revoked',{message:'用户撤销该平台全部已保存登录版本',platform});});return this.public().find(s=>s.id===platform)!;}
 private current(platform:PlatformId):SessionSnapshot{const s=this.stored(platform);if(!s?.enabled)throw Error('请在定制中心 → Key 与服务保存并启用 '+(platform==='weibo'?'微博':'B 站')+' 登录态');this.usable(s);return s;}
 freeze(service:Service,taskId:string,token:string,platform:PlatformId):SessionSnapshot{
  return this.config.db.transaction(()=>{const task=service.requireRun(taskId,token),cfg=JSON.parse(task.config_json);let s:SessionSnapshot|undefined=cfg.platform_sessions?.[platform];
   if(!s){s=this.current(platform);cfg.platform_sessions={...(cfg.platform_sessions||{}),[platform]:s};this.config.db.run('UPDATE tasks SET config_json=?,revision=revision+1 WHERE id=?',encode(cfg),taskId);this.config.db.event(taskId,'platform_session.frozen',{message:'本任务首次使用时冻结平台登录版本；Cookie 正文不进入任务或模型',platform,version:s.version});}
   this.usable(s);return s;
  });
 }
 access(snapshot:SessionSnapshot):PlatformAccess{
  this.usable(snapshot);const cookie=this.config.secret(snapshot.cookie_ref)!,definition=endpoints[snapshot.platform],values=cookie.split(';').map(c=>c.trim().slice(c.trim().indexOf('=')+1)).filter(v=>v.length>=4),redactions=[cookie,...values.flatMap(v=>[v,encodeURIComponent(v)])].sort((a,b)=>b.length-a.length);
  const scrub=(text:string)=>redactions.reduce((s,value)=>s.replaceAll(value,'[redacted]'),text);
  return {mode:'saved_session',version:snapshot.version,check:()=>this.usable(snapshot),headers:(url:string)=>{this.usable(snapshot);const target=new URL(url);if(target.origin!==definition.origin||!definition.paths.includes(target.pathname as never))throw Error('平台登录态只能用于对应平台批准的只读接口');return {Cookie:cookie};},scrub,scrubJson:(text:string)=>{const payload=JSON.parse(text);let changed=false;const cleaned=JSON.stringify(payload,(_key,value)=>{if(typeof value!=='string')return value;const next=scrub(value);if(next!==value)changed=true;return next;});return changed?cleaned:text;}};
 }
 async probe(platform:PlatformId,signal:AbortSignal,fetcher=fetchText){
  const snapshot=this.current(platform),access=this.access(snapshot),endpoint=endpoints[platform],url=endpoint.origin+endpoint.probe;let status='unavailable',message='未取得可判定的登录状态';
  try{const response=await fetcher(url,signal,true,{headers:{...access.headers(url),Referer:endpoint.origin+'/'},allowedOrigins:[endpoint.origin],beforeRequest:target=>{access.headers(target);}});signal.throwIfAborted();access.check();const payload=JSON.parse(response.text),flag=platform==='weibo'?payload.data?.login:payload.data?.isLogin;
   if((platform==='weibo'?Number(payload.ok)===1:payload.code===0)&&typeof flag==='boolean'){status=flag?'authenticated':'not_authenticated';message=flag?'平台明确返回已登录；关键词与评论可用性仍需单独验收':'平台明确返回未登录，需更新 Cookie';}
   else if(platform==='bilibili'&&payload.code===-101){status='not_authenticated';message='平台明确要求登录，请更新 Cookie';}
  }catch(error){signal.throwIfAborted();const raw=error instanceof Error?error.message:'';if(/HTTP (403|412|429|432)|风控|验证/i.test(raw)){status='access_blocked';message='平台访问受限，无法据此判定 Cookie 是否有效；未绕过限制';}else if(/HTTP 401/.test(raw)){status='not_authenticated';message='平台要求重新登录';}else{message='登录验证未完成，请检查网络和登录态配置';}}
  const health={status,message,checked_at:now(),version:snapshot.version};this.config.db.transaction(()=>{if(this.stored(platform)?.version===snapshot.version&&!this.revoked(snapshot.cookie_ref))this.config.set('platform.session.health.'+platform,health);this.config.db.event(null,'platform_session.checked',{message,platform,status,version:snapshot.version});});return health;
 }
 refreshTask(service:Service,taskId:string,platform:PlatformId,revision:number){return this.config.db.transaction(()=>{
  const task=service.rawTask(taskId);if(task.revision!==revision)throw new Conflict('任务已变化，请刷新后操作');if(!['paused','waiting_runtime','waiting_evidence','waiting_input','waiting_approval','failed'].includes(task.status))throw new Conflict('请先暂停此任务；已完成任务须创建补充研究');
  const s=this.current(platform),cfg=JSON.parse(task.config_json);cfg.platform_sessions={...(cfg.platform_sessions||{}),[platform]:s};
  for(const a of this.config.db.rows("SELECT id,request_json FROM approvals WHERE task_id=? AND operation='platform_keyword_crawl' AND status='pending'",taskId)){const scope=JSON.parse(a.request_json);if(scope.platform===platform&&scope.access_mode==='saved_session')this.config.db.run("UPDATE approvals SET status='rejected',decided_at=? WHERE id=?",now(),a.id);}
  this.config.db.run("UPDATE tasks SET config_json=?,status='queued',lease_owner=NULL,lease_until=NULL,revision=revision+1,block_reason=NULL,updated_at=? WHERE id=?",encode(cfg),now(),taskId);
  this.config.db.event(taskId,'platform_session.refreshed',{message:'用户选择当前平台登录版本继续任务；新采集范围仍需重新审批',platform,version:s.version});this.config.db.event(taskId,'task.supplement',{message:`${platform==='weibo'?'微博':'B站'}后续取证使用已保存登录态（access_mode=saved_session）。登录版本已更新；先申请精确范围审批再执行。`});return {saved:true,version:s.version,task_id:taskId};
 });}
}
