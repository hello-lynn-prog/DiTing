import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Database} from '../packages/domain/db.js';import {Service} from '../packages/domain/service.js';import {numericSupportHints} from '../packages/reporting/support-hints.js';import {reportNumberIssues} from '../packages/reporting/numeric-support.js';
test('explicit subsection cross references are structure, while the same decimal quantity still needs a source',()=>{
 assert.deepEqual(reportNumberIssues('多空观点详见4.2的对照表；行动建议参见6.3。','',[],7),[]);
 assert.ok(reportNumberIssues('增长率达到4.2%，具体预测详见4.2%的增长。','',[],7).length);
 assert.ok(reportNumberIssues('累计达到4.2万条。','',[],7).length);
});
test('number hints expose exact candidate subjects but do not certify a same-number entity swap',()=>{
 const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-number-hints-')),'db.sqlite3'),process.cwd()),service=new Service(db),task=service.createTask('调查原文数字',null),run=service.claim('fixture')!,eid=service.archive(task,'https://example.org/hints','原文','乙组共有7条记录。',run.lease_owner);try{service.addClaim(task,'乙组共有7条记录。',[{evidence_id:eid,quote:'乙组共有7条记录。'}],run.lease_owner);const hints=numericSupportHints(db,task,['7','999']);assert.equal(hints[0].candidates[0].claim_number,1);assert.ok(hints[0].candidates[0].text.includes('乙组'));assert.equal(hints[1].candidate_count,0);assert.ok(reportNumberIssues('甲组共有7条记录','乙组共有7条记录。',[],0).length);assert.deepEqual(reportNumberIssues('参见第4.3节以及第5.2小节。','',[],0),[]);assert.ok(reportNumberIssues('收益率4.3%','',[],0).length);}finally{db.close();}
});
