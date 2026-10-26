import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,encode} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {verificationPacket} from '../packages/dsh-diting/verification-packet.js';

test('verification packet includes every complete claim quote and exact neighbouring source once, not only previews',()=>{
 const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-verification-packet-')),'db.sqlite3'),process.cwd()),service=new Service(db),task=service.createTask('调查核验材料包',null),run=service.claim('fixture')!,quote='这是原文中的可核验完整陈述。',content='前文'.repeat(2000)+quote+'后文'.repeat(2000),eid=service.archive(task,'https://example.org/verification','归档原文',content,run.lease_owner);
 try{for(const text of ['原文确有这一陈述。','该判断的原文依据可回溯。'])service.addClaim(task,text,[{evidence_id:eid,quote}],run.lease_owner);const packet=verificationPacket(db,task);assert.equal(packet.claim_count,2);assert.equal(packet.reference_count,2);assert.equal(packet.source_count,1);assert.equal(packet.source_windows.length,1);const window=packet.source_windows[0];assert.equal(window.quote,quote);assert.equal(window.quote_offset,4000);assert.equal(window.content,content.slice(window.offset,window.end_offset));assert.ok(window.content.length<=quote.length+480);assert.equal(packet.claims[0].references[0].window_id,window.id);
 const other=service.createTask('另一任务不包含这些引文',null);assert.equal(verificationPacket(db,other).reference_count,0);
 db.run('UPDATE claims SET references_json=? WHERE task_id=?',encode([{evidence_id:eid,quote:'归档原文里没有这句话。'}]),task);assert.throws(()=>verificationPacket(db,task),/不在归档原文/);
 }finally{db.close();}
});
