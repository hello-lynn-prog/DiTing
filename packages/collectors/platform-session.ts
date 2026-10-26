import {setTimeout as delay} from 'node:timers/promises';
import {fetchText} from './network.js';
import {Service} from '../domain/service.js';
import {encode,hash,now,uid,type Row} from '../domain/db.js';
import type {PlatformAccess} from '../domain/platform-accounts.js';
import {frozenResearchWindow} from '../domain/research-window.js';

export type PlatformDependencies={fetcher?:typeof fetchText;wait?:(ms:number,signal:AbortSignal)=>Promise<unknown>;batchId?:string;access?:PlatformAccess};
export const numeric=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:typeof value==='string'&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
export const unixDate=(value:unknown)=>{const n=numeric(value);if(!n||n>253402300799)return null;return new Date(n*1000).toISOString();};
export class PlatformSession{
 readonly records:Row[]=[];readonly errors:Row[]=[];readonly window:{start:string;end:string;unknown_dates:string};
 requests=0;cache_hits=0;skipped_outside_window=0;stopped=false;private lastRequest=0;
 constructor(readonly service:Service,readonly taskId:string,readonly token:string,readonly platform:string,readonly query:string,readonly maxRequests:number,readonly signal:AbortSignal,readonly deps:PlatformDependencies={}){
  const task=service.rawTask(taskId),frozen=frozenResearchWindow(task.created_at,JSON.parse(task.config_json).window_days||7);
  this.window={start:frozen.start,end:frozen.end,unknown_dates:'保留未知，不宣称处于研究窗口内'};
 }
 check(){this.signal.throwIfAborted();this.service.requireRun(this.taskId,this.token);this.deps.access?.check();}
 within(value:string|null){if(!value)return true;const ts=Date.parse(value),valid=ts>=Date.parse(this.window.start)&&ts<=Date.parse(this.window.end);if(!valid)this.skipped_outside_window++;return valid;}
 async get(url:string,operation:string,validate:(payload:Row)=>Row|null):Promise<Row|null>{
  this.check();if(this.stopped)return null;
  const db=this.service.db,key=hash(url),batch=this.deps.batchId,page=batch?db.one('SELECT * FROM crawl_pages WHERE batch_id=? AND request_hash=?',batch,key):undefined;
  if(page?.status==='succeeded'){this.cache_hits++;return validate(JSON.parse(page.payload_json));}
  const previous=batch?db.one('SELECT COALESCE(SUM(attempts),0) n FROM crawl_pages WHERE batch_id=?',batch)!.n:this.requests;
  if(previous>=this.maxRequests){this.errors.push({operation,error:'已达到批准的网络请求上限，未继续翻页'});this.stopped=true;return null;}
  const wait=Math.max(0,1200-(Date.now()-this.lastRequest));if(wait)await (this.deps.wait||((ms,s)=>delay(ms,undefined,{signal:s})))(wait,this.signal);
  this.check();this.lastRequest=Date.now();this.requests++;
  if(batch)db.run(`INSERT INTO crawl_pages VALUES(?,?,?,?,?,'running',NULL,NULL,1,?,?) ON CONFLICT(batch_id,request_hash) DO UPDATE SET attempts=attempts+1,status='running',updated_at=excluded.updated_at`,uid('page'),batch,key,operation,url,now(),now());
  try{
   const response=await(this.deps.fetcher||fetchText)(url,this.signal,true,{headers:{Referer:this.platform==='weibo'?'https://m.weibo.cn/':'https://www.bilibili.com/',...(this.deps.access?.headers(url)||{})},allowedOrigins:[new URL(url).origin],beforeRequest:target=>{this.check();this.deps.access?.headers(target);}});
   this.check();let responseText:string,payload:Row;
   try{responseText=this.deps.access?.scrubJson(response.text)||response.text;payload=JSON.parse(responseText);}catch{throw Error('平台未返回可解析 JSON，可能需要登录或访问受限');}
   const result=validate(payload);
   if(result===null)throw Error('平台响应缺少明确的成功标志或列表');
   db.transaction(()=>{this.check();db.run('INSERT INTO acquisitions VALUES(?,?,?,?,?,?,?)',uid('acq'),this.taskId,this.platform,operation,'succeeded','已取得并校验平台返回；批准范围保留，敏感登录字段会脱敏，不代表全平台覆盖',now());if(batch)db.run("UPDATE crawl_pages SET status='succeeded',payload_json=?,error=NULL,updated_at=? WHERE batch_id=? AND request_hash=?",responseText,now(),batch,key);});
   return result;
  }catch(error){
   this.check();const original=error instanceof Error?error.message:'平台请求失败',message=(this.deps.access?.scrub(original)||original).slice(0,250);
   if(/HTTP (?:401|403|412|429)|平台未允许公开读取|平台拒绝本次请求|登录|登陆|风控|验证|security|captcha|blocked|频繁/i.test(message))this.stopped=true;
   db.transaction(()=>{this.check();db.run('INSERT INTO acquisitions VALUES(?,?,?,?,?,?,?)',uid('acq'),this.taskId,this.platform,operation,'failed',message,now());if(batch)db.run("UPDATE crawl_pages SET status='failed',error=?,updated_at=? WHERE batch_id=? AND request_hash=?",message,now(),batch,key);});
   this.errors.push({operation,error:message});return null;
  }
 }
 save(row:Row){
  this.check();const db=this.service.db;
  if(this.records.some(r=>r.record_id===String(row.record_id)&&r.record_type===row.record_type))return;
  const previous=db.one('SELECT * FROM content_records WHERE task_id=? AND platform=? AND record_id=? AND record_type=?',this.taskId,this.platform,String(row.record_id),row.record_type);
  if(previous){this.records.push({id:previous.id,record_id:previous.record_id,record_type:previous.record_type,title:previous.title,url:previous.url,text:previous.text,author:previous.author,published_at:previous.published_at,metrics:JSON.parse(previous.metrics_json),evidence_id:previous.evidence_id,reused:true});return;}
  const content=[`公开平台 ${this.platform} ${row.record_type} 文本；只支持已取得文本/元数据，不表示已观看图片或视频。`,'标题：'+row.title,'正文：'+row.text,'公开作者：'+(row.author||'未提供'),'平台发布时间：'+(row.published_at||'未提供'),'原始指标：'+encode(row.metrics),row.text_complete===false?'正文覆盖：平台返回截断文本，完整正文未取得。':'正文覆盖：仅当前平台返回文本，可能缺少附件或外链。'].join('\n');
  db.transaction(()=>{
   this.check();const evidence_id=this.service.archive(this.taskId,row.url,row.title||'公开评论',content,this.platform+'_'+row.record_type,this.token,{author:row.author,published_at:row.published_at,publisher:this.platform,method:'platform_response'}),id=uid('content');
   db.run('INSERT INTO content_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,this.taskId,this.platform,String(row.record_id),row.record_type,row.url,row.title,row.text,row.author,row.published_at,encode(row.metrics),encode(row.raw),evidence_id,now());
   db.run('INSERT INTO content_provenance VALUES(?,?,?,?,?)',id,this.deps.batchId||null,row.parent_record_id||null,row.page_url||row.url,this.query);
   const raw=row.raw?.post||row.raw||{},media:Row[]=[];const add=(type:string,url:unknown)=>{if(typeof url!=='string')return;const value=url.startsWith('//')?'https:'+url:url;if(/^https?:\/\//.test(value)&&!media.some(a=>a.url===value))media.push({type,url:value,description:type==='image'?'平台原始响应声明的图片/封面':'平台原始响应声明的视频'});};
   for(const pic of raw.pics||[])add('image',pic.large?.url||pic.url);for(const pic of raw.content?.pictures||[])add('image',pic.img_src);add('image',raw.pic?.large?.url||raw.pic);const video=raw.page_info?.media_info;add('video',video?.stream_url_hd||video?.stream_url);
   if(media.length)db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',uid('artifact'),this.taskId,'media_assets','media',encode({evidence_id,page_url:row.url,assets:media.slice(0,10),extraction:'platform response declaration; not visual verification'}),now());
   this.records.push({...row,record_id:String(row.record_id),id,evidence_id,media_assets:media.slice(0,10)});
  });
 }
 result(scope:Row,coverage:string){return {platform:this.platform,scope,window:this.window,skipped_outside_window:this.skipped_outside_window,requests:this.requests,cache_hits:this.cache_hits,records:this.records.map(({raw,...r})=>r),errors:this.errors,truncated:true,coverage,deduplication:'同一任务按平台、记录 ID 和类型保留首次归档版本；再次采集的原始响应另存批次页面，不覆盖原文',observed_at:now()};}
}
