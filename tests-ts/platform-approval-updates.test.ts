import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Database,encode,now} from '../packages/domain/db.js';import {Service} from '../packages/domain/service.js';import {ROOT} from '../apps/server/settings.js';
import {platformApprovalUpdates,assertApprovedPlatformWorkFinished} from '../packages/domain/platform-approval-updates.js';

test('approval updates expose the exact allowed retry to DiTing Prism without credentials and cannot omit unexecuted grants from review',()=>{
 const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-approval-updates-')),'db.sqlite3'),ROOT),s=new Service(db),id=s.createTask('平台审批回流',null),run=s.claim('test')!;
 try{
  const scope={platform:'weibo',query:'人工智能',access_mode:'saved_session',session_version:'session_fixture',max_posts:10,comments_per_post:3,max_requests:15,max_pages:1,comment_pages:1,include_long_text:true,cookie:'MUST_NOT_ENTER_CONTEXT',key_ref:'PRIVATE_REFERENCE'};
  const aid=s.requestCrawlApproval(id,'platform_keyword_crawl',scope,run.lease_owner);
  assert.equal(platformApprovalUpdates(db,id)[0].state,'pending');assert.doesNotThrow(()=>assertApprovedPlatformWorkFinished(db,id));
  db.run("UPDATE approvals SET status='approved' WHERE id=?",aid);
  const updates=platformApprovalUpdates(db,id),call=updates[0].crawl_deep!;assert.equal(updates[0].state,'approved_not_started');assert.equal(call.query,'人工智能');assert.equal(call.options.max_requests,15);assert.equal(call.options.session_version,'session_fixture');
  assert.ok(!JSON.stringify(updates).includes('MUST_NOT_ENTER_CONTEXT'));assert.ok(!JSON.stringify(updates).includes('PRIVATE_REFERENCE'));
  assert.throws(()=>assertApprovedPlatformWorkFinished(db,id),/尚未执行完/);
  db.run('INSERT INTO crawl_batches VALUES(?,?,?,?,?,?,?,NULL,?,?)','batch-fixture',id,aid,'weibo',encode(scope),'running',run.lease_owner,now(),now());assert.throws(()=>assertApprovedPlatformWorkFinished(db,id),/running/);
  db.run("UPDATE crawl_batches SET status='failed' WHERE id='batch-fixture'");assert.doesNotThrow(()=>assertApprovedPlatformWorkFinished(db,id),'a real failed attempt must not be forced to fabricate samples');
  const other=s.createTask('其他任务',null);assert.deepEqual(platformApprovalUpdates(db,other),[]);
 }finally{db.close();}
});
