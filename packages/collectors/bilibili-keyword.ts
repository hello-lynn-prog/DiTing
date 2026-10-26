/** Independently implemented public metadata collection; no login or challenge bypass. */
import {z} from 'zod';
import {plainText,fetchText} from './network.js';
import {Service} from '../domain/service.js';
import type {Row} from '../domain/db.js';
import {PlatformSession,numeric,unixDate,type PlatformDependencies} from './platform-session.js';
export const bilibiliScope=z.object({query:z.string().trim().min(2).max(200),platform:z.literal('bilibili'),access_mode:z.enum(['public','saved_session']).default('public'),order:z.enum(['pubdate','totalrank']).default('pubdate'),session_version:z.string().max(100).optional(),max_pages:z.number().int().min(1).max(3).default(3),max_videos:z.number().int().min(1).max(10).default(5),comments_per_video:z.number().int().min(0).max(60).default(0),comment_pages:z.number().int().min(1).max(3).default(1),max_requests:z.number().int().min(1).max(30).default(20)}).strict();
export async function crawlBilibili(service:Service,taskId:string,token:string,input:unknown,signal:AbortSignal,fetcher=fetchText,deps:PlatformDependencies={}){
 const scope=bilibiliScope.parse(input),s=new PlatformSession(service,taskId,token,'bilibili',scope.query,scope.max_requests,signal,{...deps,fetcher}),videos:Row[]=[],seen=new Set<string>();
 if(scope.access_mode==='saved_session'&&!deps.access)throw Error('使用登录态的采集必须先取得本任务冻结的登录版本');
 const validate=(data:Row)=>{if(data.code!==0)throw Error('平台拒绝本次请求（'+data.code+'）'+String(data.message||''));if(!data.data||typeof data.data!=='object')throw Error('平台未返回数据对象');return data.data;};
 for(let page=1;page<=scope.max_pages&&videos.length<scope.max_videos&&!s.stopped;page++){
  const url=new URL('https://api.bilibili.com/x/web-interface/search/type');url.search=new URLSearchParams({search_type:'video',keyword:scope.query,page:String(page),page_size:'20',order:scope.order}).toString();
  const data=await s.get(url.href,'platform_search',payload=>{const data=validate(payload);if(!Array.isArray(data.result))throw Error('平台响应缺少视频列表');return data;});if(!data)break;
  for(const video of data.result){if(!/^BV[A-Za-z0-9-]+$/.test(video.bvid||'')||!/^\d+$/.test(String(video.aid))||seen.has(video.bvid)||!s.within(unixDate(video.pubdate)))continue;seen.add(video.bvid);videos.push({...video,page_url:url.href});if(videos.length===scope.max_videos)break;}
  if(!data.result.length||page>=Math.ceil((data.numResults??Infinity)/20))break;
 }
 for(const video of videos){
  s.check();const url='https://www.bilibili.com/video/'+video.bvid,title=plainText(String(video.title||'')),{page_url,...raw}=video;
  s.save({record_id:video.bvid,record_type:'video_metadata',url,title,text:plainText(String(video.description||'')),author:String(video.author||''),published_at:unixDate(video.pubdate),metrics:{plays:numeric(video.play),likes:numeric(video.like),comments:numeric(video.review)},raw,page_url});
  const comments=new Set<string>();
  for(let page=1;scope.comments_per_video&&page<=scope.comment_pages&&comments.size<scope.comments_per_video&&!s.stopped;page++){
   const pageUrl='https://api.bilibili.com/x/v2/reply?'+new URLSearchParams({type:'1',oid:String(video.aid),pn:String(page),ps:'20',sort:'2'});
   const data=await s.get(pageUrl,'platform_comments',payload=>{const data=validate(payload);if(data.replies!==null&&!Array.isArray(data.replies))throw Error('平台响应缺少可识别评论列表');return data;});if(!data)break;
   const rows=data.replies||[];let fresh=0;
   for(const comment of rows){const id=String(comment.rpid||'');if(!/^\d+$/.test(id)||!comment.content?.message||comments.has(id))continue;comments.add(id);fresh++;if(!s.within(unixDate(comment.ctime)))continue;
    s.save({record_id:id,record_type:'comment',parent_record_id:video.bvid,url:url+'#reply'+id,title:'公开评论 · '+title,text:String(comment.content.message),author:String(comment.member?.uname||''),published_at:unixDate(comment.ctime),metrics:{likes:numeric(comment.like),replies:numeric(comment.rcount)},raw:comment,page_url:pageUrl});if(comments.size>=scope.comments_per_video)break;
   }
   if(!rows.length||!fresh||(numeric(data.page?.count)!==null&&page*20>=data.page.count))break;
  }
 }
 return s.result(scope,'有界视频搜索元数据与按页采样的顶层评论；未观看画面，未覆盖全平台、全部评论或子评论');
}
