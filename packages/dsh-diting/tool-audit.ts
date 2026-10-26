/** Persist concise, secret-safe progress summaries; full evidence/results live in their own records. */
export function summarizeToolResult(value:unknown){
  if(!value||typeof value!=='object'||Array.isArray(value))return {result_type:Array.isArray(value)?'array':typeof value};
  const row=value as Record<string,unknown>,summary:Record<string,unknown>={};
  for(const key of ['evidence_id','artifact_id','report_id','approval_id','batch_id','visual_id','asset_id','status','executed','reused','saved','gate','passed','provider','role','total_records','next_offset','has_more']){
    const item=row[key];if(['string','number','boolean'].includes(typeof item))summary[key]=typeof item==='string'?item.slice(0,180):item;
  }
  for(const key of ['items','results','records','pages','rows','claims','evidence_ids','formats'])if(Array.isArray(row[key]))summary[key+'_count']=(row[key] as unknown[]).length;
  if(Array.isArray(row.sources))summary.sources=(row.sources as Record<string,unknown>[]).slice(0,12).map(source=>({provider:typeof source.provider==='string'?source.provider.slice(0,80):null,count:typeof source.count==='number'?source.count:null,failed:!!source.error}));
  if(typeof row.error==='string')summary.failed=true;
  return summary;
}
