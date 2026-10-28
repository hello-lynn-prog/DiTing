/** Explicit layout upgrade of this saved AI policy report, without fresh model calls. */
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {Database,encode,type Row} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {templates,validateReport,resolveTemplate} from '../packages/reporting/report.js';
import {reviseReport} from '../packages/reporting/revision.js';
const root=process.cwd(),data=join(root,'data'),db=new Database(join(data,'diting.sqlite3'),root),service=new Service(db);
const id=process.argv[2],source=db.one('SELECT * FROM reports WHERE id=?',id);if(!source)throw Error('请提供报告ID');
const document=JSON.parse(source.document_json);if(document.template_id!=='policy')throw Error('此迁移映射仅适用于现有政策/行业报告');
const builtin=templates.find(t=>t.id==='policy')!;
const matching=(pattern:RegExp)=>document.sections.filter((s:Row)=>pattern.test(s.title));
const groups=[matching(/^研究摘要/),matching(/^事实与时间线/),matching(/^观点与分歧/),matching(/^行业影响/),matching(/^政策原文/),matching(/^(风险研判|应对建议)/)];
if(groups.some(g=>!g.length))throw Error('旧报告结构不符合本次已审阅的迁移映射');
const sections=builtin.main_sections.map((title,i)=>({title,text:groups[i].map((s:Row)=>s.text).join('\n\n'),claim_ids:[...new Set(groups[i].flatMap((s:Row)=>s.claim_ids))],visuals:groups[i].flatMap((s:Row)=>s.visuals||[]).slice(0,6),references:groups[i].flatMap((s:Row)=>s.references||[])}));
for(const title of builtin.sections.slice(builtin.main_sections.length)){const old=document.sections.find((s:Row)=>s.title===title);if(!old)throw Error('缺少原始附录：'+title);sections.push(old);}
const input={title:document.title,template_id:'policy',reader_version:2,sections,dataset_ids:document.dataset_ids,limitations:document.limitations,frameworks:document.frameworks};
validateReport(db,source.task_id,input,resolveTemplate(db,'policy'));
const result=await reviseReport(db,service,id,input,data,{upgradeTemplate:true});
writeFileSync(join(data,'diagnostics','editorial-layout-result.json'),encode(result));console.log(JSON.stringify(result));db.close();
