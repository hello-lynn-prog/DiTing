import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import assert from 'node:assert/strict';
import {NativeMiniLM,SemanticSampler} from '../packages/sampling/semantic.js';import {settings} from '../apps/server/settings.js';
const dataDir=settings().dataDir,engine=new NativeMiniLM(join(dataDir,'models/paraphrase-multilingual-MiniLM-L12-v2'));
const began=performance.now(),texts=['这款人工智能模型的安全治理需要改进。','应当加强AI系统的风险控制和安全管理。','今天的足球比赛进入加时赛。'],vectors=await engine.embed(texts);
const cosine=(a:number[],b:number[])=>a.reduce((n,v,i)=>n+v*b[i],0)/Math.sqrt(a.reduce((n,v)=>n+v*v,0)*b.reduce((n,v)=>n+v*v,0));
const related=cosine(vectors[0],vectors[1]),unrelated=cosine(vectors[0],vectors[2]);assert.ok(related>unrelated,'real related sentence must score above unrelated sentence');
const sampler=new SemanticSampler(dataDir,engine),rows=Array.from({length:40},(_,i)=>({id:String(i),title:texts[i%3],content:'',hotness_score:i})),sample=await sampler.sample(rows,()=>{});assert.equal(sample.method,'multilingual-minilm-kmeans');
const {rows:selected,...sampling}=sample,result={status:'passed',elapsed_ms:performance.now()-began,related_cosine:related,unrelated_cosine:unrelated,model_version:engine.version,embedding_dimensions:vectors[0].length,sampling,selected_ids:selected.map(r=>r.id),scope:'real-local-model-smoke-not-a-topic-accuracy-benchmark',checked_at:new Date().toISOString()};
mkdirSync(join(dataDir,'diagnostics'),{recursive:true});writeFileSync(join(dataDir,'diagnostics','semantic-real-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
