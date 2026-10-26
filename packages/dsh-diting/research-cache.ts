import type {Configuration} from '../domain/configuration.js';
import {encode,hash,now,uid,type Database,type Row} from '../domain/db.js';

/** A task/date/provider scoped search cache; failures are never cached as success. */
const pendingSearches=new WeakMap<Database,Map<string,Promise<Row>>>();
export async function cachedSearch(db:Database,taskId:string,key:Row,operation:()=>Promise<Row>){
  const fingerprint=hash(encode(key)),cached=db.one("SELECT id,data_json FROM artifacts WHERE task_id=? AND kind='search_cache' AND json_extract(data_json,'$.fingerprint')=? ORDER BY rowid DESC LIMIT 1",taskId,fingerprint);
  if(cached){const value=JSON.parse(cached.data_json);if(Date.now()-Date.parse(value.created_at)<15*60000){db.event(taskId,'research.search_reused',{message:'复用同任务、同查询和窗口的成功检索',artifact_id:cached.id});return {...value.result,cache_hit:true,cache_artifact_id:cached.id};}}
  let pending=pendingSearches.get(db);if(!pending){pending=new Map();pendingSearches.set(db,pending);}const pendingKey=taskId+':'+fingerprint,active=pending.get(pendingKey);if(active)return {...await active,inflight_shared:true};
  const job=(async()=>{const result=await operation();if(result.results?.length&&result.sources?.every((s:Row)=>!s.error&&!s.skipped)){const id=uid('artifact');db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',id,taskId,'search_cache','collector',encode({fingerprint,result,created_at:now()}),now());}return {...result,cache_hit:false};})();pending.set(pendingKey,job);try{return await job;}finally{pending.delete(pendingKey);}
}
export function searchIdentity(config:Configuration,query:string,window:Row,providers?:string[]){return {query:query.normalize('NFKC').trim().replace(/\s+/g,' '),window,providers:providers||['tavily','bocha','anspire'],configuration:['tavily','bocha','anspire'].map(id=>({id,config:config.get('service.'+id,{}),credential_hash:hash(config.secret('service.'+id)||'')}))};}

export function evidenceIndex(rows:Row[],query:string){return rows.map(e=>{const at=e.content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()),offset=Math.max(0,at-120);return {id:e.id,title:e.title,url:e.source_url,captured_at:e.captured_at,content_chars:e.content.length,match_offset:at<0?null:at,preview:e.content.slice(offset,offset+500),content_hash:e.content_hash};});}

export class ContextReuse {
  private snapshots=new Map<string,{signature:string,collections:Record<string,Map<string,string>>}>();
  project(agentId:string,context:Row,force=false):Row{
    const signature=hash(encode(context)),previous=this.snapshots.get(agentId),collections:Record<string,Map<string,string>>={};
    for(const key of ['evidence','claims','artifacts'])collections[key]=new Map(context[key].map((item:Row)=>[item.id,hash(encode(item))]));
    this.snapshots.set(agentId,{signature,collections});
    if(!previous||force)return {...context,context_version:signature,unchanged:false,delta:false};
    if(previous.signature!==signature){
      const changes:Row={},removed:Row={};for(const key of Object.keys(collections)){changes[key]=context[key].filter((item:Row)=>previous.collections[key].get(item.id)!==collections[key].get(item.id));removed[key]=[...previous.collections[key].keys()].filter(id=>!collections[key].has(id));}
      return {...context,...changes,context_version:signature,base_context_version:previous.signature,unchanged:false,delta:true,removed,counts:{...context.counts,evidence:context.evidence.length,claims:context.claims.length,artifacts:context.artifacts.length},note:'本子会话材料增量：合并新增/变更项目，removed 中编号从当前目录移除；保留此前已读正文。需要完整目录用 task_context(full=true)。'};
    }
    return {task:context.task,review_input:context.review_input,report_checkpoint:context.report_checkpoint,context_version:signature,unchanged:true,counts:{...context.counts,evidence:context.evidence.length,claims:context.claims.length,artifacts:context.artifacts.length},agents:context.agents,note:'研究材料版本未变化；复用本子会话上次完整上下文。需要强制重读时 task_context(full=true)。'};
  }
}
