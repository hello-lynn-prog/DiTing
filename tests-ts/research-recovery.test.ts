import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../apps/server/settings.js';
import { Database } from '../packages/domain/db.js';
import { Service, numbers, unsupportedNumericRelations } from '../packages/domain/service.js';
import { Configuration } from '../packages/domain/configuration.js';
import { searchWeb } from '../packages/collectors/search.js';
import { ReportPipeline } from '../packages/reporting/pipeline.js';
import { statistics, templates, validateReport, renderReport } from '../packages/reporting/report.js';
import { createApp } from '../apps/server/app.js';
import { reasoningProfile, roleOutputLimit } from '../packages/dsh-diting/model-policy.js';
import { reviseReport } from '../packages/reporting/revision.js';

test('forced-thinking GLM advertises supported reasoning and honors the frozen route output limit', () => {
  const glm = reasoningProfile({ model: 'GLM-5.3-Flash', protocol: 'anthropic-messages' });
  assert.equal(glm.provider?.reasoning, 'low'); assert.equal(glm.provider?.thinkingBudgets.low, 1024);
  assert.notEqual(glm.model.reasoningEfforts, false); assert.equal((glm.model.reasoningEfforts as any).off, null);
  // pi-ai detects the real BigModel hostname as legacy z.ai and disables effort
  // unless explicitly overridden; a localhost fixture alone cannot catch that.
  const coding = reasoningProfile({ model: 'glm-5.3-flash', protocol: 'openai-completions', base_url: 'https://open.bigmodel.cn/api/coding/paas/v4' });
  assert.equal(coding.model.compat?.supportsReasoningEffort, true);
  assert.equal(roleOutputLimit('main', 65536), 65536); assert.equal(roleOutputLimit('report', 65536), 65536);
  assert.equal(roleOutputLimit('verifier', 65536), 65536); assert.equal(roleOutputLimit('media', 65536), 65536); assert.equal(roleOutputLimit('report', 4096), 4096);
  assert.equal(reasoningProfile({ model: 'explicit-fixture' }).model.reasoningEfforts, false);
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'diting-recovery-')), db = new Database(join(dir, 'state.sqlite3'), ROOT);
  return { dir, db, service: new Service(db), config: new Configuration(db, dir) };
}

test('reference IDs are excluded from factual numbers but real entity/quantity substitutions still fail', () => {
  const id = 'evidence_85fa6d7195ae4d77bc8588dfe9dc8c51';
  assert.deepEqual(numbers(`据 ${id} 归档资料，甲公司发布了12份资料`), ['12']);
  assert.deepEqual(unsupportedNumericRelations(`甲公司发布了12份资料（${id}）`, '甲公司发布了12份资料'), []);
  assert.ok(unsupportedNumericRelations('乙公司发布了12份资料', '甲公司发布了12份资料').length);
  assert.ok(unsupportedNumericRelations('甲公司发布了999份资料', '甲公司发布了12份资料').length);
});

test('search archives provider diagnostics, backs off denied credentials and force rechecks a topped-up service', async () => {
  const { db, config, service } = setup(), task = service.createTask('检索故障恢复测试', null);
  config.set('service.bocha', { enabled: true, base_url: 'https://bocha.example/search' });
  config.putSecret('service.bocha', 'test-secret-only');
  let requests = 0, denied = true;
  const fetcher = (async () => {
    requests++;
    return denied ? new Response(JSON.stringify({ code: 'InsufficientBalance', message: '测试余额不足 test-secret-only' }), { status: 403 })
      : new Response(JSON.stringify({ code: 200, data: { webPages: { value: [{ name: '明确测试结果', url: 'https://example.org/story', snippet: '真实协议结构测试' }] } } }));
  }) as typeof fetch;
  try {
    const first = await searchWeb(config, task, '明确测试', new AbortController().signal, fetcher);
    assert.match(first.sources[0].error!, /403.*InsufficientBalance/);
    assert.equal(first.sources[0].error!.includes('test-secret-only'), false);
    await searchWeb(config, task, '明确测试', new AbortController().signal, fetcher);
    assert.equal(requests, 1, 'known 403 must not be retried for every new Agent turn');
    denied = false;
    const recovered = await searchWeb(config, task, '明确测试', new AbortController().signal, fetcher, undefined, { providers: ['bocha'], force: true });
    assert.equal(requests, 2); assert.equal(recovered.results.length, 1);
    assert.equal(config.get<any>('service.health.bocha', {}).status, 'succeeded');
    assert.equal(db.one('SELECT COUNT(*) n FROM acquisition_responses')!.n, 2);
    const raw = db.rows('SELECT response_json FROM acquisition_responses').map(r => r.response_json).join('');
    assert.equal(raw.includes('test-secret-only'), false); assert.ok(raw.includes('[redacted]'));
  } finally { db.close(); }
});

