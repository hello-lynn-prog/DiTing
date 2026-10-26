import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {readSoakStatus,saveSoakStatus,type SoakStatus} from '../packages/domain/soak-status.js';
test('soak status exposes a dead/stale observer, merges legacy heartbeat and synchronizes final pointer',()=>{
 const folder=mkdtempSync(join(tmpdir(),'diting-soak-')),pointer=join(folder,'latest.json'),stamp='2026-10-20T00:00:00Z';
 assert.equal(readSoakStatus(pointer).status,'not_started');
 const status:SoakStatus={folder,pid:123,started_at:stamp,finished_at:null,duration_hours:24,status:'running',checks:0,failures:0,last_check_at:null,production_certified:false};
 saveSoakStatus(pointer,status);writeFileSync(join(folder,'summary.json'),JSON.stringify({...status,checks:134,failures:2,last_check_at:stamp}));
 const interrupted=readSoakStatus(pointer,Date.parse(stamp)+1000,()=>false);assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.checks,134);assert.equal(interrupted.failures,2);
 assert.equal(readSoakStatus(pointer,Date.parse(stamp)+181000,()=>true).status,'stale');assert.equal(readSoakStatus(pointer,Date.parse(stamp)+1000,()=>true).status,'running');
 saveSoakStatus(pointer,{...status,status:'completed_with_failures',checks:1441,failures:2,finished_at:'2026-10-21T00:00:00Z'});
 assert.deepEqual(JSON.parse(readFileSync(pointer,'utf8')),JSON.parse(readFileSync(join(folder,'summary.json'),'utf8')));assert.equal(readSoakStatus(pointer,Date.now(),()=>false).status,'completed_with_failures');
 assert.equal(readSoakStatus(pointer).production_certified,false);writeFileSync(pointer,'broken');assert.equal(readSoakStatus(pointer).status,'invalid');
});
