import { mkdirSync, writeFileSync, existsSync,readFileSync } from 'node:fs';
import { join, resolve,dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Database, type Row, uid, encode, now, hash } from '../domain/db.js';
import { createHash } from 'node:crypto';
import { renderReaderReport } from './reader.js';
import {validateVisualReference} from '../domain/visual-evidence.js';
import {reportNumberIssues} from './numeric-support.js';
import {meaningfulWordCloudTerms} from './wordcloud.js';
import {programAppendix} from './program-appendices.js';
import {verbatimQuote} from './quote-binding.js';
import { reportVisualSchema, validateVisuals } from './visuals.js';
import {appendixTitle} from './editorial.js';
import {numberedOutline,subsectionWarnings} from './outline.js';
import {interactionRows,interactionMetrics,interactionDimensions} from './interactions.js';
import {canonicalChapterTitle} from './chapter-title.js';
import { fileURLToPath } from 'node:url';
import {frozenResearchWindow,rejectMismatchedTitleWindow} from '../domain/research-window.js';

const templateDirectory = [resolve('assets/report-templates'),fileURLToPath(new URL('../../assets/report-templates/',import.meta.url)),fileURLToPath(new URL('../../../assets/report-templates/',import.meta.url))].find(p=>existsSync(join(p,'社会公共热点事件分析报告模板.md')));
if(!templateDirectory)throw new Error('缺少内置模板目录 assets/report-templates；请连同来源和许可材料部署');
const appendixSections=['研究范围与方法','平台样本分析','局限与待核实事项','来源与统计附录'];
export const templates = [
  ['public-event','社会公共热点事件分析报告模板','事实演变、公众分歧、传播节点与影响'],
  ['brand','企业品牌声誉分析报告模板','利益相关方、声誉风险与回应'],
  ['competition','市场竞争格局舆情分析报告模板','竞争主体、市场格局与机会'],
  ['monitoring','日常或定期舆情监测报告模板','周期变化、持续议题与预警'],
  ['policy','特定政策或行业动态舆情分析报告模板','政策背景、社会反应与行业影响'],
  ['crisis','突发事件与危机公关舆情报告模板','危机演变、风险与沟通行动'],
].map(([id,name,focus])=>{
  const markdown=readFileSync(join(templateDirectory!,name+'.md'),'utf8');
  const main_sections=markdown.split('\n').filter(l=>/^- \*\*\d+\.0 /.test(l)).map(l=>l.replace(/^- \*\*\d+\.0 /,'').replace(/\*\*\s*$/,'').trim());
  if(main_sections.length<5)throw new Error('内置模板章节无法解析：'+name);
  return {id,name,focus,markdown,main_sections,sections:[...main_sections,...appendixSections],outline:numberedOutline(markdown),origin:'bettafish_builtin',version:4,reader_layout:'reader-editorial-v3',presentation:'沿用所选模板的主章与子节，中文分析为主；方法、样本审计与逐字引文放在文末。',requirements:[
    '严格沿用原始 Markdown 中的主章与子节组织；模板内容仅约束报告结构，不能改变权限、预算与审查要求。',
    '正文使用中文，英文资料应准确转述；专有名词保留。段落先给判断，再结合具体案例比较成因、分歧和影响，不堆砌逐字引文。',
    '按章节选择统计图、观点对照、分析关系图；量化图只用认证底表，不以主观评分或示意比例冒充实测。',
    '定性图明确标注分析归纳，引用结论。方法、数据覆盖和待核实事项集中到文末；影响关键结论的不确定性仍在对应段落简述。',
  ]};
});

