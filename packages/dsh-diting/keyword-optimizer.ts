import { Configuration } from '../domain/configuration.js';
import { Database, hash, encode, now, uid, type Row } from '../domain/db.js';
import { calculateCost } from '../domain/service.js';
import {acquireModelSlot} from '../domain/model-queue.js';

export type KeywordResult = { keywords: string[]; method: 'keyword_model' | 'bounded_fallback'; reason: string };
const system = '你是中文社交媒体舆情检索词优化器。把研究查询改写为10到20个贴近普通网民实际发帖用语的短关键词，覆盖简称、常见别称、口语表达、争议点和情绪表达；不要加入原题无关实体，不要输出专业报告词（如舆情、传播、倾向、展望）。每个关键词不含空格且不超过20个汉字。只返回JSON对象：{"keywords":["..."],"reasoning":"..."}。';

function fallback(query: string): string[] {
  const chunks = query.toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9][a-z0-9._+-]{1,}/gu) || [];
  const terms = new Set<string>();
  const add = (s: string) => { const value = s.trim().replace(/[\s，。！？；：、,.!?;:]+/g, ''); if (value.length >= 2 && value.length <= 20) terms.add(value); };
  add(query);
  for (const chunk of chunks) { add(chunk); if (/^[\p{Script=Han}]+$/u.test(chunk) && chunk.length >= 4) { add(chunk.slice(0, 2)); add(chunk.slice(-2)); } }
  return [...terms].slice(0, 20);
}
function parseKeywords(content: string, query: string): string[] {
  const jsonText = content.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) throw new Error('keyword JSON missing');
  const parsed = JSON.parse(jsonText) as Row;
  if (!Array.isArray(parsed.keywords)) throw new Error('keyword list missing');
  const sourceTerms = fallback(query).map(x => x.toLowerCase());
  const values = parsed.keywords.filter((x: unknown): x is string => typeof x === 'string')
    .map((x: string) => x.trim().replace(/\s+/g, ''))
    .filter((x: string) => x.length >= 2 && x.length <= 20 && !/[，。！？；：、,.!?;:]/.test(x));
  const kept = [...new Set(values)].filter(x => sourceTerms.some(term => term.includes(x.toLowerCase()) || x.toLowerCase().includes(term)) || values.length >= 10);
  if (kept.length < 5) throw new Error('too few valid keyword variants');
  return kept.slice(0, 20);
}

