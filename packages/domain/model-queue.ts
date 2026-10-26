import {setTimeout as delay} from 'node:timers/promises';
import {Configuration} from './configuration.js';
import {Database,hash,type Row} from './db.js';

// Different protocols/keys for the same account must not accidentally bypass its cap.
export function modelAccountScope(config:Configuration,route?:Row){
  if(!route)return 'global';
  let origin:string;try{origin=new URL(route.base_url).origin;}catch{origin=String(route.provider||'unknown');}
  return hash(origin+'\n'+(route.key_ref?config.secret(route.key_ref)||route.key_ref:'anonymous'));
}

/** Called only after the single-writer server lock is acquired at process boot. */
export function recoverModelQueue(db:Database){
  const stale=Number(db.one('SELECT COUNT(*) n FROM model_queue')?.n||0);
  db.run('DELETE FROM model_queue');
  return stale;
}

/** FIFO and pacing per provider account; independent accounts never block each other. */
export async function acquireModelSlot(db:Database,config:Configuration,taskId:string,callId:string,role:string,signal:AbortSignal=AbortSignal.timeout(300000),guard?:()=>void,route?:Row){
  signal=AbortSignal.any([signal,AbortSignal.timeout(300000)]);
  const policy=config.get<{max_concurrency?:number;min_interval_ms?:number}>('model.queue',{});
  const concurrency=Math.max(1,Math.min(8,policy.max_concurrency??4)),gap=Math.max(0,Math.min(60000,policy.min_interval_ms??1000)),scope=modelAccountScope(config,route);
  db.transaction(()=>{db.run("INSERT INTO model_queue(call_id,task_id,role,state,expires_at) VALUES(?,?,?,'waiting',?)",callId,taskId,role,Date.now()+360000);db.run('INSERT INTO model_queue_scopes VALUES(?,?)',callId,scope);});
  try{
    while(true){
      signal.throwIfAborted();guard?.();
      const admitted=db.transaction(()=>{
        const stamp=Date.now();db.run('DELETE FROM model_queue WHERE expires_at<?',stamp);
        const head=db.one("SELECT q.call_id FROM model_queue q LEFT JOIN model_queue_scopes s ON s.call_id=q.call_id WHERE q.state='waiting' AND COALESCE(s.scope,'global')=? ORDER BY q.seq LIMIT 1",scope);
        if(head?.call_id!==callId||db.one("SELECT COUNT(*) n FROM model_queue q LEFT JOIN model_queue_scopes s ON s.call_id=q.call_id WHERE q.state='running' AND COALESCE(s.scope,'global')=?",scope)!.n>=concurrency)return false;
        if(stamp-Number(db.one('SELECT last_started FROM model_account_clocks WHERE scope=?',scope)?.last_started||0)<gap)return false;
        db.run("UPDATE model_queue SET state='running',expires_at=? WHERE call_id=?",stamp+360000,callId);
        db.run('INSERT INTO model_account_clocks VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET last_started=excluded.last_started',scope,stamp);
        return true;
      });
      if(admitted){let released=false;const renew=setInterval(()=>{db.run('UPDATE model_queue SET expires_at=? WHERE call_id=?',Date.now()+360000,callId);},45000);renew.unref();return (cooldownMs=0)=>{if(released)return;released=true;clearInterval(renew);db.transaction(()=>{db.run('DELETE FROM model_queue WHERE call_id=?',callId);if(cooldownMs>0)db.run('UPDATE model_account_clocks SET last_started=MAX(last_started,?) WHERE scope=?',Date.now()+Math.min(60000,cooldownMs),scope);});};}
      await delay(100,undefined,{signal});
    }
  }catch(error){db.run('DELETE FROM model_queue WHERE call_id=?',callId);throw error;}
}
