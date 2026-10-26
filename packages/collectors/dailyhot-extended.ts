/** Source-specific endpoint/field mappings audited against local DailyHotApi routes.
 * RSS here is an upstream collection protocol, not a report-subscription UI feature. */
import type {Item,Source} from './hotlists.js';
import type {Row} from '../domain/db.js';
type Factory=(id:unknown,title:unknown,url:unknown,heat:unknown,raw:Row)=>Item;
const clean=(s:unknown)=>String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").trim();
function rows(value:unknown,name:string):Row[]{if(!Array.isArray(value))throw Error(name+' 未返回预期列表，保留失败状态');return value;}
const count=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:typeof v==='string'&&/^\d+$/.test(v)?Number(v):null;
export function dailyHotExtendedSources(item:Factory):Source[]{
  const json=(id:string,title:string,url:string,metric:string,parse:(data:Row)=>Item[]):Source=>({id,title,url,provider:'dailyhot',kind:'content_rank',metric,parse:text=>parse(JSON.parse(text))});
  const rss=(id:string,title:string,url:string):Source=>({id,title,url,provider:'dailyhot',kind:'content_rank',metric:'RSS 最新/热门条目，未提供可比热度',parse:text=>{if(!/<rss\b|<rdf:RDF\b/i.test(text))throw Error(title+' 未返回 RSS，可能为验证页面');return [...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0,100).map((m,i)=>{const field=(name:string)=>clean(m[1].match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'))?.[1]),link=field('link');return item(field('guid')||link||i,field('title'),link,null,{guid:field('guid'),published_at:field('pubDate'),description:field('description')});});}});
  return [
    json('juejin','稀土掘金文章榜','https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot','hot_rank 排序值仅保留原始字段，不作为可比热度',d=>rows(d.data,'掘金').map(v=>item(v.content?.content_id,v.content?.title,'https://juejin.cn/post/'+v.content?.content_id,null,v))),
    json('huxiu','虎嗅24小时','https://moment-api.huxiu.com/web-v3/moment/feed?platform=www','点赞数（非全网声量）',d=>rows(d.data?.moment_list?.datalist,'虎嗅').map(v=>item(v.object_id,clean(v.content).split('\n')[0],'https://www.huxiu.com/moment/'+v.object_id+'.html',count(v.count_info?.agree_num),v))),
    json('ifanr','爱范儿快讯','https://sso.ifanr.com/api/v5/wp/buzz/?limit=20&offset=0','点赞数（不混用评论数）',d=>rows(d.objects,'爱范儿').map(v=>item(v.id,v.post_title,v.buzz_original_url||'https://www.ifanr.com/'+v.post_id,count(v.like_count),v))),
    json('geekpark','极客公园文章','https://mainssl.geekpark.net/api/v2','阅读数（平台指标）',d=>rows(d.homepage_posts,'极客公园').map(v=>{const p=v.post;return item(p?.id,p?.title,'https://www.geekpark.net/news/'+p?.id,count(p?.views),v);})),
    json('csdn','CSDN文章热榜','https://blog.csdn.net/phoenix/web/blog/hot-rank?page=0&pageSize=30','平台 hotRankScore 原始分值',d=>rows(d.data,'CSDN').map(v=>item(v.productId,v.articleTitle,v.articleDetailUrl,count(v.hotRankScore),v))),
    json('newsmth','水木社区全站热帖','https://wap.newsmth.net/wap/api/hot/global','未提供热度',d=>rows(d.data?.topics,'水木社区').map(v=>item(v.firstArticleId,v.article?.subject,'https://wap.newsmth.net/article/'+v.article?.topicId,null,v))),
    json('smzdm','什么值得买文章排行','https://post.smzdm.com/rank/json_more/?unit=1','收藏数（平台指标）',d=>rows(d.data,'什么值得买').map(v=>item(v.article_id,v.title,v.jump_link,count(v.collection_count),v))),
    json('yystv','游研社文章','https://www.yystv.cn/home/get_home_docs_by_page','未提供热度',d=>rows(d.data,'游研社').map(v=>item(v.id,v.title,'https://www.yystv.cn/p/'+v.id,null,v))),
    rss('linuxdo','Linux.do周榜','https://linux.do/top.rss?period=weekly'),
    rss('nytimes','纽约时报世界新闻','https://rss.nytimes.com/services/xml/rss/nyt/World.xml'),
    rss('52pojie','吾爱破解热门主题','https://www.52pojie.cn/forum.php?mod=guide&view=hot&rss=1'),
    rss('hostloc','全球主机交流热门主题','https://hostloc.com/forum.php?mod=guide&view=hot&rss=1'),
  ];
}
