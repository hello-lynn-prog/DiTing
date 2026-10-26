import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ROOT} from '../apps/server/settings.js';
import {Database} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {ReportPipeline} from '../packages/reporting/pipeline.js';
import {statistics,templates,validateReport} from '../packages/reporting/report.js';
import {stopRepeatedReportFailures} from '../packages/dsh-diting/report-retries.js';
import {reportNumberIssues} from '../packages/reporting/numeric-support.js';
import {bindReportQuotes,verbatimQuote} from '../packages/reporting/quote-binding.js';

function fixture(minChars=1000,withExtra=false){
  const dir=mkdtempSync(join(tmpdir(),'diting-report-flow-')),db=new Database(join(dir,'db.sqlite3'),ROOT),service=new Service(db),task=service.createTask('报告流程测试',null),run=service.claim('fixture')!;
  const evidence=service.archive(task,'https://example.org/test','公开测试材料','机构公开了安全措施，执行效果尚需观察。');
  const claim=service.addClaim(task,'机构公开了安全措施',[{evidence_id:evidence,quote:'机构公开了安全措施'}],run.lease_owner),pipeline=new ReportPipeline(db,service,task),template=templates[0];
  if(withExtra)service.addClaim(task,'同一归档材料支持另一项分析归纳。',[{evidence_id:evidence,quote:'机构公开了安全措施'}],run.lease_owner);
  pipeline.record('template',{template_id:template.id,reason:'选择公开事件研究模板以测试成稿流程'});
  pipeline.record('evidence_map',{evidence_ids:[evidence],claim_ids:[claim]});
  const chapters=template.sections.map((title,i)=>({id:'c'+i,title,goal:'分析公开材料并说明适用范围和局限'}));
  chapters[2].title+='：证据中的实际变化';
  pipeline.record('layout',{chapters});
  pipeline.record('length',{chapters:chapters.map(c=>({id:c.id,min_chars:minChars,max_chars:1200}))});
  return {db,service,task,run,evidence,claim,pipeline,template,chapters};
}

test('automatic template checkpoints record who selected the template and why',()=>{
 const s=fixture();try{
  const row=s.db.one("SELECT data_json FROM artifacts WHERE task_id=? AND kind='report_stage' AND json_extract(data_json,'$.stage')='template'",s.task)!;
  const data=JSON.parse(row.data_json).data;
  assert.equal(data.selection_mode,'auto');
  assert.equal(data.selected_by,'report_agent');
  assert.match(data.selection_note,/用户选择了“系统自选”/);
 }finally{s.db.close();}
});

test('Chinese chapter labels normalize before writing and legacy layouts stay resumable without rewriting saved prose',()=>{
 const s=fixture();try{
  const row=s.db.one("SELECT id,data_json FROM artifacts WHERE task_id=? AND kind='report_stage' AND json_extract(data_json,'$.stage')='layout'",s.task)!;
  const layout=JSON.parse(row.data_json);layout.data.chapters=layout.data.chapters.map((c:any,i:number)=>({...c,title:(i<6?['一','二','三','四','五','六'][i]+'、':'')+c.title}));s.db.run('UPDATE artifacts SET data_json=? WHERE id=?',JSON.stringify(layout),row.id);
  for(const [i,c] of s.chapters.entries())s.pipeline.record('chapter',{id:c.id,title:(i<6?['一','二','三','四','五','六'][i]+'、':'')+c.title,text:`针对${c.title}，机构公开措施的执行效果需要结合具体条件分析。`,claim_ids:[s.claim]});
  assert.equal(s.pipeline.progress().chapters[0].title,'报告摘要');assert.equal(s.pipeline.preview().document.sections[0].title,'报告摘要');
  s.pipeline.record('repair',{issues:[],actions:[]});const table=statistics(s.db,s.task),candidate=s.pipeline.finalize({title:'中文编号不改变模板身份',template_id:s.template.id,dataset_ids:[table.id],limitations:['合成测试不构成现实研判。']});assert.ok(candidate.artifact_id);
  assert.equal(JSON.parse(s.db.one('SELECT data_json FROM artifacts WHERE id=?',row.id)!.data_json).data.chapters[0].title,'一、报告摘要','legacy raw checkpoint remains intact');
 }finally{s.db.close();}
});

