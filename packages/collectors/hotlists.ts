/** Native TypeScript hotlist parsers. Endpoint/parser shapes are ported from the MIT-licensed NewsNow and DailyHotApi source projects (see THIRD_PARTY_NOTICES.md). */
import { Database, encode, hash, now, uid, type Row } from '../domain/db.js';
import { fetchText } from './network.js';
import { createHash } from 'node:crypto';
import { hotlistChannels } from './hotlist-catalog.js';
import {dailyHotExtendedSources} from './dailyhot-extended.js';

export type Item = { id: string; title: string; url: string | null; heat: number | null; heat_label: string | null; raw: Row };
type SourceKind = 'hotlist' | 'content_rank' | 'public_notice' | 'reference';
export interface Source { provider: 'newsnow' | 'dailyhot'; id: string; title: string; url: string; kind: SourceKind; metric: string; request?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }; parse(text: string): Item[]; }
const item = (id: unknown, title: unknown, url: unknown, heat: unknown, raw: Row): Item => ({ id: String(id), title: String(title || '').trim(), url: typeof url === 'string' && /^https?:\/\//.test(url) ? url : null,
  heat: typeof heat === 'number' && Number.isFinite(heat) && heat >= 0 ? heat : null, heat_label: heat === undefined || heat === null ? null : String(heat), raw });
