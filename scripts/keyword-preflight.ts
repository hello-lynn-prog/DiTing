/** Explicit bounded public-API verification, isolated from real research reports. */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Database,now} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {Configuration} from '../packages/domain/configuration.js';
import {DeepCrawl} from '../packages/domain/deep-crawl.js';
import {ROOT,settings} from '../apps/server/settings.js';
const selected=process.argv.find(a=>a.startsWith('--platform='))?.split('=')[1]||'all';
if(!['all','weibo','bilibili'].includes(selected))throw Error('platform must be all, weibo or bilibili');
mkdirSync(join(ROOT,'tmp'),{recursive:true});const dir=mkdtempSync(join(ROOT,'tmp/keyword-check-')),db=new Database(join(dir,'state.sqlite3'),ROOT),service=new Service(db),results:any[]=[];
try{
 for(const platform of ['weibo','bilibili'].filter(p=>selected==='all'||p===selected)){
  const task=service.createTask('公开关键词 API 连通验收，不生成正式研究报告',null),lease=service.claim('keyword-preflight')!,crawl=new DeepCrawl(service);
  const scope=platform==='weibo'?{platform,query:'人工智能',max_pages:1,max_posts:1,comments_per_post:1,comment_pages:1,include_long_text:false,max_requests:3}:{platform,query:'人工智能',max_pages:1,max_videos:1,comments_per_video:1,comment_pages:1,max_requests:3};
  const pending:any=await crawl.request(task,lease.lease_owner,scope,AbortSignal.timeout(45000));
  // This grant exists only in the isolated probe database, never the user's business approval ledger.
  db.run("UPDATE approvals SET status='approved',decided_at=? WHERE id=?",now(),pending.approval_id);
  const result:any=await crawl.request(task,lease.lease_owner,scope,AbortSignal.timeout(45000));
  const summary={checked_at:now(),check_kind:'isolated_preflight',platform,status:result.status,scope:result.scope,requests:result.requests,records:result.records.length,record_types:result.records.map((r:any)=>r.record_type),errors:result.errors,coverage:result.coverage,note:'真实公开 API 验证；脚本批准范围仅存在隔离验收库，无正式报告、无用户业务审批记录'};
  results.push(summary);service.waitRuntime(task,lease.lease_owner,'隔离连通验收结束，不生成业务报告','waiting_evidence');
 }
 const file=join(ROOT,'docs/keyword-live-verification-2026-10-18.json'),old=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null,previous=Array.isArray(old?.results)?old.results:old?.platform?[old]:[];
 const all=[...previous.filter((r:any)=>!results.some(x=>x.platform===r.platform)),...results];writeFileSync(file,JSON.stringify({checked_at:now(),results:all},null,2));
 if(process.argv.includes('--persist-health')){const production=new Database(join(settings().dataDir,'diting.sqlite3'),ROOT);try{const config=new Configuration(production,settings().dataDir);for(const result of results)config.set('collector.health.'+result.platform,result);}finally{production.close();}}
 console.log(JSON.stringify({results,isolated_database:join(dir,'state.sqlite3'),business_reports:0},null,2));
}finally{db.close();}
