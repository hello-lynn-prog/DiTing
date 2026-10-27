import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Database,uid,encode,type Row} from '../packages/domain/db.js';import {ROOT} from '../apps/server/settings.js';import {DailyDigest,dailyDigestHtml,extractArticleText,extractFirecrawlExcerpt,rankTopicPages} from '../packages/domain/daily-digest.js';import {Configuration} from '../packages/domain/configuration.js';
test('an archived card with a cross-topic source is withdrawn without changing the stored draft',()=>{
 const url='https://news.example.org/2026-10-27/uk',excerpt='外交部发言人郭嘉昆表示，对英国边境执法人员长时间扣留中国公民提出严正交涉，将维护中国公民权益。';
 const digest={date:'2026-10-27',title:'错误的姆巴佩分析',coverage:{succeeded:1,failed:0,sources:1,observations:1,topics:1},candidate_themes:[{id:'mbappe',title:'外交部回应姆巴佩发表不当言论',members:[],sources:['board'],source_count:1,best_rank:1}],sections:[{title:'今日总览',themes:[]},{title:'重点事件',items:[{id:'mbappe',title:'外交部回应姆巴佩发表不当言论',sources:['board'],source_count:1,best_rank:1}]},{title:'编辑总结',text:''}],source_pages:[{topic_id:'mbappe',url,excerpt,status:'insufficient_body',fetched_at:'2026-10-27T19:00:00+08:00'}],narrative_status:'model',narrative:{headline:'错误的姆巴佩分析',lead:'英国边境执法与姆巴佩事件同构。',overview:['英国边境执法与姆巴佩事件同构。'],events:[{topic_id:'mbappe',anchor_grade:'A',source_url:url,headline:'跨主题错绑',fact_summary:'错误事实',conclusion:'错误结论'}],trends:[],watch:[],editor_summary:['错误总结']}};
 const html=dailyDigestHtml(digest);assert.match(html,/来源正文与选题不匹配/);assert.doesNotMatch(html,/英国边境执法与姆巴佩事件同构|跨主题错绑|错误结论/);
 assert.equal(digest.narrative.events[0].headline,'跨主题错绑');
});
test('daily event cites the directly relevant story before an omnibus brief',()=>{
 const topic={title:'中兴通讯三季度净利同比增长'};
 const pages=[
  {url:'https://example.org/roundup',excerpt:'SpaceX 发射安排。DeepSeek 模型动态。多家公司发布三季度业绩，中兴通讯也出现在快讯列表。'},
  {url:'https://example.org/zte',excerpt:'中兴通讯三季度净利同比增长。中兴通讯披露三季度财务数据，并说明主要业务的收入情况。'}
 ];
 assert.equal(rankTopicPages(topic,pages)[0].url,'https://example.org/zte');
});
test('same-day preview reuses an article archived after the frozen hotlist snapshot',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-frozen-cache-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
 try{
  const excerpt=Array.from({length:35},(_,i)=>`中兴通讯公布第三季度业绩，第${i+1}项财务说明涉及营业收入、净利润和业务进展。`).join('');
  const page={topic_id:'theme-zte',url:'https://news.example.org/2026/10/26/zte',final_url:'https://news.example.org/2026/10/26/zte',excerpt,content_hash:'archived-hash',fetched_at:'2026-10-26T19:00:00+08:00',published_at:'2026-10-26T17:00:00+08:00',status:'fetched',method:'native_article_paragraphs'};
  db.run('INSERT INTO daily_digests(id,report_date,title,data_json,created_at) VALUES(?,?,?,?,?)',uid('digest'),'2026-10-26','prior',encode({source_pages:[page]}),'2026-10-26T19:01:00+08:00');
  const service=new DailyDigest(db,()=>new Date('2026-10-26T19:30:00+08:00'),undefined,fetch,async()=>{throw new Error('already archived; must not refetch');});
  const result=await(service as any).sourcePages('2026-10-26',[{id:'theme-zte',title:'中兴通讯公布第三季度业绩',source_urls:[page.url]}],{through:new Date('2026-10-26T18:45:00+08:00')});
  assert.equal(result[0].reused,true);assert.equal(result[0].topic_id,'theme-zte');assert.equal(result[0].url,page.url);
 }finally{db.close();}
});
test('Firecrawl news-flash excerpt excludes recommendation chrome before material scoring',()=>{
 const short='财联社10月22日电，针对设备适配问题，相关平台表示将尽快推出更新。';
 const raw=`# 快讯 ${short} 财联社声明：文章内容仅供参考，不构成投资建议。 1289436 阅读 热门解锁 ${'其它文章推荐与广告。'.repeat(120)}`;
 const clean=extractFirecrawlExcerpt(raw);assert.match(clean,/尽快推出更新/);assert.doesNotMatch(clean,/其它文章推荐|1289436|热门解锁/);assert.ok(clean.length<800);
 const long=`# 事件报道 ${'主管部门说明具体措施、时间安排和后续执行步骤。'.repeat(50)} 责任编辑：编辑 ${'推荐新闻。'.repeat(100)}`;
 const article=extractFirecrawlExcerpt(long);assert.ok(article.length>=800);assert.doesNotMatch(article,/推荐新闻/);
 const finance='开盘行情提示 打开APP 北京副市长接受调查。正文说明纪律审查与调查机关。 【新浪财经·社区调查活动】'+('读者推荐与评论。'.repeat(200));
 assert.ok(extractFirecrawlExcerpt(finance).length<800);
 const economic='首页 公司 金融 正文 手机软件适配调查。'+('测评记录了常见应用的具体适配表现和客服回应。'.repeat(55))+'返回21经济网首页 分享到：'+('导航链接。'.repeat(100));
 assert.ok(extractFirecrawlExcerpt(economic).length>=800);assert.doesNotMatch(extractFirecrawlExcerpt(economic),/导航链接/);
});
test('article extraction keeps story paragraphs and rejects verification interstitials',()=>{
 const html='<nav>新浪首页 新闻 体育 财经 娱乐 登录 注册</nav><article><h1>菲律宾对仁爱礁船只运送物资</h1><p>中国海警局新闻发言人表示，10月21日，经中方允许，菲律宾对仁爱礁船只运送生活物资，中国海警对菲船只询问确认并全程监管。</p><p>中国海警表示将持续依法开展维权执法活动。</p><aside>相关新闻 阅读排行榜 评论排行榜</aside></article><footer>新浪公司 版权所有</footer>';
 const text=extractArticleText(html);assert.match(text,/中国海警局新闻发言人表示/);assert.doesNotMatch(text,/新浪首页|阅读排行榜|版权所有/);
 assert.throws(()=>extractArticleText('<main><p>火山引擎正在进行安全检测，为保障您的访问安全，系统正在检测当前网络环境，请耐心等待。</p></main>'),/安全检测或验证页/);
});
test('article extraction rejects navigation shells and text unrelated to the selected topic',()=>{
 const shell='<div class="top-nav"><p>AI产业新闻中心今日热点论坛服务指南和客户端下载入口。</p></div><article><p>影视明星活动安排与观众互动时间信息说明。</p></article><footer><p>联系我们版权声明。</p></footer>';
 assert.throws(()=>extractArticleText(shell,'菲律宾仁爱礁补给'),/标题关键词不匹配|页面壳|正文段落/);
 const relevant=`<html><body><nav><p>${'仁爱礁新闻链接导航和热门推荐。'.repeat(30)}</p></nav><main><article><h1>仁爱礁补给监管</h1><p>${'中国海警局通报菲律宾对仁爱礁船只运送生活物资，海警询问确认并实施全程监管。'.repeat(25)}</p></article></main></body></html>`;
 const text=extractArticleText(relevant,'菲律宾仁爱礁补给');assert.ok(text.length>=800);assert.doesNotMatch(text,/热门推荐|导航/);
});
test('similar cross-board headline variants merge into one topic without hiding platform titles',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-merge-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
 try{for(const [source,title,rank] of [['kuaishou','纪念长征胜利90周年大会在京举行',1],['baidu','纪念长征胜利90周年大会隆重举行',2],['weibo','国家公园申请条件变化',3]] as const){const snap=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snap,'dailyhot',source,'succeeded',1,null,'2026-10-20T10:00:00+08:00','2026-10-20T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snap,title,title,'https://example.org/'+source,rank,10,'10',encode({}),title+source);}const digest=new DailyDigest(db).generate('2026-10-20'),events=digest.sections[1].items;assert.ok(events);assert.equal(events.length,2);const anniversary=events.find((e:Row)=>e.title.includes('长征'));assert.ok(anniversary);assert.equal(anniversary.source_count,2);assert.deepEqual(anniversary.title_variants,['纪念长征胜利90周年大会在京举行','纪念长征胜利90周年大会隆重举行']);assert.equal(anniversary.best_rank,1);assert.equal(anniversary.source_urls.length,2);}finally{db.close();}
});
test('daily material collection tries a second original article before paid title search while reserving later events',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-alternative-')),db=new Database(join(dir,'state.sqlite3'),ROOT),requested:string[]=[];
 try{
  const topic='监管部门公布风险处置方案',brief='监管部门公布风险处置方案，并说明后续办理安排。'.repeat(5),long='监管部门公布风险处置方案，解释执行步骤、适用对象及后续办理安排。'.repeat(45);
  const fetchPage=(async(url:string)=>{requested.push(url);return{url,text:`<article><p>${url.endsWith('/1')?brief:long}</p></article>`,headers:{'content-type':'text/html; charset=utf-8'}};}) as any;
  const digest=new DailyDigest(db,()=>new Date('2026-10-22T12:00:00+08:00'),undefined,fetch,fetchPage);
  const pages=await(digest as any).sourcePages('2026-10-22',[{id:'topic-one',title:topic,source_urls:['https://news.example.org/article/1','https://news.example.org/article/2']}]);
  assert.equal(pages[0].status,'fetched');assert.equal(pages[0].method,'native_alternative_source');assert.ok(pages[0].excerpt.length>=800);assert.deepEqual(requested,['https://news.example.org/article/1','https://news.example.org/article/2']);assert.equal(db.rows("SELECT id FROM acquisitions WHERE operation='source_search'").length,0);
 }finally{db.close();}
});

