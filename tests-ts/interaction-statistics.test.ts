import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Database,uid,now} from '../packages/domain/db.js';import {Service} from '../packages/domain/service.js';
import {interactionRows} from '../packages/reporting/interactions.js';import {statistics,templates,validateReport} from '../packages/reporting/report.js';
import {validateVisuals} from '../packages/reporting/visuals.js';import {renderReaderReport} from '../packages/reporting/reader.js';
test('public interaction charts count observed per-platform metrics, deduplicate records and distinguish unknown from zero',()=>{
 const record=(record_id:string,record_type:string,likes:unknown)=>({platform:'weibo',record_id,record_type,metrics:{likes}});
 const rows=[{platform_records:[record('1','post',12),record('1','post',12),record('2','post',null),record('3','post','99'),record('4','comment',0),record('5','comment',-1)]}];
 assert.deepEqual(interactionRows(rows,'interaction_likes'),[['weibo · comment',0],['weibo · post',12]]);assert.deepEqual(interactionRows(rows,'interaction_plays'),[]);
});
test('real metric tables recompute from archived records and render as topic charts; tampering or cross-platform pies fail',()=>{
 const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-interaction-')),'db.sqlite3'),process.cwd()),service=new Service(db),task=service.createTask('测试公开互动样本',null),run=service.claim('fixture')!;
 try{
 const evidence=service.archive(task,'https://example.org/public-post','公开帖子','平台公开资料描述了本次讨论的主题与背景。','platform_keyword',run.lease_owner),claim=service.addClaim(task,'平台公开资料描述了本次讨论主题。',[{evidence_id:evidence,quote:'平台公开资料描述了本次讨论'}],run.lease_owner);
 db.run('INSERT INTO content_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',uid('record'),task,'weibo','1','post','https://example.org/public-post','公开帖子','平台公开资料描述了本次讨论的主题与背景。','作者',now(),JSON.stringify({likes:12,comments:null,reposts:0}),'{}',evidence,now());
 const datasets=statistics(db,task).datasets,metric=datasets.find(d=>d.dimension==='interaction_likes')!;assert.deepEqual(metric.rows,[['weibo · post',12]]);assert.ok(!datasets.some(d=>d.dimension==='interaction_comments'));assert.equal(datasets.find(d=>d.dimension==='interaction_reposts')!.rows[0][1],0);
 const document={title:'公开帖子讨论研判测试',template_id:'public-event',sections:templates[0].sections.map(title=>({title,text:'这里讨论公开材料所描述的讨论主题与背景。',claim_ids:[claim]})),dataset_ids:datasets.map(d=>d.id),limitations:['合成测试，不构成真实平台代表性研究。']};
 const checked=validateReport(db,task,document);const html=renderReaderReport(checked,db.rows('SELECT * FROM evidence'),db.rows('SELECT * FROM claims')).html;assert.ok(html.includes('已采集内容的公开点赞指标'));assert.ok(html.includes('帖子/视频与评论分列'));
 assert.throws(()=>validateVisuals([{title:'公众观点',visuals:[{kind:'dataset',dataset_id:metric.id,title:'错误跨平台占比',style:'donut'}]}],new Set([claim]),datasets),/跨平台/);
 db.run('UPDATE content_records SET metrics_json=? WHERE task_id=?',JSON.stringify({likes:999}),task);assert.throws(()=>validateReport(db,task,document),/底表已过期/);
 }finally{db.close();}
});
