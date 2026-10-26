import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {freezeLexicon,lookupLexicon,defaultLexicon} from '../packages/domain/research-lexicon.js';
import {HistoricalResearch} from '../packages/domain/historical-research.js';import {Database,now} from '../packages/domain/db.js';import {Service} from '../packages/domain/service.js';
test('versioned query lexicon normalizes spacing, keeps ambiguity context and never certifies facts',()=>{
 const frozen=freezeLexicon(defaultLexicon),result=lookupLexicon(frozen,'分析AIagent落地及世界模型');assert.ok(result.keywords.includes('AI智能体'));assert.ok(result.keywords.includes('world model'));assert.equal(result.evidence,false);
 const modified=freezeLexicon({...defaultLexicon,entries:[...defaultLexicon.entries,{term:'圈内说法',variants:['用户维护的别称'],context:'仅用于相关材料召回，需要回查语境。',source:'自定义测试词库'}]});assert.notEqual(frozen.version,modified.version);assert.equal(lookupLexicon(frozen,'圈内说法').keywords.length,0);assert.equal(lookupLexicon({...modified,enabled:false},'圈内说法').keywords.length,0);
 assert.throws(()=>freezeLexicon({...defaultLexicon,entries:[defaultLexicon.entries[0],defaultLexicon.entries[0]]}),/重复/);
});
test('historical lookup keeps the latest report per task, excludes the current task and does not return old claim IDs as evidence',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'diting-history-')),db=new Database(join(directory,'db.sqlite3'),process.cwd()),service=new Service(db),one=service.createTask('历史AI研究',null),two=service.createTask('历史足球研究',null);
 try{
  const report=(id:string,task:string,version:number,title:string)=>db.run('INSERT INTO reports(id,task_id,version,title,document_json,input_hash,created_at) VALUES(?,?,?,?,?,?,?)',id,task,version,title,JSON.stringify({title,sections:[{title:'报告摘要',text:title,claim_ids:['old_claim_not_usable']}]}),'fixture',now());
  report('report_a',one,1,'人工智能安全治理');report('report_b',one,2,'人工智能安全治理升级');report('report_c',two,1,'足球赛事分析');
  let calls=0;const history=new HistoricalResearch(db,directory,{version:'fixture',embed:async texts=>{calls++;return texts.map(text=>/足球/.test(text)?[0,1]:[1,0]);}}),result=await history.lookup('人工智能风险',two);
  assert.equal(result.results.length,1);assert.equal(result.results[0].report_id,'report_b');assert.equal(result.results[0].version,2);assert.equal(result.evidence,false);assert.equal(JSON.stringify(result).includes('old_claim_not_usable'),false);
  const before=calls;await history.lookup('人工智能风险',two);assert.equal(calls,before,'cached queries and reports do not rerun local inference');
  assert.equal((await new HistoricalResearch(db,directory).lookup('人工智能安全')).method,'lexical-jaccard-fallback');await assert.rejects(history.lookup('人工智能',undefined,99),/不合法/);
 }finally{db.close();}
});
