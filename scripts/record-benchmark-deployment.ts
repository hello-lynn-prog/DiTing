import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {Database,encode,hash,uid,now} from '../packages/domain/db.js';
const taskId=process.argv[2],reason=process.argv[3];if(!taskId||!reason)throw Error('需要明确任务编号及部署原因');
const manifestPath=process.argv[4]||'data/diagnostics/depth-benchmark-clean.json',manifest=JSON.parse(readFileSync(manifestPath,'utf8'));if(manifest.task_id!==taskId)throw Error('清单任务不一致，未修改任务');
const root=process.cwd(),db=new Database(join(root,'data/diting.sqlite3'),root);
try{if(db.one('SELECT status FROM tasks WHERE id=?',taskId)?.status!=='paused')throw Error('只能在任务暂停时记录变更');
 const files:Record<string,string>={};function walk(path:string){for(const name of readdirSync(path)){const p=join(path,name);if(statSync(p).isDirectory())walk(p);else files[relative(root,p).replace(/\\/g,'/')]=createHash('sha256').update(readFileSync(p)).digest('hex');}}walk(join(root,'dist/apps'));walk(join(root,'dist/packages'));
 const stamp=now(),id=uid('artifact');db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',id,taskId,'code_deployment','system',encode({at:stamp,reason,files,fingerprint_method:'sha256 of compiled file bytes',no_model_route_change:true,baseline_interrupted:true}),stamp);db.event(taskId,'benchmark.deployment',{message:reason,artifact_id:id,baseline_interrupted:true});
 manifest.clean=false;manifest.interventions||=[];manifest.interventions.push({at:stamp,artifact_id:id,reason,compiled_files:Object.keys(files).length});writeFileSync(manifestPath,JSON.stringify(manifest,null,2));console.log(JSON.stringify({id,taskId,files:Object.keys(files).length,baseline_interrupted:true}));
}finally{db.close();}
