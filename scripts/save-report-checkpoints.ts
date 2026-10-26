/** Recover unaccepted chapter text exactly from dsh logs; never publishes or approves it. */
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {zstdDecompressSync} from 'node:zlib';
import {ROOT,settings} from '../apps/server/settings.js';
import {Database,encode,hash,uid,now,type Row} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {ReportPipeline} from '../packages/reporting/pipeline.js';
const taskId=process.argv[2];if(!/^task_[a-f0-9]{32}$/.test(taskId||''))throw Error('Explicit task ID required');
const paths=settings(),db=new Database(join(paths.dataDir,'diting.sqlite3'),ROOT),service=new Service(db);
try{
 if(service.rawTask(taskId).status!=='paused')throw Error('Pause task before recovering chapter checkpoints');
 const {scanZstdFrames}=await import(pathToFileURL(join(paths.dshRoot,'packages/session/session-persistence-jsonl/src/zstd.ts')).href),base=join(paths.dataDir,'dsh',taskId,'sessions'),chapters=new Map<string,Row>();
 for(const run of db.rows("SELECT child_session_id FROM agent_runs WHERE task_id=? AND role='report' ORDER BY created_at",taskId))for(const folder of readdirSync(base)){
  let bytes:Buffer;try{bytes=readFileSync(join(base,folder,run.child_session_id,'session.v4.jsonl.zstd'));}catch{continue;}
  for(const frame of scanZstdFrames(bytes).frames)for(const line of zstdDecompressSync(bytes.subarray(frame.start,frame.end)).toString('utf8').split('\n').filter(Boolean)){
   const r=JSON.parse(line),calls=r.type==='tool/call'?[r.data]:r.type==='assistant/message'?(r.data?.message?.content||[]).filter((b:Row)=>b.type==='tool-call'):[];
   for(const call of calls){if(call.name!=='report_stage')continue;const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;if(args.stage!=='chapter')continue;const data=typeof args.data==='string'?JSON.parse(args.data):args.data;if(!data?.id||typeof data.text!=='string')continue;const previous=chapters.get(data.id);if(!previous||r.time>=previous.time)chapters.set(data.id,{time:r.time,data,native_call_id:call.callId||call.id});}
  }
 }
 const already=new Set(new ReportPipeline(db,service,taskId).progress().chapters.filter((c:Row)=>c.saved).map((c:Row)=>c.id)),saved:Row[]=[];
 for(const [chapterId,value] of chapters){if(already.has(chapterId))continue;const digest=hash(encode(value.data));if(db.one("SELECT id FROM artifacts WHERE task_id=? AND kind='report_chapter_submission' AND json_extract(data_json,'$.recovered_input_hash')=?",taskId,digest))continue;const id=uid('artifact'),invalid=(value.data.claim_ids||[]).filter((cid:string)=>!db.one('SELECT id FROM claims WHERE task_id=? AND id=?',taskId,cid));
  db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',id,taskId,'report_chapter_submission','report',encode({...value,input_version:service.reviewInput(taskId),recovered_input_hash:digest,status:'rejected',error:'未接受的原生章节参数；须重验。无效结论编号：'+invalid.join('、'),source:'native_model_tool_arguments_unvalidated'}),now());db.event(taskId,'report.chapter_checkpoint_recovered',{message:'保留未通过章节原始文本，仅作修复检查点，未发布报告',chapter_id:chapterId,artifact_id:id,chars:value.data.text.length});saved.push({chapter_id:chapterId,artifact_id:id,chars:value.data.text.length,invalid_claim_ids:invalid});
 }console.log(JSON.stringify({task_id:taskId,checkpoints:saved},null,2));
}finally{db.close();}
