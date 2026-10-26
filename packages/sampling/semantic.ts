import {createReadStream,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {encode,hash,uid,type Row} from '../domain/db.js';import {clusteredSample} from './kmeans.js';
export interface EmbeddingEngine{version:string;embed(texts:string[]):Promise<number[][]>;}
export function semanticStatus(dataDir:string){const directory=join(dataDir,'models/paraphrase-multilingual-MiniLM-L12-v2');return {model_id:'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',installed:existsSync(join(directory,'manifest.json'))&&existsSync(join(directory,'onnx/model_quantized.onnx')),method:'multilingual-minilm-kmeans',dtype:'q8',max_candidates:200,max_results:30,per_cluster:5,seed:42,n_init:10,cloud_tokens:0,note:'Insight本地查询候选超过30条时抽样；原文全部保留。模型缺失/失败会明确记录顺序截取回退。情感模型与语义抽样模型各自独立。'};}
export class NativeMiniLM implements EmbeddingEngine{
 readonly manifest:Row;readonly version:string;private loading?:Promise<any>;
 constructor(readonly directory:string){this.manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));if(this.manifest.model_id!=='sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')throw Error('语义模型来源不匹配');this.version=hash(encode(this.manifest));}
 private load(){return this.loading||=(async()=>{
  for(const [name,expected] of Object.entries(this.manifest.files) as [string,Row][]){if(name.includes('..')||name.startsWith('/')||name.includes(':'))throw Error('语义模型路径不合法');const digest=createHash('sha256');for await(const bytes of createReadStream(join(this.directory,name)))digest.update(bytes);if(digest.digest('hex')!==expected.sha256)throw Error('语义模型文件哈希不匹配：'+name);}
  const hf=await import('@huggingface/transformers');return hf.pipeline('feature-extraction',this.directory,{local_files_only:true,dtype:'q8',device:'cpu',session_options:{intraOpNumThreads:2,interOpNumThreads:1}});
 })();}
 async embed(texts:string[]){if(!texts.length)return [];const extractor=await this.load(),output=await extractor(texts,{pooling:'mean',normalize:false,truncation:true,max_length:128});const rows=output.tolist() as number[][];
  if(rows.length!==texts.length||rows.some(v=>v.length!==384||v.some(n=>!Number.isFinite(n))))throw Error('MiniLM 输出形状异常');return rows;
 }
}
export class SemanticSampler{
 private native?:NativeMiniLM;
 constructor(readonly dataDir:string,readonly engine?:EmbeddingEngine){}
 async sample(rows:Row[],guard:()=>void,maxResults=30){
  guard();if(rows.length<=maxResults)return {rows,method:'no-sampling-needed',input_count:rows.length,output_count:rows.length};
  const directory=join(this.dataDir,'models/paraphrase-multilingual-MiniLM-L12-v2');
  if(!this.engine&&!existsSync(join(directory,'manifest.json')))return {rows:rows.slice(0,maxResults),method:'ordered-truncation-fallback',reason:'MiniLM模型尚未安装',input_count:rows.length,output_count:maxResults};
  try{
   const engine=this.engine||(this.native||=new NativeMiniLM(directory)),cache=join(this.dataDir,'cache','semantic',engine.version);mkdirSync(cache,{recursive:true});const vectors:number[][]=[],misses:{index:number;text:string;file:string}[]=[];
   rows.forEach((row,index)=>{const text=Array.from(`${row.title||''}\n${row.content||''}`).slice(0,500).join(''),file=join(cache,hash(text)+'.json');if(existsSync(file)){const vector=JSON.parse(readFileSync(file,'utf8'));if(Array.isArray(vector)&&vector.length&&vector.every(n=>typeof n==='number'&&Number.isFinite(n))){vectors[index]=vector;return;}}misses.push({index,text,file});});
   for(let offset=0;offset<misses.length;offset+=8){guard();const batch=misses.slice(offset,offset+8),result=await engine.embed(batch.map(m=>m.text));guard();if(result.length!==batch.length)throw Error('语义批次数量不一致');batch.forEach((m,i)=>{vectors[m.index]=result[i];const temp=m.file+'.'+uid('vector')+'.tmp';writeFileSync(temp,JSON.stringify(result[i]));renameSync(temp,m.file);});}
   guard();const selected=clusteredSample(rows,vectors,maxResults,5,row=>Number(row.hotness_score)||0);
   return {rows:selected.items,method:'multilingual-minilm-kmeans',model_id:'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',model_version:engine.version,input_scope:'title+content first 500 Unicode characters, at most 128 tokens',dtype:'q8',seed:42,n_init:10,clusters_requested:selected.clusters,clusters_nonempty:selected.nonempty_clusters,cache_hits:rows.length-misses.length,input_count:rows.length,output_count:selected.items.length};
  }catch(error){guard();return {rows:rows.slice(0,maxResults),method:'ordered-truncation-fallback',reason:error instanceof Error?error.message:'MiniLM抽样失败',input_count:rows.length,output_count:maxResults};}
 }
}
