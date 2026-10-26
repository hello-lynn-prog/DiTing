import type {Database,Row} from '../domain/db.js';

/** Stable within the reviewed claim version; exact positional binding, never fuzzy ID repair. */
export function reportClaimNumbers(db:Database,taskId:string,input:unknown):any{
 const ids=db.rows('SELECT id FROM claims WHERE task_id=? ORDER BY created_at,rowid',taskId).map(c=>c.id);
 const visit=(value:any):any=>{
  if(Array.isArray(value))return value.map(visit);if(!value||typeof value!=='object')return value;
  const result:Row=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='claim_numbers').map(([key,item])=>[key,visit(item)]));
  if(Object.hasOwn(value,'claim_numbers')){if(Object.hasOwn(value,'claim_ids'))throw Error('claim_numbers和claim_ids二选一');if(!Array.isArray(value.claim_numbers)||!value.claim_numbers.length||value.claim_numbers.some((n:unknown)=>!Number.isInteger(n)||Number(n)<1||Number(n)>ids.length))throw Error('结论序号不存在于本任务当前版本');result.claim_ids=[...new Set(value.claim_numbers.map((n:number)=>ids[n-1]))];}
  return result;
 };return visit(input);
}
