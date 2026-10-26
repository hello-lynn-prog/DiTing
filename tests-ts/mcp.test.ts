import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/app.js';
import { Mcp } from '../packages/domain/mcp.js';

test('MCP configuration encrypts credentials, restricts grants and preserves old credential references for frozen tasks',async()=>{
 const {app,config,db}=await createApp({dataDir:mkdtempSync(join(tmpdir(),'diting-mcp-'))},false);
 try{
  const entry={id:'local_search',name:'明确的本机配置测试',transport:'streamable-http',url:'http://127.0.0.1:3333/mcp',tools:[{name:'search',roles:['query']}],enabled:true};
  const put=(items:unknown[])=>app.inject({method:'PUT',url:'/api/config/extensions/mcp',payload:{items}});
  assert.equal((await put([{config:{...entry,tools:[]}}])).statusCode,400);
  assert.equal((await put([{config:{...entry,tools:[{name:'*',roles:['main']}]}}])).statusCode,400);
  assert.equal((await put([{config:{...entry,url:'https://example.com/mcp?key=not-allowed'}}])).statusCode,400);
  const response=await put([{config:entry,credentials:{headers:{Authorization:'Bearer explicit-fixture-credential'}}}]);assert.equal(response.statusCode,200);
  assert.ok(!response.body.includes('explicit-fixture-credential'));assert.equal(response.json().items[0].credentials_configured,true);assert.equal(response.json().records.length,0);
  const mcp=new Mcp(config),frozen=mcp.freeze()[0];assert.ok(frozen.key_ref);assert.ok(!JSON.stringify(config.get('mcp',[])).includes('explicit-fixture-credential'));
  assert.ok(!db.one('SELECT ciphertext FROM secrets WHERE id=?',frozen.key_ref)!.ciphertext.includes('explicit-fixture-credential'));
  await put([{config:{...entry,description:'只修改用途'}}]);assert.equal(mcp.freeze()[0].key_ref,frozen.key_ref,'blank credentials must preserve the configured secret');
  await put([{config:entry,credentials:{headers:{Authorization:'Bearer rotated-fixture'}}}]);assert.notEqual(mcp.freeze()[0].key_ref,frozen.key_ref);assert.ok(config.secret(frozen.key_ref!)!.includes('explicit-fixture-credential'),'active tasks must keep their frozen credential reference');
  const list=(await app.inject({url:'/api/config/extensions/mcp'})).body;assert.ok(!list.includes('rotated-fixture'));assert.ok(!list.includes('key_ref'));
 }finally{await app.close();}
});