test('a cached article dated a year earlier cannot be rebound to a current hotlist event',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-stale-')),db=new Database(join(dir,'state.sqlite3'),ROOT),requested:string[]=[];
 try{
  const topic='西藏巴青7.0级地震启动应急响应',current='https://news.example.org/2026/10/23/current',old='https://news.example.org/2025/01/07/old';
  const prior={date:'2026-10-23',source_pages:[{topic_id:'topic-current',url:old,final_url:old,excerpt:'西藏定日县6.8级地震作出重要指示。'.repeat(40),status:'fetched',fetched_at:'2026-10-23T10:00:00+08:00',method:'title_search_then_native_article'},{topic_id:'topic-current',url:current,final_url:current,published_at:'2025-01-07T09:00:00+08:00',excerpt:'西藏定日县6.8级地震旧事件。'.repeat(40),status:'fetched',fetched_at:'2026-10-23T10:00:00+08:00',method:'native_article_paragraphs'}]};
  db.run('INSERT INTO daily_digests(id,report_date,title,data_json,created_at) VALUES(?,?,?,?,?)',uid('digest'),'2026-10-23','prior preview',encode(prior),'2026-10-23T10:00:00+08:00');
  const fetchPage=(async(url:string)=>{requested.push(url);return{url,text:`<article><p>${'西藏巴青7.0级地震启动应急响应，工作组赶赴现场核实灾情。'.repeat(50)}</p></article>`,headers:{'content-type':'text/html; charset=utf-8'}};}) as any;
  const service=new DailyDigest(db,()=>new Date('2026-10-23T12:00:00+08:00'),undefined,fetch,fetchPage);
  const pages=await(service as any).sourcePages('2026-10-23',[{id:'topic-current',title:topic,source_urls:[current]}]);
  assert.equal(pages[0].status,'fetched');assert.equal(pages[0].url,current);assert.deepEqual(requested,[current]);assert.doesNotMatch(pages[0].excerpt,/定日县/);
 }finally{db.close();}
});

test('a stored preview with an old bound article is flagged and its model prose is withheld on export',()=>{
 const title='西藏巴青7.0级地震启动应急响应',old='https://news.example.org/2025/01/07/old';
 const topic={id:'topic-current',title,source_count:2,best_rank:2,trend:'今日新见',sources:['dailyhot:a','dailyhot:b'],url:old};
 const digest={date:'2026-10-23',title:'错误生成的判断式主标题',coverage:{succeeded:2,failed:0,sources:2,observations:10,topics:1},sections:[{title:'今日总览',themes:[]},{title:'重点事件',items:[topic]},{title:'趋势观察',items:[]},{title:'值得继续关注',items:[]},{title:'编辑总结',text:''}],source_pages:[{topic_id:'topic-current',url:old,final_url:old,excerpt:'西藏定日县6.8级地震旧事件。'.repeat(20),status:'insufficient_body',fetched_at:'2026-10-23T10:00:00+08:00'}],narrative_status:'model',narrative:{headline:'错误生成的判断式主标题',lead:'旧稿被误写为今日事件。',overview:['旧稿被误写为今日事件。'],events:[{topic_id:'topic-current',headline:'错误事件卡',fact_summary:'旧稿被误写为今日事件。',why_hot:'',impact_path:'',conclusion:''}],trends:[],watch:[],editor_summary:['旧稿被误写为今日事件。']}};
 const html=dailyDigestHtml(digest);assert.match(html,/来源页日期超出日报窗口/);assert.match(html,/模型叙事已从阅读页撤下/);assert.doesNotMatch(html,/旧稿被误写为今日事件|错误事件卡/);assert.match(html,/西藏巴青7.0级地震启动应急响应/);
});
test('a short factual source outside the report date window also withholds old prose',()=>{
 const date='2026-10-23',old='https://news.example.org/2025/01/07/old';
 const digest={date,title:'旧来源生成标题',coverage:{succeeded:1,failed:0,sources:1,observations:1,topics:1},sections:[{title:'重点事件',items:[{id:'a',title:'地震部门通报应急安排',source_count:1,best_rank:1,sources:['dailyhot:test'],url:old}]}],source_pages:[{url:old,final_url:old,excerpt:'地震部门通报应急安排，说明现场核查与信息发布计划。工作人员表示后续会根据核查结果公开更新。',status:'insufficient_body',fetched_at:`${date}T10:00:00+08:00`}],narrative:{headline:'旧来源生成标题',lead:'错绑来源',overview:['错绑来源'],events:[],trends:[],watch:[],editor_summary:['错绑来源']}};
 const html=dailyDigestHtml(digest);assert.match(html,/来源页日期超出日报窗口/);assert.doesNotMatch(html,/错绑来源/);
});

test('a source linked today but declaring an old publication date cannot supply current-day facts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-old-metadata-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
 try{
  const url='https://news.example.org/article/undated';
  const fetchPage=(async()=>({url,text:`<meta property="article:published_time" content="2025-01-07T09:00:00+08:00"><article><p>${'西藏定日县6.8级地震旧报道，介绍当年的应急处置。'.repeat(50)}</p></article>`,headers:{'content-type':'text/html; charset=utf-8'}})) as any;
  const service=new DailyDigest(db,()=>new Date('2026-10-23T12:00:00+08:00'),undefined,fetch,fetchPage);
  const pages=await(service as any).sourcePages('2026-10-23',[{id:'topic-new',title:'西藏定日县地震最新情况',url,source_urls:[url]}]);
  assert.notEqual(pages[0].status,'fetched');assert.match(pages[0].reason,/原文日期/);assert.equal(db.rows("SELECT id FROM acquisitions WHERE source='daily-digest:2026-10-23' AND operation='page_fetch'").length,1);
 }finally{db.close();}
});

test('a search landing URL uses the remaining page slot for a dated article found by title search',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-search-first-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir),requested:string[]=[];
 try{
  for(let i=0;i<9;i++)db.run('INSERT INTO acquisitions VALUES(?,?,?,?,?,?,?)',uid('acq'),null,'daily-digest:2026-10-23','page_fetch','failed',`prior ${i}`,'2026-10-23T09:00:00+08:00');
  config.set('service.bocha',{enabled:true,base_url:'https://bocha.example/v1/web-search'});config.putSecret('service.bocha','bocha-test-secret');
  const articleUrl='https://news.example.org/2026/10/23/frost';
  const searchFetcher=(async()=>new Response(JSON.stringify({code:200,data:{webPages:{value:[{title:'今天霜降气温变化',url:articleUrl,summary:'公开报道'}]}}}),{status:200,headers:{'content-type':'application/json'}})) as typeof fetch;
  const pageFetcher=(async(url:string)=>{requested.push(url);return{url,text:`<article><p>${'今天霜降气温变化，气象部门说明冷空气移动与当地观测情况。'.repeat(50)}</p></article>`,headers:{'content-type':'text/html; charset=utf-8'}};}) as any;
  const service=new DailyDigest(db,()=>new Date('2026-10-23T12:00:00+08:00'),config,searchFetcher,pageFetcher);
  const pages=await(service as any).sourcePages('2026-10-23',[{id:'topic-frost',title:'今天霜降气温变化',source_urls:['https://www.baidu.com/s?wd=frost']}]);
  assert.equal(pages[0].status,'fetched');assert.equal(pages[0].url,articleUrl);assert.deepEqual(requested,[articleUrl]);
  assert.equal(db.rows("SELECT id FROM acquisitions WHERE source='daily-digest:2026-10-23' AND operation='page_fetch'").length,10);
  assert.equal(db.rows("SELECT id FROM acquisitions WHERE source='daily-digest:2026-10-23' AND operation='source_search'").length,1);
 }finally{db.close();}
});

test('a same-day diary preview freezes and displays its latest archived snapshot time',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-partial-')),db=new Database(join(dir,'state.sqlite3'),ROOT),date='2026-10-26';
 try{
  const observed='2026-10-26T09:15:00+08:00',snapshot=uid('snap');
  db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot','baidu','succeeded',1,null,observed,observed);
  db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,'topic','某公司公布产品安排','https://example.org/news',1,null,null,encode({}),'partial-day-topic');
  const digest=new DailyDigest(db,()=>new Date('2026-10-26T11:00:00+08:00')).generate(date,{notify:false});
  assert.equal(digest.through,observed);
  assert.match(dailyDigestHtml({...digest,preview:true}),/截至 09:15[^<]*未覆盖未采集时段/);
 }finally{db.close();}
});

