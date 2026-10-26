import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,encode} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {attachPublicLibrary} from '../packages/dsh-diting/public-library.js';

test('public archive reuse requires the task instruction and never imports user-provided evidence',()=>{
  const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-library-')),'db.sqlite3'),process.cwd()),service=new Service(db);try{
    const old=service.createTask('旧研究中的合成测试',null);const publicId=service.archive(old,'https://example.org/public','AI合成材料','这是一份用于测试AI语料复用的公开采集夹具。','web_fetch');const privateId=service.archive(old,'https://example.org/private','AI私人导入','这是一份用于测试AI语料隔离的用户导入夹具。','user_import');service.action(old,'cancel',service.task(old).revision);
    const task=service.createTask('研究AI测试',null),run=service.claim('fixture')!;assert.deepEqual(attachPublicLibrary(service,task,['AI'],run.lease_owner),[]);
    const config=JSON.parse(service.rawTask(task).config_json);config.reuse_public_library=true;db.run('UPDATE tasks SET config_json=? WHERE id=?',encode(config),task);
    const attached=attachPublicLibrary(service,task,['AI'],run.lease_owner);assert.equal(attached.length,1);assert.equal(attached[0].id,publicId);assert.equal(db.one('SELECT COUNT(*) n FROM task_evidence WHERE task_id=? AND evidence_id=?',task,privateId)!.n,0);
    assert.equal(attachPublicLibrary(service,task,['AI'],run.lease_owner).length,0);
  }finally{db.close();}
});

test('legacy raw-response hashes normalize into the actual returned evidence ID, preserving original snapshot time',()=>{
  const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-library-legacy-')),'db.sqlite3'),process.cwd()),service=new Service(db);try{
    const old=service.createTask('旧快照夹具',null),id=service.archive(old,'https://example.org/legacy','AI旧快照','AI测试原文，仅用于验证哈希口径兼容。','web_fetch'),at=service.db.one('SELECT captured_at FROM evidence WHERE id=?',id)!.captured_at;
    db.run('UPDATE evidence SET content_hash=? WHERE id=?','legacy-raw-hash-fixture',id);service.action(old,'cancel',service.task(old).revision);
    const task=service.createTask('研究AI并允许复用公开原文',null),run=service.claim('fixture')!,rows=attachPublicLibrary(service,task,['AI'],run.lease_owner);
    assert.equal(rows.length,1);assert.notEqual(rows[0].id,id);assert.equal(rows[0].source_snapshot_id,id);assert.ok(db.one('SELECT 1 FROM task_evidence WHERE task_id=? AND evidence_id=?',task,rows[0].id));assert.equal(db.one('SELECT captured_at FROM evidence WHERE id=?',rows[0].id)!.captured_at,at);assert.equal(attachPublicLibrary(service,task,['AI'],run.lease_owner).length,0);
  }finally{db.close();}
});
