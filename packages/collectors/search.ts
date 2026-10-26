import { Configuration } from '../domain/configuration.js';
import { type Row, now, uid, encode } from '../domain/db.js';
import { fetchText, plainText } from './network.js';
import { extractPageMetadata, normalizePublishedAt } from './page-metadata.js';
import { extractArticleText } from './article-extract.js';

/** Provider wire protocols are separate from the Agent loop; returned snippets are discovery only. */
export async function searchWeb(config: Configuration, taskId: string | null, query: string, signal: AbortSignal, fetcher: typeof fetch = fetch, window?: { start_date?: string; end_date?: string }, options: { providers?: string[]; force?: boolean } = {}) {
  if (query.length < 2 || query.length > 1000) throw new Error('检索关键词长度无效');
  const startDate=window?.start_date, endDate=window?.end_date;
  const validDate=(v:string|undefined)=>{if(!v)return true;if(!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const parsed=new Date(v+'T00:00:00Z');return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===v;};
  if(!validDate(startDate)||!validDate(endDate)||(startDate&&endDate&&startDate>endDate))throw new Error('检索时间范围必须使用有效的 YYYY-MM-DD 日期且开始不晚于结束');
  const enabled = ['tavily', 'bocha', 'anspire'].filter(id => (!options.providers || options.providers.includes(id)) && config.get<Row>(`service.${id}`, {}).enabled && config.hasSecret(`service.${id}`));
  if (!enabled.length) throw new Error('尚未配置并启用检索供应商；没有虚构搜索结果');
  const outcomes = await Promise.all(enabled.map(async provider => {
    const settings = config.get<Row>(`service.${provider}`, {}), key = config.secret(`service.${provider}`)!;
    const previous = config.get<Row>(`service.health.${provider}`, {});
    if (!options.force && previous.retry_at && new Date(previous.retry_at).getTime() > Date.now())
      return { provider, results: [], error: `供应商暂缓重试至 ${previous.retry_at}：${previous.last_error}`, skipped: true };
    const acquisitionId = uid('acq'); let statusCode: number | null = null, responseBody: unknown = null;
    const scrub = (value: string) => value.replaceAll(key, '[redacted]').slice(0, 300);
    const archive = (status: string, detail: string) => config.db.transaction(() => {
      config.db.run('INSERT INTO acquisitions VALUES(?,?,?,?,?,?,?)', acquisitionId, taskId, provider, 'search', status, detail, now());
      config.db.run('INSERT INTO acquisition_responses VALUES(?,?,?,?,?)', acquisitionId, encode({ provider, query, window: window || null }), responseBody === null ? null : encode(responseBody), statusCode, now());
    });
    let url = settings.base_url, init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } };
    if (provider === 'tavily') init.body = JSON.stringify({ api_key: key, query, max_results: 8, search_depth: 'advanced', include_answer: false, ...(startDate?{start_date:startDate}:{}), ...(endDate?{end_date:endDate}:{}) });
    if (provider === 'bocha') init.body = JSON.stringify({ query, summary: false, count: 8, stream: false });
    if (provider === 'anspire') { const u = new URL(url); u.searchParams.set('query', query); u.searchParams.set('top_k', '8'); url = u.href; init.method = 'GET'; }
    try {
      const response = await fetcher(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      statusCode = response.status;
      const raw = (await response.text()).replaceAll(key, '[redacted]');
      try { responseBody = JSON.parse(raw); } catch { responseBody = { raw: raw.slice(0, 100000) }; }
      const data = responseBody as Row;
      if (!response.ok) {
        const reason = [data?.code, data?.message || data?.msg || data?.error?.message || (typeof data?.error === 'string' ? data.error : '')].filter(Boolean).join('：');
        throw new Error(`供应商 HTTP ${response.status}${reason ? ' · ' + scrub(reason) : ''}`);
      }
      if (provider === 'bocha' && data.code !== undefined && ![0, 200, '0', '200'].includes(data.code)) throw new Error(`Bocha 业务错误：${scrub(String(data.code) + ' ' + String(data.message || data.msg || '未提供说明'))}`);
      let rows = provider === 'bocha' ? data.data?.webPages?.value || data.webPages?.value : data.results;
      if (!Array.isArray(rows) && provider === 'bocha' && Array.isArray(data.messages)) rows = data.messages.filter((m: Row) => m.type === 'source' && m.content_type === 'webpage').flatMap((m: Row) => (typeof m.content === 'string' ? JSON.parse(m.content) : m.content)?.value || []);
      if (!Array.isArray(rows) || !rows.length) throw new Error('供应商未返回可识别的搜索列表');
      const results = rows.map((r: Row) => {const published_at=r.published_date||r.publishedAt||r.date||null,candidate=published_at&&/^\d{4}-\d{2}-\d{2}/.test(String(published_at))?String(published_at).slice(0,10):null,date=candidate&&validDate(candidate)?candidate:null;return { title: String(r.title || r.name || ''), url: String(r.url || ''), snippet: String(r.content || r.snippet || ''), published_at, date_status:!date?'unknown':(!startDate||date>=startDate)&&(!endDate||date<=endDate)?'in_window':'outside_window', provider };}).filter((r: Row) => /^https?:\/\//.test(r.url));
      const filtered=results.filter((r:Row)=>r.date_status!=='outside_window');
      archive('succeeded', `返回 ${filtered.length} 个窗口内/日期未知发现链接，另过滤 ${results.length-filtered.length} 个窗口外结果；摘要不是原文证据，供应商工具费未回传时保持未知`);
      config.set(`service.health.${provider}`,{status:'succeeded',checked_at:now(),result_count:filtered.length,last_error:null,retry_at:null});
      return { provider, results:filtered, error: null };
    } catch (error) {
      const message = scrub(error instanceof Error ? error.message : '检索失败');
      archive('failed', message);
      const retry_at = [401,403,429].includes(statusCode || 0) ? new Date(Date.now() + (statusCode === 429 ? 60000 : 300000)).toISOString() : null;
      config.set(`service.health.${provider}`,{status:'failed',checked_at:now(),result_count:0,last_error:message,retry_at});
      return { provider, results: [], error: message };
    }
  }));
  const seen = new Set<string>(), results = outcomes.flatMap(o => o.results).filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; });
  return { results, window:{start_date:startDate||null,end_date:endDate||null,unknown_date_policy:'保留并标记 unknown；不将采集时间当发布时间'}, sources: outcomes.map(({ results, ...rest }) => ({ ...rest, count: results.length })), evidence: false };
}