type Fields = { title: string[]; id: string[]; url: string[]; metric: string[] };
const fields: Record<string, Fields> = {
  'zhihu-daily': { title: ['title'], id: ['id'], url: ['url'], metric: [] }, douyin: { title: ['word', 'sentence', 'title'], id: ['sentence_id', 'word'], url: ['url'], metric: ['hot_value', 'hotValue'] },
  'douban-movie': { title: ['title', 'name'], id: ['id', 'url'], url: ['url'], metric: [] }, 'douban-group': { title: ['title'], id: ['id', 'url'], url: ['url'], metric: ['replies', 'comment_count'] },
  tieba: { title: ['topic_name', 'title'], id: ['topic_id', 'topic_name'], url: ['topic_url', 'url'], metric: ['discuss_num'] }, sspai: { title: ['title'], id: ['id'], url: ['url'], metric: ['view_count', 'viewCount'] },
  ithome: { title: ['title', 'newsTitle'], id: ['id', 'newsid'], url: ['url', 'link'], metric: ['review-num'] }, 'ithome-xijiayi': { title: ['title'], id: ['id', 'url'], url: ['url', 'link'], metric: ['comment'] },
  jianshu: { title: ['title'], id: ['id', 'slug', 'url'], url: ['url', 'link'], metric: ['likes_count', 'views_count'] }, guokr: { title: ['title'], id: ['id'], url: ['url'], metric: ['likings_count'] },
  thepaper: { title: ['name', 'title'], id: ['contId', 'id'], url: ['url'], metric: ['praiseTimes'] }, toutiao: { title: ['Title', 'title'], id: ['ClusterIdStr', 'id'], url: ['url'], metric: ['HotValue'] },
  '36kr': { title: ['templateMaterial.widgetTitle', 'title'], id: ['itemId', 'id'], url: ['url'], metric: ['templateMaterial.statCollect'] }, '51cto': { title: ['title'], id: ['source_id', 'id'], url: ['url'], metric: [] },
  weread: { title: ['title', 'bookInfo.title'], id: ['bookId', 'book_id','bookInfo.bookId'], url: ['url'], metric: [] }, ngabbs: { title: ['subject'], id: ['tid'], url: ['tpcurl'], metric: ['replies'] },
  v2ex: { title: ['title'], id: ['id'], url: ['url'], metric: ['replies'] }, hellogithub: { title: ['title'], id: ['item_id'], url: ['url'], metric: ['star', 'stars'] },
  weatheralarm: { title: ['title'], id: ['alertid'], url: ['url'], metric: [] }, earthquake: { title: ['LOCATION_C', 'title'], id: ['NEW_DID'], url: ['url'], metric: ['M'] }, history: { title: ['title'], id: ['link', 'title'], url: ['link'], metric: [] },
  acfun: { title: ['contentTitle'], id: ['dougaId'], url: ['url'], metric: ['likeCount'] }, kuaishou: { title: ['name', 'title'], id: ['id'], url: ['url'], metric: ['hotValue'] },
};
const getPath = (row: Row, path: string): unknown => path.split('.').reduce((value: any, key) => value?.[key], row);
function metricNumber(value: unknown): number | null { if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value; if (typeof value !== 'string') return null; const text = value.trim().replaceAll(',', ''), match = text.match(/[\d.]+/); if (!match) return null; const base = Number(match[0]); if (!Number.isFinite(base)) return null; return base * (text.includes('亿') ? 1e8 : text.includes('万') ? 1e4 : 1); }
function findArrays(value: unknown, depth = 0): Row[][] {
  if (depth > 7 || !value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return [value.filter(v => !!v && typeof v === 'object') as Row[], ...value.slice(0, 8).flatMap(v => findArrays(v, depth + 1))];
  return Object.values(value).flatMap(v => findArrays(v, depth + 1));
}
function parseJson(text: string, id: string): Item[] {
  if (id === 'earthquake') { const rows=JSON.parse(text); if(!Array.isArray(rows))throw new Error('地震目录未返回事件列表');return (rows as Row[]).filter(row=>typeof row.id==='string'&&typeof row.location==='string'&&typeof row.magnitude==='number'&&Number.isFinite(row.magnitude)&&typeof row.time==='string'&&!Number.isNaN(Date.parse(row.time.replace(' ','T')+'+08:00'))).sort((a,b)=>String(b.time).localeCompare(String(a.time))).slice(0,50).map(row=>item(row.id,`${row.location}发生${row.magnitude}级地震`,'https://www.ceic.ac.cn/',null,row)); }
  if (id === 'history') { const data = JSON.parse(text) as Row, month = String(new Date().getMonth()+1).padStart(2,'0'), day = String(new Date().getDate()).padStart(2,'0'), events = data[month]?.[month+day]; if (!Array.isArray(events)) throw new Error('历史上的今天未返回本日事件'); return events.map((row: Row, i: number) => item(i, String(row.title||'').replace(/<[^>]*>/g,' ').trim(), row.link, null, row)); }
  const parsed = JSON.parse(text) as Row;
  // Keep source-specific field names; the fallback is only for common API shapes, not a fabricated heat score.
  const f = fields[id] || ({ title: ['title', 'name', 'word', 'subject'], id: ['id', 'url'], url: ['url', 'link'], metric: ['hotValue', 'hot_value', 'hotScore', 'heat'] } satisfies Fields);
  const rows = findArrays(parsed).filter(list => list.some(row => f.title.some(k => typeof getPath(row, k) === 'string'))).sort((a, b) => b.length - a.length)[0] || [];
  return rows.map((row, i) => {
    const title = f.title.map(k => getPath(row, k)).find(v => typeof v === 'string' && v.trim());
    const key = f.id.map(k => getPath(row, k)).find(v => v !== undefined && v !== null);
    const href = f.url.map(k => getPath(row, k)).find(v => typeof v === 'string' && v.length);
    const metric = f.metric.map(k => getPath(row, k)).find(v => v !== undefined && v !== null);
    const n = metricNumber(metric);
    const canonical:Record<string,string>=key===undefined||key===null?{}:{acfun:`https://www.acfun.cn/v/ac${key}`,'zhihu-daily':`https://daily.zhihu.com/story/${key}`,sspai:`https://sspai.com/post/${key}`,guokr:`https://www.guokr.com/article/${key}`,thepaper:`https://www.thepaper.cn/newsDetail_forward_${key}`,'36kr':`https://36kr.com/p/${key}`};
    return item(key ?? href ?? hash(String(title)), String(title || ''), typeof href === 'string' ? href : canonical[id]||null, typeof n === 'number' && Number.isFinite(n) ? n : null, { ...row, source_metric: metric ?? null });
  });
}
const strip = (s: string) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
function blocks(text: string, tag: string, klass: string): string[] {
  const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), result: string[] = []; let start: RegExpExecArray | null;
  while ((start = tokens.exec(text))) { if (start[0].startsWith('</') || !new RegExp(`class=["'][^"']*\\b${klass}\\b[^"']*["']`, 'i').test(start[0])) continue; let depth = 1, end = tokens.lastIndex, token: RegExpExecArray | null;
    while ((token = tokens.exec(text))) { if (token[0].startsWith('</')) depth--; else if (!/\/>$/.test(token[0])) depth++; if (depth === 0) { end = tokens.lastIndex; break; } }
    if (depth === 0) { result.push(text.slice(start.index, end)); tokens.lastIndex = end; }
  } return result;
}
function parseHtml(text: string, base: string, id: string): Item[] {
  if (id === 'kuaishou') {
    if (/^\s*\{/.test(text)) {
      try { const result = JSON.parse(text); if (result && typeof result === 'object' && 'result' in result) throw new Error(`快手未返回公开热榜（平台结果码 ${String(result.result).slice(0,20)}）`); }
      catch (error) { if (error instanceof Error && error.message.startsWith('快手未返回公开热榜')) throw error; }
    }
    const marker = 'window.__APOLLO_STATE__='; const start = text.indexOf(marker); if (start < 0) throw new Error('快手页面结构变化：未找到 APOLLO_STATE');
    const tail = text.slice(start + marker.length), end = tail.indexOf('</script>'), raw = (end < 0 ? tail : tail.slice(0, end)).split(';(function(')[0].trim().replace(/;$/, ''), last = raw.lastIndexOf('}');
    if (last < 0) throw new Error('快手 APOLLO_STATE 缺少 JSON 结束标记');
    const state = JSON.parse(raw.slice(0, last + 1)).defaultClient as Row, refs = state['$ROOT_QUERY.visionHotRank({"page":"home"})']?.items || state['$ROOT_QUERY.visionHotRank({"page":"home","platform":"web"})']?.items || [];
    return refs.flatMap((ref: Row) => { const row = state[ref.id] as Row | undefined; if (!row) return []; const videoId = row.photoIds?.json?.[0]; return [item(row.id, row.name, videoId ? `https://www.kuaishou.com/short-video/${videoId}` : null, metricNumber(row.hotValue), { ...row, source_metric: row.hotValue ?? null })]; });
  }
  const selectors: Record<string, { tag: string; cls: string }> = { 'douban-movie': { tag: 'tr', cls: 'item' }, 'douban-group': { tag: 'div', cls: 'channel-item' }, ithome: { tag: 'div', cls: 'placeholder' }, 'ithome-xijiayi': { tag: 'li', cls: 'newslist' }, jianshu: { tag: 'li', cls: 'note-list' } };
  if (selectors[id]) {
    const { tag, cls } = selectors[id];
    let selectedBlocks = blocks(text, tag, cls);
    if (id === 'ithome-xijiayi' || id === 'jianshu') { const klass = id === 'ithome-xijiayi' ? 'newslist' : 'note-list', containerTag = id === 'ithome-xijiayi' ? 'ol' : 'ul'; const container = blocks(text, containerTag, klass); selectedBlocks = container.flatMap(ul => [...ul.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)].map(m => m[0])); }
    return selectedBlocks.map((block, index) => {
      const anchor = block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i), href = anchor?.[1] ? new URL(anchor[1], base).href : null;
      const titleAttr = block.match(/<a\b[^>]*title=["']([^"']+)["']/i)?.[1];
      const titlePattern = id === 'ithome' ? /class=["'][^"']*plc-title[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i : id === 'ithome-xijiayi' ? /<h2\b[^>]*>([\s\S]*?)<\/h2>/i : id === 'douban-group' ? /<h3\b[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i : id === 'jianshu' ? /<a\b[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/a>/i : /<a\b[^>]*>([\s\S]*?)<\/a>/i;
      const title = strip((id === 'douban-movie' ? titleAttr : titlePattern.exec(block)?.[1]) || titleAttr || anchor?.[2] || ''); if (!title) return null;
      const metricText = id === 'ithome' ? block.match(/class=["'][^"']*review-num[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] : id === 'ithome-xijiayi' ? block.match(/class=["'][^"']*comment[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] : null;
      return item(href || `${id}-${index}`, title, href, metricNumber(metricText ? strip(metricText) : null), { href, title, source_metric: metricText ? strip(metricText) : null });
    }).filter((v): v is Item => !!v);
  }
  const rows: Item[] = []; const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { const title = strip(m[2]); if (title.length < 5 || title.length > 160 || /登录|注册|更多|首页|下载/.test(title)) continue; try { const href = new URL(m[1], base).href; rows.push(item(href, title, href, null, { href, title })); } catch { /* malformed href */ } }
  return rows;
}
const json = (id: string, title: string, url: string, provider: Source['provider'] = 'dailyhot', kind: SourceKind = 'hotlist', metric = '平台指标（原始口径）', request?: Source['request']): Source => ({ provider, id, title, url, kind, metric, request, parse: text => parseJson(text, id) });
const html = (id: string, title: string, url: string, metric = '未提供平台热度'): Source => ({ provider: 'dailyhot', id, title, url, kind: 'content_rank', metric, parse: text => parseHtml(text, url, id) });

export const sources: Source[] = [
  {provider:'dailyhot',id:'qq-news',title:'腾讯新闻热点榜',url:'https://r.inews.qq.com/gw/event/hot_ranking_list?page_size=50',kind:'hotlist',metric:'腾讯新闻热度',parse:text=>{const rows=JSON.parse(text).idlist?.[0]?.newslist;if(!Array.isArray(rows))throw new Error('腾讯新闻没有返回榜单');return rows.slice(1).filter(v=>v.id&&v.title).map(v=>item(v.id,v.title,`https://new.qq.com/rain/a/${v.id}`,v.hotEvent?.hotScore,v));}},
  {provider:'dailyhot',id:'netease-news',title:'网易新闻热点榜',url:'https://m.163.com/fe/api/hot/news/flow',kind:'hotlist',metric:'未提供平台热度',parse:text=>{const rows=JSON.parse(text).data?.list;if(!Array.isArray(rows))throw new Error('网易新闻没有返回列表');return rows.map(v=>item(v.docid,v.title,`https://www.163.com/dy/article/${v.docid}.html`,null,v));}},
  ...(['sina-news','sina-finance'] as const).map(id=>({provider:'dailyhot' as const,id,title:id==='sina-news'?'新浪新闻排行':'新浪财经排行',url:`https://top.${id==='sina-news'?'news':'finance'}.sina.com.cn/ws/GetTopDataList.php?top_type=day&top_cat=${id==='sina-news'?'www_www_all_suda_suda':'finance_0_suda'}&top_time=${new Date(Date.now()+8*3600000).toISOString().slice(0,10).replaceAll('-','')}&top_show_num=50`,kind:'hotlist' as const,metric:'新浪点击排行指标',parse:(text:string)=>{const parsed=JSON.parse(text.trim().replace(/^var\s+data\s*=\s*/,'').replace(/;\s*$/,''));if(!Array.isArray(parsed.data))throw new Error('新浪排行结构变化');return parsed.data.map((v:Row)=>item(v.id,v.title,v.url,metricNumber(v.top_num),v));}})),
  {provider:'newsnow',id:'github',title:'GitHub Trending',url:'https://github.com/trending?since=daily',kind:'content_rank',metric:'累计 Star（非舆情热度）',parse:text=>[...text.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].flatMap(m=>{const anchor=m[1].match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);if(!anchor)return [];const star=m[1].match(/href=["'][^"']*stargazers["'][^>]*>([\s\S]*?)<\/a>/i);return [item(anchor[1],strip(anchor[2]).replace(/\s*\/\s*/,' / '),new URL(anchor[1],'https://github.com').href,metricNumber(star?strip(star[1]):null),{html:m[1]})];})},
  ...([{id:'solidot',title:'Solidot',url:'https://www.solidot.org/index.rss'},{id:'producthunt',title:'ProductHunt',url:'https://www.producthunt.com/feed'}]).map(s=>({provider:'newsnow' as const,...s,kind:'content_rank' as const,metric:'未提供平台热度',parse:(text:string)=>{const entries=[...text.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)];return entries.flatMap((m,i)=>{const title=m[1].match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1],link=m[1].match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1]||m[1].match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1];return title&&link?[item(link||i,strip(title.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')),link.trim(),null,{xml:m[1]})]:[];});}})),
  {provider:'dailyhot',id:'hackernews',title:'Hacker News',url:'https://hacker-news.firebaseio.com/v0/topstories.json',kind:'content_rank',metric:'Hacker News 分数',parse:text=>{const rows=JSON.parse(text);if(!Array.isArray(rows))throw Error('Hacker News 官方 API 未返回热门列表');return rows.filter((v:Row)=>Number.isSafeInteger(v?.id)&&typeof v.title==='string'&&v.title.trim()&&!v.deleted&&!v.dead).map((v:Row)=>item(v.id,v.title,`https://news.ycombinator.com/item?id=${v.id}`,v.score,v));}},
  {provider:'dailyhot',id:'hupu',title:'虎扑步行街热帖',url:'https://m.hupu.com/api/v2/bbs/topicThreads?topicId=1&page=1',kind:'hotlist',metric:'回复数（平台指标）',parse:text=>{const rows=JSON.parse(text).data?.topicThreads;if(!Array.isArray(rows))throw new Error('虎扑没有返回热帖');return rows.map(v=>item(v.tid,v.title,`https://bbs.hupu.com/${v.tid}.html`,v.replies,v));}},
  {provider:'newsnow',id:'wallstreetcn',title:'华尔街见闻快讯',url:'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30',kind:'content_rank',metric:'未提供平台热度',parse:text=>{const rows=JSON.parse(text).data?.items;if(!Array.isArray(rows))throw new Error('华尔街见闻没有返回快讯');return rows.map(v=>item(v.id,v.title||v.content_text,v.uri,null,v));}},
  {provider:'newsnow',id:'cls',title:'财联社电报',url:'https://www.cls.cn/v1/roll/get_roll_list',kind:'content_rank',metric:'未提供平台热度',parse:text=>{const rows=JSON.parse(text).data?.roll_data;if(!Array.isArray(rows))throw new Error('财联社没有返回电报列表');return rows.filter(v=>!v.is_ad).map(v=>item(v.id,v.title||v.brief,`https://www.cls.cn/detail/${v.id}`,null,v));}},
  {provider:'newsnow',id:'jin10',title:'金十数据快讯',url:'https://www.jin10.com/flash_newest.js',kind:'content_rank',metric:'未提供平台热度',parse:text=>{const rows=JSON.parse(text.trim().replace(/^var\s+newest\s*=\s*/,'').replace(/;*\s*$/,''));if(!Array.isArray(rows))throw new Error('金十数据没有返回快讯');return rows.filter(v=>v.data?.title||v.data?.content).map(v=>item(v.id,strip(v.data.title||v.data.content),`https://flash.jin10.com/detail/${v.id}`,null,v));}},
  {provider:'newsnow',id:'xueqiu',title:'雪球热帖',url:'https://xueqiu.com/statuses/hot/listV2.json?since_id=-1&max_id=-1&size=30',kind:'hotlist',metric:'回复数（平台指标）',parse:text=>{if(/^\s*</.test(text))throw new Error('雪球返回验证页面，未取得公开热帖列表');const parsed=JSON.parse(text),rows=parsed.items||parsed.list;if(!Array.isArray(rows))throw new Error('雪球热帖未返回公开列表，可能需要登录');return rows.map(v=>{const r=v.original_status||v;return item(r.id,strip(r.title||r.description||r.text||''),r.target?new URL(r.target,'https://xueqiu.com').href:null,r.reply_count,r);});}},
  { provider: 'newsnow', id: 'zhihu', title: '知乎热榜', url: 'https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true', kind: 'hotlist', metric: '知乎热度（原始文本）', parse: text => { const data = JSON.parse(text).data; if (!Array.isArray(data)) throw new Error('知乎榜单结构变化'); return data.map(v => item(v.target?.link?.url, v.target?.title_area?.text, v.target?.link?.url, v.target?.metrics_area?.text, v)); } },
  { provider: 'newsnow', id: 'baidu', title: '百度实时热点', url: 'https://top.baidu.com/board?tab=realtime', kind: 'hotlist', metric: '百度热度指数', parse: text => { const match = text.match(/<!--s-data:([\s\S]*?)-->/); if (!match) throw new Error('百度页面没有榜单数据，可能被限流或页面结构变化'); const rows = JSON.parse(match[1]).data?.cards?.[0]?.content; if (!Array.isArray(rows)) throw new Error('百度榜单结构变化'); return rows.filter(v => !v.isTop).map(v => item(v.rawUrl || v.word, v.word, v.rawUrl, v.hotScore, v)); } },
  { provider: 'dailyhot', id: 'weibo', title: '微博热搜', url: 'https://weibo.com/ajax/side/hotSearch', kind: 'hotlist', metric: '微博热搜数值', parse: text => { const rows = JSON.parse(text).data?.realtime; if (!Array.isArray(rows)) throw new Error('微博未返回热搜列表；可能需登录或来源限流'); return rows.map(v => item(v.word || v.word_scheme, v.word || v.word_scheme, `https://s.weibo.com/weibo?q=${encodeURIComponent(v.word || v.word_scheme || '')}`, v.num, v)); } },
  { provider: 'dailyhot', id: 'bilibili', title: '哔哩哔哩全站榜', url: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', kind: 'content_rank', metric: '播放量（非舆情热度）', parse: text => { const data = JSON.parse(text); if (data.code !== 0 || !Array.isArray(data.data?.list)) throw new Error('哔哩哔哩榜单不可用或需风控验证'); return data.data.list.map((v: Row) => item(v.bvid, v.title, `https://www.bilibili.com/video/${v.bvid}`, v.stat?.view, v)); } },
  json('acfun', 'AcFun 排行榜', 'https://www.acfun.cn/rest/pc-direct/rank/channel?channelId=&rankLimit=30&rankPeriod=DAY'),
  json('zhihu-daily', '知乎日报推荐榜', 'https://daily.zhihu.com/api/4/news/latest', 'dailyhot', 'content_rank', '未提供平台热度'),
  json('douyin', '抖音热点榜', 'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1'),
  html('kuaishou', '快手热榜', 'https://www.kuaishou.com/?isHome=1', '平台热值（快手 hotValue）'), html('douban-movie', '豆瓣电影新片榜', 'https://movie.douban.com/chart/'), html('douban-group', '豆瓣小组讨论精选', 'https://www.douban.com/group/explore'),
  json('tieba', '百度贴吧热议榜', 'https://tieba.baidu.com/hottopic/browse/topicList'), json('sspai', '少数派热门文章', 'https://sspai.com/api/v1/article/tag/page/get?limit=40&tag=热门文章', 'dailyhot', 'content_rank', '文章浏览指标'),
  html('ithome', 'IT之家热榜', 'https://m.ithome.com/rankm/', '评论数（平台指标，非热度）'), html('ithome-xijiayi', 'IT之家喜加一', 'https://www.ithome.com/zt/xijiayi', '评论数（平台指标，非热度）'), html('jianshu', '简书热门推荐', 'https://www.jianshu.com/', '未提供平台热度'),
  json('guokr', '果壳热门文章', 'https://www.guokr.com/beta/proxy/science_api/articles?limit=30', 'dailyhot', 'content_rank', '未提供平台热度'), json('thepaper', '澎湃新闻热榜', 'https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar', 'dailyhot', 'hotlist', '点赞数（平台指标）'),
  json('toutiao', '今日头条热榜', 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc'), json('36kr', '36氪人气榜', 'https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot', 'dailyhot', 'hotlist', '收藏数（平台指标）', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ partner_id: 'wap', param: { siteId: 1, platformId: 2 }, timestamp: Date.now() }) }), json('51cto', '51CTO 推荐榜', 'https://api-media.51cto.com/index/index/recommend', 'dailyhot', 'content_rank', '未提供平台热度'),
  json('weread', '微信读书飙升榜', 'https://weread.qq.com/web/bookListInCategory/rising?rank=1', 'dailyhot', 'content_rank', '榜单排名（非舆情热度）'), json('ngabbs', 'NGA 论坛热帖', 'https://ngabbs.com/nuke.php?__lib=load_topic&__act=load_topic_reply_ladder2&opt=1&all=1', 'dailyhot', 'hotlist', '回复数（平台指标）', { method: 'POST', headers: { Accept: '*/*', Referer: 'https://ngabbs.com/', 'Content-Type': 'application/x-www-form-urlencoded', 'X-User-Agent': 'NGA_skull/7.3.1(iPhone13,2;iOS 17.2.1)' }, body: '__output=14' }), json('v2ex', 'V2EX 主题榜', 'https://www.v2ex.com/api/topics/hot.json', 'dailyhot', 'hotlist', '回复数（平台指标）'),
  json('hellogithub', 'HelloGitHub 热门仓库', 'https://abroad.hellogithub.com/v1/?sort_by=featured&tid=&page=1', 'dailyhot', 'content_rank', '收藏/排序指标（非舆情热度）'), json('weatheralarm', '中央气象台天气预警', 'http://www.nmc.cn/rest/findAlarm?pageNo=1&pageSize=20&signaltype=&signallevel=&province=', 'dailyhot', 'public_notice', '无热度指标'),
  json('earthquake', '中国地震台速报', 'https://www.ceic.ac.cn/data/data.json', 'dailyhot', 'public_notice', '震级（非热度）'), json('history', '历史上的今天', `https://baike.baidu.com/cms/home/eventsOnHistory/${String(new Date().getMonth()+1).padStart(2,'0')}.json`, 'dailyhot', 'reference', '无热度指标'),
  ...dailyHotExtendedSources(item),
];

// These endpoints currently return platform refusals or challenge pages from this host.
// Keep their parsers, status and archived failures available for an explicit retest.
// They are excluded only from an unqualified automatic/manual "collect all" run.
export const defaultPausedSources = new Map<string,string>([
  ['dailyhot:weibo','公开热搜接口 HTTP 403'],
  ['newsnow:xueqiu','公开热帖接口返回验证页'],
  ['dailyhot:douyin','平台风控拒绝访问（4031）'],
  ['dailyhot:kuaishou','平台未返回公开热榜（结果码 2）'],
  ['dailyhot:linuxdo','原站 RSS 返回 HTTP 403'],
  ['dailyhot:hostloc','原站 RSS 返回验证页'],
]);
export const defaultCollectionSources=sources.filter(s=>!defaultPausedSources.has(`${s.provider}:${s.id}`));

export async function fetchSourceText(source: Source, fetcher = fetchText): Promise<string> {
  let request = source.request,targetUrl=source.url;
  if(source.id==='hackernews'){
    const index=JSON.parse((await fetcher(targetUrl)).text);
    if(!Array.isArray(index)||!index.length)throw Error('Hacker News 官方 API 未返回热门编号');
    const ids=index.filter((id:unknown)=>Number.isSafeInteger(id)&&Number(id)>0).slice(0,20) as number[];
    if(!ids.length)throw Error('Hacker News 官方 API 热门编号无效');
    const stories:Row[]=[];let cursor=0;
    await Promise.all(Array.from({length:Math.min(5,ids.length)},async()=>{while(cursor<ids.length){const id=ids[cursor++];try{const response=await fetcher(`https://hacker-news.firebaseio.com/v0/item/${id}.json`,AbortSignal.timeout(10000));const story=JSON.parse(response.text) as Row;if(story?.id===id&&typeof story.title==='string')stories.push(story);}catch{/* Individual stories may disappear; retain other official results. */}}}));
    if(stories.length<Math.min(5,ids.length))throw Error('Hacker News 官方 API 热门条目获取不足');
    const byId=new Map(stories.map(story=>[story.id,story]));return JSON.stringify(ids.map(id=>byId.get(id)).filter(Boolean));
  }
  if(source.id==='cls'){const query=new URLSearchParams({appName:'CailianpressWeb',os:'web',sv:'7.7.5',last_time:String(Math.floor(Date.now()/1000)),refresh_type:'1',rn:'30'});query.sort();query.append('sign',createHash('md5').update(createHash('sha1').update(query.toString()).digest('hex')).digest('hex'));targetUrl+='?'+query.toString();request={headers:{Referer:'https://www.cls.cn/telegraph'}};}
  if(source.id.startsWith('sina-')){const target=new URL(targetUrl);target.searchParams.set('top_time',new Date(Date.now()+8*3600000).toISOString().slice(0,10).replaceAll('-',''));targetUrl=target.href;}
  if (source.id === 'douyin') {
    const cookieResponse = await fetcher('https://www.douyin.com/passport/general/login_guiding_strategy/?aid=6383');
    try { const body = JSON.parse(cookieResponse.text), code = body.error_code ?? body.data?.error_code; if (code) throw new Error(`抖音平台风控拒绝访问（${code}）：${body.data?.description || body.message || '未下发临时 Cookie'}`); } catch (error) { if (error instanceof Error && error.message.startsWith('抖音平台风控拒绝访问')) throw error; }
    const cookieHeaders = cookieResponse.headers?.['set-cookie'];
    const cookieText = Array.isArray(cookieHeaders) ? cookieHeaders.join(';') : String(cookieHeaders || '');
    const token = cookieText.match(/passport_csrf_token=([^;]+)/)?.[1];
    if (!token) throw new Error('抖音临时 CSRF Cookie 未返回，平台拒绝本次榜单请求');
    request = { headers: { ...(request?.headers || {}), Cookie: `passport_csrf_token=${token}`, Referer: 'https://www.douyin.com/' } };
  }
  if (source.id === '36kr') request = { ...request, body: JSON.stringify({ partner_id: 'wap', param: { siteId: 1, platformId: 2 }, timestamp: Date.now() }) };
  try{return (await fetcher(targetUrl, undefined, true, request)).text;}
  catch(error){
    // CSDN occasionally returns an origin-side 521, then succeeds immediately.
    // Retry that exact public endpoint once; platform denials remain failures.
    if(source.id==='csdn'&&error instanceof Error&&error.message==='来源 HTTP 521'){
      await new Promise(resolve=>setTimeout(resolve,400));
      return (await fetcher(targetUrl,undefined,true,request)).text;
    }
    const proxy=process.env.DITING_HOTLIST_PROXY_URL;
    const transient=error instanceof Error&&(error.name==='AbortError'||error.name==='TimeoutError'||/aborted|timed?\s*out|ETIMEDOUT|ENETUNREACH|ECONNRESET/i.test(error.message));
    // Only retry the fixed, public origins that have shown local connection
    // timeouts. Verification pages and platform refusals remain failures.
    if(!proxy||!transient||!['github','hostloc','linuxdo','nytimes','v2ex'].includes(source.id))throw error;
    return (await fetcher(targetUrl,undefined,true,{...request,proxyUrl:proxy,allowedOrigins:[new URL(source.url).origin]})).text;
  }
}

export class Hotlists {
  private pending = new Map<string, Promise<Row>>();
  private pendingSources = new Map<string, Promise<Row>>();
  constructor(readonly db: Database, readonly fetcher = fetchText) {}
  collect(provider = 'both', ids?: string[] | Record<string, string[]>) {
    if (!['both', 'newsnow', 'dailyhot'].includes(provider)) throw new Error('未知采集实现');
    const selected = (ids?sources:defaultCollectionSources).filter(s => (provider === 'both' || s.provider === provider) && (!ids || (Array.isArray(ids) ? ids : ids[s.provider] || []).includes(s.id)));
    if (!selected.length) throw new Error('所选来源尚未实现，不能声称已采集');
    const key = selected.map(s => `${s.provider}:${s.id}`).sort().join(','); if (this.pending.has(key)) return this.pending.get(key)!;
    const operation = (async()=>{const snapshots: Row[]=[];let cursor=0;await Promise.all(Array.from({length:Math.min(3,selected.length)},async()=>{while(cursor<selected.length){const source=selected[cursor++];snapshots.push(await this.collectOne(source));}}));return {snapshots,succeeded:snapshots.filter(s=>s.status==='succeeded').length,failed:snapshots.filter(s=>s.status==='failed').length};})().finally(() => { this.pending.delete(key); }); this.pending.set(key, operation); return operation;
  }
  collectOne(source: Source):Promise<Row> {
    const key=`${source.provider}:${source.id}`,existing=this.pendingSources.get(key);if(existing)return existing;
    const pending=this.collectSource(source).finally(()=>this.pendingSources.delete(key));this.pendingSources.set(key,pending);return pending;
  }
  private async collectSource(source: Source) {
    const id = uid('hot'), stamp = now(); let entries: Item[] = [], error: string | null = null, raw = '';
    try { raw = await fetchSourceText(source, this.fetcher); const seen = new Set<string>(); entries = source.parse(raw).filter(v => { if (!v.title || seen.has(v.id)) return false; seen.add(v.id); return true; }).slice(0, 200); if (!entries.length) throw new Error('来源返回空榜单，不保存为空成功'); }
    catch (e) { error = e instanceof Error ? (e.name==='AbortError'||e.name==='TimeoutError'||e.message==='The operation was aborted'?'来源连接或响应超时（20秒）':e.message).slice(0, 300) : '来源失败'; }
    const status = error ? 'failed' : 'succeeded';
    this.db.transaction(() => { this.db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)', id, source.provider, source.id, status, error ? 0 : entries.length, error, stamp, stamp); this.db.run('INSERT INTO hotlist_responses VALUES(?,?,?)', id, encode({ response: raw }), source.url); if (!error) for (const [rank, v] of entries.entries()) this.db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)', uid('hotitem'), id, hash(v.id), v.title, v.url, rank + 1, v.heat, v.heat_label, encode(v.raw), hash(encode(v))); this.db.run('INSERT INTO acquisitions VALUES(?,NULL,?,?,?,?,?)', uid('acq'), `${source.provider}:${source.id}`, 'native_snapshot', status, error || `直接采集原始平台并保存 ${entries.length} 条；指标口径不代表全网声量`, stamp); });
    return { id, provider: source.provider, source_id: source.id, status, item_count: error ? 0 : entries.length, error, observed_at: stamp };
  }
  latest(limit = 100): Row[] { return this.db.rows(`SELECT s.* FROM hotlist_snapshots s WHERE s.id=(SELECT n.id FROM hotlist_snapshots n WHERE n.provider=s.provider AND n.source_id=s.source_id ORDER BY created_at DESC,rowid DESC LIMIT 1) ORDER BY created_at DESC`).map(s => { const previous = this.db.rows(`SELECT item_key,rank FROM hotlist_items WHERE snapshot_id=(SELECT id FROM hotlist_snapshots WHERE provider=? AND source_id=? AND status='succeeded' AND id<>? ORDER BY created_at DESC,rowid DESC LIMIT 1)`, s.provider, s.source_id, s.id); return { ...s, items: this.db.rows('SELECT * FROM hotlist_items WHERE snapshot_id=? ORDER BY rank LIMIT ?', s.id, Math.min(Math.max(limit, 1), 500)).map(v => ({ ...v, raw: JSON.parse(v.raw_json), rank_change: previous.find(p => p.item_key === v.item_key) ? previous.find(p => p.item_key === v.item_key)!.rank - v.rank : null })) }; }); }
  status() {
    const snapshots=this.latest(200),latest=snapshots.map(({items,...s})=>s);
    const configured=sources.map(s=>{const last=snapshots.find(v=>v.provider===s.provider&&v.source_id===s.id),metricCount=last?.items?.filter((v:Row)=>typeof v.heat_value==='number'||(typeof v.heat_label==='string'&&v.heat_label.length>0)).length??null,pausedReason=defaultPausedSources.get(`${s.provider}:${s.id}`);return {provider:s.provider,source_id:s.id,title:s.title,origin:new URL(s.url).origin,kind:s.kind,metric:s.metric,metric_count:metricCount,integration:'typescript_native_parser',scope:hotlistChannels.some(c=>c.source_id===s.id)?'v5_core':'extended',default_enabled:!pausedReason,default_pause_reason:pausedReason||null,health:last?.status??'not_tested',latest_at:last?.created_at??null,item_count:last?.item_count??null,last_error:last?.error??null};});
    return {mode:'typescript_native_parsers',configured,channels:hotlistChannels.map(c=>({...configured.find(s=>s.source_id===c.source_id),...c})),latest};
  }
}