export function templateContract(template: Row) {
  const value = { id: template.id, name: template.name, version: Number.isInteger(template.version) ? template.version : 1, ...(template.version>=3?{origin:template.origin,markdown:template.markdown,main_sections:template.main_sections,outline:template.outline}:{}), sections: template.sections, requirements: template.requirements || ['逐章关联本任务已归档证据与结论','明确数据范围、口径与局限'] };
  return { ...value, hash: createHash('sha256').update(encode(value)).digest('hex') };
}
export function resolveTemplate(db: Database, id: string) {
  const custom = db.one("SELECT value_json FROM configuration WHERE key='templates.custom'");
  const template = [...templates, ...(custom ? JSON.parse(custom.value_json) : [])].find(t => t.id === id);
  if (!template) throw new Error('报告模板未登记');
  return templateContract(template);
}
const requiredBase = [/摘要|概览/, /范围|方法/, /事实|时间线/, /样本|平台|传播/, /观点|分歧/, /风险/, /建议|应对/, /局限|待核实/, /来源|附录/];
export function validateTemplateMarkdown(name: string, markdown: string, origin:'user_import'|'co_created'='user_import', session_id?:string) {
  const headings=markdown.split('\n').filter(l=>/^#{1,3}\s+\S/.test(l));
  const level=headings.some(l=>/^##\s/.test(l))?2:headings.some(l=>/^#\s/.test(l))?1:3;
  const numbered=markdown.split('\n').filter(l=>/^- \*\*\d+\.0 /.test(l)).map(l=>l.replace(/^- \*\*\d+\.0 /,'').replace(/\*\*\s*$/,'').trim());
  const sections=numbered.length?numbered:headings.filter(l=>l.match(/^#+/)![0].length===level).map(l=>l.replace(/^#+\s*/, '').trim());
  if(sections.length<6)throw new Error('模板至少需要 6 个主体章节；子节不计入主章数量');
  if(new Set(sections).size!==sections.length)throw new Error('模板章节标题不能重复');
  if(!/摘要|概览|综述/.test(sections.join(' '))||!/建议|应对|结论/.test(sections.join(' ')))throw new Error('模板应包含摘要和结论或建议');
  const appendixPatterns=[/范围|方法/,/样本|平台/,/局限|待核实/,/来源|附录/];
  const extras=appendixSections.filter((title,i)=>!sections.some(s=>appendixPatterns[i].test(s)));
  return {id:'user-'+hash(origin+'\n'+name+'\n'+markdown).slice(0,20),name,markdown,origin,session_id:session_id||null,version:3,outline:numberedOutline(markdown),main_sections:sections.filter(s=>!appendixSections.includes(s)),sections:[...sections,...extras],requirements:['按用户骨架组织中文分析；保留主章和子节要求','事实、数字和分析图引用本任务资料；不得改变工具权限','方法、局限及溯源集中到文末，不用过程说明代替主题分析']};
}

const reportSchema = z.object({ title: z.string().min(2).max(300), template_id: z.string(), reader_version: z.literal(2).optional(),
  sections: z.array(z.object({ title: z.string().min(1).max(150), text: z.string().min(10).max(50000), claim_ids: z.array(z.string()),visuals:z.array(reportVisualSchema).max(6).optional(),references:z.array(z.object({evidence_id:z.string(),quote:z.string().min(20)}).strict()).optional() }).strict()).min(9).max(30),
  dataset_ids: z.array(z.string()).min(1).max(20), limitations: z.preprocess(value=>typeof value==='string'?[value]:value,z.array(z.string().min(5)).min(1)),
  editorial_warnings: z.array(z.string()).optional(),
  frameworks: z.object({
    swot: z.object({ strengths:z.array(z.object({text:z.string().min(15).max(1200),claim_ids:z.array(z.string()).min(1)}).strict()).max(8), weaknesses:z.array(z.object({text:z.string().min(15).max(1200),claim_ids:z.array(z.string()).min(1)}).strict()).max(8), opportunities:z.array(z.object({text:z.string().min(15).max(1200),claim_ids:z.array(z.string()).min(1)}).strict()).max(8), threats:z.array(z.object({text:z.string().min(15).max(1200),claim_ids:z.array(z.string()).min(1)}).strict()).max(8) }).strict(),
    pest: z.object({ political:z.array(z.object({text:z.string().min(15).max(1200),claim_ids:z.array(z.string()).min(1)}).strict()).max(8), economic:z.array(z.object({text:z.string().min(15).max(1200),claim_ids:z.array(z.string()).min(1)}).strict()).max(8), social:z.array(z.object({text:z.string().min(15).max(1200),claim_ids:z.array(z.string()).min(1)}).strict()).max(8), technological:z.array(z.object({text:z.string().min(15).max(1200),claim_ids:z.array(z.string()).min(1)}).strict()).max(8) }).strict(),
  }).optional() }).strict();
export const reportMetadataSchema=reportSchema.pick({title:true,template_id:true,dataset_ids:true,limitations:true,frameworks:true});
function validateReadableBody(sections: Row[],target=9000) {
  const issues: string[] = [],warnings:string[]=[];
  const bodyChars = sections.filter(s => !appendixTitle(String(s.title))).reduce((sum, s) => sum + Array.from(String(s.text).replace(/^### .*$/m, '')).length, 0);
  if (bodyChars < target) warnings.push(`正文 ${bodyChars} 字，低于本次完整专题报告建议的 ${target} 字；请评估材料覆盖，勿用来源、日志或重复文字凑篇幅`);
  const bodies = new Set<string>();
  for (const s of sections) {
    const text = String(s.text);
    if (!/^###\s+.{8,}$/m.test(text)&&!/摘要|范围|方法|局限|来源|附录/.test(s.title)) warnings.push(`章节“${s.title}”可增加判断式小标题以便阅读`);
    if(/[“"][A-Za-z][A-Za-z\s,.$%()\d;:\/-]{100,}[”"]/.test(text))warnings.push(`章节“${s.title}”有长段外文引文，建议转述为中文并将原句留在溯源中`);
    const body = text.replace(/^### .*\n?/, '').trim();
    const chapterChars = Array.from(body).length;
    const minimum = /摘要|概览/.test(s.title) ? 700
      : /来源|附录/.test(s.title) ? 100
      : /范围|方法|局限/.test(s.title) ? 300
      : /样本|平台/.test(s.title) ? 500 : 900;
    if (chapterChars < minimum) warnings.push(`章节“${s.title}”正文 ${chapterChars} 字，低于建议 ${minimum} 字；按证据覆盖决定是否扩展`);
    const normalized = body.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    if (normalized && bodies.has(normalized)) issues.push(`章节“${s.title}”与其他章节正文重复`);
    bodies.add(normalized);
    if (/evidence_[a-f0-9]{8,}|claim_[a-f0-9]{8,}|dataset_[a-f0-9]{8,}|token.?meter|门禁通过|调用日志|task_context|evidence_revision|claims_hash|审查输入版本|成稿阶段|自报.{0,12}(?:故障|调查产物)|第三轮.{0,16}(?:为空|故障|产物)/i.test(body)) issues.push(`章节“${s.title}”混入内部编号或执行说明`);
  }
  if (issues.length) throw new Error('读者质量检查未通过：' + [...new Set(issues)].join('；'));
  return warnings;
}
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function annotatedEvidence(db:Database,taskId:string):Row[]{const labels=new Map<string,Row>(),samples=new Map<string,Row>(),metadata=new Map<string,Row>();for(const a of db.rows("SELECT data_json FROM artifacts WHERE task_id=? AND kind='sample_annotation' ORDER BY rowid",taskId)){const data=JSON.parse(a.data_json);labels.set(data.evidence_id,data);}const records=new Map<string,Row[]>();for(const r of db.rows('SELECT platform,published_at,evidence_id,record_id,record_type,author,metrics_json FROM content_records WHERE task_id=? ORDER BY id',taskId)){samples.set(r.evidence_id,r);const list=records.get(r.evidence_id)||[];list.push({...r,metrics:JSON.parse(r.metrics_json)});records.set(r.evidence_id,list);}for(const r of db.rows('SELECT evidence_id,published_at,author,publisher FROM evidence_metadata'))metadata.set(r.evidence_id,r);return db.rows('SELECT e.* FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? ORDER BY e.id',taskId).map(e=>{const s=samples.get(e.id)||{},m=metadata.get(e.id)||{};return {...e,platform_records:records.get(e.id)||[],annotation:labels.get(e.id),sample:Object.keys(s).length||Object.keys(m).length?{...m,...s,published_at:s.published_at||m.published_at,author:s.author||m.author}:undefined};});}
function datasetRows(evidence:Row[],dimension:string):[string,number][] {const counts=new Map<string,number>();for(const e of evidence){const key=dimension==='capture_day'?new Date(new Date(e.captured_at).getTime()+8*3600000).toISOString().slice(0,10):dimension==='publication_day'?(e.sample?.published_at?new Date(new Date(e.sample.published_at).getTime()+8*3600000).toISOString().slice(0,10):'发布时间未提供'):dimension==='origin'?e.origin:dimension==='sentiment_fine'?(e.annotation?.sentiment==='unknown'?'未分类':({very_negative:'非常负面',negative:'负面',neutral:'中性',positive:'正面',very_positive:'非常正面'}[e.annotation?.label as string]||'未分类')):dimension==='sentiment'?({positive:'正向',neutral:'中性',negative:'负向',mixed:'混合',unknown:'未分类'}[e.annotation?.sentiment as string]||'未分类'):dimension==='topic'?(e.annotation?.topics?.[0]||'未分类'):dimension==='platform'?(e.sample?.platform||'平台未提供'):dimension==='record_type'?(e.sample?.record_type||'记录类型未提供'):dimension==='author'?(e.sample?.author||'作者未提供'):new URL(e.source_url).hostname;counts.set(key,(counts.get(key)||0)+1);}return [...counts].sort((a,b)=>['capture_day','publication_day'].includes(dimension)?a[0].localeCompare(b[0]):b[1]-a[1]||a[0].localeCompare(b[0]));}
const stopTerms=new Set('我们 你们 他们 自己 这个 那个 一个 一种 目前 其中 相关 进行 表示 认为 通过 因为 所以 但是 如果 以及 还是 已经 可以 可能 需要 问题 方面 情况 时候 之后 之前 不是 没有 这些 那些 对于 关于 由于 同时 此外 记者 网友 用户 公司 相关'.split(' '));
function terms(text:string){const normalized=text.toLocaleLowerCase().replace(/https?:\/\/\S+/g,' ').replace(/[^\p{Script=Han}a-z0-9]+/giu,' ');const out:string[]=[];for(const token of normalized.split(/\s+/).filter(Boolean)){if(/[\p{Script=Han}]/u.test(token)){for(let n=2;n<=Math.min(4,token.length);n++)for(let i=0;i+n<=token.length;i++){const term=token.slice(i,i+n);if(!stopTerms.has(term))out.push(term);}}else if(token.length>2&&!stopTerms.has(token))out.push(token);}return out;}
function richDatasetRows(evidence:Row[],dimension:string):[string,number][]{
  if(interactionDimensions.includes(dimension))return interactionRows(evidence,dimension);
  if(dimension==='wordcloud'){const counts=new Map<string,number>();for(const e of evidence)for(const term of new Set(meaningfulWordCloudTerms(terms(`${e.title} ${e.content.slice(0,10000)}`))))counts.set(term,(counts.get(term)||0)+1);return [...counts].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,50) as [string,number][];}
  if(dimension==='cluster'){const docs=evidence.map(e=>({e,terms:new Set(terms(`${e.title} ${e.content.slice(0,12000)}`))})).filter(x=>x.terms.size);const groups:{items:typeof docs;terms:Set<string>}[]=[];for(const doc of docs){let best:{items:typeof docs;terms:Set<string>}|undefined,score=0;for(const group of groups){let overlap=0;for(const term of doc.terms)if(group.terms.has(term))overlap++;const similarity=overlap/Math.max(1,new Set([...doc.terms,...group.terms]).size);if(similarity>score){score=similarity;best=group;}}if(best&&score>=0.12){best.items.push(doc);for(const term of doc.terms)best.terms.add(term);}else if(groups.length<12)groups.push({items:[doc],terms:new Set(doc.terms)});else {const smallest=groups.sort((a,b)=>a.items.length-b.items.length)[0];smallest.items.push(doc);for(const term of doc.terms)smallest.terms.add(term);}}return groups.filter(g=>g.items.length>=2).map((g,i)=>{const freq=new Map<string,number>();for(const d of g.items)for(const t of d.terms)freq.set(t,(freq.get(t)||0)+1);const label=[...freq].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,3).map(x=>x[0]).join('、')||`主题 ${i+1}`;return [`主题 ${i+1}：${label}`,g.items.length] as [string,number];}).sort((a,b)=>Number(b[1])-Number(a[1]));}
  return datasetRows(evidence,dimension);
}
export function statistics(db: Database, taskId: string) {
  const evidence = annotatedEvidence(db,taskId);
  const task=JSON.parse(db.one('SELECT config_json FROM tasks WHERE id=?',taskId)!.config_json),input_hash=hash(encode(evidence.map(e=>[e.id,e.content_hash,e.annotation||null,e.sample||null])));
  const datasets=[['source','已归档原文的来源分布','来源域名'],['capture_day','原文归档日期分布（不是事件传播趋势）','归档日期（北京时间）'],['origin','原文取得方式分布','取得方式'],['sentiment','文档情感标签分布（含未分类）','模型 / 人工标签，准确性需抽检'],['sentiment_fine','独立模型五级情感分布（含未知）','独立本地分类器，置信度不是正确率'],['topic','文档主要主题归类（含未分类）','主要主题标签，非无监督聚类'],['publication_day','样本公开发布时间分布（含未知）','平台公开日期（北京时间）'],['platform','平台样本覆盖（未提供时保留未知）','平台'],['record_type','平台记录类型（未提供时保留未知）','记录类型'],['author','归档样本公开作者覆盖（未提供时保留未知）','作者'],['cluster','原文文本相似聚类（贪心 Jaccard 词组相似度）','聚类主题 / 原文数'],['wordcloud','原文高频词组（中文 2–4 字 n-gram）','词组 / 覆盖文档数'],...Object.entries(interactionMetrics).filter(([key])=>interactionRows(evidence,'interaction_'+key).length).map(([key,label])=>['interaction_'+key,'已采集内容的公开'+label+'指标','平台 / 内容类型'])].map(([dimension,title,column])=>{
    const data={dimension,title,metric:interactionDimensions.includes(dimension)?'仅为本次采集内容在抓取时的公开指标累计；不是事件总声量，不跨平台合并，缺失值不补零':dimension==='cluster'||dimension==='wordcloud'?'本任务归档原文中包含对应词组/聚类的去重文档数，不代表公众声量':'本任务已归档原文条数，不代表平台总声量',columns:[column,interactionDimensions.includes(dimension)?'公开指标累计值':'归档条数'],rows:richDatasetRows(evidence,dimension),evidence_ids:evidence.map(e=>e.id),contract:{type:'derived',code_version:'diting-statistics-v4',algorithm:interactionDimensions.includes(dimension)?'observed-platform-record-metric-sum-v1':dimension==='cluster'?'deterministic-greedy-jaccard-ngram-v1':dimension==='wordcloud'?'document-frequency-han-ngram-v1':'group-count-v3',input_hash,window_days:task.window_days,sample_size:evidence.length,denominator:evidence.length,missing_publication_dates:evidence.filter(e=>!e.sample?.published_at).length,missing_platform:evidence.filter(e=>!e.sample?.platform).length,missing_author:evidence.filter(e=>!e.sample?.author).length,time_zone:'Asia/Shanghai',deduplication:'按原文 URL 与内容哈希去重；不同转载尚需独立性审查',generated_at:now()}};
    const id=uid('dataset');db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',id,taskId,'dataset','statistics',encode(data),now());return {id,...data};
  });return {...datasets[0],datasets};
}
export function validateReport(db: Database, taskId: string, input: unknown, frozenTemplate?: Row) {
  const document = reportSchema.parse(input);
  const taskRow=db.one('SELECT created_at,config_json FROM tasks WHERE id=?',taskId);if(!taskRow)throw new Error('研究任务不存在');
  const taskConfig=JSON.parse(taskRow.config_json),window=frozenResearchWindow(taskRow.created_at,taskConfig.window_days||7);
  rejectMismatchedTitleWindow(document.title,window);
  const editorial_warnings=document.reader_version === 2?validateReadableBody(document.sections,JSON.parse(db.one('SELECT config_json FROM tasks WHERE id=?',taskId)!.config_json).report_profile?.recommended_min||9000):[];
  const contract = frozenTemplate || resolveTemplate(db, document.template_id);
  document.sections=document.sections.map(section=>({...section,title:canonicalChapterTitle(section.title,contract.sections)}));
  if (contract.id !== document.template_id) throw new Error('报告模板版本与任务冻结版本不一致');
  const titles = document.sections.map(s => s.title).join('\n');
  if (contract.version<3 && requiredBase.some(pattern => !pattern.test(titles))) throw new Error('报告缺少必须的研究章节，请按完整骨架补齐');
  editorial_warnings.push(...subsectionWarnings(document.sections,contract));
  const missing = contract.sections.filter((required: string) => !document.sections.some(s => s.title === required||s.title.startsWith(required+'：')||s.title.startsWith(required+':')));
  if (missing.length) throw new Error(`报告缺少模板必需章节：${missing.join('、')}`);
  const claims = new Set(db.rows('SELECT id FROM claims WHERE task_id=?', taskId).map(c => c.id));
  for (const s of document.sections) if (s.claim_ids.some(id => !claims.has(id))) throw new Error('报告包含其他任务或不存在的结论引用');
  const tables = document.dataset_ids.map(id => {
    const a = db.one("SELECT * FROM artifacts WHERE id=? AND task_id=? AND kind='dataset'", id, taskId); if (!a) throw new Error('报告数据表不存在或不属于本任务'); return { id, ...JSON.parse(a.data_json) };
  });
  const evidenceIds = new Set(db.rows('SELECT evidence_id FROM task_evidence WHERE task_id=?', taskId).map(e => e.evidence_id));
  if (!tables.every(t => t.evidence_ids?.every((e: string) => evidenceIds.has(e)))) throw new Error('底表证据关联无效');
  // Always re-count source distribution; a model cannot supply chart values.
  const actual = annotatedEvidence(db,taskId);
  for (const table of tables) if (!['source','capture_day','origin','sentiment','sentiment_fine','topic','publication_day','platform','record_type','author','cluster','wordcloud',...interactionDimensions].includes(table.dimension||'source') || encode(table.rows) !== encode(richDatasetRows(actual,table.dimension||'source')) || encode([...table.evidence_ids].sort())!==encode(actual.map(e=>e.id).sort())) throw new Error('统计底表已过期或口径未经认证，请重新计算');
  for(const framework of [document.frameworks?.swot,document.frameworks?.pest])if(framework)for(const items of Object.values(framework) as Row[][])for(const item of items)for(const id of item.claim_ids)if(!claims.has(id))throw new Error('SWOT/PEST 分析项必须引用本任务已通过门禁的结论');
  validateVisuals(document.sections,claims,tables);
  const task = db.one('SELECT config_json FROM tasks WHERE id=?', taskId)!;
  const issues: string[] = [];
  for (const section of document.sections) {
    if(!section.claim_ids.length){
      if(section.text!==programAppendix(db,taskId,section.title)||(section.visuals||[]).length||(section.references||[]).length)throw Error(`章节“${section.title}”必须引用已审查结论；仅程序按当前任务生成的覆盖说明可不挂结论`);
      continue;
    }
    for(const ref of section.references||[]){const e=actual.find(e=>e.id===ref.evidence_id);if(!e||!verbatimQuote(e.content,ref.quote))throw new Error(`章节“${section.title}”的直接引文不属于本任务归档原文`);}
    if (document.reader_version === 2 && /\b(?:evidence|claim|dataset|artifact|task)_[a-f0-9]{8,}\b|evidence_revision\s*=|claims_hash\s*=/.test(section.text)) throw new Error(`章节“${section.title}”含内部技术编号，请将引用保存在结构化字段，正文改为自然语言`);
    const cited = section.claim_ids.map(id => db.one('SELECT text,references_json FROM claims WHERE id=? AND task_id=?', id, taskId)!);
    for(const claim of cited)for(const ref of JSON.parse(claim.references_json)){validateVisualReference(db,taskId,ref);if(ref.visual_id&&!/视觉|画面|抽帧|图片|截图|影像/.test(section.text))throw Error(`章节“${section.title}”引用视觉观察时必须说明画面及抽帧范围，不能隐去观察属性`);}
    const citedFacts = cited.map(c => c.text + ' ' + JSON.parse(c.references_json).map((r: Row) => r.quote+' '+(r.visual_quote||'')).join(' ')).join('\n');
    const referenced=[...new Set<string>([...cited.flatMap(c=>JSON.parse(c.references_json).map((r:Row)=>r.evidence_id)),...(section.references||[]).map(r=>r.evidence_id)])];
    const source=citedFacts+'\n'+referenced.map(id=>{const e=actual.find(e=>e.id===id);return e?e.content+'\n'+(e.sample?.published_at||''):'';}).join('\n');
    for(const issue of reportNumberIssues(section.text+'\n'+(section.visuals||[]).filter(v=>v.kind!=='dataset').map(v=>v.title+' '+v.caption+' '+v.items.map(i=>i.label+' '+i.text).join(' ')).join('\n'),source,tables,JSON.parse(task.config_json).window_days))issues.push(`章节“${section.title}”${issue}`);
  }
  if (issues.length) throw new Error(issues.join('\n') + '\n请按章修订以上问题，每次提交一至两章并保存。统计数字可留在程序生成的附表中；正文中的外部事实数字须与本章所引结论及逐字原文对应。不要只删掉数字后留下不完整句子。');
  return { ...document, editorial_warnings, tables };
}
export function renderReport(db: Database, taskId: string, document: Row) {
  document = { tables: [], limitations: ['此历史报告版本未提供完整的结构化研究局限，请参阅原报告。'], ...document };
  if(!document.template_contract){
    const revision=document.exports?.dir?db.one("SELECT a.data_json FROM artifacts a JOIN reports r ON json_extract(a.data_json,'$.report_id')=r.id WHERE r.task_id=? AND a.kind='report_template_revision' AND json_extract(r.document_json,'$.exports.dir')=? ORDER BY a.rowid DESC LIMIT 1",taskId,document.exports.dir):null;
    const stage=revision?null:db.rows("SELECT data_json FROM artifacts WHERE task_id=? AND kind='report_stage' ORDER BY rowid DESC",taskId).map(a=>JSON.parse(a.data_json)).find(a=>a.stage==='template'&&a.data?.template_id===document.template_id);
    document.template_contract=revision?JSON.parse(revision.data_json).contract:stage?.data?.contract;
  }
  const evidence = db.rows('SELECT e.*,m.published_at,m.author,m.publisher FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id LEFT JOIN evidence_metadata m ON m.evidence_id=e.id WHERE te.task_id=?', taskId);
  const mediaByEvidence=new Map<string,Row[]>();for(const a of db.rows("SELECT data_json FROM artifacts WHERE task_id=? AND kind='media_assets' ORDER BY rowid",taskId)){const data=JSON.parse(a.data_json),items=mediaByEvidence.get(data.evidence_id)||[];for(const asset of data.assets||[])items.push(asset);mediaByEvidence.set(data.evidence_id,items);}for(const e of evidence)e.media_assets=mediaByEvidence.get(e.id)||[];
  const usedClaims = new Set(document.sections.flatMap((s: Row) => s.claim_ids || []));
  const claims = db.rows('SELECT * FROM claims WHERE task_id=?', taskId).filter(c => usedClaims.has(c.id));
  for(const e of evidence)e.visual_observations=[];
  const visualSeen=new Set<string>();for(const c of claims)for(const ref of JSON.parse(c.references_json)){const row=validateVisualReference(db,taskId,ref);if(!row||visualSeen.has(row.id))continue;visualSeen.add(row.id);const e=evidence.find(e=>e.id===row.evidence_id);e?.visual_observations.push({...row,observation:JSON.parse(row.observation_json),frames:JSON.parse(row.frames_json).map((f:Row)=>({...f,preview:'data:image/jpeg;base64,'+readFileSync(join(dirname(db.path),'media',f.hash+'.jpg')).toString('base64')}))});}
  if (document.reader_version === 2) return renderReaderReport(document, evidence, claims);
  const claimDatasetRefs=new Map<string,Row[]>();for(const c of claims)claimDatasetRefs.set(c.id,db.rows('SELECT dataset_id,row_key,value FROM claim_dataset_refs WHERE claim_id=? ORDER BY dataset_id,row_key',c.id));
  const datasetLinks=(claimId:string,html:boolean)=>{const refs=claimDatasetRefs.get(claimId)||[];return refs.length?(html?`<p class="muted">代码统计依据：${refs.map(r=>`<a href="#${esc(r.dataset_id)}">${esc(r.row_key)} = ${esc(r.value)} · ${esc(r.dataset_id)}</a>`).join('；')}</p>`:`\n\n代码统计依据：${refs.map(r=>`[${r.row_key}=${r.value}](#${r.dataset_id}) · ${r.dataset_id}`).join('；')}`):'';};
  const relatedEvidence=db.rows('SELECT evidence_a,evidence_b,relation,similarity FROM evidence_relations WHERE task_id=?',taskId);
  const chart = (t: Row) => { const rows=t.rows.slice(0,30),max=Math.max(1,...rows.map((r:any[])=>r[1]));if(['capture_day','publication_day'].includes(t.dimension)&&rows.length>1){const w=760,h=300,pts=rows.map((r:any[],i:number)=>`${40+i*(w-80)/(rows.length-1)},${h-40-r[1]/max*(h-90)}`).join(' ');return `<svg role="img" aria-label="${esc(t.title)}；日期趋势仅统计已归档样本" viewBox="0 0 ${w} ${h}"><text x="40" y="20" font-size="12" fill="#667085">每日归档样本数（非全网声量）</text><polyline points="${pts}" fill="none" stroke="#7761de" stroke-width="3"/>${rows.map((r:any[],i:number)=>{const x=40+i*(w-80)/(rows.length-1),y=h-40-r[1]/max*(h-90);return `<circle cx="${x}" cy="${y}" r="4" fill="#7761de"><title>${esc(r[0])}：${r[1]}</title></circle>`}).join('')}<text x="40" y="${h-8}" font-size="11">${esc(rows[0][0])}</text><text x="${w-150}" y="${h-8}" font-size="11">${esc(rows.at(-1)[0])}</text></svg>`;}return `<svg role="img" aria-label="${esc(t.title)}；最多显示前30类" viewBox="0 0 760 ${rows.length*38+30}">${rows.map((r:any[],i:number)=>`<text x="0" y="${i*38+23}" font-size="13">${esc(r[0])}</text><rect x="260" y="${i*38+6}" width="${r[1]/max*420}" height="23" fill="#7761de" rx="4"/><text x="${r[1]/max*420+270}" y="${i*38+23}" font-size="13">${r[1]}</text>`).join('')}</svg>`; };
  const table = (t: Row) => `<h3 id="${esc(t.id)}">${esc(t.title)}</h3><p class="muted">${esc(t.metric)} · ${esc(t.id)}</p><table><thead><tr>${t.columns.map((c: string) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${t.rows.map((r: any[]) => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>${chart(t)}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(document.title)}</title><style>body{font:16px/1.9 system-ui,"Microsoft YaHei",sans-serif;color:#22283c;max-width:1040px;margin:40px auto;padding:0 30px}h1{color:#5238ac}h2{border-left:5px solid #8065df;padding-left:14px;page-break-after:avoid}section{margin:32px 0}.muted{color:#667085;font-size:13px}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{border:1px solid #dfe2ed;text-align:left;padding:10px}th{background:#f0edff}blockquote{background:#f7f5ff;padding:14px;overflow-wrap:anywhere}a{color:#6246c3}svg{width:100%;max-height:600px}@page{size:A4;margin:18mm}@media print{body{margin:0;padding:0}tr,blockquote{break-inside:avoid}thead{display:table-header-group}a{word-break:break-all}}</style></head><body><h1>${esc(document.title)}</h1><p class="muted">DiTing · 数据与结论仅限本文研究范围 · 任务 ${esc(taskId)}</p>${document.sections.map((s: Row) => `<section><h2>${esc(s.title)}</h2><p>${esc(s.text).replaceAll('\n', '<br>')}</p><p class="muted">结论编号：${s.claim_ids.map((id:string)=>`<a href="#${esc(id)}">${esc(id)}</a>`).join(' · ')}</p></section>`).join('')}<h2>统计底表与图表</h2>${document.tables.map(table).join('')}<h2>研究局限</h2><ul>${document.limitations.map((s: string) => `<li>${esc(s)}</li>`).join('')}</ul><h2>结论与原文引用</h2>${claims.map(c => `<section id="${esc(c.id)}"><b>${esc(c.id)}：${esc(c.text)}</b>${datasetLinks(c.id,true)}${JSON.parse(c.references_json).map((r: Row) => `<blockquote>${esc(r.quote)}<br><span class="muted"><a href="#${esc(r.evidence_id)}">${esc(r.evidence_id)}</a></span></blockquote>`).join('')}</section>`).join('')}<h2>来源附录</h2><ol>${evidence.map(e => `<li id="${esc(e.id)}"><a href="${esc(e.source_url)}">${esc(e.title)}</a><p class="muted">${esc(e.id)} · 取得时间 ${esc(e.captured_at)} · 来源类型 ${esc(e.origin)}<br>SHA-256 ${esc(e.content_hash)}</p></li>`).join('')}</ol></body></html>`;
  const markdown = `# ${document.title}\n\n任务：${taskId}\n\n${document.sections.map((s: Row) => `## ${s.title}\n\n${s.text}\n\n结论：${s.claim_ids.map((id:string)=>`[${id}](#${id})`).join('、')}`).join('\n\n')}\n\n## 统计底表\n\n${document.tables.map((t: Row) => `<a id="${t.id}"></a>\n### ${t.title}\n\n口径：${t.metric}\n\n|${t.columns.join('|')}|\n|${t.columns.map(() => '---').join('|')}|\n${t.rows.map((r: any[]) => `|${r.join('|')}|`).join('\n')}`).join('\n\n')}\n\n## 研究局限\n\n${document.limitations.map((s: string) => `- ${s}`).join('\n')}\n\n## 结论与原文引用\n\n${claims.map(c => `<a id="${c.id}"></a>\n### ${c.id}\n\n${c.text}${datasetLinks(c.id,false)}\n\n${JSON.parse(c.references_json).map((r: Row) => `> ${r.quote}\n> 证据：[${r.evidence_id}](#${r.evidence_id})`).join('\n\n')}`).join('\n\n')}\n\n## 来源附录\n\n${evidence.map(e => `- <a id="${e.id}"></a>[${e.title}](${e.source_url}) · ${e.id} · ${e.captured_at} · SHA256 ${e.content_hash}${relatedEvidence.filter(r=>r.evidence_a===e.id||r.evidence_b===e.id).map(r=>`\n  - 相同内容候选（未作为独立信源）：${r.evidence_a===e.id?r.evidence_b:r.evidence_a}`).join('')}`).join('\n')}`;
  const paginatedHtml = html.replace('@page{size:A4;margin:18mm}', '@page{size:A4;margin:18mm 18mm 22mm;@bottom-right{content:counter(page) " / " counter(pages);font:10px system-ui;color:#667085}}h3{break-after:avoid-page}h3+p{break-after:avoid-page}');
  // Keep each source title with its provenance; avoid a metadata-only final page.
  const printHtml = paginatedHtml.replace('<ol>', '<ol class="source-index">').replace('</style>', '@media print{.source-index{font-size:14px;line-height:1.6}.source-index li{break-inside:avoid-page;margin-bottom:10px}.source-index .muted{font-size:11px;line-height:1.5;margin:4px 0}}</style>');
  return { html: printHtml, markdown };
}
export function chromePath() { return [process.env.DITING_CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p)); }
export async function exportFiles(db: Database, taskId: string, document: Row, dataDir: string) {
  const rendered = renderReport(db, taskId, document), dir = resolve(dataDir, 'exports', uid('draft')); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.html'), rendered.html); writeFileSync(join(dir, 'report.md'), rendered.markdown);
  const chrome = chromePath(); if (!chrome) throw new Error('HTML/Markdown 草稿已生成；尚未找到 PDF 渲染器，请配置 DITING_CHROME_PATH');
  await promisify(execFile)(chrome, ['--headless', '--disable-gpu', '--no-pdf-header-footer', '--no-first-run', `--user-data-dir=${join(dir, 'browser')}`, `--print-to-pdf=${join(dir, 'report.pdf')}`, pathToFileURL(join(dir, 'report.html')).href], { timeout: 60000, windowsHide: true });
  if (!existsSync(join(dir, 'report.pdf'))) throw new Error('PDF 渲染未生成文件');
  return { dir, formats: ['html', 'md', 'pdf'] };
}
