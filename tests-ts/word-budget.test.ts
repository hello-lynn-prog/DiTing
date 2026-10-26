import {test} from 'node:test';import assert from 'node:assert/strict';
import {writingBudget,subsectionCoverage} from '../packages/reporting/word-budget.js';
import {templateContract,templates} from '../packages/reporting/report.js';
test('template word budget preserves all subsections, exact totals and brief targets, without inventing subheadings',()=>{
 for(const template of templates){const plan=writingBudget(templateContract(template));assert.equal(plan.chapters.reduce((n,c)=>n+c.target_chars,0),40000);assert.equal(plan.chapters.length,template.main_sections.length);
 for(const chapter of plan.chapters){assert.ok(chapter.target_chars>0);if(chapter.subsections.length)assert.equal(chapter.subsections.reduce((n,s)=>n+s.target_chars,0),chapter.target_chars);}}
 assert.equal(writingBudget(templateContract(templates[0]),1500).target_chars,1500);
 const custom=writingBudget({main_sections:['摘要','建议'],outline:[]},1001);assert.equal(custom.chapters.reduce((n,c)=>n+c.target_chars,0),1001);assert.equal(custom.chapters[1].subsections.length,0);
});
test('subsection coverage measures its own body and retains missing/short sections as advice, not a rejection loop',()=>{
 const chapter=writingBudget(templateContract(templates[0]),1500).chapters[0];
 const text='### 1.1 事件定性\n\n真实判断。\n\n### 1.2 核心洞察\n\n'+'具体案例与机制分析。'.repeat(30);
 const coverage=subsectionCoverage(text,chapter);assert.equal(coverage.length,3);assert.equal(coverage[0].actual_chars,5);assert.equal(coverage[0].status,'below_plan');assert.equal(coverage[1].actual_chars,300);assert.equal(coverage[2].status,'missing');
});
