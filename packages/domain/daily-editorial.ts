import {hash,type Row} from './db.js';

const generic=new Set(['AI','人工','智能','人工智能','科技','热点','新闻','今日','昨日','今天','最新','有关','相关','回应','消息','事件','关注','行业','企业','市场','中国','美国','宣布','表示','专家','公司','持续','发生','全球','发展','问题','大会','举行','正式','发布','网友','视频','热议','汽车','手机','产能','融资','财经','经济','政策','官方','平台','数据','用户','国际','调查','风险','活动','2026']);
export const dailyHeadline=(title:string)=>title.replace(/^(?:财联社|金十数据|界面新闻)\s*\d{1,2}月\d{1,2}日?(?:电|讯)[，,:：\s]*/,'').split(/[。！？\n]/,1)[0].slice(0,100).trim();
const titleHead=dailyHeadline;
const segmenter=new Intl.Segmenter('zh',{granularity:'word'}),wordCache=new Map<string,string[]>();
const words=(title:string)=>{const head=titleHead(title);const prior=wordCache.get(head);if(prior)return prior;const result=[...segmenter.segment(head.normalize('NFKC'))]
 .filter(piece=>piece.isWordLike).map(piece=>piece.segment.trim()).filter(word=>word.length>=2&&!generic.has(word)&&!/^[\d.]+$/.test(word));if(wordCache.size>50000)wordCache.clear();wordCache.set(head,result);return result;};
const shared=(a:string,b:string)=>{const right=new Set(words(b));return words(a).filter(word=>right.has(word));};

