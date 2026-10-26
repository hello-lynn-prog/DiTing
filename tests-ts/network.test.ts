import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl,fetchText } from '../packages/collectors/network.js';
import {createServer,type Server} from 'node:http';
test('public IPv4 is allowed while mapped, loopback, private and credential-bearing URLs are denied', async () => {
  assert.equal((await assertPublicUrl('https://8.8.8.8/')).addresses[0].address, '8.8.8.8');
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'https://user:password@8.8.8.8/']) await assert.rejects(assertPublicUrl(url));
});

test('hotlist proxy accepts only an uncredentialed local HTTP endpoint',async()=>{
 for(const proxyUrl of ['http://proxy.example.com:7897','https://127.0.0.1:7897','http://user:pass@127.0.0.1:7897'])
  await assert.rejects(fetchText('https://8.8.8.8/',undefined,true,{proxyUrl}),/本机 HTTP 代理/);
});

test('redirects never forward credentials or POST bodies to another origin, and endpoint restrictions run before connection',async()=>{
  const received:any[]=[];
  const target=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({headers:req.headers,method:req.method,body,url:req.url});res.setHeader('Content-Type','application/json');res.end('{"ok":true}');});
  await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const destination=`http://127.0.0.1:${(target.address() as any).port}`;
  const local:any[]=[];
  const source=createServer((req,res)=>{local.push(req.url);if(req.url==='/same'){res.writeHead(303,{Location:'/target'});res.end();}else if(req.url==='/restricted'){res.writeHead(302,{Location:'/forbidden'});res.end();}else if(req.url==='/target'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({method:req.method,content_type:req.headers['content-type']||null}));}else{res.writeHead(307,{Location:destination+'/target'});res.end();}});
  await new Promise<void>(resolve=>source.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(source.address() as any).port}`;
  const stop=(server:Server)=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
  try{
    await fetchText(origin+'/redirect',undefined,false,{headers:{Cookie:'fixture=not-real',Authorization:'Bearer fixture-only','X-Api-Key':'fixture-only',Referer:'https://example.com/private'}});
    assert.equal(received.length,1);for(const key of ['cookie','authorization','x-api-key','referer'])assert.equal(received[0].headers[key],undefined);
    await assert.rejects(fetchText(origin+'/redirect',undefined,false,{headers:{Cookie:'fixture=not-real'},allowedOrigins:[origin]}),/超出批准域名/);assert.equal(received.length,1);
    await assert.rejects(fetchText(origin+'/redirect',undefined,false,{method:'POST',body:'explicit fixture body'}),/请求体/);assert.equal(received.length,1);
    await assert.rejects(fetchText(origin+'/restricted',undefined,false,{beforeRequest:url=>{if(new URL(url).pathname==='/forbidden')throw Error('not an allowed endpoint');}}),/not an allowed endpoint/);assert.ok(!local.includes('/forbidden'));
    const same=await fetchText(origin+'/same',undefined,false,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.deepEqual(JSON.parse(same.text),{method:'GET',content_type:null});
  }finally{await stop(source);await stop(target);}
});
