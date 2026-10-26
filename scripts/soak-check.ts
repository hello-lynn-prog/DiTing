/** Passive observation of the running console. Does not create tasks or calls. */
import {appendFileSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {settings} from '../apps/server/settings.js';
import {Database,now} from '../packages/domain/db.js';
import {saveSoakStatus,type SoakStatus} from '../packages/domain/soak-status.js';

const hours=Number(process.argv.find(x=>x.startsWith('--hours='))?.split('=')[1]||24);
if(!Number.isFinite(hours)||hours<=0||hours>48)throw Error('--hours 必须介于 0 和 48 之间');
const cfg=settings(),parent=join(cfg.dataDir,'qa');mkdirSync(parent,{recursive:true});
const folder=mkdtempSync(join(parent,'soak-')),began=Date.now(),deadline=began+hours*3600000;
const summary:SoakStatus={folder,pid:process.pid,started_at:now(),finished_at:null,duration_hours:hours,status:'running',checks:0,failures:0,last_check_at:null,production_certified:false};
const pointer=join(parent,'soak-latest.json');saveSoakStatus(pointer,summary);
let stopping=false;for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;});
do{
  const stamp=now();let result:Record<string,unknown>={checked_at:stamp};
  try{
    const response=await fetch('http://127.0.0.1:'+cfg.port+'/api/health',{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error('health HTTP '+response.status);const health=await response.json() as any;
    if(health.status!=='ok')throw Error('health 状态异常');
    const db=new Database(join(cfg.dataDir,'diting.sqlite3'),cfg.root);
    try{result={...result,status:'ok',ui_revision:health.ui_revision,tasks:db.rows('SELECT status,COUNT(*) count FROM tasks GROUP BY status'),sources:db.rows('SELECT status,COUNT(*) count FROM hotlist_snapshots WHERE created_at>=? GROUP BY status',summary.started_at),signals:db.one('SELECT COUNT(*) count FROM signals WHERE created_at>=?',summary.started_at)?.count,notifications:db.rows('SELECT status,COUNT(*) count FROM outbox WHERE created_at>=? GROUP BY status',summary.started_at),monitoring_runs:db.one("SELECT COUNT(*) count FROM events WHERE kind='monitoring.finished' AND created_at>=?",summary.started_at)?.count};}finally{db.close();}
  }catch(error){summary.failures++;result={...result,status:'failed',error:error instanceof Error?error.message:'observation failed'};}
  summary.checks++;summary.last_check_at=stamp;appendFileSync(join(folder,'checks.jsonl'),JSON.stringify(result)+'\n');
  saveSoakStatus(pointer,summary);
  if(stopping||Date.now()>=deadline)break;
  await new Promise<void>(resolve=>{const timer=setTimeout(done,Math.min(60000,Math.max(0,deadline-Date.now())));function done(){clearTimeout(timer);process.off('SIGINT',done);process.off('SIGTERM',done);resolve();}process.once('SIGINT',done);process.once('SIGTERM',done);});
}while(!stopping&&Date.now()<=deadline);
summary.finished_at=now();summary.status=stopping?'interrupted':summary.failures?'completed_with_failures':'completed';
saveSoakStatus(pointer,summary);
console.log(JSON.stringify(summary));
