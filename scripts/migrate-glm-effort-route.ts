/** Explicit, audited protocol migration after a successful same-credential GLM probe. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT,settings} from '../apps/server/settings.js';
import {Database,encode,hash,uid,now,type Row} from '../packages/domain/db.js';
import {Configuration,routeSchema} from '../packages/domain/configuration.js';
const taskId=process.argv[2];if(!/^task_[a-f0-9]{32}$/.test(taskId||''))throw Error('Explicit task ID required');
const paths=settings(),db=new Database(join(paths.dataDir,'diting.sqlite3'),ROOT),config=new Configuration(db,paths.dataDir);
try{
 const task=db.one('SELECT * FROM tasks WHERE id=?',taskId);if(task?.status!=='paused')throw Error('Pause task before changing its frozen route');
 const planner=config.route('planner'),media=config.route('media'),probe=JSON.parse(readFileSync(join(paths.dataDir,'diagnostics/glm-openai-low-effort-probe.json'),'utf8'));
 if(probe.result?.method!=='keyword_model'||probe.protocol!=='openai-completions'||probe.base_url!==planner?.base_url||probe.model!==planner?.model||planner?.protocol!=='openai-completions'||new URL(planner.base_url).hostname!=='open.bigmodel.cn')throw Error('Successful official same-model OpenAI probe is required');
 const before=JSON.parse(task.config_json),after=structuredClone(before),changed:Row[]=[];
 for(const id of ['insight','media','query','forum','keyword']){
  const old=before.model_routes[id];if(!old||old.protocol!=='anthropic-messages')continue;
  if(old.model.toLowerCase()!==planner.model.toLowerCase()||new URL(old.base_url).hostname!=='open.bigmodel.cn'||config.secret(old.key_ref)!==config.secret(media!.key_ref))throw Error('Unprobed account/model for '+id);
  const next={...old,protocol:'openai-completions',base_url:planner.base_url,model:planner.model};const {key_ref,...publicInput}=next;routeSchema.parse(publicInput);after.model_routes[id]=next;changed.push({id,before:old,after:next});
 }
 db.transaction(()=>{const snapshot=uid('artifact');db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',snapshot,taskId,'model_route_migration','system',encode({reason:'GLM native reasoning_effort low is not transmitted by budget-based Anthropic SDK; official same-model OpenAI probe succeeded',before,after,changes:changed,probe,previous_config_hash:hash(encode(before))}),now());db.run('UPDATE tasks SET config_json=?,revision=revision+1 WHERE id=?',encode(after),taskId);for(const entry of changed)config.set('llm.'+entry.id,entry.after);db.event(taskId,'config.protocol_migrated',{message:'显式迁移已暂停任务及未来研究槽到同一GLM模型的OpenAI兼容入口；保留原配置、费用、凭据引用与成果',artifact_id:snapshot,roles:changed.map(c=>c.id),model:planner.model,reasoning_effort:'low'});});console.log(JSON.stringify({task_id:taskId,changed:changed.map(c=>c.id),same_model:planner.model,credentials_preserved:true}));
}finally{db.close();}
