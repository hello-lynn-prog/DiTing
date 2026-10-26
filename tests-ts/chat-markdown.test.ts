import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync('web/live-bridge.js', 'utf8');
const start = source.indexOf('// The model returns Markdown.');
const end = source.indexOf('// Keep the conversation viewport', start);
assert.ok(start >= 0 && end > start, 'chat renderer block exists');

function renderer() {
  const context = {
    URL,
    document: { createElement: () => ({ textContent: '' }), head: { append: () => {} } },
    liveEsc: (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!),
    v4MessageHTML: (message: { role: string; text: string }) => `<div class="v4-message-text">${String(message.text).replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>`,
  };
  runInNewContext(source.slice(start, end), context);
  return context.v4MessageHTML;
}

test('assistant Markdown is formatted in the existing chat bubble', () => {
  const render = renderer();
  const html = render({ role: 'assistant', text: '## 采集情况\n\n- **视频**：10 条\n- 评论：1 条\n\n[来源](https://example.com/article)' });
  assert.match(html, /<h2>采集情况<\/h2>/);
  assert.match(html, /<ul><li><strong>视频<\/strong>：10 条<\/li><li>评论：1 条<\/li><\/ul>/);
  assert.match(html, /href="https:\/\/example\.com\/article"/);
  assert.doesNotMatch(html, /##|\*\*视频\*\*/);
});

test('user text stays literal and model HTML cannot execute', () => {
  const render = renderer();
  const markdown = '## 标题\n\n<script>alert(1)</script> **说明** [危险](javascript:alert(1))';
  const userHtml = render({ role: 'user', text: markdown });
  const assistantHtml = render({ role: 'assistant', text: markdown });
  assert.match(userHtml, /## 标题/);
  assert.doesNotMatch(userHtml, /<h2>/);
  assert.match(assistantHtml, /<h2>标题<\/h2>/);
  assert.match(assistantHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(assistantHtml, /<script>|href="javascript:/);
});
