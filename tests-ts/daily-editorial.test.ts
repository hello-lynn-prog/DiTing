import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDailyThemes,dailyAnchorGrade,relatedDailyTheme,shortlistDailyThemes} from '../packages/domain/daily-editorial.js';
import type {Row} from '../packages/domain/db.js';

test('distinct events can share a specific subject without grouping every AI headline',()=>{
 assert.equal(relatedDailyTheme('小米汽车公布交付计划','小米汽车回应售后争议'),true);
 assert.equal(relatedDailyTheme('AI 融资热潮持续','AI Agent 企业落地'),false);
 const events=[{id:'a',title:'小米汽车公布交付计划',category:'科技与产业',sources:['board:a'],source_urls:['https://a.example']},{id:'b',title:'小米汽车回应售后争议',category:'科技与产业',sources:['board:b'],source_urls:['https://b.example']},{id:'c',title:'AI Agent 企业落地',category:'科技与产业',sources:['board:c'],source_urls:[]}];
 const themes=buildDailyThemes(events,[],(a,b)=>a===b);assert.equal(themes.length,2);assert.equal(themes[0].members.length,2);assert.equal(themes[0].source_count,2);
});

test('cross-day pairing comes from all prior titles and does not call a repeat progress',()=>{
 const today=[{id:'a',title:'小米汽车公布交付计划',category:'科技与产业',sources:['board:a'],source_urls:[],best_rank:2}];
 const same=buildDailyThemes(today,[{title:'小米汽车公布交付计划'}],(a,b)=>a===b)[0];assert.equal(same.continuation,'持续上榜');assert.equal(same.continuation_pairs[0].yesterday_title,'小米汽车公布交付计划');
});

test('short factual dispatch can be A; a title action is B; a topic alone is C',()=>{
 assert.equal(dailyAnchorGrade('小米汽车公布交付计划','小米汽车公布交付计划，明确交付时间和车型安排，并说明用户可在官方渠道查询。有关负责人介绍，此次计划适用于已下订车辆。'),'A');
 assert.equal(dailyAnchorGrade('小米汽车公布交付计划',''),'B');
 assert.equal(dailyAnchorGrade('小米汽车话题',''),'C');
 assert.equal(dailyAnchorGrade('小米汽车公布交付计划','火山引擎正在进行安全检测，点击加载更多阅读排行榜评论排行榜'),'B');
});

test('shortlist rewards high rank rather than a large rank number and is bounded',()=>{
 const themes=Array.from({length:45},(_,i)=>({id:`t${i}`,title:`议题${i}`,category:'综合观察',source_count:1,best_rank:i+1,continuation_pairs:[]}));
 const selected=shortlistDailyThemes(themes as Row[],40);assert.equal(selected.length,40);assert.equal(selected[0].id,'t0');assert.equal(selected.some(t=>t.id==='t44'),false);
});
