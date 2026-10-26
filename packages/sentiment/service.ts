import {join,dirname} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {Configuration} from '../domain/configuration.js';
import {Service} from '../domain/service.js';
import {hash,encode,uid,now,type Row} from '../domain/db.js';
import {NativeSentimentEngine,BatchedSentimentEngine,type SentimentEngine} from './engine.js';

export class LocalSentiment {
  private engine?:SentimentEngine;
  private inflight=new Map<string,Promise<Row>>();
  readonly directory:string;
  constructor(readonly service:Service,readonly config:Configuration,engine?:SentimentEngine){this.engine=engine;this.directory=join(dirname(service.db.path),'models','bettafish-multilingual-sentiment');}
  settings(taskId?:string):Row {const frozen=taskId?JSON.parse(this.service.rawTask(taskId).config_json).sentiment:null;return frozen||this.config.get('sentiment.local',{enabled:false,min_confidence:0.5});}
  freeze(){const value=this.settings(),path=join(this.directory,'manifest.json');return {...value,model_version:existsSync(path)?hash(encode(JSON.parse(readFileSync(path,'utf8')))):null};}
  status(){const path=join(this.directory,'manifest.json'),installed=existsSync(path),manifest=installed?JSON.parse(readFileSync(path,'utf8')):null;return {...this.settings(),installed,model_id:'tabularisai/multilingual-sentiment-analysis',runtime:'typescript-onnx-cpu',labels:['非常负面','负面','中性','正面','非常正面'],revision:manifest?.revision||null,cloud_token_cost:0,input_scope:'每条前512个分词token，超过截断；置信度是模型输出，不是正确率',completed:Number(this.service.db.one('SELECT COUNT(*) n FROM sentiment_inferences')?.n||0)};}
  async annotate(taskId:string,evidenceIds:string[],guard:()=>void){
    if(!this.settings(taskId).enabled)return {enabled:false,results:[]};
    this.engine ||= new BatchedSentimentEngine(new NativeSentimentEngine(this.directory));
    const frozen=this.settings(taskId).model_version;if(frozen&&frozen!==this.engine.version)throw Error('本任务冻结的独立情感模型版本与本地文件不符');
    const engine=this.engine,db=this.service.db;
    const results=await Promise.all([...new Set(evidenceIds)].map(async evidenceId=>{
      guard();const evidence=db.one('SELECT e.* FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? AND e.id=?',taskId,evidenceId);if(!evidence)throw Error('情感输入不属于本任务');
      const current=db.one('SELECT result_json FROM sentiment_inferences WHERE task_id=? AND evidence_id=? AND model_version=?',taskId,evidenceId,engine.version);if(current){return {...JSON.parse(current.result_json),reused:true};}
      const key=taskId+':'+evidenceId;let pending=this.inflight.get(key);
      if(!pending){pending=this.predictAndSave(taskId,evidence,engine,guard);this.inflight.set(key,pending);pending.finally(()=>this.inflight.delete(key)).catch(()=>{});}
      return await pending;
    }));
    return {enabled:true,method:'local_sentiment_model',model_version:engine.version,results};
  }
  private async predictAndSave(taskId:string,e:Row,engine:SentimentEngine,guard:()=>void){
    const db=this.service.db,text=e.title+'\n'+e.content,inputHash=hash(text),cached=db.one('SELECT result_json FROM sentiment_prediction_cache WHERE input_hash=? AND model_version=?',inputHash,engine.version),started=performance.now();
    let prediction:Row;
    try{prediction=cached?JSON.parse(cached.result_json):(await engine.predict([text]))[0];if(!prediction)throw Error('情感推理没有返回结果');}
    catch(error){guard();db.event(taskId,'sentiment.failed',{message:'独立情感模型推理失败，不退回大模型伪装成功',evidence_id:e.id,error:error instanceof Error?error.message:'推理失败'});throw error;}
    guard();const threshold=Number(this.settings(taskId).min_confidence??0.5),result:Row={...prediction,sentiment:prediction.confidence<threshold?'unknown':prediction.sentiment,evidence_id:e.id,input_hash:inputHash,model_id:'tabularisai/multilingual-sentiment-analysis',model_version:engine.version,method:'local_sentiment_model',input_scope:'first_512_tokens',cloud_tokens:0,cloud_cost:0,cache_hit:!!cached,elapsed_ms:performance.now()-started};
    return db.transaction(()=>{guard();const existing=db.one('SELECT result_json FROM sentiment_inferences WHERE task_id=? AND evidence_id=? AND model_version=?',taskId,e.id,engine.version);if(existing)return {...JSON.parse(existing.result_json),reused:true};if(!cached)db.run('INSERT OR IGNORE INTO sentiment_prediction_cache VALUES(?,?,?,?)',inputHash,engine.version,encode(prediction),now());
      db.run('INSERT OR IGNORE INTO sentiment_inferences VALUES(?,?,?,?,?,?)',uid('sentiment'),taskId,e.id,engine.version,encode(result),now());
      const prior=db.one("SELECT data_json FROM artifacts WHERE task_id=? AND kind='sample_annotation' AND json_extract(data_json,'$.evidence_id')=? ORDER BY rowid DESC LIMIT 1",taskId,e.id),annotation=prior?JSON.parse(prior.data_json):{};
      db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',uid('artifact'),taskId,'sample_annotation','sentiment',encode({...annotation,...result,topics:annotation.topics||[],quote:e.content.slice(0,250),reason:'独立五级分类器输出；中性保留，低于阈值标为未知；仅对实际输入文本有效'}),now());
      db.run('UPDATE tasks SET evidence_revision=evidence_revision+1,revision=revision+1 WHERE id=?',taskId);
      db.event(taskId,'sentiment.completed',{message:'独立情感推理已保存，无云端Token费',evidence_id:e.id,model_version:engine.version,label:result.label,confidence:result.confidence,cache_hit:result.cache_hit,elapsed_ms:result.elapsed_ms});return result;
    });
  }
}
