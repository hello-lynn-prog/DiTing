import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]] as const) blocked.addSubnet(address, prefix, 'ipv6');

export async function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅接受不含凭据的 HTTP/HTTPS 原文链接');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  // Node BlockList normalizes IPv4 to mapped IPv6; adding ::ffff/96 would block every public IPv4 too.
  if (!addresses.length || addresses.some(a => (a.family === 6 && /^::ffff:/i.test(a.address)) || blocked.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))) throw new Error('原文抓取不访问本机、私有或保留网络');
  return { url, addresses };
}
export type TextRequestInit={method?:'GET'|'POST';headers?:Record<string,string>;body?:string;allowedOrigins?:readonly string[];beforeRequest?:(url:string)=>void;proxyUrl?:string};
export async function fetchText(url: string, signal?: AbortSignal, publicOnly = true, init?: TextRequestInit): Promise<{ text: string; url: string; headers?: IncomingMessage['headers'] }> {
  let proxyEnv:Record<string,string>|undefined;
  if(init?.proxyUrl){
    const proxy=new URL(init.proxyUrl);
    if(proxy.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(proxy.hostname)||!proxy.port||proxy.username||proxy.password||proxy.pathname!=='/'||proxy.search||proxy.hash)
      throw new Error('榜单备用代理仅允许无凭据的本机 HTTP 代理');
    proxyEnv={HTTP_PROXY:proxy.href,HTTPS_PROXY:proxy.href};
  }
  let current = url;
  let method=init?.method||'GET',body=init?.body,headers={...(init?.headers||{})};
  for (let i = 0; i < 5; i++) {
    if(init?.allowedOrigins&&!init.allowedOrigins.includes(new URL(current).origin))throw Error('来源重定向超出批准域名，未继续请求');
    init?.beforeRequest?.(current);
    const resolved = publicOnly ? await assertPublicUrl(current) : null;
    const timeout = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
    // Pin the validated DNS answer to the connection, closing a rebinding gap between validation and fetch.
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const secure=current.startsWith('https:');
      const request = (secure ? httpsRequest : httpRequest)(current, { signal: timeout, method,
        headers: { 'User-Agent': 'Mozilla/5.0 DiTing/0.3', Accept: 'application/json,text/html;q=0.9', ...headers },
        ...(proxyEnv?{agent:secure?new HttpsAgent({proxyEnv}):new HttpAgent({proxyEnv})}:{}),
        ...(resolved ? { lookup: ((_hostname: string, options: any, callback: any) => { const chosen = resolved.addresses.find(a => a.family === 4) || resolved.addresses[0]; options?.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family); }) as any } : {}) }, resolve);
      request.on('error', reject); request.end(body);
    });
    const status = response.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location; response.destroy(); if (!location) throw new Error('重定向没有目标地址'); const next=new URL(location,current);
      if(next.origin!==new URL(current).origin){
        // A new origin never inherits request credentials or a potentially sensitive POST body.
        headers=Object.fromEntries(Object.entries(headers).filter(([k])=>/^(accept|accept-language|user-agent)$/i.test(k)));
        if(body)throw Error('携带请求体的请求不跨域重定向');
      }
      if(status===303||([301,302].includes(status)&&method==='POST')){method='GET';body=undefined;headers=Object.fromEntries(Object.entries(headers).filter(([k])=>!/^content-/i.test(k)));}
      current=next.href;continue;
    }
    if (status < 200 || status >= 300) { response.destroy(); throw new Error(`来源 HTTP ${status}`); }
    const type = response.headers['content-type'] || '';
    if (type && !/text\/|application\/(json|xhtml|xml|[\w.+-]+\+xml|(?:x-)?javascript)/i.test(type)) { response.destroy(); throw new Error('该内容类型需要专用解析器，未当作网页原文归档'); }
    const chunks: Uint8Array[] = []; let size = 0;
    try { for await (const chunk of response) { size += chunk.length; if (size > 4_000_000) throw new Error('来源响应超过 4MB 上限'); chunks.push(chunk); } }
    finally { response.destroy(); }
    const buffer=Buffer.concat(chunks),declared=type.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]||buffer.subarray(0,200).toString('ascii').match(/encoding\s*=\s*["']([\w-]+)/i)?.[1]||'utf-8';
    const encoding=/^(gbk|gb2312|gb18030)$/i.test(declared)?'gb18030':'utf-8';
    return { text: new TextDecoder(encoding).decode(buffer), url: current, headers: response.headers };
  } throw new Error('来源重定向次数过多');
}
export function plainText(html: string) {
  return html.replace(/<(script|style|nav|footer)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

/** Binary-only archival uses the same DNS pinning and redirect checks as page collection. */
export async function fetchMediaBinary(url:string,signal:AbortSignal,maxBytes=25_000_000):Promise<{bytes:Buffer;url:string;mediaType:string}>{
  let current=url;
  for(let i=0;i<5;i++){
    signal.throwIfAborted();const resolved=await assertPublicUrl(current);
    const response=await new Promise<IncomingMessage>((resolve,reject)=>{const req=(resolved.url.protocol==='https:'?httpsRequest:httpRequest)(resolved.url,{signal:AbortSignal.any([signal,AbortSignal.timeout(45000)]),headers:{'User-Agent':'Mozilla/5.0 DiTing/0.3',Accept:'image/png,image/jpeg,video/mp4,video/webm'},lookup:((_h:string,o:any,cb:any)=>{const a=resolved.addresses.find(x=>x.family===4)||resolved.addresses[0];o?.all?cb(null,[a]):cb(null,a.address,a.family);}) as any},resolve);req.on('error',reject);req.end();});
    const status=response.statusCode||0;
    if([301,302,303,307,308].includes(status)){const location=response.headers.location;response.destroy();if(!location)throw Error('素材重定向缺少地址');current=new URL(location,current).href;continue;}
    if(status<200||status>=300){response.destroy();throw Error('素材 HTTP '+status);}
    const mediaType=String(response.headers['content-type']||'').split(';')[0].trim().toLowerCase();
    if(!['image/png','image/jpeg','video/mp4','video/webm'].includes(mediaType)){response.destroy();throw Error('仅归档 PNG/JPEG/MP4/WebM 视觉素材');}
    if(Number(response.headers['content-length'])>maxBytes){response.destroy();throw Error('素材超过归档大小上限');}
    const chunks:Buffer[]=[];let size=0;try{for await(const chunk of response){size+=chunk.length;if(size>maxBytes)throw Error('素材超过归档大小上限');chunks.push(Buffer.from(chunk));}}finally{response.destroy();}
    const bytes=Buffer.concat(chunks),valid=mediaType==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mediaType==='image/jpeg'?bytes[0]===255&&bytes[1]===216:mediaType==='video/mp4'?bytes.subarray(4,8).toString()==='ftyp':bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]));
    if(!valid)throw Error('素材文件签名与声明类型不符');return {bytes,url:current,mediaType};
  }throw Error('素材重定向次数超限');
}