test('report planning is idempotent, saved drafts remain previewable, and all chapter failures are persisted together', () => {
  const { db, service } = setup(), task = service.createTask('报告恢复测试', null), run = service.claim('fixture')!;
  const evidence = service.archive(task, 'https://example.org/source', '明确测试材料', '公开机构已发布公开材料供查阅。');
  const claim = service.addClaim(task, '机构发布了公开材料', [{ evidence_id: evidence, quote: '机构已发布公开材料' }], run.lease_owner);
  const pipeline = new ReportPipeline(db, service, task), template = templates[0];
  const plan = { template_id: template.id, reason: '完整公共事件骨架，只使用测试材料' };
  pipeline.record('template', plan); pipeline.record('evidence_map', { claim_ids: [claim], evidence_ids: [evidence] });
  const chapters = template.sections.map((title, i) => ({ id: 'chapter-' + i, title, goal: '展示已保存章节以及证据范围和边界' }));
  const minimum = (title: string) => /摘要|概览/.test(title) ? 700 : /来源|附录/.test(title) ? 100 : /范围|方法|局限/.test(title) ? 300 : /样本|平台/.test(title) ? 500 : 900;
  pipeline.record('layout', { chapters }); pipeline.record('length', { chapters: chapters.map(c => ({ id: c.id, min_chars: minimum(c.title), max_chars: 3000 })) });
  for (const chapter of chapters) pipeline.record('chapter', { id: chapter.id, title: chapter.title, text: `### ${chapter.title}的测试判断与证据边界\n\n本章围绕${chapter.title}测试恢复与校验，不代表真实研究结论。${'本段是自动测试使用的合成占位内容，不可解释为真实事实。'.repeat(80)}`, claim_ids: [claim] });
  const duplicate = pipeline.record('template', plan);
  assert.equal(duplicate.reused, true); assert.equal(pipeline.progress().chapters.filter((c: any) => c.saved).length, chapters.length);
  const tables = statistics(db, task); pipeline.record('repair', { issues: [], actions: [] });
  assert.equal(pipeline.preview().published, false); assert.equal(db.one('SELECT COUNT(*) n FROM reports')!.n, 0);
  for (const chapter of chapters.slice(0, 2)) pipeline.record('chapter', { id: chapter.id, title: chapter.title, text: `### ${chapter.title}存在一项待核实的数据\n\n针对${chapter.title}，测试章节包含机构发布了999份资料的未支持数字，应被保留为草稿而不得发布。${'此处为合成占位说明，不构成现实事实。'.repeat(50)}`, claim_ids: [claim] });
  assert.throws(() => pipeline.finalize({ title: '错误草稿测试', template_id: template.id, dataset_ids: [tables.id], limitations: ['本测试材料不能代表真实研究。'] }), /无引用或统计底表支持的数字|数字与所引结论/);
  assert.equal(db.one("SELECT COUNT(*) n FROM artifacts WHERE kind='report_validation'")!.n, 1);
  assert.equal(db.one("SELECT COUNT(*) n FROM artifacts WHERE kind='report_candidate'")!.n, 0);
  db.close();
});

test('runtime API accepts 800 calls and still enforces an upper bound', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diting-policy-')), { app } = await createApp({ dataDir: dir }, false);
  try {
    const response = await app.inject({ method: 'PUT', url: '/api/config/runtime', payload: { enabled: false, max_calls: 800, max_minutes: 45 } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().max_calls, 800);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/config/runtime', payload: { enabled: false, max_calls: 2001, max_minutes: 45 } })).statusCode, 400);
  } finally { await app.close(); }
});

test('reader report keeps provenance accessible without technical IDs in prose or meaningless missing-field charts', () => {
  const { db, service } = setup(), task = service.createTask('读者报告验收', null), run = service.claim('fixture')!;
  try {
    const evidence = service.archive(task, 'https://example.org/story', '机构公开材料', '机构公开了安全措施并解释适用范围。');
    const claim = service.addClaim(task, '机构公开了安全措施', [{ evidence_id: evidence, quote: '机构公开了安全措施' }], run.lease_owner);
    const data = statistics(db, task), document = { title: '安全措施如何回应关切', template_id: 'public-event', reader_version: 2, sections: templates[0].sections.map(title => ({ title, text: `### ${title}需要结合适用范围判断\n\n${title}：机构公开了安全措施。读者应核对措施适用条件、负责主体和出现问题后的处理方式，再判断它能否回应关切。现有材料只能支持对公开表述的归纳，不能证明措施在所有场景都有效，也不能替代受影响者的实际处理记录。\n\n下一步应比较适用条款、实际执行案例与纠错机制，观察公开承诺是否能被外部核查。当前章节关注的事项各有侧重，因此不能把单一材料扩写成普遍结论。` + '应当继续对照公开承诺和实际处理记录，判断不同对象能否获得清晰说明和可行的纠错渠道。'.repeat(24), claim_ids: [claim] })), dataset_ids: data.datasets.map(t => t.id), limitations: ['仅使用合成材料验证程序，不代表真实研究。'] };
    const valid = validateReport(db, task, document), rendered = renderReport(db, task, valid);
    assert.ok(rendered.html.includes('参考资料')); assert.ok(rendered.html.includes(`href="#${evidence}"`));
    const visibleProse = rendered.html.match(/<div class="chapter-body">([\s\S]*?)<\/div>/g)!.join('');
    assert.ok(!visibleProse.includes('claim_')); assert.ok(!visibleProse.includes('evidence_'));
    assert.ok(rendered.html.includes('<details id="audit">')); assert.ok(rendered.html.includes('<table>'));
    assert.equal((rendered.html.match(/<svg /g) || []).length, 2, 'only real source and acquisition dimensions are graphed; cluster and word frequency stay empty when the sample is too small');
    const thin = { ...document, sections: document.sections.map(section => ({ ...section, text: `### ${section.title}只有一个初步判断\n\n针对${section.title}，目前的公开材料只支持有限观察。` })) };
    assert.ok(validateReport(db,task,thin).editorial_warnings.some(w=>w.includes('38000 字')),'full report has BettaFish depth guidance without forcing padding/retry loops');
    const processLeak = { ...document, sections: document.sections.map((section, i) => i ? section : { ...section, text: section.text + ' task_context 读取故障，不作为正式结论。' }) };
    assert.throws(() => validateReport(db, task, processLeak), /内部编号或执行说明/);
    document.sections[0].text += ' 内部编号 ' + evidence;
    assert.throws(() => validateReport(db, task, document), /内部编号|内部技术编号/);
  } finally { db.close(); }
});

