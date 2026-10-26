import type {Database,Row} from '../domain/db.js';
import {reportNumberIssues} from './numeric-support.js';

/** Read-only candidates, never automatic attribution or a waiver of numerical checks. */
export function numericSupportHints(db:Database,taskId:string,values:string[]){
 const claims=db.rows('SELECT * FROM claims WHERE task_id=? ORDER BY created_at,rowid',taskId);
 return values.map(value=>{const matches=claims.flatMap((c,i)=>{const refs=JSON.parse(c.references_json),source=c.text+'\n'+refs.map((r:Row)=>r.quote).join('\n');return reportNumberIssues(value,source,[],0).length?[]:[{claim_number:i+1,claim_id:c.id,text:c.text.slice(0,500)}];});return {value,candidates:matches.slice(0,8),candidate_count:matches.length,note:matches.length?'同值只是候选：须核对主体、单位、时间，不可借其他实体的数字':'当前已审查结论池无该数字依据：收窄该句或针对已有归档原文补证，不得凭空补引用'};});
}
