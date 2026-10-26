import {JSDOM} from 'jsdom';
const norm=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const eventStopWords=['今天','昨日','今日','刚刚','正式','隆重','举行','发布','大会','召开','我国','国内','最新','消息','情况','事件','关注','报道','进行','在京'];
export const verificationText=/火山引擎正在进行安全检测|正在进行安全检测|访问安全检测|请完成安全验证|人机验证|验证码|verify you are human|checking your browser|captcha|cloudflare/i;
const boilerplate=/^(新浪首页|新闻中心|相关新闻|阅读排行榜|评论排行榜|返回顶部|点击加载更多|我要反馈|广告|登录|注册|收藏|分享|打印网页|下载客户端|关注我们|联系我们|版权声明|上一篇|下一篇)/i;
const titleTerms=(title:string)=>[...new Set((title.match(/[\u3400-\u9fff]{2,}/g)||[]).flatMap(part=>part.length>8?Array.from({length:part.length-1},(_,i)=>part.slice(i,i+3)): [part]).filter(x=>x.length>=2))].filter(x=>!eventStopWords.includes(x));
/** DOM based article extraction: remove page chrome, score text blocks, then retain readable paragraphs. */
export function extractArticleText(html:string,title=''){
 const dom=new JSDOM(html),doc=dom.window.document,body=doc.body;
 const blockedPage=verificationText.test((body?.textContent||'').slice(0,8000));
 const noise=/(^|[-_\s])(nav|menu|header|footer|sidebar|recommend|related|rank|hotlist|share|toolbar|breadcrumb|advert|captcha|verify|security|loading|comment|recommendation)([-_\s]|$)/i;
 for(const node of [...doc.querySelectorAll('script,style,noscript,svg,iframe,form,nav,header,footer,aside,button,input,select,textarea,[role="navigation"],[aria-label*="导航"],[class],[id]')]){
  const marker=`${node.getAttribute('class')||''} ${node.id||''} ${node.getAttribute('aria-label')||''}`;
  if(node.matches('script,style,noscript,svg,iframe,form,nav,header,footer,aside,button,input,select,textarea,[role="navigation"]')||noise.test(marker))node.remove();
 }
 const candidates=[...doc.querySelectorAll('article,main,[role="main"],section,div,body')];
 const score=(node:Element)=>{const ps=[...node.querySelectorAll('p')].map(p=>(p.textContent||'').replace(/\s+/g,' ').trim()).filter(p=>p.length>=28&&!boilerplate.test(p));const text=ps.join('\n');if(text.length<80)return -1;const links=[...node.querySelectorAll('a')].reduce((n,a)=>n+(a.textContent||'').trim().length,0),density=links/Math.max(1,(node.textContent||'').length),terms=titleTerms(title),hits=terms.filter(term=>text.includes(term)).length;return Math.min(text.length,12000)+Math.min(ps.length,12)*90+hits*180-density*5000+(node.matches('article,main,[role="main"]')?220:0);};
 const root=candidates.map(node=>({node,score:score(node)})).sort((a,b)=>b.score-a.score)[0]?.node||body;
 const paragraphs=[...root.querySelectorAll('p')].map(p=>(p.textContent||'').replace(/\s+/g,' ').trim()).filter(s=>s.length>=18&&!boilerplate.test(s));
 let article=paragraphs.join('\n');
 if(article.length<80){article=(root.textContent||'').split(/[。！？!?\n]+/).map(s=>s.trim()).filter(s=>s.length>=24&&!boilerplate.test(s)).join('\n');}
 const linkChars=[...root.querySelectorAll('a')].reduce((n,a)=>n+(a.textContent||'').trim().length,0),linkDensity=linkChars/Math.max(1,(root.textContent||'').length);
 const terms=titleTerms(title),hits=terms.filter(term=>norm(article).includes(norm(term))).length;
 dom.window.close();
 if(blockedPage&&article.length<120)throw new Error('来源返回安全检测或验证页，不是新闻正文');
 if(article.length<80)throw new Error('未提取到足够的新闻正文段落');
 if(linkDensity>=0.3)throw new Error('来源页面链接/导航文本占比过高，判定为页面壳');
 if(title&&norm(title).length>=10&&terms.length>=3&&hits===0)throw new Error('正文与议题标题关键词不匹配，判定为页面壳');
 return article.slice(0,3000);
}
