import type {Row} from '../domain/db.js';

/** Adapter error chunks may contain synthetic zero counters, not a vendor bill. */
export function streamUsage(usage:Row|undefined,status:string){
  const valid=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
  if(!usage||!valid(usage.inputTokens)||!valid(usage.outputTokens))return {input:null,output:null,cache:null};
  const read=usage.cacheReadTokens??0,write=usage.cacheWriteTokens??0;
  if(!valid(read)||!valid(write))return {input:null,output:null,cache:null};
  const input=usage.inputTokens+read+write;
  if(status!=='succeeded'&&input===0&&usage.outputTokens===0)return {input:null,output:null,cache:null};
  return {input,output:usage.outputTokens,cache:read};
}
