import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {hash,type Database,type Row} from './db.js';import {NativeMiniLM,type EmbeddingEngine} from '../sampling/semantic.js';
const tokenize=(text:string)=>{const normalized=text.toLocaleLowerCase().replace(/\s+/g,'');const set=new Set<string>(normalized.match(/[a-z]{2,}/g)||[]);for(const part of normalized.match(/[\p{Script=Han}]+/gu)||[])for(let i=0;i+2<=part.length;i++)set.add(part.slice(i,i+2));return set;};
const lexical=(a:string,b:string)=>{const x=tokenize(a),y=tokenize(b);return [...x].filter(t=>y.has(t)).length/Math.max(1,new Set([...x,...y]).size);};
const cosine=(a:number[],b:number[])=>{if(a.length!==b.length||a.some(v=>!Number.isFinite(v))||b.some(v=>!Number.isFinite(v)))throw Error('历史检索向量无效');const norm=Math.sqrt(a.reduce((n,v)=>n+v*v,0)*b.reduce((n,v)=>n+v*v,0));return norm?a.reduce((n,v,i)=>n+v*b[i],0)/norm:0;};
export class HistoricalResearch{
 private native?:EmbeddingEngine;
 constructor(readonly db:Database,readonly dataDir:string,readonly engine?:EmbeddingEngine){}
 async lookup(query:string,excludeTask?:string,limit=5,guard=()=>{}){
  guard();if(!query.trim()||query.length>500||!Number.isInteger(limit)||limit<1||limit>10)throw Error('历史检索主题或数量不合法');
  const seen=new Set<string>(),candidates=this.db.rows('SELECT id,task_id,version,created_at,document_json FROM reports ORDER BY created_at DESC,version DESC').filter(r=>{if(r.task_id===excludeTask||seen.has(r.task_id))return false;seen.add(r.task_id);return true;}).slice(0,200).map(r=>{
   const document=JSON.parse(r.document_json),summary=String(document.sections?.find((s:Row)=>/摘要|概览|综述/.test(s.title))?.text||'').slice(0,500);return {report_id:r.id,task_id:r.task_id,version:r.version,published_at:r.created_at,title:String(document.title||''),summary};
  });
  if(!candidates.length)return {query,method:'empty-history',results:[],evidence:false};
  let scores=candidates.map(c=>lexical(query,c.title+' '+c.summary)),method='lexical-jaccard-fallback',model_version:string|undefined,reason:string|undefined;
  const directory=join(this.dataDir,'models/paraphrase-multilingual-MiniLM-L12-v2');
  if(this.engine||existsSync(join(directory,'manifest.json')))try{
   const engine=this.engine||(this.native||=new NativeMiniLM(directory));model_version=engine.version;
   const cache=join(this.dataDir,'cache','historical',engine.version);mkdirSync(cache,{recursive:true});
   const texts=[query,...candidates.map(c=>c.title+'\n'+c.summary)],vectors:number[][]=[];
   for(let i=0;i<texts.length;i++){guard();const text=Array.from(texts[i]).slice(0,500).join(''),path=join(cache,hash(text)+'.json');if(existsSync(path)){vectors.push(JSON.parse(readFileSync(path,'utf8')));continue;}const [vector]=await engine.embed([text]);guard();vectors.push(vector);writeFileSync(path,JSON.stringify(vector));}
   scores=candidates.map((_,i)=>cosine(vectors[0],vectors[i+1]));method='multilingual-minilm-cosine';
  }catch(error){guard();reason=error instanceof Error?error.message:'本地模型不可用';}
  guard();return {query,method,model_version,reason,candidate_tasks:candidates.length,results:candidates.map((c,i)=>({...c,score:Math.round(scores[i]*1e6)/1e6})).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||b.published_at.localeCompare(a.published_at)).slice(0,limit),evidence:false,note:'相似度是检索排序，不是事件相同或结论正确率。历史结论不能直接作为本任务事实；比较前须重新归档并核验相应来源。'};
 }
}
