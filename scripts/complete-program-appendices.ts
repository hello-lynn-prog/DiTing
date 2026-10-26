/** Operator recovery: generate coverage notes only; never modifies analysis, claims or gates. */
import {join} from 'node:path';
import {Database,encode} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {ReportPipeline} from '../packages/reporting/pipeline.js';
const root=process.cwd(),db=new Database(join(root,'data/diting.sqlite3'),root),service=new Service(db),taskId=process.argv[2];
try{if(service.rawTask(taskId).status!=='paused')throw Error('只允许操作已暂停任务');
 const pipeline=new ReportPipeline(db,service,taskId),before=pipeline.progress(),version=service.reviewInput(taskId);
 for(const gate of ['sufficiency','verifier','advocate'])if(!db.one('SELECT passed FROM reviews WHERE task_id=? AND gate=? AND evidence_revision=? AND claims_hash=?',taskId,gate,version.evidence_revision,version.claims_hash)?.passed)throw Error('当前三道门禁未通过');
 const main=before.chapters.filter((c:any)=>!['研究范围与方法','平台样本分析','局限与待核实事项','来源与统计附录'].includes(c.title));if(!main.length||main.some((c:any)=>!c.saved))throw Error('主分析章节尚未完成，不生成替代正文');
 const immutable=main.map((c:any)=>[c.id,c.artifact_id,c.actual_chars]);
 pipeline.record('repair',{issues:['覆盖说明被错误地要求挂分析结论，造成成稿暂停'],actions:['说明由程序根据当前任务生成；保留全部分析正文、原文与审查记录']});
 const after=pipeline.progress(),same=after.chapters.filter((c:any)=>main.some((m:any)=>m.id===c.id)).map((c:any)=>[c.id,c.artifact_id,c.actual_chars]);if(encode(immutable)!==encode(same))throw Error('分析章节发生意外变更');
 db.event(taskId,'report.appendix_recovery',{message:'已自动补齐程序覆盖说明，六章分析正文与审查版本保持；仍由原生Report提交元数据与主Agent发布',main_chapters:main.length});console.log(JSON.stringify({task_id:taskId,main_chapters_unchanged:main.length,saved_chapters:after.chapters.filter((c:any)=>c.saved).length,still_requires_native_finalization:true}));
}finally{db.close();}
