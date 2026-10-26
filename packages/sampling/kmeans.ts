/** Seeded k-means++/Lloyd implementation. Ten restarts match the upstream sampling strategy. */
const distance=(a:number[],b:number[])=>a.reduce((n,v,i)=>n+(v-b[i])**2,0);
function random(seed:number){return ()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
export function kmeans(vectors:number[][],clusters:number,seed=42,restarts=10){
 if(!vectors.length||!vectors[0].length||vectors.some(v=>v.length!==vectors[0].length||v.some(n=>!Number.isFinite(n))))throw Error('聚类向量必须为同维度有限数值');
 if(!Number.isInteger(clusters)||clusters<1||clusters>vectors.length)throw Error('聚类数不合法');
 let best:{labels:number[];centers:number[][];inertia:number}|undefined;
 for(let run=0;run<restarts;run++){
  const rng=random(seed+run),centers=[vectors[Math.floor(rng()*vectors.length)].slice()];
  while(centers.length<clusters){const distances=vectors.map(v=>Math.min(...centers.map(c=>distance(v,c)))),sum=distances.reduce((a,b)=>a+b,0);let index=0;
   if(sum){let value=rng()*sum;for(index=0;index<distances.length-1;index++){value-=distances[index];if(value<=0)break;}}else index=centers.length%vectors.length;
   centers.push(vectors[index].slice());
  }
  let labels=vectors.map(()=>-1);
  for(let step=0;step<100;step++){
   const next=vectors.map(v=>{let index=0,score=Infinity;centers.forEach((c,i)=>{const d=distance(v,c);if(d<score){index=i;score=d;}});return index;});
   if(next.every((v,i)=>v===labels[i]))break;labels=next;
   for(let group=0;group<clusters;group++){const indices=labels.flatMap((label,i)=>label===group?[i]:[]);if(!indices.length)continue;
    centers[group]=vectors[0].map((_,d)=>indices.reduce((n,i)=>n+vectors[i][d],0)/indices.length);
   }
  }
  const inertia=vectors.reduce((n,v,i)=>n+distance(v,centers[labels[i]]),0);if(!best||inertia<best.inertia)best={labels,centers:centers.map(c=>c.slice()),inertia};
 }
 return best!;
}
export function clusteredSample<T>(items:T[],vectors:number[][],maxResults=30,perCluster=5,heat:(item:T)=>number=()=>0){
 if(!Number.isInteger(maxResults)||maxResults<1||!Number.isInteger(perCluster)||perCluster<1)throw Error('抽样数量必须为正整数');
 if(items.length<=maxResults)return {items,indices:items.map((_,i)=>i),sampled:false,clusters:items.length};
 if(items.length!==vectors.length)throw Error('抽样材料与向量数量不一致');
 const clusters=Math.min(Math.max(2,Math.floor(maxResults/perCluster)),items.length),result=kmeans(vectors,clusters),indices:number[]=[];
 for(let group=0;group<clusters;group++){
  const members=result.labels.flatMap((label,i)=>label===group?[i]:[]).sort((a,b)=>{const ah=heat(items[a]),bh=heat(items[b]);return (Number.isFinite(bh)?bh:0)-(Number.isFinite(ah)?ah:0)||a-b;});
  for(const index of members.slice(0,perCluster)){indices.push(index);if(indices.length===maxResults)break;}if(indices.length===maxResults)break;
 }
 return {items:indices.map(i=>items[i]),indices,sampled:true,clusters,nonempty_clusters:new Set(result.labels).size,inertia:result.inertia};
}
