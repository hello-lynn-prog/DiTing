import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../apps/server/app.js';
import {DeepCrawl} from '../packages/domain/deep-crawl.js';
import {PlatformSession} from '../packages/collectors/platform-session.js';
import {bilibiliScope,crawlBilibili} from '../packages/collectors/bilibili-keyword.js';
import {weiboDate} from '../packages/collectors/weibo-keyword.js';
import {statistics} from '../packages/reporting/report.js';
import {hash} from '../packages/domain/db.js';
const wait=async()=>{};
async function setup(){const s=await createApp({dataDir:mkdtempSync(join(tmpdir(),'diting-deep-'))},false),task=s.service.createTask('调查近7天明确的合成平台材料',null),lease=s.service.claim('deep-test')!;return {...s,task,token:lease.lease_owner as string,time:new Date(Date.parse(s.service.rawTask(task).created_at)-60000).toISOString()};}
const scope={platform:'weibo',query:'明确测试',max_posts:1,comments_per_post:3,comment_pages:3};
async function approve(crawl:DeepCrawl,s:Awaited<ReturnType<typeof setup>>,input:unknown=scope){const pending:any=await crawl.request(s.task,s.token,input,new AbortController().signal);assert.equal(pending.executed,false);s.db.run("UPDATE approvals SET status='approved' WHERE id=?",pending.approval_id);return pending;}

test('approved keyword batches preserve long text, paginated comments, unknown dates and raw provenance; repeat calls never recollect',async()=>{
 const s=await setup();let calls=0;
 const fetcher=async(url:string)=>{calls++;let data:any;
  if(url.includes('getIndex'))data={cards:[{card_group:[{card_type:9,mblog:{idstr:'100',text:'截断的<em>测试</em>正文',isLongText:true,created_at:s.time,attitudes_count:'12',reposts_count:'1.2万',user:{screen_name:'合成测试账号'}}}]}]};
  else if(url.includes('extend'))data={longTextContent:'这是明确的完整<b>测试正文</b>，用于验证原文归档。'};
  else if(new URL(url).searchParams.get('max_id')==='222')data={data:[{id:'201',text:'重复的测试评论',created_at:s.time},{id:'202',text:'另一条公开<em>测试</em>评论',created_at:'昨天'}],max_id:'222'};
  else data={data:[{id:'201',text:'首屏的公开测试评论',created_at:s.time,like_count:2}],max_id:'222',max_id_type:0};
  return {url,text:JSON.stringify({ok:1,data},null,2)};
 };
 const crawl=new DeepCrawl(s.service,{fetcher,wait});try{
  const pending=await approve(crawl,s);assert.equal(calls,0,'asking for approval cannot perform a network request');
  const result:any=await crawl.request(s.task,s.token,scope,new AbortController().signal);assert.equal(result.status,'completed');assert.equal(calls,4);assert.equal(result.records.length,3);
  assert.equal(s.db.one("SELECT COUNT(*) n FROM content_records WHERE record_type='comment'")!.n,2);assert.equal(s.db.one('SELECT COUNT(*) n FROM content_provenance WHERE parent_record_id=?','100')!.n,2);
  const post=s.db.one("SELECT * FROM content_records WHERE record_type='post'")!;assert.match(post.text,/完整\s*测试正文/);assert.equal(JSON.parse(post.metrics_json).reposts,null);assert.ok(JSON.parse(post.raw_json).long_text.longTextContent.includes('<b>'));
  const page=s.db.one('SELECT * FROM crawl_pages WHERE batch_id=? ORDER BY created_at LIMIT 1',result.batch_id)!;assert.ok(page.payload_json.includes('\n'),'original response formatting must be preserved');
  assert.equal((await crawl.request(s.task,s.token,scope,new AbortController().signal) as any).reused,true);assert.equal(calls,4);
  const dataset=statistics(s.db,s.task).datasets.find(d=>d.dimension==='publication_day')!;assert.equal(dataset.contract.missing_publication_dates,1);
  const listing=(await s.app.inject({url:`/api/tasks/${s.task}/platform-data?limit=1&kind=comment`})).json();assert.equal(listing.records.length,1);assert.equal(listing.total_records,2);assert.ok(!JSON.stringify(listing.batches).includes('lease_token'));
  const raw=(await s.app.inject({url:`/api/tasks/${s.task}/crawl-batches/${result.batch_id}/pages/${page.id}`})).json();assert.equal(raw.response_hash,hash(page.payload_json));assert.equal(raw.response.ok,1);
  const download=await s.app.inject({url:`/api/tasks/${s.task}/crawl-batches/${result.batch_id}/pages/${page.id}/export`});assert.equal(download.body,page.payload_json);assert.ok(download.headers['content-disposition']?.includes(page.id));
  const foreign=s.service.createTask('调查另一份明确的合成测试',null);
  for(const path of [`platform-data/${post.id}`,`crawl-batches/${result.batch_id}`,`crawl-batches/${result.batch_id}/pages/${page.id}`,`crawl-batches/${result.batch_id}/pages/${page.id}/export`])assert.equal((await s.app.inject({url:`/api/tasks/${foreign}/${path}`})).statusCode,404);
  assert.equal((await s.app.inject({url:`/api/tasks/${s.task}/platform-data?limit=999`})).statusCode,400);
  assert.equal(pending.scope.include_long_text,true);
 }finally{await s.app.close();}
});