test('code coverage appendices need no invented claim IDs, while empty or forged analysis still fails',()=>{
 const s=fixture();try{
  const main=s.chapters.slice(0,6);
  assert.throws(()=>s.pipeline.record('chapter',{id:main[0].id,title:main[0].title,text:'机构已公开措施，但此处故意不提供任何事实引用。',claim_ids:[]}),/分析正文必须引用/);
  for(const c of main)s.pipeline.record('chapter',{id:c.id,title:c.title,text:`${c.title}：机构公开的措施与适用范围仍应结合执行记录分析。`,claim_ids:[s.claim]});
  s.pipeline.record('repair',{issues:[],actions:[]});
  const appendices=s.pipeline.preview().document.sections.slice(6);assert.equal(appendices.length,4);assert.ok(appendices.every((x:any)=>x.claim_ids.length===0));assert.match(appendices[0].text,/归档1份原文/);assert.match(appendices[1].text,/没有归档登录平台/);
  const tables=statistics(s.db,s.task),result=s.pipeline.finalize({title:'程序附录不需要编造事实引用',template_id:s.template.id,dataset_ids:tables.datasets.map(t=>t.id),limitations:['仅为程序回归测试，不能作为现实研究。']});
  const document=JSON.parse(s.db.one('SELECT data_json FROM artifacts WHERE id=?',result.artifact_id)!.data_json).document;const forged={...document,sections:document.sections.map((x:any,i:number)=>i===6?{...x,text:x.text+' 另有999家公司已经破产。'}:x)};delete forged.tables;
  assert.throws(()=>validateReport(s.db,s.task,forged),/必须引用已审查结论/);
  for(const gate of ['sufficiency','verifier','advocate'])s.service.review(s.task,gate,true,'仅合成流程发布测试，不能视为现实事实核验。',s.run.lease_owner,s.service.reviewInput(s.task));
  assert.throws(()=>s.service.publishReport(s.task,forged,s.run.lease_owner),/每个事实章节必须引用/);
  const published=s.service.publishReport(s.task,document,s.run.lease_owner);assert.ok(published);assert.equal(s.service.task(s.task).status,'completed');
 }finally{s.db.close();}
});

test('saved chapters are not rejected for editorial length/headings, metadata strings normalize and provenance remains linked',()=>{
  const s=fixture();try{
    for(const c of s.chapters){const result=s.pipeline.record('chapter',{...{id:c.id,title:c.title},text:`针对${c.title}，机构公开的措施及其适用范围需要结合执行记录判断。`+(c.id==='c0'?'这段文字专用于验证超长章节不会触发模型反复压缩。'.repeat(70):''),claim_ids:[s.claim]});assert.ok('warnings' in result);assert.equal(result.warnings.length,1);}
    const last=s.chapters.at(-1)!;
    s.pipeline.record('chapter',{id:last.id,title:last.title,text:`${last.title}：已核对原始材料 ${s.evidence} 和结论 ${s.claim}，可在文末参考资料查看。`,claim_ids:[s.claim]});
    s.pipeline.record('repair',{issues:[],actions:[]});const table=statistics(s.db,s.task);
    const result=s.pipeline.finalize({title:'安全措施的适用范围与执行观察',template_id:s.template.id,dataset_ids:[table.id],limitations:'仅用公开测试材料验证成稿，不构成真实研究。'});
    const document=JSON.parse(s.db.one('SELECT data_json FROM artifacts WHERE id=?',result.artifact_id)!.data_json).document;
    assert.ok(document.editorial_warnings.length);assert.ok(!document.sections.at(-1).text.includes(s.evidence));assert.deepEqual(document.sections.at(-1).claim_ids,[]);assert.equal(document.sections[0].claim_ids[0],s.claim);
    assert.equal(s.pipeline.progress().candidate_id,result.artifact_id);assert.ok(s.pipeline.progress().next.includes('直接 report_publish'));
    assert.equal(s.db.one("SELECT COUNT(*) n FROM artifacts WHERE kind='report_appendix_normalization'")!.n,1);
  }finally{s.db.close();}
});

