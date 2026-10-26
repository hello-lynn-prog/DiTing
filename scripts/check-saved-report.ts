import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,copyFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {settings} from '../apps/server/settings.js';
import {Database} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {ReportPipeline} from '../packages/reporting/pipeline.js';

// Revalidate a consistent copy of the saved report; never publish or mutate the live task.
const taskId=process.argv[2];if(!/^task_[a-f0-9]{32}$/.test(taskId||''))throw Error('请提供任务ID');
const cfg=settings(),dir=join(cfg.dataDir,'diagnostics','report-flow-'+Date.now());mkdirSync(dir,{recursive:true});
const source=new DatabaseSync(join(cfg.dataDir,'diting.sqlite3'),{readOnly:true});
try{await backup(source,join(dir,'diting.sqlite3'));}finally{source.close();}
const db=new Database(join(dir,'diting.sqlite3'),cfg.root),service=new Service(db),pipeline=new ReportPipeline(db,service,taskId);
try{
  mkdirSync(join(dir,'media'),{recursive:true});
  for(const v of db.rows('SELECT content_hash,media_type,frames_json FROM visual_assets WHERE task_id=?',taskId)){
    const files=[...(JSON.parse(v.frames_json)||[]).map((f:{hash:string})=>f.hash+'.jpg'),...['png','jpg','webp','mp4','webm'].map(ext=>v.content_hash+'.'+ext)];
    for(const file of files)if(existsSync(join(cfg.dataDir,'media',file)))copyFileSync(join(cfg.dataDir,'media',file),join(dir,'media',file));
  }
  const preview=pipeline.preview(),datasets=preview.document.tables.map((t:{id:string})=>t.id),checkpoint=pipeline.progress();
  let result:unknown;
  try{const last=db.one("SELECT data_json FROM artifacts WHERE task_id=? AND kind='report_submission' ORDER BY rowid DESC LIMIT 1",taskId);result=pipeline.finalize(last?JSON.parse(last.data_json).input:{title:'近七天 AI 行业争议研判',template_id:checkpoint.template_id,dataset_ids:datasets,limitations:['本次仅分析已归档公开网页，不代表平台总体声量；正文判断按原有证据范围解读。']});}
  catch(error){result={passed:false,message:error instanceof Error?error.message:String(error)};}
  const summary={task_id:taskId,checked_at:new Date().toISOString(),source_untouched:true,checkpoint,result};
  writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({dir,result},null,2));
}finally{db.close();}
