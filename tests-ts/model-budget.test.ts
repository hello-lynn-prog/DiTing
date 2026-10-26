import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveModelCost } from '../packages/domain/model-budget.js';

test('model reservation scales with the serialized multi-agent prompt and reserves all in-flight output', () => {
  const rates = { input: 0.8, cache: 0.23, output: 2.8 };
  const short = reserveModelCost({ messages: [{ role: 'user', content: '短问题' }] }, 4096, rates);
  const long = reserveModelCost({ messages: [{ role: 'user', content: '长上下文'.repeat(40_000) }] }, 4096, rates);
  assert.ok(long > short * 5, 'large context must reserve proportionally more than a fixed per-call allowance');
  const outputHeavy = reserveModelCost({ messages: [] }, 8192, rates);
  assert.ok(outputHeavy > reserveModelCost({ messages: [] }, 4096, rates));
  assert.ok(reserveModelCost('x', 100, { input: 0.1, cache: 0.2, output: 0.3 }) > 0);
});
