import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../apps/server/settings.js';
import { Database } from '../packages/domain/db.js';
import { Service } from '../packages/domain/service.js';
import { normalizeJsonParameters } from '../packages/dsh-diting/normalize.js';
import { common, rootPersona, roles } from '../packages/dsh-diting/roles.js';
import { requiresInitialInvestigationSubmission } from '../packages/dsh-diting/investigation-gate.js';
import { persistInvestigation,repairInvestigationSubmission } from '../packages/dsh-diting/investigation-submit.js';

test('unwraps provider-serialized arrays/objects for dsh json parameters', () => {
  const input = {
    claims: JSON.stringify([{ text: '有原文支持的结论', references: [{ evidence_id: 'ev_1', quote: '这是足够长的逐字原文' }] }]),
    gaps: '[]',
    options: '{"max_posts":5}',
    query: 'AI',
  };
  const result = normalizeJsonParameters(input, {
    claims: { type: 'json' }, gaps: { type: 'json' }, options: { type: 'json' }, query: { type: 'string' },
  });
  assert.deepEqual(result.claims, JSON.parse(input.claims));
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.options, { max_posts: 5 });
  assert.equal(result.query, 'AI');
});

test('leaves malformed JSON untouched for the tool schema to reject', () => {
  const result = normalizeJsonParameters({ claims: '[broken', gaps: '[]' }, { claims: { type: 'json' }, gaps: { type: 'json' } });
  assert.equal(result.claims, '[broken');
  assert.deepEqual(result.gaps, []);
});

test('research prompts require persisted investigator artifacts before gates', () => {
  assert.match(common, /调查成员应先拆分研究问题并查找\/抓取材料/);
  assert.match(common, /调查阶段结束前必须调用 investigation_submit/);
  assert.match(rootPersona, /调查成果须分别标记 insight\/media\/query/);
  assert.match(rootPersona, /恢复任务时不得无条件重跑成员/);
  assert.match(rootPersona, /从最后已保存阶段继续/);
  assert.match(rootPersona, /continue_waiting=true 时，必须继续等待/);
  assert.match(rootPersona, /旧 session 的子 Agent 可能保留过期工具权限/);
  assert.match(roles.forum.persona, /旁路协作/);
  assert.match(roles.forum.persona, /绝不等待主持意见/);
  assert.match(roles.forum.persona, /5条新摘要/);
});

test('investigators can collect evidence before submitting conclusions', () => {
  assert.equal(requiresInitialInvestigationSubmission('query', 'source_search', 10, false), false);
  assert.equal(requiresInitialInvestigationSubmission('insight', 'sample_annotate', 1, false), false);
  assert.equal(requiresInitialInvestigationSubmission('media', 'source_fetch', 10, true), false);
  assert.equal(requiresInitialInvestigationSubmission('query', 'source_search', 0, false), false);
  assert.equal(requiresInitialInvestigationSubmission('main', 'source_search', 10, false), false);
  assert.equal(requiresInitialInvestigationSubmission('query', 'investigation_submit', 10, false), false);
});

test('investigation submission atomically rolls back invalid claims and safely retries committed claims', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diting-investigation-submit-'));
  const db = new Database(join(dir, 'diting.sqlite3'), ROOT), service = new Service(db);
  const taskId = service.createTask('调查近7天 AI 行业争议', null), run = service.claim('test-worker')!;
  const evidenceId = service.archive(taskId, 'https://example.org/source', '原文', 'FTC 已向 Anthropic 和 OpenAI 发出调查要求。', run.lease_owner);
  const valid = { text: 'FTC 已向 Anthropic 和 OpenAI 发出调查要求。', references: [{ evidence_id: evidenceId, quote: 'FTC 已向 Anthropic 和 OpenAI 发出调查要求。' }] };
  const invalid = { text: '不相关结论', references: [{ evidence_id: evidenceId, quote: '这段原文不存在' }] };
  assert.throws(() => persistInvestigation(db, service, taskId, 'query', [valid, invalid], [], run.lease_owner, 'agent_test'));
  assert.equal(db.one('SELECT COUNT(*) n FROM claims WHERE task_id=?', taskId)?.n, 0);
  assert.equal(db.one('SELECT COUNT(*) n FROM artifacts WHERE task_id=? AND kind=\'investigation\'', taskId)?.n, 0);
  const committed = persistInvestigation(db, service, taskId, 'query', [valid], [], run.lease_owner, 'agent_test');
  const retry = persistInvestigation(db, service, taskId, 'query', [valid], [], run.lease_owner, 'agent_test');
  assert.deepEqual(retry.claim_ids, committed.claim_ids);
  assert.equal(db.one('SELECT COUNT(*) n FROM claims WHERE task_id=?', taskId)?.n, 1);
  assert.equal(db.one('SELECT COUNT(*) n FROM artifacts WHERE task_id=? AND kind=\'investigation\'', taskId)?.n, 2);
  db.close();
});

test('investigation rejection lists all failing claim indexes in one response and preserves batch rollback',()=>{
  const dir=mkdtempSync(join(tmpdir(),'diting-all-claim-errors-')),db=new Database(join(dir,'db.sqlite3'),ROOT),service=new Service(db),task=service.createTask('调查错误聚合测试',null),run=service.claim('fixture')!;
  const eid=service.archive(task,'https://example.org/all-errors','原文','甲组共有42条记录。',run.lease_owner),reference={evidence_id:eid,quote:'甲组共有42条记录。'};
  try{assert.throws(()=>persistInvestigation(db,service,task,'query',[{text:'甲组共有42条记录。',references:[reference]},{text:'甲组共有99条记录。',references:[reference]},{text:'乙组共有42条记录。',references:[reference]}],[],run.lease_owner,'agent_fixture'),e=>e instanceof Error&&e.message.includes('claims[1]')&&e.message.includes('claims[2]')&&!e.message.includes('claims[0]'));assert.equal(db.one('SELECT COUNT(*) n FROM claims')!.n,0);}finally{db.close();}
});

test('indexed repairs preserve untouched source quotes, rerun validation and reject another role/task',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-claim-patch-')),db=new Database(join(dir,'db.sqlite3'),ROOT),service=new Service(db),task=service.createTask('调查局部修复验收',null),run=service.claim('fixture')!;
 const eid=service.archive(task,'https://example.org/claim-patch','原文','甲组共有42条记录。乙组共有7条记录。',run.lease_owner),refs=[{evidence_id:eid,quote:'甲组共有42条记录。'}],valid={text:'甲组共有42条记录。',references:refs};
 try{assert.throws(()=>persistInvestigation(db,service,task,'media',[valid,{text:'甲组共有99条记录。',references:refs}],[],run.lease_owner,'agent_fixture'));const pending=db.one("SELECT id FROM artifacts WHERE kind='investigation_submission'")!.id;
 assert.throws(()=>repairInvestigationSubmission(db,service,task,'query',pending,[],[],run.lease_owner,'agent_fixture'),/当前任务与角色/);
 assert.throws(()=>repairInvestigationSubmission(db,service,task,'media',pending,[{index:1,text:'甲组共有98条记录。'}],[],run.lease_owner,'agent_fixture'),/claims\[1\]/);
 const result=repairInvestigationSubmission(db,service,task,'media',pending,[{index:1,text:'甲组确有这些记录。'}],[],run.lease_owner,'agent_fixture');assert.equal(result.claim_ids.length,2);assert.deepEqual(JSON.parse(db.one('SELECT references_json FROM claims WHERE text=?',valid.text)!.references_json),refs);
 }finally{db.close();}
});
