import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {Database,encode,hash,type Row} from './db.js';

export function visualObservationHash(row:Row){return hash(encode({asset_hash:row.content_hash,frames:JSON.parse(row.frames_json),observation:JSON.parse(row.observation_json),call_id:row.call_id}));}
export function visualRecord(db:Database,taskId:string,id:string){return db.one('SELECT o.*,a.content_hash,a.media_type,a.byte_size,a.frames_json,a.source_url,a.final_url,c.status call_status FROM visual_observations o JOIN visual_assets a ON a.id=o.asset_id JOIN model_calls c ON c.id=o.call_id WHERE o.id=? AND o.task_id=? AND a.task_id=o.task_id AND a.evidence_id=o.evidence_id',id,taskId);}
export function verifyVisualFiles(db:Database,row:Row){
  const folder=join(dirname(db.path),'media');
  const entries=[{hash:row.content_hash,extension:row.media_type==='image/png'?'png':row.media_type==='image/jpeg'?'jpg':row.media_type==='video/mp4'?'mp4':'webm'},...JSON.parse(row.frames_json).map((f:Row)=>({hash:f.hash,extension:'jpg'}))];
  for(const item of entries){if(!/^[a-f0-9]{64}$/.test(item.hash))throw Error('视觉素材哈希无效');let bytes:Buffer;try{bytes=readFileSync(join(folder,item.hash+'.'+item.extension));}catch{throw Error('视觉素材归档缺失，不能发布引用它的结论');}if(createHash('sha256').update(bytes).digest('hex')!==item.hash)throw Error('视觉素材归档哈希变化，必须重新取证');}
}
export function validateVisualReference(db:Database,taskId:string,ref:Row){
  if(!ref.visual_id){if(ref.visual_quote||ref.visual_hash)throw Error('视觉引用字段必须一并绑定观察编号');return null;}
  const row=visualRecord(db,taskId,ref.visual_id);
  if(!row||row.evidence_id!==ref.evidence_id||row.status!=='succeeded'||row.call_status!=='succeeded')throw Error('视觉引用必须属于本任务同一来源页且已完成真实模型识别');
  if(ref.visual_hash!==visualObservationHash(row))throw Error('视觉观察版本已变化，请重新核对引用');
  const value=JSON.parse(row.observation_json),quotes=[value.summary,...value.observations.map((x:Row)=>x.text)];
  if(typeof ref.visual_quote!=='string'||ref.visual_quote.trim().length<5||!quotes.some((x:string)=>x.includes(ref.visual_quote)))throw Error('视觉引文必须逐字来自已保存的模型观察');
  verifyVisualFiles(db,row);return row;
}
