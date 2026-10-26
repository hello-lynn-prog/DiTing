import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/app.js';
import { Skills } from '../packages/domain/skills.js';

test('skills require instruction bodies and role grants; task snapshots do not follow later edits',async()=>{
  const {app,config}=await createApp({dataDir:mkdtempSync(join(tmpdir(),'diting-skills-'))},false);
  try{
    const skills=new Skills(config),initial=skills.status();assert.equal(initial.items.length,10);assert.equal(initial.items.filter(s=>s.enabled).length,10);
    assert.equal(initial.calls.length,0);assert.equal(initial.mounted.length,0);
    const request=(items:unknown[])=>app.inject({method:'PUT',url:'/api/config/extensions/skills',payload:{items}});
    assert.equal((await request([{id:'no-body',name:'空技能',description:'测试',enabled:true,roles:['insight']}])).statusCode,400);
    assert.equal((await request([{id:'bad-role',name:'错误角色',description:'测试',enabled:true,content:'测试正文',roles:['administrator']}])).statusCode,400);
    assert.equal((await request([{id:'with-command',name:'执行脚本',description:'测试',enabled:true,content:'正文',roles:['insight'],command:'cmd.exe'}])).statusCode,400);
    const entry={id:'custom-evidence',name:'自定义证据规范',description:'仅调查员可读取',content:'只接受已归档证据，缺失不可编造。',roles:['insight'],enabled:true};
    assert.equal((await request([entry])).statusCode,200);
    const frozen=skills.freeze(),old=frozen.find(s=>s.id===entry.id)!;assert.ok(old.version);
    await request([{...entry,content:'变更后的技能正文。',roles:['query']}]);
    assert.equal(old.content,entry.content);assert.deepEqual(old.roles,['insight']);assert.notEqual(old.version,skills.freeze().find(s=>s.id===entry.id)!.version);
    const duplicated=await request([entry,entry]);assert.equal(duplicated.statusCode,400);
    const status=(await app.inject({url:'/api/config/extensions/skills'})).json();assert.equal(status.status,'dsh_native_skill_registry');assert.equal(status.mounted.length,0,'saving a config must not claim it was mounted');
    const unchanged=skills.freeze().find(s=>s.id==='evidence-link')!.version;
    await request(skills.items().map(s=>({...s,roles:[...s.roles].reverse()})));
    assert.equal(skills.freeze().find(s=>s.id==='evidence-link')!.version,unchanged,'schema property and role order cannot change a skill content version');
  }finally{await app.close();}
});