/** External Firecrawl is optional. DiTing extracts public article text in-process by default. */
export function firecrawlConfigured(config: Configuration) {
  const service = config.get<Row>('service.firecrawl', {});
  if (!service.enabled || typeof service.base_url !== 'string') return false;
  try {
    const url = new URL(service.base_url);
    return config.hasSecret('service.firecrawl') || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch { return false; }
}
export async function scrapePublicPage(config: Configuration, url: string, signal: AbortSignal, fetcher: typeof fetch = fetch, pageFetcher:typeof fetchText=fetchText) {
  const service = config.get<Row>('service.firecrawl', {});
  if (!firecrawlConfigured(config)) {
    const result = await pageFetcher(url, signal, true,{allowedOrigins:[new URL(url).origin]});
    if(!/^text\/html\b|^application\/xhtml\+xml\b/i.test(String(result.headers?.['content-type']||'')))throw new Error('来源不是 HTML/XHTML 页面');
    const title=plainText(result.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||new URL(result.url).hostname).slice(0,500);
    return { url:result.url,title,content:extractArticleText(result.text,title),metadata:extractPageMetadata(result.text),provider:'diting-native' };
  }
  const configured = new URL(service.base_url), base = configured.href.replace(/\/$/, '');
  const endpoint = /\/scrape$/.test(configured.pathname) ? base : /\/v[12]$/.test(configured.pathname) ? `${base}/scrape` : `${base}/v2/scrape`;
  const headers: Record<string,string> = { 'Content-Type': 'application/json' };
  if (config.hasSecret('service.firecrawl')) headers.Authorization = `Bearer ${config.secret('service.firecrawl')}`;
  const response = await fetcher(endpoint, { method: 'POST', headers,
    body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: 20000 }), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  if (!response.ok) throw new Error(`Firecrawl 请求失败（HTTP ${response.status}）`);
  const rawPayload=await response.text();if(Buffer.byteLength(rawPayload,'utf8')>4_000_000)throw new Error('Firecrawl响应超过4MB上限');let payload:Row;try{payload=JSON.parse(rawPayload) as Row;}catch{throw new Error('Firecrawl返回无效JSON');}const data = payload.data || payload;
  if (payload.success === false || typeof (data.markdown || data.content) !== 'string') throw new Error('Firecrawl 未返回可归档正文');
  const pageMetadata=extractPageMetadata(data.markdown||data.content);
  const textValue=(value:unknown)=>typeof value==='string'?value.trim().slice(0,300)||null:null;
  return { url: data.metadata?.sourceURL || data.metadata?.url || url, title: String(data.metadata?.title || new URL(url).hostname).slice(0, 500), content: plainText(data.markdown || data.content), metadata:{published_at:normalizePublishedAt(data.metadata?.publishedTime||data.metadata?.published_time)||pageMetadata.published_at,author:textValue(data.metadata?.author)||pageMetadata.author,publisher:textValue(data.metadata?.ogSiteName||data.metadata?.siteName)||pageMetadata.publisher,method:'firecrawl_page_metadata'}, provider: 'firecrawl' };
}
