import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSourceText, sources } from '../packages/collectors/hotlists.js';
import type { fetchText } from '../packages/collectors/network.js';
import { hotlistChannels } from '../packages/collectors/hotlist-catalog.js';

const source = (id: string) => { const value = sources.find(row => row.id === id); assert.ok(value, `source ${id}`); return value; };
test('native directory keeps original channels plus distinct extended endpoints and declares each indicator scope', () => {
  assert.equal(sources.length, 52);
  assert.equal(new Set(sources.map(s => `${s.provider}:${s.id}`)).size, 52);
  assert.equal(hotlistChannels.length,27);
  assert.equal(new Set(hotlistChannels.map(c=>c.source_id)).size,25);
  assert.ok(hotlistChannels.every(channel=>sources.some(s=>s.id===channel.source_id)), 'every original v5 channel maps to an implemented collector');
  assert.ok(sources.every(s => s.url.startsWith('http') && s.parse instanceof Function && s.metric.length > 0));
  assert.equal(source('bilibili').metric, '播放量（非舆情热度）');
  assert.equal(source('earthquake').kind, 'public_notice');
  assert.equal(source('history').kind, 'reference');
});
test('ported original news and finance parsers preserve IDs, links and missing heat',()=>{
 const netease=source('netease-news').parse('{"data":{"list":[{"docid":"TEST1","title":"明确的网易解析测试"}]}}');
 assert.equal(netease[0].url,'https://www.163.com/dy/article/TEST1.html');assert.equal(netease[0].heat,null);
 const cls=source('cls').parse('{"data":{"roll_data":[{"id":12,"title":"测试电报","is_ad":0},{"id":13,"title":"测试广告","is_ad":1}]}}');
 assert.equal(cls.length,1);assert.equal(cls[0].url,'https://www.cls.cn/detail/12');assert.equal(cls[0].heat,null);
 const rss=source('producthunt').parse('<feed><entry><title>明确的产品测试</title><link rel="alternate" href="https://example.com/product"/></entry></feed>');
 assert.equal(rss[0].url,'https://example.com/product');assert.equal(rss[0].heat_label,null);
});
test('ported parsers retain platform metrics and do not synthesize heat values', () => {
  const acfun = source('acfun').parse(JSON.stringify({ rankList: [{ dougaId: 'ac1', contentTitle: 'AcFun fixture title', likeCount: 17 }] }));
  assert.equal(acfun[0].title, 'AcFun fixture title'); assert.equal(acfun[0].heat, 17);
  const guokrFixture = source('guokr').parse(JSON.stringify({ data: [{ id: 2, title: 'Guokr fixture article' }] }));
  assert.equal(guokrFixture[0].title, 'Guokr fixture article'); assert.equal(guokrFixture[0].heat, null);
  const earthquake = source('earthquake').parse('const newdata = [{"NEW_DID":"e1","LOCATION_C":"测试地点","M":"3.2"}];');
  assert.equal(earthquake[0].title, '测试地点发生3.2级地震'); assert.equal(earthquake[0].heat, null);
  const day = String(new Date().getDate()).padStart(2, '0'), month = String(new Date().getMonth()+1).padStart(2, '0');
  const history = source('history').parse(JSON.stringify({ [month]: { [month+day]: [{ title: '历史事件 fixture', link: 'https://example.org/event' }] } }));
  assert.equal(history[0].url, 'https://example.org/event'); assert.equal(history[0].heat, null);
  const apollo = JSON.stringify({ defaultClient: { '$ROOT_QUERY.visionHotRank({"page":"home"})': { items: [{ id: 'Photo:1' }] }, 'Photo:1': { id: '1', name: 'KS fixture', hotValue: '1.2万', photoIds: { json: ['clip1'] } } } });
  const kuaishou = source('kuaishou').parse(`<script>window.__APOLLO_STATE__=${apollo};</script>`);
  assert.equal(kuaishou[0].heat, 12000); assert.ok(kuaishou[0].url?.endsWith('/clip1'));
  assert.throws(()=>source('kuaishou').parse('{"result":2,"error_msg":null}'),/平台结果码 2/);
  const movie = source('douban-movie').parse(`<table><tr class="item"><td><a href="https://movie.douban.com/subject/123/" title="Movie fixture">Movie</a></td></tr></table>`);
  assert.equal(movie[0].title, 'Movie fixture');
  const article = source('jianshu').parse(`<ul class="note-list"><li><a class="title" href="/p/abc">Jianshu fixture</a></li></ul>`);
  assert.equal(article.length, 1); assert.equal(article[0].heat, null);
});
test('ported extension parsers preserve exact metric types, null heat and RSS source provenance',()=>{
  assert.equal(source('juejin').parse(JSON.stringify({data:[{content:{content_id:'one',title:'技术文章'},content_counter:{hot_rank:12}}]}))[0].heat,null);
  assert.equal(source('ifanr').parse(JSON.stringify({objects:[{id:'one',post_title:'科技快讯',post_id:'123',like_count:0,comment_count:8}]}))[0].heat,0);
  assert.equal(source('smzdm').parse(JSON.stringify({data:[{article_id:'one',title:'消费文章',collection_count:'42',jump_link:'https://post.smzdm.com/p/one'}]}))[0].heat,42);
  const feed=source('linuxdo').parse('<rss><channel><item><title><![CDATA[技术与 AI]]></title><link>https://linux.do/t/123</link><guid>123</guid><pubDate>Mon, 19 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>');assert.equal(feed[0].title,'技术与 AI');assert.equal(feed[0].heat,null);assert.equal(feed[0].raw.published_at,'Mon, 19 Oct 2026 08:00:00 GMT');assert.throws(()=>source('csdn').parse('{}'),/预期列表/);assert.throws(()=>source('linuxdo').parse('<html>challenge</html>'),/未返回 RSS/);
});

test('Douyin uses its short-lived CSRF cookie preflight before requesting the list endpoint', async () => {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fake = (async (url: string, _signal?: AbortSignal, _publicOnly?: boolean, init?: unknown) => { calls.push({ url, init }); return calls.length === 1 ? { text: '', url, headers: { 'set-cookie': ['passport_csrf_token=fixture-token; Path=/'] } } : { text: '{"ok":true}', url, headers: {} }; }) as typeof fetchText;
  assert.equal(await fetchSourceText(source('douyin'), fake), '{"ok":true}');
  assert.equal(calls.length, 2); assert.ok(calls[0].url.includes('/passport/general/login_guiding_strategy/'));
  assert.ok(JSON.stringify(calls[1].init).includes('fixture-token'));
});

test('Hacker News collects ranked stories from its official API without the blocked HTML page', async () => {
  const calls:string[]=[];
  const fake=(async (url:string)=>{calls.push(url);if(url.endsWith('/topstories.json'))return{text:'[31,32,33]',url};const id=Number(url.match(/\/(\d+)\.json$/)?.[1]);return{text:JSON.stringify({id,title:`Story ${id}`,score:id,deleted:false}),url};}) as typeof fetchText;
  const raw=await fetchSourceText(source('hackernews'),fake),items=source('hackernews').parse(raw);
  assert.equal(items.length,3);
  assert.deepEqual(items.map(row=>row.id),['31','32','33']);
  assert.equal(items[0].heat,31);
  assert.equal(items[0].url,'https://news.ycombinator.com/item?id=31');
  assert.ok(calls.every(url=>url.startsWith('https://hacker-news.firebaseio.com/v0/')));
});