test('daily title-search fallback fetches a public article and binds the material to its event',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-search-fallback-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir);
 try{
  const snapshot=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot','kuaishou','succeeded',1,null,'2026-10-22T10:00:00+08:00','2026-10-22T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,'监管部门公布风险处置方案','监管部门公布风险处置方案','https://news.kuaishou.com/video/123',1,10,'10',encode({}),'regulatory-kuaishou');const second=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',second,'dailyhot','baidu','succeeded',1,null,'2026-10-22T10:00:00+08:00','2026-10-22T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),second,'监管部门公布风险处置方案','监管部门公布风险处置方案','https://news.example.org/article/direct',2,10,'10',encode({}),'regulatory-baidu');
  config.saveRoute({id:'keyword',provider:'test',base_url:'https://model.example/v1',model:'flash-test',enabled:true,protocol:'openai-completions',api_key:'test-secret',max_tokens:4096,rates:{input:0.8,cache:0.23,output:2.8}});
  config.set('service.bocha',{enabled:true,base_url:'https://bocha.example/v1/web-search'});config.putSecret('service.bocha','bocha-test-secret');
  config.set('service.firecrawl',{enabled:true,base_url:'http://127.0.0.1:3002'}); // An old service setting must not make normal daily collection depend on it.
  const article='监管部门公布风险处置方案，明确后续安排并回应公众关切。该报道梳理了相关措施的背景、执行环节与适用范围，也介绍了不同参与方的公开表态。'.repeat(20);
  const fetcher=(async(url:any,init:any)=>{
   if(String(url).includes('bocha.example'))return new Response(JSON.stringify({code:200,data:{webPages:{value:[{title:'明星演唱会现场引发热议',url:'https://news.example.org/irrelevant',summary:'不相关结果'},{title:'监管部门公布风险处置方案',url:'https://news.example.org/2025/01/07/old',summary:'旧年同名报道'},{title:'风险处置方案公布：快讯',url:'https://news.example.org/article/124',summary:'短讯'},{title:'风险处置方案公布：实施细节与各方回应',url:'https://news.example.org/article/123',summary:'公开报道'}]}}}),{status:200,headers:{'content-type':'application/json'}});
   const body=JSON.parse(init.body),table=JSON.parse(body.messages[1].content),source=table.events[0],fake={headline:source.title,lead:'榜单出现一条公共事务线索，以下依据公开报道归纳。',overview:[{fact:'公开报道提供了处置安排的背景和执行信息。',judgment:'执行环节值得继续核对。'}],events:[{topic_id:source.topic_id,title:source.title,fact_summary:'报道介绍了处置措施的背景、执行环节与适用范围。',why_hot:'推测：报道梳理处置措施背景与适用范围，可能有助于读者理解方案内容。',impact_path:'推测：报道提及后续安排，相关议题可能随执行进展继续受到关注。',conclusion:'后续可关注公开安排的落实进展。'}],trends:[],watch:[],editor_summary:['本期围绕榜单议题与公开报道整理。']};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(fake)}}],usage:{prompt_tokens:800,completion_tokens:160,prompt_tokens_details:{cached_tokens:0}}}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  const pageRequests:string[]=[],pageFetcher=(async(url:string)=>{pageRequests.push(url);return{url,text:url.endsWith('/direct')||url.includes('kuaishou.com')?'<main><p>火山引擎正在进行安全检测，为保障您的访问安全，系统正在检测当前网络环境，请耐心等待。</p></main>':`<article><p>${url.endsWith('/124')?'风险处置方案已公布，后续安排待详细报道。'.repeat(5):article}</p></article>`,headers:{'content-type':'text/html; charset=utf-8'}};}) as any;
  const digest=await new DailyDigest(db,()=>new Date('2026-10-22T12:00:00+08:00'),config,fetcher,pageFetcher).generateNarrated('2026-10-22',{notify:false});
  assert.equal((digest as any).narrative.overview[0],'公开报道提供了处置安排的背景和执行信息。 执行环节值得继续核对。');
  const result=digest as any;assert.equal(result.narrative_status,'model',String(result.narrative_fallback_reason));assert.equal(result.material_run.search_fallback_success,1);assert.equal(result.material_run.with_usable_body,1);assert.equal(result.material_run.search_attempts,1);assert.equal(result.material_run.search_provider_cost,'unknown');assert.equal(result.narrative.events[0].source_url,'https://news.example.org/article/123');assert.equal(result.narrative.events[0].fact_basis,'source_page_excerpt');assert.equal(result.narrative.events[0].why_hot,'');assert.equal(result.narrative.events[0].impact_path,'');assert.ok((result.model.quality_adjustments as Row[]).some(x=>x.field==='why_hot'&&/锚点/.test(x.reason)));assert.equal(result.source_pages[0].method,'title_search_then_native_article');assert.ok(result.source_pages[0].excerpt.length>=800);assert.equal(pageRequests.some(url=>url.endsWith('irrelevant')||url.endsWith('/old')),false);assert.deepEqual(pageRequests,['https://news.example.org/article/direct','https://news.kuaishou.com/video/123','https://news.example.org/article/124','https://news.example.org/article/123']);assert.equal(db.rows("SELECT * FROM acquisitions WHERE source='daily-digest:2026-10-22' AND operation='source_search'").length,1);
 }finally{db.close();}
});
test('selected theme proactively searches a second independent article and keeps both source records',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-topic-research-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir),date='2026-10-24',title='监管部门公布风险处置方案';
 try{
  const snapshot=uid('snap'),first='https://8.8.8.8/2026/10/24/base',second='https://1.1.1.1/2026/10/24/second';
  db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot','baidu','succeeded',1,null,`${date}T09:00:00+08:00`,`${date}T09:00:00+08:00`);
  db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,'topic',title,first,1,100,'100',encode({}),'raw-topic');
  config.saveRoute({id:'keyword',provider:'fixture',base_url:'https://model.example/v1',model:'fixture',enabled:true,protocol:'openai-completions',api_key:'model-test-key',max_tokens:4096,rates:{input:0.8,cache:0.23,output:2.8}});
  config.set('service.bocha',{enabled:true,base_url:'https://bocha.example/v1/web-search'});config.putSecret('service.bocha','search-test-key');
  const requested:string[]=[],modelInputs:Row[]=[],firstBody='监管部门公布风险处置方案。正文说明执行对象及办理渠道，公布现场受理流程与查询渠道。'.repeat(30),secondBody='监管部门公布风险处置方案。正文说明执行对象及办理渠道，同时介绍地区执行安排及公开反馈渠道。当地受理点同步公开咨询电话和办理流程。'.repeat(30);
  const fetcher=(async(url:any,init:any)=>{
   if(String(url).includes('bocha.example'))return new Response(JSON.stringify({code:200,data:{webPages:{value:[{title,url:second,published_date:date}]}}}),{status:200,headers:{'content-type':'application/json'}});
   const input=JSON.parse(JSON.parse(init.body).messages[1].content) as Row;modelInputs.push(input);const event=input.events[0];
   return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({headline:'风险处置方案进入执行观察',lead:'公开报道分别解释了执行对象和地方安排。',overview:['两家来源分别提供执行对象及办理渠道、地区执行安排。'],events:[{topic_id:event.topic_id,headline:title,fact_summary:'一篇报道说明执行对象及办理渠道，另一篇说明地区执行安排及公开反馈渠道。',why_hot:'分析：执行对象及办理渠道的说明使方案更便于理解。',impact_path:'分析：地区执行安排及公开反馈渠道将影响后续落实。',conclusion:'后续可核对公开办理进展。'}],trends:[],watch:[],editor_summary:['公开报道提供了不同环节的信息，后续仍需核对执行情况。']})}}],usage:{prompt_tokens:850,completion_tokens:200,prompt_tokens_details:{cached_tokens:0}}}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  const pageFetcher=(async(url:string)=>{requested.push(url);return{url,text:`<html><article><p>${url===first?firstBody:secondBody}</p></article></html>`,headers:{'content-type':'text/html; charset=utf-8'}};}) as any;
  const service=new DailyDigest(db,()=>new Date(`${date}T11:45:00+08:00`),config,fetcher,pageFetcher),digest=await service.generateNarrated(date,{notify:false,scheduled:true}) as any;
  assert.equal(digest.narrative_status,'model',String(digest.narrative_fallback_reason));assert.deepEqual(requested,[first,second]);assert.equal(digest.source_scope,'hotlist_selected_cross_source_articles');assert.equal(digest.material_run.cross_source_topics,1);assert.equal(digest.source_pages.length,2,JSON.stringify({pages:digest.source_pages,acquisitions:db.rows("SELECT operation,status,detail FROM acquisitions WHERE source=?",`daily-digest:${date}`)}));assert.equal(digest.source_pages[1].research_expansion,true);assert.equal(digest.narrative.events[0].source_urls.length,2);assert.match(modelInputs[0].events[0].source_excerpt,/来源1[\s\S]*来源2/);assert.match(dailyDigestHtml(digest),/阅读交叉来源/);assert.equal(db.rows("SELECT id FROM acquisitions WHERE source=? AND operation='source_search'",`daily-digest:${date}`).length,1);assert.equal(db.rows("SELECT id FROM acquisitions WHERE source=? AND operation='research_fetch'",`daily-digest:${date}`).length,1);
  const topic=digest.candidate_themes.find((candidate:Row)=>candidate.id===digest.source_pages[0].topic_id);
  const replay=await(service as any).expandTopicSources(date,[topic],[digest.source_pages[0]],{allowCurrentSources:true});
  assert.equal(replay.pages.length,1);assert.equal(replay.pages[0].reused,true);assert.equal(replay.searches,0);assert.equal(requested.length,2,'saved cross-source material should avoid a second search and fetch');
  const nextMorning={...digest,source_pages:[...digest.source_pages.map((page:Row)=>page.research_expansion?{...page,fetched_at:'2026-10-25T08:05:00+08:00'}:page),{...digest.source_pages[1],url:'https://9.9.9.9/2026/10/24/third',final_url:'https://9.9.9.9/2026/10/24/third',fetched_at:'2026-10-25T08:06:00+08:00'}]};
  db.run('UPDATE daily_digests SET data_json=? WHERE id=?',encode(nextMorning),digest.id);
  const delayed=await(service as any).expandTopicSources(date,[topic],[digest.source_pages[0]],{allowCurrentSources:true});
  assert.equal(delayed.pages.length,2,'both independently archived articles should survive the next-morning final');
  assert.equal(delayed.pages.every((page:Row)=>page.reused),true,'the next-morning final should reuse saved articles rather than search again');
 }finally{db.close();}
});
test('proactive topic research rejects a search result that points at loopback',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-research-ssrf-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir),date='2026-10-24';
 try{
  config.set('service.bocha',{enabled:true,base_url:'https://bocha.example/v1/web-search'});config.putSecret('service.bocha','search-test-key');
  const fetcher=(async()=>new Response(JSON.stringify({code:200,data:{webPages:{value:[{title:'监管部门公布风险处置方案',url:'http://127.0.0.1/private',published_date:date}]}}}),{status:200,headers:{'content-type':'application/json'}})) as typeof fetch;
  let fetched=0;const pageFetcher=(async()=>{fetched++;throw new Error('private address should not reach the page fetcher');}) as any;
  const service=new DailyDigest(db,()=>new Date(`${date}T11:00:00+08:00`),config,fetcher,pageFetcher);
  const result=await(service as any).expandTopicSources(date,[{id:'theme_test',title:'监管部门公布风险处置方案',members:[]}],[{topic_id:'theme_test',url:'https://8.8.8.8/story',excerpt:'已有报道'}],{allowCurrentSources:true});
  assert.equal(result.pages.length,0);assert.equal(result.searches,1);assert.equal(fetched,0);assert.match(db.rows("SELECT detail FROM acquisitions WHERE source=? AND operation='research_fetch'",`daily-digest:${date}`)[0].detail,/不访问本机/);
 }finally{db.close();}
});
test('topic research falls back to Tavily and caps independently fetched articles',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-research-providers-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir),date='2026-10-24',title='监管部门公布风险处置方案';
 try{
  config.set('service.bocha',{enabled:true,base_url:'https://bocha.example/v1/web-search'});config.putSecret('service.bocha','bocha-test-key');
  config.set('service.tavily',{enabled:true,base_url:'https://tavily.example/search'});config.putSecret('service.tavily','tavily-test-key');
  config.set('daily_digest.policy',{research_extra_page_limit:2});
  const urls=['https://1.1.1.1/2026/10/24/a','https://9.9.9.9/2026/10/24/b'];
  const fetcher=(async(url:any)=>new Response(JSON.stringify(String(url).includes('bocha.example')?{code:200,data:{webPages:{value:[{title:'演唱会举行',url:'https://8.8.4.4/2026/10/24/irrelevant',published_date:date}]}}}:{results:urls.map(url=>({title,url,published_date:date}))}),{status:200,headers:{'content-type':'application/json'}})) as typeof fetch;
  const requested:string[]=[],pageFetcher=(async(url:string)=>{requested.push(url);return{url,text:`<article><p>${(title+'。报道说明执行对象及办理渠道，也公布当地受理点和公开反馈方式。相关机构介绍了办理时间与后续核查流程。').repeat(20)}</p></article>`,headers:{'content-type':'text/html; charset=utf-8'}};}) as any;
  const service=new DailyDigest(db,()=>new Date(`${date}T11:00:00+08:00`),config,fetcher,pageFetcher);
  const result=await(service as any).expandTopicSources(date,[{id:'theme_test',title,members:[]}],[{topic_id:'theme_test',url:'https://8.8.8.8/base',excerpt:'已归档来源'}],{allowCurrentSources:true});
  assert.equal(result.searches,2);assert.equal(result.pages.length,2);assert.deepEqual(requested,urls);assert.equal(result.pages.every((page:Row)=>page.origin==='tavily'),true);assert.equal(db.rows("SELECT id FROM acquisitions WHERE source=? AND operation='research_fetch'",`daily-digest:${date}`).length,2);
 }finally{db.close();}
});
test('a factual news flash does not consume the whole material budget when a fuller original article is available',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-brief-upgrade-')),db=new Database(join(dir,'state.sqlite3'),ROOT),requested:string[]=[];
 try{const short='主管部门公布风险处置方案，明确实施时间与申请范围，并说明后续将按公告推进办理。',long='主管部门公布风险处置方案，明确实施时间与申请范围，并说明后续将按公告推进办理。报道逐项解释了执行步骤、参与机构的职责、申请材料和争议处理办法。'.repeat(20),pageFetcher=(async(url:string)=>{requested.push(url);return{url,text:`<article><p>${url.endsWith('/first')?short:long}</p></article>`,headers:{'content-type':'text/html; charset=utf-8'}};}) as any;
 const service=new DailyDigest(db,()=>new Date('2026-10-23T12:00:00+08:00'),undefined,undefined,pageFetcher),pages=await(service as any).sourcePages('2026-10-23',[{id:'topic-plan',title:'主管部门公布风险处置方案',source_urls:['https://news.example.org/story/first','https://news.example.org/story/full']}]);assert.equal(pages[0].url,'https://news.example.org/story/full');assert.equal(pages[0].status,'fetched');assert.deepEqual(requested,['https://news.example.org/story/first','https://news.example.org/story/full']);}finally{db.close();}
});
test('daily digest extra page-fetch allowance is per-request and never changes the default daily cap',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-extra-fetch-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir);let pageFetches=0;
 try{
  const snapshot=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot','sina','succeeded',1,null,'2026-10-22T10:00:00+08:00','2026-10-22T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,'topic','测试公共议题','https://news.example.org/article/1',1,10,'10',encode({}),'测试公共议题');
  for(let i=0;i<10;i++)db.run('INSERT INTO acquisitions VALUES(?,?,?,?,?,?,?)',uid('acq'),null,'daily-digest:2026-10-22','page_fetch','failed',`prior attempt ${i}`,'2026-10-22T11:00:00+08:00');
  config.saveRoute({id:'keyword',provider:'test',base_url:'https://model.example/v1',model:'flash-test',enabled:true,protocol:'openai-completions',api_key:'test-secret',max_tokens:4096,rates:{input:0.8,cache:0.23,output:2.8}});
  const fetcher=(async(_url:any,init:any)=>{const table=JSON.parse(JSON.parse(init.body).messages[1].content),event=table.events[0],narrative={headline:'公共议题进入观察',lead:'一条公共议题进入观察。以下按公开材料整理。',overview:['日报归纳热榜记录与来源页信息。'],events:[{topic_id:event.topic_id,headline:event.title,fact_summary:'来源页介绍相关议题背景与后续安排。',why_hot:'',impact_path:'',conclusion:'可继续关注后续公开信息。'}],trends:[],watch:[],editor_summary:['本期据现有公开材料整理。']};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(narrative)}}],usage:{prompt_tokens:500,completion_tokens:100,prompt_tokens_details:{cached_tokens:0}}}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
  const pageFetcher=(async(url:string)=>{pageFetches++;return{url,text:`<article><p>${'测试公共议题发布后，公开报道介绍参与方回应及后续安排，并列出办理流程和资料查询渠道。'.repeat(40)}</p></article>`,headers:{'content-type':'text/html; charset=utf-8'}};}) as any;
  const service=new DailyDigest(db,()=>new Date('2026-10-22T12:00:00+08:00'),config,fetcher,pageFetcher);
  const ordinary=await service.generateNarrated('2026-10-22',{notify:false}) as any;assert.equal(pageFetches,0);assert.equal(ordinary.material_run.with_usable_body,0);
  const approved=await service.generateNarrated('2026-10-22',{notify:false,acceptanceTest:true,additionalPageFetches:6}) as any;assert.equal(pageFetches,1);assert.equal(approved.material_run.with_usable_body,1);assert.equal(db.rows("SELECT id FROM acquisitions WHERE source='daily-digest:2026-10-22' AND operation IN ('page_fetch','firecrawl_fetch')").length,11);
 }finally{db.close();}
});
test('an archived short article supports bound facts but not an invented cause or impact',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-short-source-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir);
 try{
  const snapshot=uid('snap'),title='公开事项7.0级后续安排';db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot','news','succeeded',1,null,'2026-10-22T10:00:00+08:00','2026-10-22T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,title,title,'https://news.example.org/article/brief',1,10,'10',encode({}),title);
  const base=new DailyDigest(db,()=>new Date('2026-10-22T12:00:00+08:00')).generate('2026-10-22',{notify:false}),eventSection=base.sections.find((s:Row)=>s.title==='重点事件');assert.ok(eventSection&&Array.isArray(eventSection.items));const topic=eventSection.items[0];
  const brief='来源短讯称，主管部门公布了公开事项的后续安排，明确实施时间和办理地点；有关人员可按公告提交材料。随后公布办理窗口、咨询方式与材料审核步骤，相关安排将依照公告时间实施。报道还说明未提交齐全材料的人员可继续补正，窗口将按规定答复。';
  db.run('UPDATE daily_digests SET data_json=?,created_at=? WHERE id=?',encode({...base,source_pages:[{topic_id:topic.id,url:'https://news.example.org/article/brief',event_url:'https://news.example.org/article/brief',excerpt:brief,method:'firecrawl_main_content',status:'insufficient_body'}]}),'2026-10-22T12:00:00+08:00',base.id);
  config.saveRoute({id:'keyword',provider:'test',base_url:'https://model.example/v1',model:'flash-test',enabled:true,protocol:'openai-completions',api_key:'test-secret',max_tokens:4096,rates:{input:0.8,cache:0.23,output:2.8}});
   let briefSeen=false;const fetcher=(async(_url:any,init:any)=>{const input=JSON.parse(JSON.parse(init.body).messages[1].content),event=input.events[0];briefSeen=event.source_excerpt.includes('办理地点')&&event.anchor_grade==='A';const result={headline:'公开事项7级进入办理阶段',lead:'来源短讯公布后续安排。以下区分事实与推断。',overview:['归档榜单与来源短讯共同构成本期观察。'],events:[{topic_id:event.topic_id,headline:event.title,fact_summary:'主管部门公布了公开事项的后续安排，明确实施时间和办理地点；有关人员可按公告提交材料。',why_hot:'推测：此事将迅速成为全网焦点。',impact_path:'推测：可能推动重大政策变化。',conclusion:'后续影响仍需更多材料核对。'}],trends:[],watch:[],editor_summary:['短讯仅支持事实概述。']};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:700,completion_tokens:150,prompt_tokens_details:{cached_tokens:0}}}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
  const noFetch=(async()=>{throw new Error('saved brief should be reused without collection');}) as any;
  const digest=await new DailyDigest(db,()=>new Date('2026-10-23T12:00:00+08:00'),config,fetcher,noFetch).generateNarrated('2026-10-22',{notify:false}) as any;
   assert.equal(briefSeen,true);assert.equal(digest.title,'公开事项7级进入办理阶段');assert.equal(digest.material_run.with_usable_body,0);assert.equal(digest.material_run.with_brief,1);assert.equal(digest.source_pages[0].time_basis,'digest_recorded_upper_bound');assert.equal(digest.narrative.events[0].fact_basis,'source_page_excerpt');assert.match(digest.narrative.events[0].fact_summary,/办理地点/);assert.equal(digest.narrative.events[0].why_hot,'');assert.equal(digest.narrative.events[0].impact_path,'');assert.match(dailyDigestHtml(digest),/来源材料|归档完成时间/);
 }finally{db.close();}
});
test('one-day approval adds at most eight attempts after twenty-two recorded attempts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-eight-fetch-')),db=new Database(join(dir,'state.sqlite3'),ROOT);let fetched=0;
 try{
  for(let i=0;i<22;i++)db.run('INSERT INTO acquisitions VALUES(?,?,?,?,?,?,?)',uid('acq'),null,'daily-digest:2026-10-22','page_fetch','failed',`prior attempt ${i}`,'2026-10-22T11:00:00+08:00');
  const pageFetcher=(async(url:string)=>{fetched++;return{url,text:`<article><p>${'测试公开议题报道具体措施与后续执行安排。'.repeat(70)}</p></article>`,headers:{'content-type':'text/html; charset=utf-8'}};}) as any;
  const service=new DailyDigest(db,()=>new Date('2026-10-22T12:00:00+08:00'),undefined,undefined,pageFetcher);
  const events=Array.from({length:9},(_,i)=>({id:`topic-${i}`,title:`测试公开议题${i}`,url:`https://news.example.org/article/${i}`,source_urls:[`https://news.example.org/article/${i}`]}));
  await (service as any).sourcePages('2026-10-22',events);
  assert.equal(fetched,0);
  const pages=await (service as any).sourcePages('2026-10-22',events,{additionalPageFetches:20});
  assert.equal(fetched,8);assert.equal(pages.length,9);assert.equal(pages.filter((page:Row)=>page.status==='fetched').length,8);
  assert.equal(db.rows("SELECT id FROM acquisitions WHERE source='daily-digest:2026-10-22' AND operation IN ('page_fetch','firecrawl_fetch')").length,30);
 }finally{db.close();}
});
test('automatic previous-day narrative may fetch current source pages while an ordinary historical replay may not',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-scheduled-fetch-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir),snapshot=uid('snap');let pageFetches=0,modelCalls=0;
 try{
   db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot','sina','succeeded',1,null,'2026-10-21T10:00:00+08:00','2026-10-21T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,'test','官方通报采取具体措施并公布相关安排','https://news.example/article',1,10,'10',encode({}),'官方通报采取具体措施并公布相关安排');
  config.saveRoute({id:'keyword',provider:'fixture',base_url:'https://model.example/v1',model:'fixture',enabled:true,protocol:'openai-completions',api_key:'fixture-model-key',max_tokens:4096,rates:{input:0.8,cache:0.23,output:2.8}});
  const modelFetcher=(async(_url:any,init:any)=>{modelCalls++;const input=JSON.parse(JSON.parse(init.body).messages[1].content),source=input.events[0],phrase='官方通报采取具体措施并公布相关安排。',hasBody=Boolean(source.source_excerpt),event={topic_id:source.topic_id,headline:source.title,fact_summary:hasBody?`来源页提到${phrase}`:`归档标题显示：${source.title}。`,why_hot:hasBody?`推测：${phrase}，使处理进展成为讨论焦点。`:'',impact_path:hasBody?`推测：${phrase}，后续关注点可能落在安排落实情况。`:'',conclusion:'后续可继续对照公开进展。'};const narrative={headline:'公共议题出现新进展',lead:'一项公共议题进入多主题日报观察。来源页提供了具体处置内容。',overview:['本次概述来自已归档来源正文。'],events:[event],trends:[],watch:[],editor_summary:['来源材料为事件梳理提供了事实基础。']};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(narrative)}}],usage:{prompt_tokens:800,completion_tokens:300,prompt_tokens_details:{cached_tokens:0}}}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
   const pageFetcher=async(url:string,_signal:AbortSignal,_origin:string)=>{pageFetches++;return{text:`<html><article><p>${'官方通报采取具体措施并公布相关安排。通报介绍了实施对象、办理时间和公开查询渠道。相关部门说明后续会发布执行进度并回应疑问。'.repeat(40)}</p></article></html>`,url,headers:{'content-type':'text/html; charset=utf-8'} as any};};
  const service=new DailyDigest(db,()=>new Date('2026-10-22T03:00:00Z'),config,modelFetcher,pageFetcher);
  const replay=await service.generateNarrated('2026-10-21',{notify:false}) as any;assert.equal(pageFetches,0);assert.equal(replay.narrative_status,'model');
   const scheduled=await service.generateNarrated('2026-10-21',{notify:false,scheduled:true}) as any;assert.equal(pageFetches,1);assert.equal(modelCalls,2);assert.equal(scheduled.material_run.with_usable_body,1);assert.equal(scheduled.narrative.events[0].fact_basis,'source_page_excerpt');assert.equal(scheduled.narrative.events[0].why_hot,'');assert.ok(scheduled.model.quality_adjustments.some((item:Row)=>item.field==='why_hot'));
 }finally{db.close();}
});
test('daily digest combines many themes, reports observed sources and does not claim total online volume',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-')),db=new Database(join(dir,'state.sqlite3'),ROOT),snap=(source:string,time:string,titles:string[])=>{const id=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',id,'dailyhot',source,'succeeded',titles.length,null,time,time);titles.forEach((title,i)=>db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),id,title.toLowerCase(),title,'https://example.org/'+encodeURIComponent(title),i+1,10,'10',encode({}),title+'-'+source));return id;};
 try{snap('weibo','2026-10-20T10:00:00+08:00',['AI 争议','新能源降价']);snap('baidu','2026-10-20T10:10:00+08:00',['AI 争议','海外政策']);snap('weibo','2026-10-19T10:00:00+08:00',['AI 争议']);db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',uid('snap'),'dailyhot','zhihu','failed',0,'HTTP 403','2026-10-20T10:15:00+08:00','2026-10-20T10:15:00+08:00');const service=new DailyDigest(db),digest=service.generate('2026-10-20');assert.equal(digest.title,'2026-10-20 热点日报（统计版）');assert.equal(digest.coverage.succeeded,2);assert.equal(digest.coverage.failed,1);assert.equal(digest.coverage.topics,3);assert.deepEqual(digest.sections.map((s:any)=>s.title),['今日总览','重点事件','趋势观察','值得继续关注','编辑总结']);assert.match(digest.sections[1].text,/标注推测/);assert.equal(digest.source_status.find((s:any)=>s.status==='failed')?.error,'HTTP 403');assert.equal(service.get('2026-10-20')?.id,digest.id);const html=dailyDigestHtml(digest);assert.match(html,/编辑摘要/);assert.match(html,/https:\/\/example.org/);assert.match(html,/查看榜单记录与标题变体/);assert.match(html,/2 个榜单入口/);assert.doesNotMatch(html,/HTTP 403|成功快照|采集覆盖与来源状态|采集成功\/失败数/);assert.equal(await service.generatePreviousDayIfMissing(),null);}finally{db.close();}
});

