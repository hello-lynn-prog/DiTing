/** Replay exact model-generated recovery data; no prose edits, new claims or gate changes. */
import {Database,encode} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {ReportPipeline} from '../packages/reporting/pipeline.js';
const taskId=process.argv[2],checkpoint=process.argv[3];if(!taskId||!checkpoint)throw Error('需要明确任务与已保存的修复检查点');
const db=new Database('data/diting.sqlite3',process.cwd()),service=new Service(db);
try{if(service.rawTask(taskId).status!=='paused')throw Error('只允许处理暂停任务');const input=service.reviewInput(taskId);
 const source=db.one("SELECT data_json FROM artifacts WHERE id=? AND task_id=? AND kind='report_chapter_submission'",checkpoint,taskId);if(!source)throw Error('仅重放本任务保存的原生模型提交');const saved=JSON.parse(source.data_json);if(encode(saved.input_version)!==encode(input))throw Error('来源版本已变');
 const pipeline=new ReportPipeline(db,service,taskId),result=pipeline.repairChapter(checkpoint,{});db.event(taskId,'report.checkpoint_replayed',{message:'重放原生模型已生成的局部修复全文，仅剔除后台派生字段；无人工文字编辑，待最终报告验证',checkpoint,artifact_id:result.artifact_id,chapter_id:saved.data.id});console.log(JSON.stringify({task_id:taskId,checkpoint,...result}));
}finally{db.close();}
