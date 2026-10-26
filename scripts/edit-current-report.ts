import {join} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Database,encode,type Row} from '../packages/domain/db.js';
import {Configuration} from '../packages/domain/configuration.js';
import {Service} from '../packages/domain/service.js';
import {editorialCall} from '../packages/reporting/editor.js';
import {appendixTitle} from '../packages/reporting/editorial.js';
import {validateReport,renderReport} from '../packages/reporting/report.js';
import {reviseReport} from '../packages/reporting/revision.js';

const root=process.cwd(),data=join(root,'data'),db=new Database(join(data,'diting.sqlite3'),root),config=new Configuration(db,data),service=new Service(db);
const sourceId=process.argv[2];if(!sourceId)throw Error('请提供报告ID');
const source=db.one('SELECT * FROM reports WHERE id=?',sourceId);if(!source)throw Error('报告不存在');
const dir=join(data,'diagnostics','editorial-'+sourceId);mkdirSync(dir,{recursive:true});
const previous=JSON.parse(source.document_json),document={...previous};delete document.exports;delete document.tables;
const stage=db.rows("SELECT data_json FROM artifacts WHERE task_id=? AND kind='report_stage' ORDER BY rowid DESC",source.task_id).map(a=>JSON.parse(a.data_json)).find(a=>a.stage==='template');
const claims=db.rows('SELECT * FROM claims WHERE task_id=?',source.task_id);
let calls=0;
for(let i=0;i<document.sections.length;i++){
  const section=document.sections[i];if(appendixTitle(section.title))continue;
  console.log('编辑章节：'+section.title);
  const chosen=claims.filter(c=>section.claim_ids.includes(c.id));
  const input={report_title:document.title,chapter:section.title,all_chapters:document.sections.map((s:Row)=>s.title),prior_text:section.text,claims:chosen.map(c=>({id:c.id,text:c.text,references:JSON.parse(c.references_json)}))};
  const output=await editorialCall(db,config,source.task_id,input);calls++;
  if(!output.visuals.length){
    const items=output.text.split(/^###\s+/m).slice(1).map((s:string)=>{const [label,...rest]=s.split('\n');const first=rest.join('\n').trim().split(/\n\s*\n/)[0];return {label:label.trim().slice(0,100),text:first.split(/(?<=。)/).filter(Boolean).slice(0,2).join('').slice(0,600),claim_ids:section.claim_ids.slice(0,20)};}).filter((s:Row)=>s.text.length>=5).slice(0,4);
    if(items.length>=2)output.visuals=[{kind:'matrix',title:'本章判断对照',caption:'从本章已审查材料的分析段落提取，引用范围同本章；不表示量化评分。',items}];
  }
  let proposed={...section,text:output.text,visuals:output.visuals};
  // Validate the whole document after each local edit; never publish unchecked model output.
  try{validateReport(db,source.task_id,{...document,sections:document.sections.map((s:Row,n:number)=>n===i?proposed:s)},stage.data.contract);}
  catch(error){console.log('本章需一次局部修订：'+String(error));if(calls>=14)throw error;
    const repair=await editorialCall(db,config,source.task_id,{...input,prior_text:output.text,previous_visuals:output.visuals,correction:String(error),instruction:'仅修正明确报错的事实数值或结构；保留分析深度。不要重新生成其他章节。'});calls++;proposed={...section,text:repair.text,visuals:repair.visuals};
    validateReport(db,source.task_id,{...document,sections:document.sections.map((s:Row,n:number)=>n===i?proposed:s)},stage.data.contract);
  }
  document.sections[i]=proposed;
  writeFileSync(join(dir,'document.json'),encode(document));
  const preview=renderReport(db,source.task_id,validateReport(db,source.task_id,document,stage.data.contract));writeFileSync(join(dir,'preview.html'),preview.html);
  console.log('已保存 '+section.title+'，'+proposed.text.length+' 字符，'+proposed.visuals.length+' 个分析图');
}
const result=await reviseReport(db,service,sourceId,document,data);writeFileSync(join(dir,'result.json'),encode(result));
console.log(JSON.stringify(result));db.close();