test('old stored digest HTML is rendered without collection diagnostics in the article body',()=>{
 const old={date:'2026-10-20',title:'AI 争议等热点观察',coverage:{succeeded:42,failed:3},source_status:[{provider:'dailyhot',source_id:'weibo',status:'failed',error:'HTTP 403'}],note:'成功快照42份、失败3份；逐源状态：weibo HTTP 403',sections:[{title:'今日总览',text:'成功快照42份、失败3份，归纳3个议题。',themes:[]},{title:'重点事件',text:'若干热点',items:[{title:'AI 争议',source_count:2,sources:['dailyhot:weibo','newsnow:baidu'],best_rank:2,trend:'延续',url:'https://example.org/a'}]},{title:'趋势观察',text:'观察'},{title:'值得继续关注',text:'线索'},{title:'编辑总结',text:'总结'}]};
 const html=dailyDigestHtml(old);assert.doesNotMatch(html,/HTTP 403|成功快照42份|失败3份/);assert.match(html,/AI 争议/);assert.match(html,/阅读原始来源/);
});

test('source text is hidden behind disclosure and escaped rather than presented as report analysis',()=>{
 const digest={date:'2026-10-20',title:'回退日报',coverage:{succeeded:1,failed:0,sources:1,observations:1,topics:1},sections:[{title:'今日总览',text:'观察',themes:[]},{title:'重点事件',text:'观察',items:[{id:'topic-a',title:'公开事件',source_count:1,sources:['dailyhot:board'],best_rank:1,trend:'基线不足',url:'https://example.org/a'}]},{title:'趋势观察',text:'无基线',items:[]},{title:'值得继续关注',text:'无',items:[]},{title:'编辑总结',text:'总结'}],source_pages:[{url:'https://example.org/a',status:'fetched',fetched_at:'2026-10-20T10:00:00.000Z',excerpt:'来源页称：<script>alert(1)</script>事件的背景和用户讨论情况仍在发展，文章介绍了产品体验与日常使用场景，并说明讨论仍在持续，暂未出现进一步结论。'.repeat(18)}]};
 const html=dailyDigestHtml(digest);assert.match(html,/<details class="source-material"><summary>查看来源页文字 · 2026-10-20T10:00:00.000Z · 来源陈述，未独立核实<\/summary>/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>alert/);assert.doesNotMatch(html,/<blockquote class="source-excerpt">/);
});
test('stored verification pages are not presented as source materials',()=>{
 const digest={date:'2026-10-22',title:'安全检测',coverage:{succeeded:1,failed:0,sources:1,observations:1,topics:1},sections:[{title:'今日总览',text:'观察',themes:[]},{title:'重点事件',text:'观察',items:[{id:'topic-a',title:'产品体验讨论',source_count:1,sources:['dailyhot:36kr'],best_rank:1,trend:'今日新见',url:'https://example.org/a'}]},{title:'趋势观察',text:'无',items:[]},{title:'值得继续关注',text:'无',items:[]},{title:'编辑总结',text:'总结'}],narrative:{headline:'产品体验引发关注',lead:'观察热榜条目。',overview:['总览'],events:[{topic_id:'topic-a',headline:'产品体验引发关注',fact_summary:'榜单中出现相关体验讨论。',why_hot:'',impact_path:'',conclusion:'继续观察。',source_url:'https://example.org/a'}],trends:[],watch:[],editor_summary:['总结']},source_pages:[{url:'https://example.org/a',status:'fetched',fetched_at:'2026-10-22T10:00:00Z',excerpt:'火山引擎正在进行安全检测，为保障您的访问安全，系统正在检测当前网络环境，请耐心等待。'}]};
  const html=dailyDigestHtml(digest);assert.doesNotMatch(html,/查看来源材料/);assert.doesNotMatch(html,/火山引擎正在进行安全检测/);assert.match(html,/仅有话题线索/);assert.match(html,/未取得可用事件事实/);
});

