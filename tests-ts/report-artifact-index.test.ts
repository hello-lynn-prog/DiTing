import {test} from 'node:test';import assert from 'node:assert/strict';
import {compactArtifactIndex,summarizeArtifact} from '../packages/dsh-diting/artifact-window.js';
test('report artifact index retains every saved chapter and replaces only the same chapter revision',()=>{
 const record=(id:string,chapter:string,text:string,stamp:string)=>({id,kind:'report_stage',role:'report',created_at:stamp,data_json:JSON.stringify({stage:'chapter',data:{id:chapter,title:'章节'+chapter,text},input_version:{}})});
 const rows=[record('a','c1','首稿','2026-10-20T01:00:00Z'),record('b','c2','另一章','2026-10-20T02:00:00Z'),record('c','c1','修正后的章节','2026-10-20T03:00:00Z')];
 const index=compactArtifactIndex(rows);assert.deepEqual(index.rows.map(r=>r.id),['b','c']);assert.equal(index.counts.report_stage,3);
 assert.deepEqual(summarizeArtifact('report_stage','report',JSON.parse(rows[2].data_json)),{stage:'chapter',template_id:undefined,chapter_id:'c1',title:'章节c1',chars:6});
});