test('report numeric checks accept literal source quotes and scale conversion, reject entity swaps and altered table values',()=>{
  const source='甲组共有42条记录，乙组共有7条记录。The company expects a $1.5 trillion valuation. Reported growth was 45% to $16.8 billion.';
  assert.deepEqual(reportNumberIssues('媒体引述“Reported growth was 45% to $16.8 billion.”，预测估值为1.5万亿美元。',source,[],7),[]);
  assert.ok(reportNumberIssues('甲组共有7条记录',source,[],7).some(s=>s.includes('主体')));
  assert.ok(reportNumberIssues('该机构发布999份资料',source,[],7).some(s=>s.includes('999')));
  const tables=[{rows:[['正向',2],['负向',5]]}];
  assert.deepEqual(reportNumberIssues('正向=2；负向=5',source,tables,7),[]);
  assert.ok(reportNumberIssues('正向=5',source,tables,7).some(s=>s.includes('统计行')));
});

test('literal quotation binding handles HTML entities, preserves original source text and does not guess missing sources',()=>{
  const content='OpenAI&#x27;s valuation is down more than 4% the past 24 hours, according to the report.';
  const quote="OpenAI's valuation is down more than 4% the past 24 hours, according to the report.";
  assert.equal(verbatimQuote(content,quote),content);
  assert.equal(verbatimQuote(content.replace('&#x27;','’'),quote),content.replace('&#x27;','’'));
  const binding=bindReportQuotes('报道说："'+quote+'"',[{id:'source-a',content}]);
  assert.equal(binding.references[0].evidence_id,'source-a');assert.equal(binding.references[0].quote,content);
  assert.equal(bindReportQuotes('报道说："'+quote+'"',[{id:'source-b',content:'这是与引文无关的材料，其中也有数字4%'}]).references.length,0);
});

test('chapter citation ownership still blocks unrelated claims before any candidate is saved',()=>{
  const s=fixture();try{const c=s.chapters[0];assert.throws(()=>s.pipeline.record('chapter',{id:c.id,title:c.title,text:'这一章节不允许使用其他任务的结论。',claim_ids:['claim_foreign']}),/不属于本任务/);assert.equal(s.pipeline.progress().chapters[0].saved,false);}finally{s.db.close();}
});

test('three consecutive rejected report submissions pause the run; successful checkpoints reset the retry streak',()=>{
  const s=fixture(),child='report-child';try{
    const event=(kind:string)=>s.db.event(s.task,kind,{child_session_id:child,tool:'report_draft',role:'report',message:'测试：引用存在未支持数字'});
    event('tool.failed');event('tool.failed');assert.equal(stopRepeatedReportFailures(s.db,s.service,s.task,s.run.lease_owner,child),false);
    event('tool.completed');event('tool.failed');assert.equal(stopRepeatedReportFailures(s.db,s.service,s.task,s.run.lease_owner,child),false);
    event('tool.failed');event('tool.failed');assert.equal(stopRepeatedReportFailures(s.db,s.service,s.task,s.run.lease_owner,child),true);
    assert.equal(s.service.task(s.task).status,'paused');assert.match(s.service.task(s.task).block_reason,/防空转/);
  }finally{s.db.close();}
});