test('daily digest uses the actual collection day to select the previous full calendar day',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-catchup-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
 try{
  db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',uid('snap'),'dailyhot','baidu','succeeded',1,null,'2026-10-20T10:00:00+08:00','2026-10-20T10:00:00+08:00');
  const digest=new DailyDigest(db,()=>new Date('2026-10-24T04:00:00.000Z'));
  await digest.generatePreviousDayIfMissing({referenceTime:new Date('2026-10-21T00:00:00.000Z')});
  assert.equal(digest.get('2026-10-20')?.report_date,'2026-10-20');
  assert.equal(db.rows('SELECT id FROM daily_digests').length,1);
 }finally{db.close();}
});
test('failed-only coverage cannot trigger a scheduled paid digest',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-failed-only-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
 try{db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',uid('snap'),'dailyhot','baidu','failed',0,'HTTP 403','2026-10-20T10:00:00+08:00','2026-10-20T10:00:00+08:00');const digest=new DailyDigest(db);assert.equal(await digest.generatePreviousDayIfMissing({referenceTime:new Date('2026-10-21T00:00:00.000Z')}),null);assert.equal(db.rows('SELECT id FROM daily_digests').length,0);assert.equal(db.rows('SELECT id FROM model_calls').length,0);}finally{db.close();}
});
test('11:30 morning brief remains separate from the next-day final digest for the same date',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-morning-edition-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
 try{
  const snap=(stamp:string)=>db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',uid('snap'),'dailyhot','baidu','succeeded',1,null,stamp,stamp);
  snap('2026-10-24T08:00:00+08:00');snap('2026-10-24T11:35:00+08:00');snap('2026-10-24T16:00:00+08:00');
  const service=new DailyDigest(db,()=>new Date('2026-10-24T11:40:00+08:00'));
  const morning=await service.generateMorningBriefIfMissing({referenceTime:new Date('2026-10-24T11:30:00+08:00'),through:new Date('2026-10-24T11:40:00+08:00')}) as Row;
  assert.equal(morning.edition,'morning');assert.equal(morning.coverage.succeeded,2);assert.equal(service.get('2026-10-24'),null);assert.equal(service.getEdition('2026-10-24','morning')?.id,morning.id);assert.match(dailyDigestHtml(morning),/今日早报/);assert.match(dailyDigestHtml(morning),/不含下午及晚间变化/);
  assert.equal(await service.generateMorningBriefIfMissing({referenceTime:new Date('2026-10-24T11:30:00+08:00')}),null);
  const final=await service.generatePreviousDayIfMissing({referenceTime:new Date('2026-10-25T08:00:00+08:00')}) as Row;
  assert.equal(final.edition,'daily');assert.equal(final.coverage.succeeded,3);assert.notEqual(final.id,morning.id);assert.equal(service.get('2026-10-24')?.id,final.id);assert.equal(db.rows('SELECT id FROM model_calls').length,0);
 }finally{db.close();}
});
test('an unpublished preview suppresses automatic catch-up to avoid unapproved generation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-preview-catchup-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
 try{const snapshot=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot','baidu','succeeded',1,null,'2026-10-20T10:00:00+08:00','2026-10-20T10:00:00+08:00');const digest=new DailyDigest(db,()=>new Date('2026-10-21T04:00:00.000Z'));digest.generate('2026-10-20',{notify:false});assert.equal(db.rows('SELECT id FROM daily_digests').length,1);await digest.generatePreviousDayIfMissing();assert.equal(db.rows('SELECT id FROM daily_digests').length,1);assert.equal(db.rows("SELECT id FROM events WHERE kind='daily_digest.completed'").length,0);}finally{db.close();}
});
test('the scheduled window may replace a preview while restart catch-up cannot',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-scheduled-preview-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
 try{db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',uid('snap'),'dailyhot','baidu','succeeded',1,null,'2026-10-20T10:00:00+08:00','2026-10-20T10:00:00+08:00');const digest=new DailyDigest(db,()=>new Date('2026-10-21T00:10:00+08:00')),preview=digest.generate('2026-10-20',{notify:false});db.run('UPDATE daily_digests SET data_json=? WHERE id=?',encode({...preview,preview:true}),preview.id);assert.equal(await digest.generatePreviousDayIfMissing(),null);assert.equal(db.rows('SELECT id FROM daily_digests').length,1);await digest.generatePreviousDayIfMissing({replacePreview:true});assert.equal(db.rows('SELECT id FROM daily_digests').length,2);assert.equal(db.rows("SELECT id FROM events WHERE kind='daily_digest.completed'").length,0);assert.equal(db.rows("SELECT id FROM events WHERE kind='daily_digest.quality_blocked'").length,1);assert.equal(await digest.generatePreviousDayIfMissing({replacePreview:true}),null);}finally{db.close();}
});
test('an unreviewable generated digest stays in the platform and never reaches the notification queue',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-quality-gate-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
 try{db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',uid('snap'),'dailyhot','baidu','succeeded',1,null,'2026-10-20T10:00:00+08:00','2026-10-20T10:00:00+08:00');const digest=await new DailyDigest(db).generateNarrated('2026-10-20',{notify:true}) as Row;assert.equal(digest.preview,true);assert.equal(digest.quality_status,'needs_review');assert.equal(db.rows("SELECT id FROM events WHERE kind='daily_digest.completed'").length,0);assert.equal(db.rows("SELECT id FROM outbox WHERE event_type='daily_digest.completed'").length,0);assert.match(dailyDigestHtml(digest),/本版质检未通过，未向企微推送/);}finally{db.close();}
});