const pendingOptimizations=new WeakMap<Database,Map<string,Promise<KeywordResult>>>();
export async function optimizeKeywords(db: Database, config: Configuration, taskId: string, query: string, route: Row | null, fetcher: typeof fetch = fetch,runGuard?:()=>void): Promise<KeywordResult> {
  let pending=pendingOptimizations.get(db);if(!pending){pending=new Map();pendingOptimizations.set(db,pending);}const key=hash(encode({taskId,query,route}));
  const active=pending.get(key);if(active){const result=await active;runGuard?.();return result;}
  const job=runKeywordOptimization(db,config,taskId,query,route,fetcher,runGuard);pending.set(key,job);try{return await job;}finally{pending.delete(key);}
}
async function runKeywordOptimization(db: Database, config: Configuration, taskId: string, query: string, route: Row | null, fetcher: typeof fetch,runGuard?:()=>void): Promise<KeywordResult> {
  const cached = db.one("SELECT data_json FROM artifacts WHERE task_id=? AND kind='keyword_optimization' AND json_extract(data_json,'$.query')=? ORDER BY rowid DESC LIMIT 1", taskId,query);
  if (cached) {
    const prior = JSON.parse(cached.data_json) as Row;
    if (prior.query === query) return { keywords: prior.keywords, method: prior.method, reason: '复用本任务已保存的同查询优化结果' };
  }
  let result: KeywordResult = { keywords: fallback(query), method: 'bounded_fallback', reason: route ? '模型优化不可用，使用原题词与可验证分词回退' : 'keyword 模型槽未启用，使用原题词与可验证分词回退' };
  let input: number | null = null, output: number | null = null, cache: number | null = null, status = 'unavailable';
  if (route?.enabled && route.key_ref && config.hasSecret(route.key_ref)) {
    const callId=uid('call'),maxTokens=Math.min(Math.max(route.max_tokens||2048,2048),4096);let reserved=false,requestStarted=false,cooldown=0,started=Date.now(),release:(cooldownMs?:number)=>void=()=>{};
    try {
      if(!route.rates)throw Error('关键词模型缺少费率');
      db.transaction(()=>{runGuard?.();const totals=db.one('SELECT COUNT(*) n,COALESCE(SUM(COALESCE(actual_cost,reserved_cost)),0) cost FROM model_reservations WHERE task_id=?',taskId)!,budget=db.one('SELECT budget FROM tasks WHERE id=?',taskId)!.budget,reservation=(8192*Math.max(route.rates.input,route.rates.cache)+maxTokens*route.rates.output)/1e6;if(totals.n>=(config.get<Row>('runtime.policy',{}).max_calls||120)||totals.cost+reservation>budget)throw Error('关键词优化预算或调用额度不足');db.run('INSERT INTO model_reservations VALUES(?,?,?,NULL,?,?)',callId,taskId,reservation,'pending',now());reserved=true;});
      release=await acquireModelSlot(db,config,taskId,callId,'keyword',undefined,runGuard,route);runGuard?.();requestStarted=true;started=Date.now();db.event(taskId,'model.started',{role:'keyword',call_id:callId,max_output_tokens:maxTokens,message:'独立关键词模型开始优化查询'});
      const anthropic = route.protocol === 'anthropic-messages';
      const response = await fetcher(String(route.base_url).replace(/\/$/, '') + (anthropic ? '/v1/messages' : '/chat/completions'), {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: anthropic ? { 'Content-Type': 'application/json', 'x-api-key': config.secret(route.key_ref) || '', 'anthropic-version': '2023-06-01' } : { 'Content-Type': 'application/json', Authorization: `Bearer ${config.secret(route.key_ref)}` },
        body: JSON.stringify(anthropic ? { model: route.model, system, messages: [{ role: 'user', content: `研究查询：${query}` }], max_tokens: maxTokens,.../^glm-5/i.test(route.model)?{thinking:{type:'enabled'},reasoning_effort:'low',temperature:1}:{} } : { model: route.model, messages: [{ role: 'system', content: system }, { role: 'user', content: `研究查询：${query}` }], max_tokens: maxTokens,.../^glm-5/i.test(route.model)?{thinking:{type:'enabled'},reasoning_effort:'low',temperature:1}:{temperature:0.2}, stream: false }),
      });
      if (!response.ok){if(response.status===429)cooldown=30000;throw new Error('keyword provider HTTP '+response.status);}
      const body = await response.json() as Row;
      const content = anthropic ? (Array.isArray(body.content) ? body.content.filter((x: Row) => x.type === 'text').map((x: Row) => x.text).join('\n') : '') : body.choices?.[0]?.message?.content;
      const usage = body.usage || {};
      const rawInput = anthropic ? Number(usage.input_tokens) + Number(usage.cache_read_input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0) : Number(usage.prompt_tokens);
      const rawOutput = anthropic ? Number(usage.output_tokens) : Number(usage.completion_tokens);
      input = Number.isSafeInteger(rawInput) && rawInput >= 0 ? rawInput : null;
      output = Number.isSafeInteger(rawOutput) && rawOutput >= 0 ? rawOutput : null;
      const rawCache = anthropic ? Number(usage.cache_read_input_tokens || 0) : Number(usage.prompt_tokens_details?.cached_tokens);
      cache = Number.isSafeInteger(rawCache) && rawCache >= 0 && (input === null || rawCache <= input) ? rawCache : null;
      if (typeof content !== 'string') throw new Error('keyword model returned no text');
      result = { keywords: parseKeywords(content, query), method: 'keyword_model', reason: '由独立关键词模型生成并完成格式、长度和重复校验' };
      status = 'succeeded';
    } catch(error) { status = 'failed'; result.reason = '模型优化失败，使用原题词与可验证分词回退';db.event(taskId,'keyword.failed',{call_id:callId,message:'关键词优化未完成；已使用明确标记的本地分词回退',error_type:error instanceof Error?error.name:'Error',reason:error instanceof Error&&/^(keyword |too few valid)/.test(error.message)?error.message.slice(0,180):'请求超时、传输失败或调用前置检查未通过'}); }
    finally{release(cooldown);if(!requestStarted)input=output=cache=0;else db.event(taskId,'model.finished',{role:'keyword',call_id:callId,elapsed_ms:Date.now()-started,status});}
    if(reserved)db.transaction(()=>{const cost=calculateCost(input,output,cache,route.rates);db.run('INSERT INTO model_calls VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?)',callId,taskId,'keyword',route.provider,route.model,input,output,cache,cost,status,1,now());db.run('UPDATE model_reservations SET actual_cost=?,status=? WHERE id=?',cost,cost===null?'unknown':status,callId);});
  }
  runGuard?.();
  db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)', uid('artifact'), taskId, 'keyword_optimization', 'insight', JSON.stringify({ query, ...result, created_by: 'diting_typescript_middleware' }), now());
  return result;
}
