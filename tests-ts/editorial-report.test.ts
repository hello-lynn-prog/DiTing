import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {Configuration} from '../packages/domain/configuration.js';
import {editorialCall} from '../packages/reporting/editor.js';
import {numberedOutline,chineseChapter,subsectionWarnings} from '../packages/reporting/outline.js';
import {reportNumberIssues} from '../packages/reporting/numeric-support.js';
import {templates,templateContract,validateTemplateMarkdown} from '../packages/reporting/report.js';
import {reportVisualSchema,validateVisuals} from '../packages/reporting/visuals.js';
import {renderReaderReport} from '../packages/reporting/reader.js';
test('an uploaded chapter that already includes its Chinese display number is not numbered twice',()=>{
 const html=renderReaderReport({title:'用户模板显示测试',sections:[{title:'一、报告摘要',text:'原始用户章节标题保持可读。',claim_ids:[]}],tables:[]},[],[]).html;
 assert.ok(html.includes('<h2>一、报告摘要</h2>'));assert.ok(!html.includes('一、一、报告摘要'));
});

test('six built-ins read original BettaFish main chapters and subheadings; template contract freezes raw structure',()=>{
  assert.equal(templates.length,6);
  for(const t of templates){assert.equal(t.origin,'bettafish_builtin');assert.equal(t.markdown,readFileSync('assets/report-templates/'+t.name+'.md','utf8'));assert.ok(t.main_sections.length>=6);assert.ok(t.sections.length>t.main_sections.length);const contract=templateContract(t);assert.equal(contract.markdown,t.markdown);assert.notEqual(templateContract({...t,markdown:t.markdown+'\n新子节'}).hash,contract.hash);}
  assert.deepEqual(templates[0].main_sections,['报告摘要','事件全景与演变脉络','传播路径与引爆点分析','舆论场多方观点与情绪光谱','深层动因与价值观探讨','关联性评估与行动建议']);
});

test('native outline preserves every numbered subsection and reports missing structure without losing saved prose',()=>{
  const t=templates[0],outline=numberedOutline(t.markdown);assert.equal(outline.length,6);assert.equal(outline.flatMap(c=>c.subsections).length,17);
  assert.deepEqual(outline[0].subsections.map((s:any)=>s.number),['1.1','1.2','1.3']);assert.equal(chineseChapter(6),'六');assert.equal(chineseChapter(12),'十二');
  assert.equal(subsectionWarnings([{title:t.main_sections[0],text:'### 自拟标题\n\n原文应保留'}],templateContract(t)).length,1);
  assert.equal(subsectionWarnings([{title:t.main_sections[0],text:outline[0].subsections.map((s:any)=>`### ${s.number} ${s.title}\n\n真实分析正文`).join('\n\n')}],templateContract(t)).length,0);
});

test('outline numbering is not a factual number, while the same unsupported value in body text remains invalid',()=>{
  assert.deepEqual(reportNumberIssues('### 4.3 社会情绪分析\n\n本批有42条样本。','本批有42条样本。',[],7),[]);
  assert.ok(reportNumberIssues('### 4.3 社会情绪分析\n\n本批有4.3万条样本。','只有42条样本。',[],7).length>0);
});