test('short evidence-limited appendix plans are saved with editorial warnings instead of forcing length rewrites',()=>{
 const s=fixture(30);try{assert.equal(s.pipeline.progress().chapters.length,s.chapters.length);assert.equal(s.db.one("SELECT COUNT(*) n FROM events WHERE kind='report.editorial_warning'")!.n,1);const stage=JSON.parse(s.db.one("SELECT data_json FROM artifacts WHERE kind='report_stage' AND json_extract(data_json,'$.stage')='length'")!.data_json);assert.ok(stage.data.editorial_warnings.some((w:string)=>w.includes('平台样本分析')));assert.equal(stage.data.chapters[0].min_chars,30);}finally{s.db.close();}
});

test('failed chapter prose is retained and indexed citation repairs change only metadata in the same reviewed version',()=>{
 const s=fixture();try{const chapter=s.chapters[0],text='这段已生成正文应保留，机构公开的措施及其适用范围需要结合执行记录判断。';
 assert.throws(()=>s.pipeline.record('chapter',{id:chapter.id,title:chapter.title,text,claim_ids:['claim_missing']}),/章节全文已保留/);const pending=s.db.one("SELECT id,data_json FROM artifacts WHERE kind='report_chapter_submission'")!;assert.equal(JSON.parse(pending.data_json).data.text,text);
 assert.throws(()=>s.pipeline.repairChapter(pending.id,{claim_numbers:[99]}),/序号不存在/);
 const fixed=s.pipeline.repairChapter(pending.id,{claim_numbers:[1]});assert.ok(fixed.artifact_id);const data=JSON.parse(s.db.one('SELECT data_json FROM artifacts WHERE id=?',fixed.artifact_id)!.data_json).data;assert.equal(data.text,text);assert.deepEqual(data.claim_ids,[s.claim]);assert.equal(s.pipeline.progress().chapters.filter((c:any)=>c.saved).length,1);
 s.service.archive(s.task,'https://example.org/new-version','新资料','新归档材料会使检查点所属版本发生变化。',s.run.lease_owner);assert.throws(()=>s.pipeline.repairChapter(pending.id,{claim_numbers:[1]}),/版本已变化/);
 }finally{s.db.close();}
});

test('same-stage JSON envelopes unwrap without rewriting text; a conflicting chapter identity remains rejected',async()=>{
 const {stagePayload}=await import('../packages/reporting/stage-payload.js');const source={id:'ch5',title:'原章节',text:'原始正文不能被结构修复改写。',claim_numbers:[1]};const wrapped={stage:'chapter',data:source};assert.deepEqual(stagePayload('chapter',wrapped),source);assert.equal(wrapped.data,source);assert.deepEqual(stagePayload('chapter',{stage:'chapter',data:JSON.stringify(source),claim_ids:['claim_exact']}),{...source,claim_ids:['claim_exact']});assert.deepEqual(stagePayload('chapter',{stage:'length',data:source}),{stage:'length',data:source});assert.throws(()=>stagePayload('chapter',{stage:'chapter',data:source,id:'ch6'}),/id冲突/);
 const s=fixture();try{const c=s.chapters[0];const saved=s.pipeline.record('chapter',{stage:'chapter',data:{id:c.id,title:c.title,text:source.text,claim_numbers:[1]}});assert.ok(saved.artifact_id);}finally{s.db.close();}
});

test('wrapped rejected chapters can be repaired in place without losing their inner id or rewriting prose',()=>{
 const s=fixture();try{const c=s.chapters[0],text='机构公开的措施及其适用范围需要结合执行记录判断，原始正文必须逐字保留。';assert.throws(()=>s.pipeline.record('chapter',{stage:'chapter',data:{id:c.id,title:c.title,text,claim_ids:['claim_missing']}}));const checkpoint=s.db.one("SELECT id FROM artifacts WHERE kind='report_chapter_submission' ORDER BY rowid DESC")!.id;
 assert.throws(()=>s.pipeline.repairChapter(checkpoint,{id:'other',claim_numbers:[1]}),/不能改变/);const fixed=s.pipeline.repairChapter(checkpoint,{stage:'chapter',data:{id:c.id,claim_numbers:[1]}});const result=JSON.parse(s.db.one('SELECT data_json FROM artifacts WHERE id=?',fixed.artifact_id)!.data_json);assert.equal(result.data.id,c.id);assert.equal(result.data.text,text);assert.deepEqual(result.data.claim_ids,[s.claim]);
 }finally{s.db.close();}
});

