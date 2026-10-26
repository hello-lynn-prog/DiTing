import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../packages/domain/db.js';
import { Configuration } from '../packages/domain/configuration.js';
import { Service } from '../packages/domain/service.js';
import { optimizeKeywords } from '../packages/dsh-diting/keyword-optimizer.js';
import { ROOT } from '../apps/server/settings.js';

test('Insight query middleware uses the independent keyword model, validates variants, meters usage and caches repeats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diting-keywords-')), db = new Database(join(dir, 'state.sqlite3'), ROOT), config = new Configuration(db, dir), service = new Service(db), taskId = service.createTask('AI 行业争议', null);
  config.putSecret('fixture', 'local-test-key'); let calls = 0;
  const route = { id: 'keyword', protocol: 'openai-completions', provider: 'fixture', model: 'keyword-test', base_url: 'https://model.example/v1', enabled: true, key_ref: 'fixture', rates: { input: 1, cache: 0.1, output: 2 } };
  const fetcher = (async (_url, init) => { calls++; assert.equal((JSON.parse(String(init?.body))).model, 'keyword-test'); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keywords: ['AI', '人工智能', 'AI行业争议', '大模型翻车', '模型乱说', 'AI失业', 'AI替代工作', '模型侵权', 'AI伦理争议', 'AI幻觉'] }) } }], usage: { prompt_tokens: 20, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 4 } } })); }) as typeof fetch;
  const first = await optimizeKeywords(db, config, taskId, '分析 AI 行业争议', route, fetcher);
  const again = await optimizeKeywords(db, config, taskId, '分析 AI 行业争议', route, fetcher);
  assert.equal(first.method, 'keyword_model'); assert.ok(first.keywords.includes('模型侵权')); assert.equal(again.method, 'keyword_model'); assert.equal(calls, 1);
  const meter = db.one("SELECT role,input_tokens,output_tokens,cache_tokens,status FROM model_calls WHERE task_id=?", taskId)!;
  assert.deepEqual({ ...meter }, { role: 'keyword', input_tokens: 20, output_tokens: 8, cache_tokens: 4, status: 'succeeded' });
  db.close();
});

test('keyword optimizer has an explicit local fallback when no separate model slot is enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diting-keywords-fallback-')), db = new Database(join(dir, 'state.sqlite3'), ROOT), config = new Configuration(db, dir), service = new Service(db), taskId = service.createTask('AI 行业争议', null);
  const result = await optimizeKeywords(db, config, taskId, '近期人工智能行业争议', null);
  assert.equal(result.method, 'bounded_fallback'); assert.ok(result.keywords.includes('近期人工智能行业争议')); assert.ok(result.reason.includes('未启用'));
  assert.equal(db.one("SELECT COUNT(*) n FROM artifacts WHERE task_id=? AND kind='keyword_optimization'", taskId)!.n, 1); db.close();
});

test('keyword middleware shares the task reservation cap and records billed invalid output',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'diting-keyword-budget-')),db=new Database(join(dir,'db.sqlite3'),ROOT),config=new Configuration(db,dir),service=new Service(db),task=service.createTask('关键词预算测试',null);config.putSecret('fixture','explicit-key');const route={enabled:true,key_ref:'fixture',protocol:'openai-completions',provider:'fixture',model:'fixture',base_url:'https://model.example/v1',rates:{input:1,cache:0.1,output:2}};let calls=0;
  const fetcher=(async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'invalid'}}],usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:0}}}));}) as typeof fetch;
  db.run('UPDATE tasks SET budget=0.000001 WHERE id=?',task);await optimizeKeywords(db,config,task,'检查预算限制',route,fetcher);assert.equal(calls,0);assert.equal(db.one('SELECT COUNT(*) n FROM model_calls')!.n,0);
  db.run('UPDATE tasks SET budget=20 WHERE id=?',task);await optimizeKeywords(db,config,task,'检查失败输出费用',route,fetcher);assert.equal(calls,1);assert.equal(db.one('SELECT status FROM model_calls')!.status,'failed');assert.ok(db.one('SELECT actual_cost FROM model_reservations')!.actual_cost>0);db.close();
});

test('concurrent identical keyword queries share one metered request and native Anthropic GLM uses low reasoning',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'diting-keyword-concurrent-')),db=new Database(join(dir,'db.sqlite3'),ROOT),config=new Configuration(db,dir),service=new Service(db),task=service.createTask('关键词并发验收',null);config.putSecret('fixture','fixture-key');
  const route={enabled:true,key_ref:'fixture',protocol:'anthropic-messages',provider:'fixture',model:'GLM-5.3-Flash',base_url:'https://model.example',rates:{input:1,cache:0.1,output:2}};let calls=0;
  const fetcher=(async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.reasoning_effort,'low');return new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify({keywords:['AI落地','AI智能体','AI工具','AI失业','AI翻车','AI幻觉','AI创业','AI风险','AI赚钱','AI投资']})}],usage:{input_tokens:50,output_tokens:100,cache_read_input_tokens:0}}));}) as typeof fetch;
  try{const results=await Promise.all([optimizeKeywords(db,config,task,'AI',route,fetcher),optimizeKeywords(db,config,task,'AI',route,fetcher)]);assert.equal(calls,1);assert.ok(results.every(r=>r.method==='keyword_model'));assert.equal(db.one('SELECT COUNT(*) n FROM model_calls')!.n,1);assert.equal(db.one("SELECT COUNT(*) n FROM events WHERE kind='model.finished'")!.n,1);}finally{db.close();}
});
