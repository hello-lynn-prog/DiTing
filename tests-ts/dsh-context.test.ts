import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../apps/server/settings.js';
import { Database } from '../packages/domain/db.js';
import { Service } from '../packages/domain/service.js';
import { evidenceWindow } from '../packages/dsh-diting/evidence-window.js';
import { artifactWindow, compactArtifactIndex, summarizeArtifact } from '../packages/dsh-diting/artifact-window.js';
import { extractPageMetadata, normalizePublishedAt } from '../packages/collectors/page-metadata.js';
import { summarizeToolResult } from '../packages/dsh-diting/tool-audit.js';

test('task evidence index and bounded reader use the persisted source_url field',()=>{
  const dir=mkdtempSync(join(tmpdir(),'diting-evidence-reader-'));
  const db=new Database(join(dir,'diting.sqlite3'),ROOT),service=new Service(db);
  const taskId=service.createTask('测试任务',null),run=service.claim('test-worker')!;
  const content='完整原文内容'.repeat(1200),evidenceId=service.archive(taskId,'https://example.org/source','测试原文',content,'web_fetch',run.lease_owner,{published_at:'2026-10-18T08:30:00.000Z',author:'测试作者',publisher:'测试媒体',method:'publisher_page_metadata'});
  const index=db.rows('SELECT e.id,e.title,e.source_url AS url,e.captured_at,e.content FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? ORDER BY e.captured_at,e.id',taskId);
  assert.equal(index.length,1);
  assert.equal(index[0].id,evidenceId);
  assert.equal(index[0].url,'https://example.org/source');
  const metadata=db.one('SELECT published_at,author,publisher FROM evidence_metadata WHERE evidence_id=?',evidenceId)!;
  assert.equal(metadata.published_at,'2026-10-18T08:30:00.000Z');assert.equal(metadata.author,'测试作者');assert.equal(metadata.publisher,'测试媒体');
  const window=evidenceWindow(index[0].content,0,6000);
  assert.equal(window.content.length,6000);
  assert.equal(window.total_chars,content.length);
  assert.equal(window.has_more,true);
  assert.equal(window.next_offset,6000);
  db.close();
});

test('publisher metadata extracts article and public media declarations while keeping missing/invalid dates unknown',()=>{
  const html=`<meta content="2026-10-18T08:30:00+08:00" property="article:published_time"><meta name="author" content="林记者"><meta property="og:site_name" content="示例媒体"><meta property="og:image" content="https://cdn.example.org/story.jpg"><meta property="og:video" content="https://cdn.example.org/story.mp4"><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-17T10:00:00Z","author":{"name":"JSON 作者"}}</script>`;
  assert.deepEqual(extractPageMetadata(html),{published_at:'2026-10-18T00:30:00.000Z',author:'林记者',publisher:'示例媒体',media_assets:[{type:'image',url:'https://cdn.example.org/story.jpg',description:null,source:'og'},{type:'video',url:'https://cdn.example.org/story.mp4',description:null,source:'og'}],method:'publisher_page_metadata'});
  assert.equal(normalizePublishedAt('not a date'),null);
  assert.equal(extractPageMetadata('<html><body>无元数据</body></html>').published_at,null);
});

test('tool audit summaries persist progress counts without raw source text or credentials',()=>{
  const summary=summarizeToolResult({status:'succeeded',provider:'news-search',results:[{url:'https://example.org/?secret=do-not-log',content:'private raw article'}],api_key:'do-not-log',sources:[{provider:'bocha',count:3,error:null}]});
  assert.deepEqual(summary,{status:'succeeded',provider:'news-search',results_count:1,sources:[{provider:'bocha',count:3,failed:false}]});
  assert.equal(JSON.stringify(summary).includes('do-not-log'),false);
  assert.equal(JSON.stringify(summary).includes('private raw article'),false);
});

test('artifact context summarizes history and can read the full payload in bounded windows',()=>{
  const payload={claim_ids:['claim_1','claim_2'],gaps:['缺少独立来源'.repeat(30)]};
  const summary=summarizeArtifact('investigation','media',payload);
  assert.deepEqual(summary.claim_ids,['claim_1','claim_2']);
  assert.equal(summary.gaps[0].length,180);
  const forum=summarizeArtifact('forum','forum',{summary:'s'.repeat(500),disagreements:Array.from({length:8},()=> 'd'.repeat(220)),supplements:Array.from({length:8},()=> 'x'.repeat(220))});
  assert.equal(String(forum.summary).length,320);
  assert.equal((forum.disagreements as string[]).length,4);
  assert.equal((forum.disagreements as string[])[0].length,180);
  const full=JSON.stringify({rows:Array.from({length:500},(_,i)=>[`row-${i}`,i])});
  const first=artifactWindow(full,0,6000);
  assert.equal(first.content,full.slice(0,6000));
  assert.equal(first.has_more,true);
  assert.equal(first.next_offset,6000);
  assert.equal(artifactWindow(full,first.next_offset!,6000).offset,6000);
  const index=compactArtifactIndex([
    {id:'dataset_old',kind:'dataset',role:'statistics',created_at:'2026-01-01',data_json:'{"dimension":"topic"}'},
    {id:'dataset_new',kind:'dataset',role:'statistics',created_at:'2026-01-02',data_json:'{"dimension":"topic"}'},
    {id:'dataset_sentiment',kind:'dataset',role:'statistics',created_at:'2026-01-03',data_json:'{"dimension":"sentiment"}'},
  ]);
  assert.deepEqual(index.rows.map(row=>row.id),['dataset_new','dataset_sentiment']);
  assert.deepEqual(index.counts,{dataset:3});
});

test('report context retains every section and reflection round for complete investigator artifact reads',()=>{
  const reflection=(id:string,role:string,section:string,round:number)=>({id,role,kind:'investigation_reflection',created_at:'2026-10-20',data_json:JSON.stringify({section_id:section,round,cycle:0,findings:'完整调查发现'})});
  const index=compactArtifactIndex([reflection('a','insight','section-1',1),reflection('b','insight','section-1',2),reflection('c','insight','section-2',1),reflection('d','media','section-1',1)]);
  assert.deepEqual(index.rows.map(r=>r.id),['a','b','c','d']);assert.equal(summarizeArtifact('investigation_reflection','insight',JSON.parse(index.rows[2].data_json)).section_id,'section-2');
});