test('public event reader uses Chinese main headings, numbered child links and embeds diagrams beside their subsection',()=>{
  const contract=templateContract(templates[0]),claim={id:'c',text:'已有材料的解释',references_json:'[]'};
  const s={title:contract.main_sections[0],claim_ids:['c'],text:'### 1.1 事件定性\n\n第一节的分析。\n\n### 1.2 核心洞察\n\n第二节的分析。\n\n### 1.3 关联性与建议\n\n第三节的建议。',visuals:[{kind:'matrix',title:'本节观点对照',caption:'来自已审查结论的分析归纳',after_subsection:'1.2',items:[{label:'主体甲',text:'甲关注责任划分。',claim_ids:['c']},{label:'主体乙',text:'乙关注成本核算。',claim_ids:['c']}]}]};
  const {html,markdown}=renderReaderReport({title:'报告',template_id:'public-event',template_contract:contract,sections:[s],tables:[]},[],[claim]);
  assert.match(html,/<h2>一、报告摘要<\/h2>/);assert.match(html,/href="#subsection-1-2"/);const start=html.indexOf('id="chapter-0"');const body=html.slice(start);assert.ok(body.indexOf('本节观点对照')<body.indexOf('id="subsection-1-3"'));assert.match(markdown,/## 一、报告摘要/);
});

test('uploaded and co-created skeletons keep distinct origins and ignore nested headings as chapters',()=>{
  const md='# 研究报告\n## 报告摘要\n### 主要判断\n## 背景与演变\n## 多方观点\n## 行业影响\n## 风险研判\n## 结论与建议';
  const uploaded=validateTemplateMarkdown('我的骨架',md),coCreated=validateTemplateMarkdown('我的骨架',md,'co_created','session-fixture');
  assert.equal(uploaded.main_sections.length,6);assert.equal(uploaded.sections.length,10);assert.equal(coCreated.origin,'co_created');assert.equal(coCreated.session_id,'session-fixture');assert.notEqual(uploaded.id,coCreated.id);assert.equal(validateTemplateMarkdown('原生格式',templates[0].markdown).main_sections.length,6);assert.ok(!uploaded.sections.includes('主要判断'));
});

test('chapter diagrams cannot smuggle values or cross-task claims; numeric charts only reference certified datasets',()=>{
  const matrix={kind:'matrix',title:'观点对照',caption:'对已审查结论的分析归纳',items:[{label:'产业方',text:'产业方关注部署边界',claim_ids:['c']},{label:'使用方',text:'使用方关注责任归属',claim_ids:['c']}]};
  reportVisualSchema.parse(matrix);assert.throws(()=>reportVisualSchema.parse({...matrix,values:[90,10]}));
  validateVisuals([{claim_ids:['c'],visuals:[matrix]}],new Set(['c']),[]);
  assert.throws(()=>validateVisuals([{claim_ids:['other'],visuals:[matrix]}],new Set(['c']),[]),/本章/);
  assert.throws(()=>validateVisuals([{visuals:[{kind:'dataset',dataset_id:'missing'}]}],new Set(),[]),/认证统计/);
  assert.throws(()=>validateVisuals([{visuals:[{kind:'dataset',dataset_id:'d',style:'line'}]}],new Set(),[{id:'d',dimension:'source'}]),/时间/);
});

test('reader lays out Chinese analysis and chapter diagrams before compact provenance; supports real Markdown tables',()=>{
  const evidence=[{id:'e',title:'测试原文',source_url:'https://example.org',captured_at:'2026-10-20'}],claims=[{id:'c',text:'测试归纳',references_json:'[{"evidence_id":"e","quote":"仅用于测试的原文"}]'}];
  const report={title:'中文研判示例',sections:[{title:'观点与影响',text:'### 判断应当回到具体应用\n\n这是连贯的分析段落。\n\n|主体|关切|\n|---|---|\n|企业|部署责任|',claim_ids:['c'],visuals:[{kind:'flow',title:'从部署到责任',caption:'根据已审查结论归纳',items:[{label:'部署',text:'企业明确实际任务边界',claim_ids:['c']},{label:'责任',text:'明确失败处理与人员责任',claim_ids:['c']}]}]},{title:'研究范围与方法',text:'范围说明放在附录。',claim_ids:['c']}],tables:[],limitations:['这是测试资料。']};
  const {html,markdown}=renderReaderReport(report,evidence,claims);
  assert.match(html,/text-indent:2em/);assert.match(html,/<th>主体<\/th>/);assert.match(html,/analysis-flow/);assert.ok(html.indexOf('从部署到责任')<html.indexOf('范围说明放在附录'));assert.match(html,/分析归纳/);assert.match(markdown,/从部署到责任/);assert.match(html,/文末溯源/);
});

test('editorial rewrites meter malformed responses, retain usage and cache successful exact requests',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'diting-editor-')),db=new Database(join(dir,'diting.sqlite3'),process.cwd()),service=new Service(db),config=new Configuration(db,dir),task=service.createTask('研究编辑调用的合成测试',null);
  config.saveRoute({id:'report',provider:'fixture',model:'fixture',enabled:true,base_url:'https://model.example/v1',api_key:'fake-key',max_tokens:2048,rates:{input:1,cache:0.1,output:2}});config.set('model.queue',{min_interval_ms:0});
  let requests=0;const fetcher=(async()=>{requests++;return new Response(JSON.stringify({choices:[{message:{content:requests===1?'坏JSON':JSON.stringify({text:'这是可用的编辑结果。',visuals:[]})}}],usage:{prompt_tokens:120,completion_tokens:90,prompt_tokens_details:{cached_tokens:20}}}),{status:200});}) as typeof fetch;
  await assert.rejects(editorialCall(db,config,task,{chapter:'合成测试'},fetcher));
  assert.equal(db.one('SELECT output_tokens FROM model_calls WHERE task_id=?',task)!.output_tokens,90);assert.equal(db.one('SELECT COUNT(*) n FROM model_reservations WHERE task_id=? AND actual_cost IS NOT NULL',task)!.n,1);
  const result=await editorialCall(db,config,task,{chapter:'另一个合成测试'},fetcher);assert.equal(result.text,'这是可用的编辑结果。');
  await editorialCall(db,config,task,{chapter:'另一个合成测试'},fetcher);assert.equal(requests,2);assert.equal(db.one("SELECT COUNT(*) n FROM artifacts WHERE task_id=? AND kind='editorial_raw_response'",task)!.n,2);db.close();
});

 test('provider preamble before a JSON editorial result is recovered locally without another billed request',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-editor-prefix-')),db=new Database(join(dir,'db.sqlite3'),process.cwd()),service=new Service(db),config=new Configuration(db,dir),task=service.createTask('研究格式恢复合成测试',null);
 config.saveRoute({id:'report',provider:'fixture',model:'fixture',enabled:true,base_url:'https://model.example/v1',api_key:'fake-key',max_tokens:2048,rates:{input:1,cache:0.1,output:2}});config.set('model.queue',{min_interval_ms:0});
 let requests=0;const fetcher=(async()=>{requests++;return new Response(JSON.stringify({choices:[{message:{content:'以下为编辑结果：\n'+JSON.stringify({text:'这是主体分析。',visuals:[]})}}],usage:{prompt_tokens:100,completion_tokens:20}}));}) as typeof fetch;
 const value=await editorialCall(db,config,task,{chapter:'格式'},fetcher);assert.equal(value.text,'这是主体分析。');await editorialCall(db,config,task,{chapter:'格式'},fetcher);assert.equal(requests,1);db.close();
 });
