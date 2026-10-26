/** Apply an explicit per-slot output plan; preserve model, key reference and rates, with rollback evidence. */
import {join} from 'node:path';import {mkdirSync,writeFileSync} from 'node:fs';import {Database,now} from '../packages/domain/db.js';import {Configuration} from '../packages/domain/configuration.js';import {settings} from '../apps/server/settings.js';
const cfg=settings(),db=new Database(join(cfg.dataDir,'diting.sqlite3'),cfg.root),config=new Configuration(db,cfg.dataDir);
try{
 if(db.one("SELECT id FROM tasks WHERE status='running'"))throw Error('研究运行中，不修改验收配置');
 const limits={planner:8192,insight:12288,media:12288,query:12288,forum:4096,report:16384,keyword:4096},changes=Object.entries(limits).flatMap(([id,limit])=>{const route=config.route(id);return route?[{id,before:route.max_tokens,after:Math.min(route.max_tokens,limit)}]:[];});
 const record={at:now(),reason:'用户要求修复执行效率；为角色分配有限单次输出，报告按章生成；不改模型/凭据/费率，不改已有任务冻结配置',changes,applied:process.argv.includes('--apply')};
 if(record.applied)db.transaction(()=>{for(const change of changes){const route=config.route(change.id)!;config.set('llm.'+change.id,{...route,max_tokens:change.after});}db.event(null,'config.efficiency_limits',record);});
 mkdirSync(join(cfg.dataDir,'diagnostics'),{recursive:true});writeFileSync(join(cfg.dataDir,'diagnostics','efficiency-limits-'+Date.now()+'.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record));
}finally{db.close();}
