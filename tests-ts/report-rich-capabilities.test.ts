import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../apps/server/settings.js';
import { Database } from '../packages/domain/db.js';
import { Service } from '../packages/domain/service.js';
import { statistics } from '../packages/reporting/report.js';
import { renderReaderReport } from '../packages/reporting/reader.js';

test('sample clustering, document-frequency word cloud, source-linked SWOT/PEST and media links render in reader output',()=>{
  const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-rich-report-')),'db.sqlite3'),ROOT),service=new Service(db),task=service.createTask('研究人工智能模型应用样例',null);
  const run=service.claim('rich-report-test')!;
  const first=service.archive(task,'https://example.org/one','人工智能模型应用一','人工智能模型正在进入产业应用，企业开始评估人工智能模型的部署、安全和治理。', 'web_fetch',run.lease_owner);
  const second=service.archive(task,'https://example.net/two','人工智能模型应用二','人工智能模型应用推动产业升级，但企业必须检查人工智能模型治理、部署安全和数据风险。', 'web_fetch',run.lease_owner);
  const claimId=service.addClaim(task,'两份归档材料都提到人工智能模型部署与治理。',[{evidence_id:first,quote:'企业开始评估人工智能模型的部署、安全和治理'}],run.lease_owner);
  const computed=statistics(db,task),cluster=computed.datasets.find(d=>d.dimension==='cluster')!,wordcloud=computed.datasets.find(d=>d.dimension==='wordcloud')!;
  assert.ok(cluster.rows.some(r=>r[1]===2),'similar source texts are grouped into a deterministic cluster');
  assert.ok(wordcloud.rows.some(r=>r[0].includes('人工智能')),'frequent Chinese n-grams derive from archived pages');
  const evidence=db.rows('SELECT * FROM evidence WHERE id IN (?,?) ORDER BY id',first,second);
  evidence[0].media_assets=[{type:'video',url:'https://cdn.example.org/clip.mp4',description:'发布页面声明的视频'}];
  const claim={id:claimId,text:'两份归档材料都提到人工智能模型部署与治理。',references_json:JSON.stringify([{evidence_id:first,quote:'企业开始评估人工智能模型的部署、安全和治理'}])};
  const rendered=renderReaderReport({title:'人工智能模型应用研究',sections:[{title:'样本分析',text:'### 归档样本共同出现的议题\n\n这些材料共同讨论模型治理。',claim_ids:[claimId]}],tables:computed.datasets,frameworks:{swot:{strengths:[{text:'现有来源均讨论模型部署与治理能力。',claim_ids:[claimId]}],weaknesses:[],opportunities:[],threats:[]},pest:{political:[],economic:[],social:[],technological:[{text:'材料显示模型应用正进入产业场景。',claim_ids:[claimId]}]}}},evidence,[claim]);
  assert.match(rendered.html,/SWOT 分析/);assert.match(rendered.html,/PEST 外部环境分析/);assert.match(rendered.html,/样本文本相似聚类/);assert.match(rendered.html,/原文高频词组/);assert.match(rendered.html,/打开媒体文件/);assert.match(rendered.markdown,/SWOT 分析/);assert.match(rendered.markdown,/打开媒体文件/);db.close();
});
