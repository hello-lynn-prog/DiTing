import {encode,hash,type Database,type Row} from '../domain/db.js';

/** All claim citations with exact, bounded neighbouring source context, read from storage once. */
export function verificationPacket(db:Database,taskId:string){
  const sources=new Map(db.rows('SELECT e.* FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=?',taskId).map(e=>[e.id,e])),windows=new Map<string,Row>();
  const claims=db.rows('SELECT id,text,references_json FROM claims WHERE task_id=? ORDER BY id',taskId).map(c=>({id:c.id,text:c.text,references:JSON.parse(c.references_json).map((ref:Row)=>{
    const source=sources.get(ref.evidence_id);if(!source)throw Error('核验材料引用不属于本任务');const at=source.content.indexOf(ref.quote);if(at<0)throw Error('核验引文已不在归档原文中');
    const id=hash(encode([ref.evidence_id,ref.quote])),offset=Math.max(0,at-240),end=Math.min(source.content.length,at+ref.quote.length+240);
    if(!windows.has(id))windows.set(id,{id,evidence_id:source.id,url:source.source_url,title:source.title,content_hash:source.content_hash,quote:ref.quote,quote_offset:at,offset,end_offset:end,content:source.content.slice(offset,end),total_chars:source.content.length});
    return {window_id:id,...ref};
  })}));
  const data={claims,source_windows:[...windows.values()]};return {...data,hash:hash(encode(data)),claim_count:claims.length,reference_count:claims.reduce((n,c)=>n+c.references.length,0),source_count:new Set([...windows.values()].map(w=>w.evidence_id)).size,scope:'全部引用的逐字引文及前后各240字符；不是来源全文，也不证明来源真实性。上下文不足须evidence_read续读，视觉引用另读观察产物。'};
}