test('pause rejects late network results; a fresh lease resumes successful pages without refetching them',async()=>{
 const s=await setup();let calls=0,release!:()=>void,entered!:()=>void;
 const observed=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve);
 const fetcher=async(url:string)=>{calls++;if(url.includes('getIndex'))return {url,text:JSON.stringify({ok:1,data:{cards:[{card_type:9,mblog:{id:'100',text:'明确的测试正文',created_at:s.time}}]}})};
  if(calls===2){entered();await hold;}return {url,text:JSON.stringify({ok:1,data:{data:[{id:'201',text:'测试评论',created_at:s.time}],max_id:0}})};
 };
 const crawl=new DeepCrawl(s.service,{fetcher,wait});try{
  await approve(crawl,s);const pending=crawl.request(s.task,s.token,scope,new AbortController().signal),rejected=assert.rejects(pending,/租约/);await observed;
  s.service.action(s.task,'pause',s.service.task(s.task).revision);const audits=s.db.one('SELECT COUNT(*) n FROM acquisitions')!.n;release();await rejected;
  assert.equal(s.db.one('SELECT COUNT(*) n FROM acquisitions')!.n,audits,'late responses cannot become success or failure audits for the stopped run');assert.equal(s.db.one('SELECT COUNT(*) n FROM content_records')!.n,1);
  assert.equal(crawl.runs(s.task)[0].status,'interrupted');
  s.service.action(s.task,'resume',s.service.task(s.task).revision);const resumed=s.service.claim('deep-resumed')!;
  const result:any=await crawl.request(s.task,resumed.lease_owner,scope,new AbortController().signal);assert.equal(result.cache_hits,1);assert.equal(calls,3);assert.equal(result.records.length,2);assert.equal(result.total_requests,3);assert.equal(s.db.one('SELECT COUNT(*) n FROM crawl_batches')!.n,1);
 }finally{release?.();await s.app.close();}
});

test('denied access is a failed batch, not empty success; another attempt requires new approval',async()=>{
 const s=await setup();let calls=0;const crawl=new DeepCrawl(s.service,{wait,fetcher:async(url)=>{calls++;if(calls===1)throw Error('来源 HTTP 403');return {url,text:'{"ok":1,"data":{"cards":[]}}'};}});
 try{await approve(crawl,s);const failed:any=await crawl.request(s.task,s.token,scope,new AbortController().signal);assert.equal(failed.status,'failed');assert.equal(failed.records.length,0);await crawl.request(s.task,s.token,scope,new AbortController().signal);assert.equal(calls,1);
  s.service.waitRuntime(s.task,s.token,'等待用户决定是否重新采集','waiting_evidence');
  const retry=await s.app.inject({method:'POST',url:`/api/crawl-runs/${failed.batch_id}/retry-approval`,payload:{}});assert.equal(retry.statusCode,200);const aid=retry.json().approval_id;
  assert.equal((await s.app.inject({method:'POST',url:`/api/crawl-runs/${failed.batch_id}/retry-approval`,payload:{}})).json().approval_id,aid);
  assert.equal(calls,1);await s.app.inject({method:'POST',url:`/api/approvals/${aid}/decision`,payload:{approved:true}});const lease=s.service.claim('retry')!;
  const result:any=await crawl.request(s.task,lease.lease_owner,scope,new AbortController().signal);assert.equal(result.status,'completed');assert.equal(result.records.length,0);assert.equal(calls,2);assert.equal(s.db.one('SELECT COUNT(*) n FROM crawl_batches')!.n,2);assert.equal(crawl.directory().find(x=>x.id==='weibo')!.record_count,0);
 }finally{await s.app.close();}
});

test('Bilibili reads bounded comment pages and excludes records outside the frozen time window',async()=>{
 const s=await setup(),seconds=Date.parse(s.time)/1000;let calls=0;
 try{const result=await crawlBilibili(s.service,s.task,s.token,{platform:'bilibili',query:'测试主题',max_videos:1,comments_per_video:21,comment_pages:2},new AbortController().signal,async(url)=>{
  calls++;const p=Number(new URL(url).searchParams.get('pn'));
  return {url,text:JSON.stringify({code:0,data:url.includes('search/type')?{result:[{aid:1,bvid:'BVfixture',title:'明确的测试视频',pubdate:seconds}]}:{page:{count:21},replies:Array.from({length:p===1?20:1},(_,i)=>({rpid:(p-1)*20+i+1,ctime:p===2?seconds+864000:seconds,content:{message:'明确的合成分页评论'},like:1}))}})};
 },{wait});assert.equal(calls,3);assert.equal(result.records.filter(r=>r.record_type==='comment').length,20);assert.equal(result.skipped_outside_window,1);
 }finally{await s.app.close();}
});

