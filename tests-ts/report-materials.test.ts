import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Database,now} from '../packages/domain/db.js';import {Service} from '../packages/domain/service.js';import {reportMaterials} from '../packages/dsh-diting/report-materials.js';
test('report input keeps complete claim quotes, every engine section and reflection round without failed or foreign submissions',()=>{
 const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-report-input-')),'db.sqlite3'),process.cwd()),service=new Service(db),task=service.createTask('成稿材料整合测试',null),run=service.claim('fixture')!,quote='真实归档段落。'.repeat(60)+'逐字引文末尾不能截短。';
 try{
 const source=service.archive(task,'https://example.org/materials','公开来源',quote,'web_fetch',run.lease_owner),one=service.addClaim(task,'该段公开资料描述了研究背景。',[{evidence_id:source,quote}],run.lease_owner);service.addClaim(task,'公开资料还提供了进一步的案例线索。',[{evidence_id:source,quote:'真实归档段落。'}],run.lease_owner);
 const stamp=service.rawTask(task).created_at,post=service.archive(task,'https://example.org/post','微博样本标题','真实微博样本文本','weibo_post',run.lease_owner,{published_at:stamp,publisher:'微博',method:'fixture'});
 db.run('INSERT INTO content_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)','sample-record',task,'weibo','post-1','post','https://example.org/post','微博样本标题','真实微博样本文本','用户甲',stamp,JSON.stringify({likes:17,comments:3,reposts:2}),JSON.stringify({fixture:true}),post,stamp);
 db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)','sample-sentiment',task,'sample_annotation','sentiment',JSON.stringify({evidence_id:post,label:'negative'}),stamp);
 const add=(id:string,kind:string,role:string,data:unknown)=>db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',id,task,kind,role,JSON.stringify(data),now());
 for(const role of ['insight','media','query'])for(let section=1;section<=4;section++){
  add(role+section,'investigation_section',role,{section_id:'section-'+section,claim_ids:[one],gaps:[]});
  for(let round=1;round<=2;round++)add(role+section+round,'investigation_reflection',role,{section_id:'section-'+section,round,findings:'完整调查总结。'.repeat(120)+'结尾观点保留'});
 }
 add('rejected','investigation_submission','insight',{claims:[{text:'未通过的错误材料不能混入成稿输入'}]});add('foreign','investigation_section','insight',{section_id:'foreign',claim_ids:['claim_foreign']});
 const packet=reportMaterials(db,task,0,1);assert.equal(packet.section_results!.length,12);assert.equal(packet.reflections!.length,24);assert.equal(packet.claims[0].references[0].quote,quote);assert.equal(packet.claims[0].number,1);assert.equal(packet.has_more,true);assert.equal(packet.next_offset,1);assert.ok(!JSON.stringify(packet).includes('未通过的错误材料'));assert.ok(packet.reflections!.every(r=>r.findings.endsWith('结尾观点保留')));
 assert.equal(packet.research_window!.timezone,'Asia/Shanghai');assert.equal(packet.source_coverage!.within_window,1);assert.equal(packet.platform_samples!.total_records,1);assert.deepEqual(packet.platform_samples!.by_platform[0].sentiment,{negative:1});assert.equal(packet.platform_samples!.by_platform[0].metrics.likes,17);assert.equal(packet.source_catalog!.find((s:any)=>s.evidence_id===post)!.window_status,'within_window');
 const next=reportMaterials(db,task,1,1);assert.equal(next.claims[0].number,2);assert.equal(next.has_more,false);assert.equal(next.reflections,undefined);assert.equal(reportMaterials(db,task,0,1).hash,packet.hash);assert.throws(()=>reportMaterials(db,task,-1),/分页/);
 }finally{db.close();}
});
