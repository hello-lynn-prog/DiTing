import {test} from 'node:test';import assert from 'node:assert/strict';
import {frozenResearchWindow,rejectMismatchedTitleWindow} from '../packages/domain/research-window.js';

test('frozen research dates stay anchored to task creation and reject a wrong overall report title range',()=>{
 const window=frozenResearchWindow('2026-10-21T01:56:35.682Z',7);
 assert.equal(window.start,'2026-10-14T01:56:35.682Z');assert.equal(window.end_date,'2026-10-21');assert.equal(window.start_date,'2026-10-14');
 assert.throws(()=>rejectMismatchedTitleWindow('近7天AI研判报告（2026年10月12日-21日）',window),/冻结窗口/);
 assert.doesNotThrow(()=>rejectMismatchedTitleWindow('近7天AI研判报告（2026年10月14日-21日）',window));
 assert.doesNotThrow(()=>rejectMismatchedTitleWindow('AI行业历史演变研判报告',window));
});
