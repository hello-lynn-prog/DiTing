/** Offline integration on previously authorized QA captures; performs no platform/model API requests. */
import {join,resolve,relative,isAbsolute} from 'node:path';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {ROOT,settings} from '../apps/server/settings.js';
import {Database,encode,hash,now} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {Configuration} from '../packages/domain/configuration.js';
import {NativeSentimentEngine,BatchedSentimentEngine} from '../packages/sentiment/engine.js';
import {LocalSentiment} from '../packages/sentiment/service.js';
import {statistics} from '../packages/reporting/report.js';
const cfg=settings(),qa=join(cfg.dataDir,'qa'),directory=resolve(process.argv[2]||join(qa,'session-live-MTyqWo')),inside=relative(qa,directory);
if(!inside||inside.startsWith('..')||isAbsolute(inside))throw Error('Only an existing isolated data/qa capture directory is accepted');
const db=new Database(join(directory,'diting.sqlite3'),ROOT),service=new Service(db),config=new Configuration(db,directory);
const engine=new BatchedSentimentEngine(new NativeSentimentEngine(join(cfg.dataDir,'models/bettafish-multilingual-sentiment'))),sentiment=new LocalSentiment(service,config,engine);
const raw=()=>hash(encode({records:db.rows('SELECT * FROM content_records ORDER BY id'),pages:db.rows('SELECT * FROM crawl_pages ORDER BY id'),evidence:db.rows('SELECT * FROM evidence ORDER BY id')}));
try{
 const before=raw(),summaries=[];
 for(const task of db.rows('SELECT DISTINCT t.* FROM tasks t JOIN content_records r ON r.task_id=t.id ORDER BY t.created_at')){
  if(!['waiting_evidence','completed'].includes(task.status))throw Error('QA task is not idle');
  const policy=JSON.parse(task.config_json);policy.sentiment={enabled:true,min_confidence:0.5,model_version:engine.version};
  db.run('UPDATE tasks SET config_json=? WHERE id=?',encode(policy),task.id);
  db.event(task.id,'qa.local_sentiment_replay',{message:'对既有隔离采样运行本地分类器，未新增平台请求，不进入正式研究',model_version:engine.version});
  const ids=db.rows('SELECT evidence_id FROM content_records WHERE task_id=? ORDER BY id',task.id).map(r=>r.evidence_id);
  const result=await sentiment.annotate(task.id,ids,()=>{assert.equal(raw(),before,'raw captures must remain unchanged');});
  assert.equal(result.results.length,ids.length);assert.ok(result.results.every((r:any)=>r.cloud_cost===0&&r.cloud_tokens===0));
  const tables=statistics(db,task.id).datasets;
  summaries.push({task_id:task.id,records:ids.length,model_version:engine.version,labels:result.results.map((r:any)=>({evidence_id:r.evidence_id,label:r.label,sentiment:r.sentiment,confidence:r.confidence,cache_hit:r.cache_hit})),table_dimensions:tables.map((t:any)=>t.dimension)});
 }
 assert.equal(raw(),before);const result={checked_at:now(),archive:directory,network_requests:0,raw_capture_hash:before,raw_captures_unchanged:true,summaries,production_certified:false,note:'真实已登录采样的本地推理与统计集成验收；标签未逐条人工评估，不是主题代表性或准确率认证。'};
 writeFileSync(join(directory,'sentiment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{db.close();}
