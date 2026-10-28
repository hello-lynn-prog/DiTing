/** One bounded paid acceptance. Preserves earlier benchmark records and the first report. */
import {DatabaseSync} from 'node:sqlite';import {readFileSync,writeFileSync,readdirSync,statSync,mkdirSync} from 'node:fs';import {join,relative} from 'node:path';import {createHash} from 'node:crypto';import {settings} from '../apps/server/settings.js';
const cfg=settings(),origin='http://127.0.0.1:'+cfg.port,db=new DatabaseSync(join(cfg.dataDir,'diting.sqlite3'),{readOnly:true});
try{
 if(Number((db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('running','queued')").get() as any).n))throw Error('已有研究执行/排队，不启动另一条收费验收');
 const previous=[...new Set(['task_749f614c7a674d399645d2a26a604b19','task_79eafcae38794f2998819378e7887e96',...readdirSync(join(cfg.dataDir,'diagnostics')).filter(name=>/^release-benchmark-\d+\.json$/.test(name)).flatMap(name=>{const saved=JSON.parse(readFileSync(join(cfg.dataDir,'diagnostics',name),'utf8'));return saved.task_id?[saved.task_id]:[];})])];
 const spent=previous.reduce((total,id)=>total+Number((db.prepare('SELECT COALESCE(SUM(COALESCE(actual_cost,reserved_cost)),0) n FROM model_reservations WHERE task_id=?').get(id) as any).n),0),budget=Math.min(5,Math.floor((20-spent)*100)/100);if(budget<3)throw Error('共同验收预算余额不足，不自动追加');
 const health=await(await fetch(origin+'/api/health')).json() as any;if(!health.runtime.ready)throw Error('研究运行条件未就绪');
 const fingerprints:Record<string,string>={};function walk(directory:string){for(const entry of readdirSync(directory)){const path=join(directory,entry);if(statSync(path).isDirectory())walk(path);else fingerprints[relative(cfg.root,path).replaceAll('\\','/')]=createHash('sha256').update(readFileSync(path)).digest('hex');}}for(const name of ['dist/apps','dist/packages','web','assets/report-templates'])walk(join(cfg.root,name));
 const title=`请深度研判近7天AI行业争议，重点覆盖AI Agent落地、世界模型与物理AI、融资预期、安全治理四个方面，预算上限${budget}元。采用社会公共热点事件分析报告内置模板，完整保留六章及编号子节，按本项目完整报告约40000字规划，结合具体案例、多方观点、机制、影响与行动建议展开。按真实材料承载能力写，不凑字数、不编数据。报告使用中文，包含可验证的数据表、有用的图表和文末溯源。允许复用已归档公开原文作为语料库，保留原采集时间及复用记录，并检索更新材料；本次范围限公开网页，不另发起平台登录深采。`;
 const saved={started_at:new Date().toISOString(),budget,previous_task_ids:previous,previous_known_and_reserved:spent,title,code_fingerprints:fingerprints,condition:'fixed version; warm public archive reuse; no platform crawl; first publication retained; no operator edits or automatic paid restart',clean:true,task_id:null as string|null,session_id:null as string|null};
 mkdirSync(join(cfg.dataDir,'diagnostics'),{recursive:true});const file=join(cfg.dataDir,'diagnostics','release-benchmark-'+Date.now()+'.json');
 if(process.argv.includes('--dry-run')){console.log(JSON.stringify({...saved,code_fingerprints:Object.keys(fingerprints).length,dry_run:true}));}
 else{
  const post=async(path:string,payload:unknown)=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),body=await response.json() as any;if(!response.ok)throw Error('验收请求失败：'+response.status);return body;};
  const session=await post('/api/sessions',{title:'固定版本 · 全链路首次成稿验收'});saved.session_id=session.id;writeFileSync(file,JSON.stringify(saved,null,2));
  const result=await post('/api/sessions/'+session.id+'/messages',{text:title,request_id:'release-benchmark-'+Date.now()});if(!result.task_id)throw Error('研究未入队');saved.task_id=result.task_id;writeFileSync(file,JSON.stringify(saved,null,2));console.log(JSON.stringify({file,...saved,code_fingerprints:Object.keys(fingerprints).length}));
 }
}finally{db.close();}
