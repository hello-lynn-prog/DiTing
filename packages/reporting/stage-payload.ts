/** Unwrap a redundant same-stage envelope without guessing fields or changing prose. */
export function stagePayload(stage:string,input:unknown):any{
 let value:any=input;
 for(let depth=0;depth<5;depth++){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.stage!==stage||!Object.hasOwn(value,'data'))break;
  const {stage:ignored,data,...overrides}=value;let nested=data;if(typeof nested==='string'){try{nested=JSON.parse(nested);}catch{break;}}
  if(!nested||typeof nested!=='object'||Array.isArray(nested))break;
  if(overrides.id&&nested.id&&overrides.id!==nested.id)throw Error('章节封装中的id冲突，不能猜测目标章节');
  value={...nested,...overrides};
 }return value;
}
