/** Extract publisher-declared page metadata without treating it as independently verified fact. */
function attrs(tag: string): Record<string,string> {
  const result:Record<string,string>={};
  for(const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))result[String(match[1]).toLowerCase()]=decode(String(match[2]??match[3]??match[4]??''));
  return result;
}
function decode(value:string){return value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();}
function first(...values:unknown[]){return values.find(v=>typeof v==='string'&&v.trim()) as string|undefined;}
export function normalizePublishedAt(value:unknown):string|null { if(typeof value!=='string'||!value.trim())return null;const date=new Date(value);return Number.isNaN(date.getTime())?null:date.toISOString(); }
function authorName(value:unknown):string|null {if(typeof value==='string')return value.trim().slice(0,300)||null;if(value&&typeof value==='object')return first((value as any).name,(value as any).alternateName)?.slice(0,300)||null;return null;}
export function extractPageMetadata(html:string){
  const values=new Map<string,string>();
  for(const tag of html.matchAll(/<meta\b[^>]*>/gi)){const a=attrs(tag[0]),key=(a.property||a.name||a.itemprop||a['http-equiv']||'').toLowerCase(),value=a.content;if(key&&value&&!values.has(key))values.set(key,value);}
  let jsonDate:string|undefined,jsonAuthor:string|undefined,jsonPublisher:string|undefined;
  const scan=(node:any)=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){for(const item of node)scan(item);return;}const type=String(node['@type']||'');if(/Article|NewsArticle|BlogPosting|Report/i.test(type)){jsonDate ||= first(node.datePublished,node.dateCreated);jsonAuthor ||= authorName(node.author)||undefined;jsonPublisher ||= authorName(node.publisher)||undefined;}if(Array.isArray(node['@graph']))scan(node['@graph']);};
  for(const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{scan(JSON.parse(script[1]));}catch{/* malformed publisher JSON-LD is ignored */}}
  const published=normalizePublishedAt(first(values.get('article:published_time'),values.get('datepublished'),values.get('date'),values.get('pubdate'),values.get('parsely-pub-date'),values.get('dc.date'),values.get('og:published_time'),jsonDate));
  const media_assets:{type:'image'|'video';url:string;description:string|null;source:'og'|'twitter'}[]=[];
  const addMedia=(type:'image'|'video',raw:string|undefined,description:string|null,source:'og'|'twitter')=>{if(!raw)return;try{const url=new URL(decode(raw), 'https://metadata.invalid');if(!['http:','https:'].includes(url.protocol)||url.hostname==='metadata.invalid')return;if(!media_assets.some(m=>m.url===url.href))media_assets.push({type,url:url.href,description,source});}catch{/* Ignore malformed publisher metadata. */}};
  addMedia('image',values.get('og:image')||values.get('og:image:url')||values.get('twitter:image'),first(values.get('og:image:alt'),values.get('twitter:image:alt'))||null,values.has('twitter:image')?'twitter':'og');
  addMedia('video',values.get('og:video:secure_url')||values.get('og:video')||values.get('og:video:url')||values.get('twitter:player:stream'),first(values.get('og:video:tag'),values.get('og:title'))||null,values.has('twitter:player:stream')?'twitter':'og');
  return {published_at:published,author:first(values.get('author'),values.get('article:author'),values.get('parsely-author'),values.get('dc.creator'),jsonAuthor)?.slice(0,300)||null,publisher:first(values.get('og:site_name'),values.get('application-name'),jsonPublisher)?.slice(0,300)||null,media_assets:media_assets.slice(0,20),method:'publisher_page_metadata'};
}
