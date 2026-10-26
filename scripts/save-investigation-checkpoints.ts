/** Recover exact rejected tool arguments from native dsh logs; never creates claims or approvals. */
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {zstdDecompressSync} from 'node:zlib';
import {ROOT,settings} from '../apps/server/settings.js';
import {Database,encode,hash,now,uid,type Row} from '../packages/domain/db.js';

const taskId=process.argv[2];if(!/^task_[a-f0-9]{32}$/.test(taskId||''))throw Error('Provide one explicit task ID');
const configuration=settings(),db=new Database(join(configuration.dataDir,'diting.sqlite3'),ROOT);
try{
 const task=db.one('SELECT * FROM tasks WHERE id=?',taskId);if(task?.status!=='paused')throw Error('Task must be paused before reading recovery checkpoints');
 const {scanZstdFrames}=await import(pathToFileURL(join(configuration.dshRoot,'packages/session/session-persistence-jsonl/src/zstd.ts')).href);
 const base=join(configuration.dataDir,'dsh',taskId,'sessions'),roles=db.rows("SELECT child_session_id,root_session_id,role FROM agent_runs WHERE task_id=? AND role IN ('insight','media','query') ORDER BY created_at",taskId),saved:Row[]=[];
 for(const run of roles){
  let latest:Row|undefined;
  for(const workspace of readdirSync(base)){
   let bytes:Buffer;try{bytes=readFileSync(join(base,workspace,run.child_session_id,'session.v4.jsonl.zstd'));}catch{continue;}
   const records=scanZstdFrames(bytes).frames.flatMap((frame:Row)=>zstdDecompressSync(bytes.subarray(frame.start,frame.end)).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)));
   latest=records.filter((r:Row)=>r.type==='tool/call'&&r.data?.name==='investigation_submit').at(-1);
  }
  if(!latest||db.one("SELECT id FROM artifacts WHERE task_id=? AND role=? AND kind='investigation'",taskId,run.role))continue;
  const args=typeof latest.data.arguments==='string'?JSON.parse(latest.data.arguments):latest.data.arguments;
  for(const key of ['claims','gaps'])if(typeof args[key]==='string')args[key]=JSON.parse(args[key]);
  if(!Array.isArray(args.claims)||!Array.isArray(args.gaps))throw Error('Rejected submission shape unavailable for '+run.role);
  const digest=hash(encode(args)),existing=db.one("SELECT id FROM artifacts WHERE task_id=? AND kind='investigation_submission' AND json_extract(data_json,'$.recovered_input_hash')=?",taskId,digest);if(existing)continue;
  const failure=db.one("SELECT payload_json FROM events WHERE task_id=? AND kind='tool.failed' AND json_extract(payload_json,'$.child_session_id')=? AND json_extract(payload_json,'$.tool')='investigation_submit' ORDER BY id DESC LIMIT 1",taskId,run.child_session_id);
  const id=uid('artifact');db.transaction(()=>{db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',id,taskId,'investigation_submission',run.role,encode({...args,status:'rejected',error:failure?JSON.parse(failure.payload_json).message:'Native submission saved before pause; requires revalidation',child_session_id:run.child_session_id,root_session_id:run.root_session_id,recovered_input_hash:digest,native_call_id:latest!.data.callId,native_sequence:latest!.seq,source:'dsh_native_tool_call_recovery'}),now());db.event(taskId,'investigation.checkpoint_recovered',{message:'从原生dsh日志保存最后提交原文，未创建或认可任何结论',role:run.role,artifact_id:id,input_hash:digest});});saved.push({role:run.role,artifact_id:id,claims:args.claims.length,input_hash:digest});
 }
 console.log(JSON.stringify({task_id:taskId,checkpoints:saved},null,2));
}finally{db.close();}
