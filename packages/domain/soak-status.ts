import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export interface SoakStatus {
  folder:string;pid:number;started_at:string;finished_at:string|null;duration_hours:number;
  status:string;checks:number;failures:number;last_check_at:string|null;production_certified:false;
}
export function saveSoakStatus(pointer:string,status:SoakStatus){
  // Both files contain the same generation. A killed writer cannot leave partial JSON.
  for(const file of [join(status.folder,'summary.json'),pointer]){
    const temp=file+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(status,null,2));renameSync(temp,file);
  }
}
export function readSoakStatus(pointer:string,at=Date.now(),alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}}):Record<string,unknown>{
  if(!existsSync(pointer))return {status:'not_started',production_certified:false};
  try{
    let saved=JSON.parse(readFileSync(pointer,'utf8')) as SoakStatus;
    const summary=join(saved.folder,'summary.json');
    if(existsSync(summary)){
      const latest=JSON.parse(readFileSync(summary,'utf8'));
      if(latest.started_at===saved.started_at)saved={...saved,...latest,folder:saved.folder,pid:saved.pid};
    }
    const heartbeat=Date.parse(saved.last_check_at||saved.started_at);
    const age=Number.isFinite(heartbeat)?Math.max(0,at-heartbeat):Infinity;
    const dead=saved.status==='running'&&!alive(saved.pid),stale=saved.status==='running'&&age>180000;
    return {...saved,...dead||stale?{status:dead?'interrupted':'stale',recorded_status:saved.status,reason:dead?'监测进程已退出，不能作为持续运行验收':'超过三分钟没有监测心跳，持续运行验收尚未成立'}:{},heartbeat_age_seconds:Number.isFinite(age)?Math.round(age/1000):null,production_certified:false};
  }catch{return {status:'invalid',reason:'监测状态无法读取，不能作为验收通过',production_certified:false};}
}