/** Event identity is supplied by the stricter caller. This relation groups distinct events only when they share a specific subject. */
export function relatedDailyTheme(a:string,b:string){
 const overlap=shared(a,b);
 const left=titleHead(a).replace(/^[【\[#]+/,'').replace(/^(?:最新|快讯|突发)[：:]?/,'').trim(),right=titleHead(b).replace(/^[【\[#]+/,'').replace(/^(?:最新|快讯|突发)[：:]?/,'').trim();
 const sameLead=[...left].slice(0,6).map((_,i)=>left.slice(0,i+1)).filter(prefix=>prefix.length>=4&&right.startsWith(prefix)).at(-1);
 return Boolean(sameLead)||overlap.some(word=>word.length>=3)||new Set(overlap).size>=2;
}

export function dailyAnchorGrade(title:string,excerpt:unknown){
 const body=typeof excerpt==='string'?excerpt.trim():'';
 const distinct=[...new Set(body.split(/[。！？；\n]+/).map(part=>part.trim()).filter(Boolean))].join('。');
 const shell=/安全检测|访问验证|请完成验证|验证码|正在检查您的浏览器|开启 javascript|点击加载更多|阅读排行榜|评论排行榜/i.test(body);
 const concrete=/[\u3400-\u9fffA-Za-z]{2,}(?:表示|称|发布|公布|宣布|决定|完成|启动|回应|通报|批准|下调|上调|增长|下降|签署|收购|融资|被查|举行|交付|发生|推出|开放|破获|起诉|判处|录得|达到|超过|投入|暂停|恢复|讨论|记录|介绍|说明)/.test(distinct);
 const compact=(value:string)=>value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'');
 const titleText=compact(titleHead(title)),bodyText=compact(distinct);
 if(distinct.length>=50&&!shell&&concrete&&(new Set(shared(title,distinct)).size>=1||titleText.length>=6&&bodyText.includes(titleText)))return 'A' as const;
 if(/[\u3400-\u9fffA-Za-z]{2,}.{0,28}(?:发布|公布|宣布|回应|通报|批准|下调|上调|增长|下降|签署|收购|融资|被查|举行|交付|发生|推出|开放|破获|起诉|判处|达到|超过|暂停|恢复)/.test(title))return 'B' as const;
 return 'C' as const;
}

export function buildDailyThemes(events:Row[],yesterday:Row[],sameEvent:(a:string,b:string)=>boolean){
 const themes:Row[]=[],themeIndex=new Map<string,Set<Row>>(),priorIndex=new Map<string,Set<Row>>();
 const index=(map:Map<string,Set<Row>>,key:string,row:Row)=>{let set=map.get(key);if(!set){set=new Set<Row>();map.set(key,set);}set.add(row);};
 const relevant=(title:string)=>[...new Set(words(title))];
 const uniquePrior=new Map<string,Row>();for(const row of yesterday)if(typeof row.title==='string')uniquePrior.set(row.title,row);
 for(const row of uniquePrior.values()){for(const word of relevant(row.title))index(priorIndex,word,row);const prefix=titleHead(row.title).slice(0,4);if(prefix.length===4&&!generic.has(prefix))index(priorIndex,`prefix:${prefix}`,row);}
 for(const event of events){
  const title=String(event.title||''),tokens=relevant(title),near=new Set<Row>();for(const word of tokens)for(const candidate of themeIndex.get(`${event.category}:${word}`)||[])near.add(candidate);
  // The first specific four-character run catches two headlines with the
  // same subject even when the segmenter splits a short brand name.
  const prefix=titleHead(title).slice(0,4);if(prefix.length===4&&!generic.has(prefix))for(const candidate of themeIndex.get(`${event.category}:prefix:${prefix}`)||[])near.add(candidate);
  let theme=[...near].find(t=>t.members.some((member:Row)=>relatedDailyTheme(member.title,title)));
  if(!theme){theme={id:'theme_'+hash(String(event.id||title)).slice(0,20),title:titleHead(title),members:[],sources:new Set<string>(),source_urls:new Set<string>(),best_rank:Number(event.best_rank)||999,category:event.category||'综合观察'};themes.push(theme);}
  theme.members.push(event);for(const source of event.sources||[])theme.sources.add(source);for(const url of event.source_urls||[])theme.source_urls.add(url);theme.best_rank=Math.min(theme.best_rank,Number(event.best_rank)||999);
  for(const word of tokens)index(themeIndex,`${event.category}:${word}`,theme);
  if(prefix.length===4&&!generic.has(prefix))index(themeIndex,`${event.category}:prefix:${prefix}`,theme);
 }
 return themes.map(theme=>{
  const pairs:Row[]=[];
  for(const member of theme.members){const near=new Set<Row>();for(const word of relevant(String(member.title)))for(const prior of priorIndex.get(word)||[])near.add(prior);const prefix=titleHead(String(member.title)).slice(0,4);if(prefix.length===4&&!generic.has(prefix))for(const prior of priorIndex.get(`prefix:${prefix}`)||[])near.add(prior);for(const prior of near){const priorTitle=String(prior.title||''),identical=sameEvent(String(member.title),priorTitle);if(identical||relatedDailyTheme(String(member.title),priorTitle))pairs.push({today_title:member.title,yesterday_title:priorTitle,match:identical?'same_event':'same_theme'});}}
  const exactYesterday=new Set(pairs.filter(p=>p.match==='same_event').map(p=>p.today_title));
  // A changed phrase alone does not establish progress. Demand a new explicit
  // action or number in a current member before using "今日进展".
  const actions=(title:string)=>[...(title.match(/公布|宣布|回应|通报|批准|下调|上调|增长|下降|签署|收购|融资|被查|交付|推出|开放|破获|起诉|判处|达到|超过|暂停|恢复|召开|举行/g)||[]),...(title.match(/\d+(?:\.\d+)?/g)||[])];
  const newFact=theme.members.find((member:Row)=>!exactYesterday.has(member.title)&&dailyAnchorGrade(String(member.title),'')==='B'&&actions(String(member.title)).some(action=>!pairs.some(p=>p.today_title===member.title&&String(p.yesterday_title).includes(action))));
  const sources=[...theme.sources],source_urls=[...theme.source_urls];
  return{id:theme.id,title:theme.title,members:theme.members.map((m:Row)=>({id:m.id,title:m.title,title_variants:m.title_variants||[],sources:m.sources||[],source_urls:m.source_urls||[],best_rank:m.best_rank,url:m.url})),sources,source_count:sources.length,source_urls,url:source_urls[0]||null,best_rank:theme.best_rank,category:theme.category,continuation_pairs:pairs.slice(0,20),continuation:pairs.length?(newFact?'今日进展':'持续上榜'):'今日新见',new_fact_title:newFact?.title||null};
 }).sort((a,b)=>b.source_count-a.source_count||a.best_rank-b.best_rank);
}

export function shortlistDailyThemes(themes:Row[],limit=40):Row[]{
 const score=(t:Row)=>Number(t.source_count||0)*100+100/Math.max(1,Number(t.best_rank||100));
 const continued=themes.filter(t=>t.continuation_pairs?.length);
 const ranked=themes.slice().sort((a,b)=>score(b)-score(a));
 const selected:Row[]=[],seen=new Set<string>(),categories=new Set<string>();
 const add=(t:Row)=>{if(selected.length<limit&&!seen.has(t.id)){selected.push(t);seen.add(t.id);categories.add(t.category);}};
 for(const t of continued.slice(0,Math.min(10,limit)))add(t);
 for(const t of ranked)if(!categories.has(t.category))add(t);
 for(const t of ranked.slice(0,30))add(t);
 for(const t of ranked)add(t);
 return selected.map(t=>({...t,selection_score:score(t)}));
}
