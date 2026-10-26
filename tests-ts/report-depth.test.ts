import {test} from 'node:test';import assert from 'node:assert/strict';import {narrativeProfile} from '../packages/reporting/depth.js';
test('full narrative keeps BettaFish word budget while deliberate briefs and user lengths take precedence',()=>{
 assert.equal(narrativeProfile('请深度分析近7天AI争议，给完整报告').target_chars,40000);assert.equal(narrativeProfile('分析AI，不要简报').mode,'full');assert.equal(narrativeProfile('分析AI，只要简报').target_chars,1500);assert.equal(narrativeProfile('分析AI，控制在10000字').target_chars,10000);assert.equal(narrativeProfile('分析AI，约3万字').target_chars,30000);assert.equal(narrativeProfile('预算20元').target_chars,40000);
});