test('Bilibili pubdate paging continues within the approved page cap until it finds in-window samples',async()=>{
 const s=await setup(),end=Date.parse(s.time)/1000;let calls=0;
 assert.equal(bilibiliScope.parse({platform:'bilibili',query:'测试主题'}).max_pages,3,'new pending requests should ask for enough sorted pages to tolerate an approval delay');
 try{const result=await crawlBilibili(s.service,s.task,s.token,{platform:'bilibili',query:'测试主题',order:'pubdate',max_pages:2,max_videos:1,comments_per_video:0},new AbortController().signal,async(url)=>{
  calls++;const page=Number(new URL(url).searchParams.get('page'));
  const pubdate=page===1?end+600:end-60;
  return {url,text:JSON.stringify({code:0,data:{numResults:60,result:[{aid:page,bvid:'BVpage'+page,title:'有界分页测试视频',pubdate}]}})};
 },{wait});assert.equal(calls,2);assert.equal(result.records.length,1);assert.equal(result.records[0].record_id,'BVpage2');assert.equal(result.skipped_outside_window,1);
 }finally{await s.app.close();}
});

test('nested evidence and structured record writes roll back together, and relative dates remain unknown',async()=>{
 const s=await setup();try{
  const session=new PlatformSession(s.service,s.task,s.token,'weibo','测试',1,new AbortController().signal,{wait});
  assert.throws(()=>session.save({record_id:'1',record_type:'post',url:'https://m.weibo.cn/detail/1',title:'测试',text:'明确的测试原文',author:'',published_at:null,metrics:{}}));
  assert.equal(s.db.one('SELECT COUNT(*) n FROM evidence')!.n,0);assert.equal(s.db.one('SELECT COUNT(*) n FROM task_evidence')!.n,0);assert.equal(s.db.one('SELECT COUNT(*) n FROM content_records')!.n,0);
  assert.equal(weiboDate('昨天'),null);assert.equal(weiboDate('刚刚'),null);assert.equal(weiboDate('Sun Oct 18 10:00:00 +0800 2026'),'2026-10-18T02:00:00.000Z');
 }finally{await s.app.close();}
});

test('request caps stop long-text and comment work; changed scope requires separate approval',async()=>{
 const s=await setup();let calls=0;const crawl=new DeepCrawl(s.service,{wait,fetcher:async(url)=>{calls++;return {url,text:JSON.stringify({ok:1,data:{cards:[{card_type:9,mblog:{id:'100',text:'只取得的截断测试正文',isLongText:true,created_at:s.time}}]}})};}});
 try{const limited={...scope,max_requests:1};await approve(crawl,s,limited);const result:any=await crawl.request(s.task,s.token,limited,new AbortController().signal);assert.equal(calls,1);assert.equal(result.status,'partial');assert.ok(result.errors[0].error.includes('上限'));assert.ok(s.db.one('SELECT content FROM evidence')!.content.includes('截断文本'));
  const changed:any=await crawl.request(s.task,s.token,{...limited,max_requests:2},new AbortController().signal);assert.equal(changed.status,'pending');assert.equal(calls,1,'increasing the request cap cannot reuse the old grant');
 }finally{await s.app.close();}
});

test('scope approvals are bounded independently of harmless repeated pending calls and each has a notification',async()=>{
 const s=await setup();let calls=0;const crawl=new DeepCrawl(s.service,{wait,fetcher:async()=>{calls++;throw Error('must not fetch');}});
 try{
  const first:any=await crawl.request(s.task,s.token,scope,new AbortController().signal);
  for(let i=0;i<4;i++)assert.equal((await crawl.request(s.task,s.token,scope,new AbortController().signal) as any).approval_id,first.approval_id);
  await crawl.request(s.task,s.token,{...scope,query:'第二个测试主题'},new AbortController().signal);
  s.service.requestCrawlApproval(s.task,'public_keyword_crawl',{query:'第三个测试主题',urls:['https://example.com/fixture']},s.token);
  await assert.rejects(crawl.request(s.task,s.token,{...scope,query:'第四个测试主题'},new AbortController().signal),/审批上限/);
  assert.equal(s.db.one("SELECT COUNT(*) n FROM outbox WHERE event_type='approval.required'")!.n,3);assert.equal(calls,0);
 }finally{await s.app.close();}
});