test('editorial revisions reject changed research and never overwrite the original report', async () => {
  const { db, service, dir } = setup(), task = service.createTask('修订版本边界验收', null), run = service.claim('fixture')!;
  try {
    const evidence = service.archive(task, 'https://example.org/article', '公开材料', '机构公开了安全措施供读者核查。');
    const claim = service.addClaim(task, '机构公开了安全措施', [{ evidence_id: evidence, quote: '机构公开了安全措施' }], run.lease_owner);
    const data = statistics(db, task), document = { title: '公开安全措施研判', template_id: 'public-event', sections: templates[0].sections.map(title => ({ title, text: `### ${title}需要结合适用范围判断\n\n${title}：机构公开了安全措施。读者应核对措施适用条件、负责主体和出现问题后的处理方式，再判断它能否回应关切。现有材料只能支持对公开表述的归纳，不能证明措施在所有场景都有效，也不能替代受影响者的实际处理记录。\n\n下一步应比较适用条款、实际执行案例与纠错机制，观察公开承诺是否能被外部核查。当前章节关注的事项各有侧重，因此不能把单一材料扩写成普遍结论。` + '应当继续对照公开承诺和实际处理记录，判断不同对象能否获得清晰说明和可行的纠错渠道。'.repeat(2), claim_ids: [claim] })), dataset_ids: data.datasets.map(t => t.id), limitations: ['这是版本边界测试，只验证程序。'] };
    const current = service.reviewInput(task);
    for (const gate of ['sufficiency', 'verifier', 'advocate']) db.run('INSERT INTO reviews VALUES(?,?,?,?,?,?,?)', task, gate, current.evidence_revision, current.claims_hash, 1, '合成材料边界测试审查', '2026-01-01');
    const original = service.publishReport(task, validateReport(db, task, document), run.lease_owner);
    const before = db.one('SELECT document_json FROM reports WHERE id=?', original)!.document_json;
    db.run('UPDATE tasks SET evidence_revision=evidence_revision+1 WHERE id=?', task);
    await assert.rejects(reviseReport(db, service, original, document, dir), /研究版本已变化/);
    assert.equal(db.one('SELECT COUNT(*) n FROM reports')!.n, 1);
    assert.equal(db.one('SELECT document_json FROM reports WHERE id=?', original)!.document_json, before);
  } finally { db.close(); }
});

test('structural section markers are excluded while real quantities and same-language entity swaps remain checked',()=>{
  assert.deepEqual(numbers('【section-1】甲公司发布了12份资料'),['12']);assert.deepEqual(numbers('section-2｜甲公司发布了12份资料'),['12']);
  assert.equal(unsupportedNumericRelations('数千家供应商中仅约130家被估计为真实','Gartner estimates only about 130 of thousands of agentic AI vendors are real').length,0);
  assert.ok(unsupportedNumericRelations('甲组共有7条记录','乙组共有7条记录').length);
  assert.ok(unsupportedNumericRelations('Company B has 7 records','Company A has 7 records').length);
  assert.ok(unsupportedNumericRelations('甲组共有8条记录','Group A has 7 records').length);
  assert.ok(unsupportedNumericRelations('甲组占比12%','Group A has 13%').length);
  assert.deepEqual(numbers('产品section-1有12份资料'),['1','12']);
});

test('prose before a number is not guessed to be a named entity',()=>{
 assert.deepEqual(unsupportedNumericRelations('《拒绝操作应用清单》显示目前已155款','显示目前已155款'),[]);
 assert.deepEqual(unsupportedNumericRelations('Indeed平台FDE相关岗位5330个','2026年4月FDE相关岗位5330个'),[]);
 assert.deepEqual(unsupportedNumericRelations('同比暴增729%','较一年前的643个同比暴增729%'),[]);
 assert.ok(unsupportedNumericRelations('甲公司共有42条','乙公司共有42条').length);
});
