/** Independent public endpoint parser; no copied platform crawler implementation, cookies, login or signing code. */
import {z} from 'zod';
import {Service} from '../domain/service.js';
import type {Row} from '../domain/db.js';
import {fetchText,plainText} from './network.js';
import {PlatformSession,numeric,type PlatformDependencies} from './platform-session.js';
export const weiboScope=z.object({platform:z.literal('weibo'),query:z.string().trim().min(2).max(200),access_mode:z.enum(['public','saved_session']).default('public'),session_version:z.string().max(100).optional(),max_pages:z.number().int().min(1).max(3).default(1),max_posts:z.number().int().min(1).max(10).default(3),comments_per_post:z.number().int().min(0).max(60).default(0),comment_pages:z.number().int().min(1).max(3).default(1),include_long_text:z.boolean().default(true),max_requests:z.number().int().min(1).max(30).default(20)}).strict();
// Relative timestamps are retained raw and remain unknown; never use capture time as publish time.
export function weiboDate(value:unknown):string|null{
 if(typeof value!=='string'||!(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} [\d:]{8} [+-]\d{4} \d{4}$/.test(value)||/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(value)))return null;
 const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null;
}
function posts(cards:unknown):Row[]{
 if(!Array.isArray(cards))throw Error('平台响应缺少卡片列表');
 return cards.flatMap((card:Row)=>card.card_type===9&&card.mblog?[card.mblog]:Array.isArray(card.card_group)?card.card_group.filter((c:Row)=>c.card_type===9&&c.mblog).map((c:Row)=>c.mblog):[]);
}
export async function crawlWeibo(service:Service,taskId:string,token:string,input:unknown,signal:AbortSignal,fetcher=fetchText,deps:PlatformDependencies={}){
 const scope=weiboScope.parse(input),s=new PlatformSession(service,taskId,token,'weibo',scope.query,scope.max_requests,signal,{...deps,fetcher}),found:Row[]=[],seen=new Set<string>();
 if(scope.access_mode==='saved_session'&&!deps.access)throw Error('使用登录态的采集必须先取得本任务冻结的登录版本');
 const validate=(payload:Row)=>{if(Number(payload.ok)!==1)throw Error('平台未允许公开读取：'+String(payload.msg||payload.message||payload.ok));if(!payload.data||typeof payload.data!=='object')throw Error('平台未返回数据对象');return payload.data;};
 for(let page=1;page<=scope.max_pages&&found.length<scope.max_posts&&!s.stopped;page++){
  const url='https://m.weibo.cn/api/container/getIndex?'+new URLSearchParams({containerid:'100103type=1&q='+scope.query,page_type:'searchall',page:String(page)});
  const data=await s.get(url,'platform_search',payload=>{const data=validate(payload);posts(data.cards);return data;});if(!data)break;const rows=posts(data.cards);let fresh=0;
  for(const post of rows){const id=String(post.idstr||post.id||'');if(!/^\d+$/.test(id)||seen.has(id))continue;seen.add(id);fresh++;if(!s.within(weiboDate(post.created_at)))continue;found.push({...post,_id:id,_page:url});if(found.length>=scope.max_posts)break;}
  if(!rows.length||!fresh)break;
 }
 for(const post of found){
  s.check();const {_id:id,_page:page_url,...raw}=post,url='https://m.weibo.cn/detail/'+id;let text=plainText(String(post.text||'')),text_complete=!post.isLongText,long_text:Row|null=null;
  if(post.isLongText&&scope.include_long_text&&!s.stopped){long_text=await s.get('https://m.weibo.cn/statuses/extend?'+new URLSearchParams({id}),'platform_long_text',payload=>{const data=validate(payload);if(typeof data.longTextContent!=='string')throw Error('未取得长正文');return data;});if(long_text){text=plainText(long_text.longTextContent);text_complete=true;}}
  s.save({record_id:id,record_type:'post',url,title:text.slice(0,100)||'公开微博',text,author:String(post.user?.screen_name||''),published_at:weiboDate(post.created_at),metrics:{reposts:numeric(post.reposts_count),comments:numeric(post.comments_count),likes:numeric(post.attitudes_count)},text_complete,raw:{post:raw,long_text},page_url});
  const comments=new Set<string>(),cursors=new Set<string>();let cursor='0',cursorType='0';
  for(let page=1;scope.comments_per_post&&page<=scope.comment_pages&&comments.size<scope.comments_per_post&&!s.stopped;page++){
   const params=new URLSearchParams({id,mid:id,max_id_type:cursorType});if(cursor!=='0')params.set('max_id',cursor);
   const pageUrl='https://m.weibo.cn/comments/hotflow?'+params;
   const data=await s.get(pageUrl,'platform_comments',payload=>{const data=validate(payload);if(!Array.isArray(data.data))throw Error('平台响应缺少评论列表');return data;});if(!data)break;let fresh=0;
   for(const comment of data.data){const cid=String(comment.idstr||comment.id||'');if(!/^\d+$/.test(cid)||typeof comment.text!=='string'||comments.has(cid))continue;comments.add(cid);fresh++;if(!s.within(weiboDate(comment.created_at)))continue;
    s.save({record_id:cid,record_type:'comment',parent_record_id:id,url:url+'#comment-'+cid,title:'公开评论 · '+text.slice(0,60),text:plainText(comment.text),author:String(comment.user?.screen_name||''),published_at:weiboDate(comment.created_at),metrics:{likes:numeric(comment.like_count),replies:numeric(comment.total_number)},raw:comment,page_url:pageUrl});if(comments.size>=scope.comments_per_post)break;
   }
   const next=String(data.max_id??'0');if(!fresh||!/^\d+$/.test(next)||next==='0'||cursors.has(next))break;cursors.add(next);cursor=next;cursorType=String(data.max_id_type??'0');
  }
 }
 return s.result(scope,'有界公开关键词结果、返回的正文和顶层评论；未取得登录内容、完整历史、全部评论、图片或视频，未知日期单列');
}