test('without prior-day coverage the digest does not mislabel every issue as new or invent trend counts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-no-baseline-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
 try{const id=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',id,'dailyhot','baidu','succeeded',1,null,'2026-10-20T10:00:00+08:00','2026-10-20T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),id,'ai','AI 观察','https://example.org/ai',1,10,'10',encode({}),'AI');const digest=new DailyDigest(db).generate('2026-10-20');assert.equal(digest.sections[1].items?.[0].trend,'基线不足');assert.equal(digest.sections[2].items?.length,0);assert.equal(digest.sections[2].new_items?.length,0);assert.match(digest.sections[0].text,/不对议题标记“新见”或“延续”/);assert.match(digest.sections[4].text,/无链接条目不作延伸判断/);}finally{db.close();}
});

test('narrative replay is metered, bound to code-selected topics and does not notify during preview',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-narrative-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir);
 try{
  const add=(source:string,title:string,rank:number)=>{const snapshot=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot',source,'succeeded',1,null,'2026-10-20T10:00:00+08:00','2026-10-20T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,title.toLowerCase(),title,'https://example.org/'+source,rank,10,'10',encode({}),title+'-'+source);};
  add('weibo','AI 行业争议',1);add('baidu','AI 行业争议',2);add('zhihu','国家数据集团与工信部发布前三季度经济数据',3);add('36kr','iPhone体验引发讨论',4);
  db.run('INSERT INTO daily_digests VALUES(?,?,?,?,?)',uid('digest_old'),'2026-10-20','旧回放记录',encode({source_pages:[{url:'https://example.org/weibo',excerpt:'未来页面内容，不可用于历史回放。',content_hash:'test-hash',fetched_at:'2026-10-21T00:00:00+08:00',status:'fetched'},{url:'https://example.org/36kr',excerpt:'据已归档的体验文章，用户讨论了iPhone在日常使用中的续航与操作体验。文章同时记录了不同使用场景下的反馈，也比较了多种使用环境的差异，并介绍了用户的实际评价与体验差异。'.repeat(16),content_hash:'archived-hash',fetched_at:'2026-10-19T12:00:00+08:00',status:'fetched'}]}),'2026-10-21T00:00:00+08:00');
  config.saveRoute({id:'keyword',provider:'test',base_url:'https://model.example/v1',model:'glm-5.3-flash',enabled:true,protocol:'openai-completions',api_key:'test-secret',max_tokens:4096,rates:{input:0.8,cache:0.23,output:2.8}});
  config.set('daily_digest.policy',{card_repair_enabled:false});
  let sentInput:Row|undefined;const fetcher=(async(_url:any,init:any)=>{const body=JSON.parse(init.body),table=JSON.parse(body.messages[1].content);sentInput=table;assert.equal(body.max_tokens,4096);assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.reasoning_effort,'low');assert.deepEqual(body.thinking,{type:'enabled'});const selected=table.events.find((i:Row)=>String(i.title).includes('iPhone'))||table.events[0],events=[{topic_id:selected.topic_id,headline:selected.title,fact_summary:selected.sources?.some((s:string)=>s.endsWith(':36kr'))?'36氪、极客公园热榜呈现一篇体验文章，讨论 iPhone 使用场景。':'AI 行业争议进入多个榜单讨论。',why_hot:'推测：该标题对应90周年纪念活动，可能因此引发跨平台关注。',impact_path:'推测：文章记录了不同使用场景下的反馈，相关讨论可能延续。',conclusion:'可结合原始来源继续观察。'}];const narrative={headline:'10月20日产业议题与AI讨论交织',lead:'10月20日归档4份成功快照。今日热点以国家数据集团发布前三季度数据为线索，同日工信部议题也进入观察范围。',overview:'一方面，榜单样本显示不同主题并行出现；其中前三季度经济数据发布也在底表标题中。可归纳为两条主线。',events,trends:[],watch:[],editor_summary:'跨源线索可作为优先阅读入口。相关议题涉及两家公司，后续变化仍需观察归档榜单。'};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(narrative)}}],usage:{prompt_tokens:1200,completion_tokens:380,prompt_tokens_details:{cached_tokens:0}}}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
  const service=new DailyDigest(db,()=>new Date(),config,fetcher),digest=await service.generateNarrated('2026-10-20',{notify:false});
   assert.equal(digest.narrative_status,'model',String(digest.narrative_fallback_reason));assert.ok(digest.narrative);assert.equal(digest.narrative.headline,'10月20日产业议题与AI讨论交织');assert.equal(sentInput?.events.length,3);assert.ok(sentInput?.events.some((e:Row)=>e.source_excerpt.includes('续航与操作体验')));assert.equal(digest.narrative.events.length,3);const iphoneEvent=digest.narrative.events.find((e:Row)=>e.fact_basis==='source_page_excerpt');assert.ok(iphoneEvent);assert.equal(iphoneEvent.fact_summary,'36氪、极客公园热榜呈现一篇体验文章，讨论 iPhone 使用场景。');assert.equal(iphoneEvent.why_hot,'');assert.ok((digest.model?.quality_adjustments as Row[]).some(x=>x.field==='事件卡降级'));assert.ok((digest.model?.quality_adjustments as Row[]).some(x=>x.field==='why_hot'));assert.match(digest.narrative.editor_summary[0],/下一步应分别核对各事件/);assert.doesNotMatch(JSON.stringify(iphoneEvent),/90周年/);assert.ok(digest.source_pages.some((p:Row)=>p.status==='historical_source_unavailable'));assert.ok(digest.source_pages.some((p:Row)=>p.status==='fetched'&&p.excerpt.includes('续航与操作体验')));assert.doesNotMatch(JSON.stringify(digest.source_pages),/未来页面内容/);assert.equal(db.rows('SELECT * FROM model_calls WHERE role=?','daily_digest').length,1);assert.ok(Number(digest.model?.cost)>0&&Number(digest.model?.cost)<0.05);assert.equal(db.rows("SELECT * FROM outbox WHERE event_type='daily_digest.completed'").length,0);const html=dailyDigestHtml(digest);assert.match(html,/来源正文/);assert.doesNotMatch(html,/该标题同时出现在|可核对的榜单数据|短讯只支持事件事实概述/);assert.match(html,/不同使用场景下的反馈/);assert.match(html,/榜单记录与来源依据/);assert.match(html,/A级依据来源正文/);assert.match(html,/个别越界内容已按对应议题材料回退或省略/);assert.match(html,/<details class="source-material">/);assert.doesNotMatch(html,/<blockquote class="source-excerpt">/);
 }finally{db.close();}
});

