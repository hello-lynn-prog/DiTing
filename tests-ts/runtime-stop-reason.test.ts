import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeStopReason} from '../packages/dsh-diting/runtime.js';

test('budget stop takes precedence over a provider stream error and preserves checkpoint wording',()=>{
  assert.equal(runtimeStopReason({budgetMessage:'剩余预算不足以预留下一次模型调用，已停止继续调用',turnError:'Stream ended without finish_reason'}),'研究预算已用尽：剩余预算不足以预留下一次模型调用，已停止继续调用。已停止继续调用并保留检查点。');
  assert.equal(runtimeStopReason({modelFailure:'503 unavailable',turnError:'secondary'}),'本轮模型调用失败：503 unavailable');
  assert.equal(runtimeStopReason({turnError:'Stream ended without finish_reason'}),'dsh 本轮执行异常：Stream ended without finish_reason');
});
