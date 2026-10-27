import {readFileSync,existsSync,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {hash,encode,type Row} from '../domain/db.js';

export const sentimentLabels=['very_negative','negative','neutral','positive','very_positive'] as const;
export interface SentimentPrediction {label:string;sentiment:'positive'|'neutral'|'negative'|'unknown';confidence:number;probabilities:Record<string,number>;input_tokens:number;max_tokens:number;elapsed_ms:number;}
export interface SentimentEngine {version:string;predict(texts:string[]):Promise<SentimentPrediction[]>;}
export function logitsPrediction(logits:number[],inputTokens:number,elapsed:number):SentimentPrediction {
  if(logits.length!==5||logits.some(n=>!Number.isFinite(n)))throw Error('情感模型必须返回五类有限 logits');
  const max=Math.max(...logits),exps=logits.map(n=>Math.exp(n-max)),sum=exps.reduce((a,b)=>a+b,0),scores=exps.map(n=>n/sum),winner=scores.indexOf(Math.max(...scores));
  return {label:sentimentLabels[winner],sentiment:winner<2?'negative':winner===2?'neutral':'positive',confidence:scores[winner],probabilities:Object.fromEntries(sentimentLabels.map((label,i)=>[label,scores[i]])),input_tokens:inputTokens,max_tokens:512,elapsed_ms:elapsed};
}

/** Five-class DistilBERT sentiment model, executed locally through ONNX. */
export class NativeSentimentEngine implements SentimentEngine {
  readonly version:string;
  readonly manifest:Row;
  private loading?:Promise<{tokenizer:any;model:any}>;
  constructor(readonly directory:string){
    this.manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));this.version=hash(encode(this.manifest));
    if(this.manifest.model_id!=='tabularisai/multilingual-sentiment-analysis')throw Error('情感模型来源不符');
  }
  private load(){return this.loading ||= (async()=>{
    for(const [file,expected] of Object.entries(this.manifest.files) as [string,Row][]){if(file.includes('..')||file.startsWith('/')||file.includes(':')||!existsSync(join(this.directory,file)))throw Error('本地模型文件缺失或路径不合法');
      const digest=createHash('sha256');for await(const chunk of createReadStream(join(this.directory,file)))digest.update(chunk);if(digest.digest('hex')!==expected.sha256)throw Error('本地情感模型文件哈希不匹配：'+file);}
    const hf:any=await import('@huggingface/transformers');hf.env.allowRemoteModels=false;
    const options={local_files_only:true},tokenizer=await hf.AutoTokenizer.from_pretrained(this.directory,options),model=await hf.AutoModelForSequenceClassification.from_pretrained(this.directory,{...options,device:'cpu',dtype:'fp32',session_options:{intraOpNumThreads:2,interOpNumThreads:1}});
    const expected=['Very Negative','Negative','Neutral','Positive','Very Positive'];for(let i=0;i<5;i++)if(model.config.id2label[String(i)]!==expected[i])throw Error('情感标签映射不匹配');
    return {tokenizer,model};
  })();}
  async predict(texts:string[]){
    if(!texts.length)return [];if(texts.length>8)throw Error('情感批次最多8条');
    const {tokenizer,model}=await this.load(),started=performance.now(),inputs=await tokenizer(texts,{padding:true,truncation:true,max_length:512}),result=await model(inputs);
    const logits=Array.from(result.logits.data,Number),width=Number(inputs.attention_mask.dims[1]),mask=Array.from(inputs.attention_mask.data,Number),elapsed=performance.now()-started;
    if(logits.length!==texts.length*5)throw Error('情感模型批次输出形状错误');
    return texts.map((_,i)=>logitsPrediction(logits.slice(i*5,i*5+5),mask.slice(i*width,(i+1)*width).reduce((a,b)=>a+b,0),elapsed/texts.length));
  }
}

/** Coalesce concurrent one-record calls from all three engines into bounded native batches. */
export class BatchedSentimentEngine implements SentimentEngine {
  readonly version:string;
  private queue:{texts:string[];resolve:(p:SentimentPrediction[])=>void;reject:(e:unknown)=>void}[]=[];
  private running=false;
  constructor(readonly engine:SentimentEngine){this.version=engine.version;}
  predict(texts:string[]):Promise<SentimentPrediction[]>{
    if(texts.length>8)return Promise.reject(Error('情感批次最多8条'));
    return new Promise((resolve,reject)=>{this.queue.push({texts,resolve,reject});if(!this.running){this.running=true;queueMicrotask(()=>void this.flush());}});
  }
  private async flush(){while(this.queue.length){const jobs:typeof this.queue=[];let size=0;while(this.queue.length&&size+this.queue[0].texts.length<=8){const job=this.queue.shift()!;jobs.push(job);size+=job.texts.length;}try{const result=await this.engine.predict(jobs.flatMap(j=>j.texts));let offset=0;for(const job of jobs){job.resolve(result.slice(offset,offset+job.texts.length));offset+=job.texts.length;}}catch(error){for(const job of jobs)job.reject(error);}}this.running=false;}
}