test('explicit diagram citations roll into their chapter without adding unrelated claims or accepting a foreign ID',()=>{
 const s=fixture(1000,true);try{const c=s.chapters[0],extra=s.db.one('SELECT id FROM claims WHERE text=?','同一归档材料支持另一项分析归纳。')!.id,visual={kind:'matrix',title:'观点归纳',caption:'仅归纳已核验结论，不表示量化评分。',items:[{label:'方向甲',text:'根据已核验材料归纳第一方向。',claim_ids:[extra]},{label:'方向乙',text:'根据已核验材料归纳第二方向。',claim_ids:[s.claim]}]};
 const result=s.pipeline.record('chapter',{id:c.id,title:c.title,text:'机构公开的措施及其适用范围需要结合执行记录判断。',claim_ids:[s.claim],visuals:[visual]});const saved=JSON.parse(s.db.one('SELECT data_json FROM artifacts WHERE id=?',result.artifact_id)!.data_json).data;assert.deepEqual(saved.claim_ids,[s.claim,extra]);
 assert.throws(()=>s.pipeline.record('chapter',{id:c.id,title:c.title,text:saved.text,claim_ids:[s.claim],visuals:[{...visual,items:[{...visual.items[0],claim_ids:['claim_foreign']},visual.items[1]]}]}),/不属于本任务/);
 }finally{s.db.close();}
});

test('repairing a saved undersized chapter recomputes server warnings without resubmitting them as model fields',()=>{
 const s=fixture();try{const c=s.chapters[0],text='机构公开的措施与适用范围需要结合具体执行记录判断。',saved=s.pipeline.record('chapter',{id:c.id,title:c.title,text,claim_ids:[s.claim]});const before=JSON.parse(s.db.one('SELECT data_json FROM artifacts WHERE id=?',saved.artifact_id)!.data_json).data;assert.equal(before.editorial_warnings.length,1);
 const repaired=s.pipeline.repairChapter(saved.artifact_id,{claim_numbers:[1]});const after=JSON.parse(s.db.one('SELECT data_json FROM artifacts WHERE id=?',repaired.artifact_id)!.data_json).data;assert.equal(after.text,text);assert.deepEqual(after.claim_ids,[s.claim]);assert.equal(after.editorial_warnings.length,1);
 }finally{s.db.close();}
});

test('chapter sentence patches keep references and other prose, and cannot replace source validation',()=>{
 const s=fixture();try{const c=s.chapters[0],text='机构公开了措施。阅读量57.97万没有依据。其他分析保持原样。',saved=s.pipeline.record('chapter',{id:c.id,title:c.title,text,claim_ids:[s.claim]});const fixed=s.pipeline.repairChapter(saved.artifact_id,{replacements:[{old:'阅读量57.97万没有依据。',new:'应核对公开措施的实际执行效果。'}]});const data=JSON.parse(s.db.one('SELECT data_json FROM artifacts WHERE id=?',fixed.artifact_id)!.data_json).data;assert.equal(data.text,'机构公开了措施。应核对公开措施的实际执行效果。其他分析保持原样。');assert.deepEqual(data.claim_ids,[s.claim]);assert.throws(()=>s.pipeline.repairChapter(saved.artifact_id,{text,replacements:[{old:'公开',new:'披露'}]}),/二选一/);assert.throws(()=>s.pipeline.repairChapter(saved.artifact_id,{replacements:[{old:'不存在的句子',new:'更正'}]}),/不在/);
 }finally{s.db.close();}
});