test('narrative guard replaces an unbound summary number with code-backed text and preserves metering',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-guard-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir);
 try{
  const snapshot=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot','weibo','succeeded',1,null,'2026-10-20T10:00:00+08:00','2026-10-20T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,'topic','新能源讨论','https://example.org/a',1,10,'10',encode({}),'新能源讨论-weibo');
  config.saveRoute({id:'keyword',provider:'test',base_url:'https://model.example/v1',model:'flash-test',enabled:true,protocol:'openai-completions',api_key:'test-secret',max_tokens:4096,rates:{input:0.8,cache:0.23,output:2.8}});
   const fetcher=(async(_url:any,init:any)=>{const table=JSON.parse(JSON.parse(init.body).messages[1].content),source=table.events[0],fake={headline:'新能源讨论显现',lead:'底表外的数字为三百条。这里观察榜单样本。',overview:['当前仅记录来源榜单。'],events:[{topic_id:source.topic_id,headline:source.title,fact_summary:`归档榜单标题显示：${source.title}。`,why_hot:'',impact_path:'',conclusion:'可结合原始来源继续观察。'}],trends:[{headline:'长征胜利90周年相关话题持续走热',body:'相关话题持续走热。',topic_ids:['not-a-selected-trend']}],watch:[],editor_summary:['总结样本。']};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(fake)}}],usage:{prompt_tokens:900,completion_tokens:100,prompt_tokens_details:{cached_tokens:0}}}),{status:200});}) as typeof fetch;
  const service=new DailyDigest(db,()=>new Date(),config,fetcher),digest=await service.generateNarrated('2026-10-20',{notify:false});
  const model=digest.model as Record<string,unknown>;
    assert.equal(digest.narrative_status,'model');assert.equal(digest.narrative?.lead,'本期选取不同主题的热点事件，优先梳理已取得来源正文的具体变化；其余仅作阅读线索。');assert.deepEqual((model.quality_adjustments as Row[]).map(x=>x.field),['导语','C级线索','趋势条目降级']);assert.equal(digest.narrative?.events[0].fact_summary,'热榜标题显示：新能源讨论。');assert.equal(digest.narrative?.events[0].conclusion,'本条仅有话题线索，暂不分析。');assert.equal(digest.narrative?.trends.length,0);assert.doesNotMatch(JSON.stringify(digest.narrative),/三百条|长征胜利90周年/);const html=dailyDigestHtml(digest);assert.match(html,/未取得可用事件事实/);assert.doesNotMatch(html,/为什么热（编辑推测）/);assert.match(html,/榜单记录与来源依据/);assert.equal(db.rows("SELECT status FROM model_calls WHERE role='daily_digest'")[0].status,'succeeded');assert.equal(db.rows('SELECT * FROM usage').length,0);
 }finally{db.close();}
});
test('invalid model event degrades only that card while preserving the readable digest shell',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-digest-event-degrade-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir);
 try{const snapshot=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot','weibo','succeeded',1,null,'2026-10-22T10:00:00+08:00','2026-10-22T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,'新能源讨论','新能源讨论',null,1,10,'10',encode({}),'新能源讨论');
  config.saveRoute({id:'keyword',provider:'test',base_url:'https://model.example/v1',model:'flash-test',enabled:true,protocol:'openai-completions',api_key:'test-secret',max_tokens:4096,rates:{input:0.8,cache:0.23,output:2.8}});
  const fetcher=(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({headline:'新能源议题出现跨平台讨论',lead:'多个热榜出现产业线索，以下以榜单记录为基础。',overview:['今日归档标题呈现产业相关议题。'],events:[{topic_id:'not-a-selected-topic',headline:'未知议题',fact_summary:'没有绑定的事实',conclusion:'继续观察'}],trends:[],watch:[],editor_summary:['本文整理当日归档线索。']})}}],usage:{prompt_tokens:500,completion_tokens:150}}),{status:200,headers:{'content-type':'application/json'}})) as typeof fetch;
  const result=await new DailyDigest(db,()=>new Date('2026-10-22T12:00:00+08:00'),config,fetcher).generateNarrated('2026-10-22',{notify:false}) as any;
  assert.equal(result.narrative_status,'model');assert.equal(result.narrative.events.length,1);assert.equal(result.narrative.events[0].fact_summary,'热榜标题显示：新能源讨论。');assert.ok(result.model.quality_adjustments.some((item:Row)=>item.field==='事件卡降级'&&item.rejected_output_excerpt));assert.equal(result.model.quality_adjustments.some((item:Row)=>item.field==='narrative_fallback'),false);
 }finally{db.close();}
});
test('editorial selection uses a bounded candidate shortlist, records a separate call, and renders its reasons',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-editorial-selection-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir);let selectionCalls=0,proseCalls=0;
 try{
  const titles=['小米汽车公布交付计划','苹果发布新款电脑','央行公布金融数据','乌克兰宣布谈判安排','中国海警通报海上行动','电影节公布获奖名单','足球联赛公布赛程'];
  for(const [index,title] of titles.entries()){const snapshot=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot',`board${index}`,'succeeded',1,null,'2026-10-23T10:00:00+08:00','2026-10-23T10:00:00+08:00');db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,title,title,null,index+1,1,'1',encode({}),title);}
  config.saveRoute({id:'keyword',provider:'test',base_url:'https://model.example/v1',model:'flash-test',enabled:true,protocol:'openai-completions',api_key:'test-secret',max_tokens:4096,rates:{input:0.8,cache:0.23,output:2.8}});
  const fetcher=(async(_url:any,init:any)=>{const input=JSON.parse(JSON.parse(init.body).messages[1].content);let result:Row;if(input.candidates){selectionCalls++;result={mainline:'小米汽车完成融资',selected_ids:input.candidates.slice(0,2).map((c:Row)=>c.id),alternate_ids:input.candidates.slice(2,4).map((c:Row)=>c.id),reasons:input.candidates.slice(0,2).map((c:Row)=>({topic_id:c.id,reason:'有明确主体与动作'})),excluded:[{topic_id:input.candidates[2].id,reason:'同日来源较少'}]};}else{proseCalls++;assert.doesNotMatch(input.editorial_selection.mainline,/完成融资/);result={headline:'多领域发布事项构成当日观察',lead:'当日归档呈现多个独立议题。',overview:['多个领域分别出现发布事项。'],events:input.events.map((e:Row)=>({topic_id:e.topic_id,headline:e.title,fact_summary:`榜单标题称：${e.title}。`,why_hot:'',impact_path:'',conclusion:'仍需核对原始来源。'})),trends:[],watch:[],editor_summary:['不同议题需分别阅读来源。']};}return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:500,completion_tokens:150,prompt_tokens_details:{cached_tokens:0}}}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
  const digest=await new DailyDigest(db,()=>new Date('2026-10-24T12:00:00+08:00'),config,fetcher).generateNarrated('2026-10-23',{notify:false}) as Row;
  assert.equal(selectionCalls,1);assert.equal(proseCalls,1);assert.equal(digest.editorial_selection.status,'model');assert.match(digest.editorial_selection.mainline_guard,/未绑定动作/);assert.equal(digest.narrative.events.length,2);assert.equal(db.rows("SELECT * FROM model_calls WHERE role IN ('daily_digest_selection','daily_digest')").length,2);assert.equal(db.rows("SELECT * FROM outbox WHERE event_type='daily_digest.completed'").length,0);assert.match(dailyDigestHtml(digest),/本日选题/);assert.match(dailyDigestHtml(digest),/有明确主体与动作/);
 }finally{db.close();}
});
test('an unsupported event number gets one metered card repair without changing archived material',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diting-editorial-repair-')),db=new Database(join(dir,'state.sqlite3'),ROOT),config=new Configuration(db,dir);let repairCalls=0;
 try{
  const date='2026-10-23',title='小米汽车公布交付计划',url='https://news.example.org/article/car',snapshot=uid('snap');db.run('INSERT INTO hotlist_snapshots VALUES(?,?,?,?,?,?,?,?)',snapshot,'dailyhot','board','succeeded',1,null,`${date}T10:00:00+08:00`,`${date}T10:00:00+08:00`);db.run('INSERT INTO hotlist_items VALUES(?,?,?,?,?,?,?,?,?,?)',uid('item'),snapshot,title,title,url,1,1,'1',encode({}),title);
  const base=new DailyDigest(db).generate(date,{notify:false}),topic=base.candidate_themes[0],article='小米汽车公布交付计划，说明首批车型的交付安排与查询渠道。公司表示将逐步公布具体交付时间，已下订用户可通过官方页面核对订单进度。';db.run('UPDATE daily_digests SET data_json=? WHERE id=?',encode({...base,source_pages:[{topic_id:topic.id,url,final_url:url,excerpt:article,status:'insufficient_body',fetched_at:`${date}T11:00:00+08:00`,method:'native_article_paragraphs'}]}),base.id);
  config.saveRoute({id:'keyword',provider:'test',base_url:'https://model.example/v1',model:'flash-test',enabled:true,protocol:'openai-completions',api_key:'test-secret',max_tokens:4096,rates:{input:0.8,cache:0.23,output:2.8}});
  const fetcher=(async(_url:any,init:any)=>{const input=JSON.parse(JSON.parse(init.body).messages[1].content);let output:Row;if(input.source){repairCalls++;output={topic_id:input.source.topic_id,headline:title,fact_summary:'小米汽车公布交付计划，说明首批车型的交付安排与查询渠道。',why_hot:'',impact_path:'',conclusion:'交付安排已公布，具体执行仍需继续核对。'};}else{const event=input.events[0];output={headline:'小米汽车公布交付计划',lead:'交付计划成为当日明确的产品进展。',overview:['小米汽车公布交付计划。'],events:[{topic_id:event.topic_id,headline:title,fact_summary:'小米汽车公布了999万辆的交付计划。',why_hot:'',impact_path:'',conclusion:'可核对官方安排。'}],trends:[],watch:[],editor_summary:['交付计划仍需观察执行。']};}return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:600,completion_tokens:120,prompt_tokens_details:{cached_tokens:0}}}),{status:200});}) as typeof fetch;
  const digest=await new DailyDigest(db,()=>new Date('2026-10-24T12:00:00+08:00'),config,fetcher).generateNarrated(date,{notify:false}) as Row;
  assert.equal(digest.narrative_status,'model');assert.equal(repairCalls,1,JSON.stringify({model:digest.model,event:digest.narrative.events[0],pages:digest.source_pages}));assert.match(digest.narrative.events[0].fact_summary,/首批车型/);assert.doesNotMatch(JSON.stringify(digest.narrative),/999/);assert.equal(digest.model.repair_calls[0].status,'accepted');assert.equal(db.rows("SELECT * FROM model_calls WHERE role='daily_digest_repair'").length,1);assert.equal(db.rows("SELECT * FROM acquisitions WHERE source='daily-digest:2026-10-23'").length,0);
 }finally{db.close();}
});
