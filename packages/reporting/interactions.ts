import type {Row} from '../domain/db.js';
export const interactionMetrics={likes:'点赞',comments:'评论',reposts:'转发',plays:'播放',replies:'回复'} as const;
export const interactionDimensions=Object.keys(interactionMetrics).map(k=>'interaction_'+k);
export function interactionRows(evidence:Row[],dimension:string):[string,number][]{
  const metric=dimension.replace(/^interaction_/,''),seen=new Set<string>(),groups=new Map<string,number>();
  if(!(metric in interactionMetrics))return [];
  for(const e of evidence)for(const record of e.platform_records||[]){
    const key=`${record.platform}:${record.record_type}:${record.record_id}`;
    if(seen.has(key))continue;seen.add(key);
    const value=record.metrics?.[metric];
    // Unknown must never become zero. An observed zero is retained.
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)continue;
    const label=`${record.platform} · ${record.record_type}`,total=(groups.get(label)||0)+value;
    if(!Number.isSafeInteger(total))throw Error('互动指标累计超出精确整数范围');groups.set(label,total);
  }
  return [...groups].sort((a,b)=>a[0].localeCompare(b[0]));
}
