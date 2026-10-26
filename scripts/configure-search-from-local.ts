/** Import only a verified Tavily credential from the user-authorized local file.
 * Never print key material or copy the source file into the project.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Database} from '../packages/domain/db.js';
import {Configuration} from '../packages/domain/configuration.js';
import {ROOT} from '../apps/server/settings.js';
const file=process.argv[2];if(!file)throw new Error('请指定用户授权的本地凭据文件');
const db=new Database(join(ROOT,'data/diting.sqlite3'),ROOT),config=new Configuration(db,join(ROOT,'data'));
try{
 const candidates=[...new Set([config.secret('service.tavily'),...readFileSync(file,'utf8').matchAll(/\btvly-(?:dev|prod)-[A-Za-z0-9_-]{15,}/g)].map(v=>typeof v==='string'?v:v?.[0]).filter((v):v is string=>!!v))].slice(0,3);
 let verified=false;
 for(const [index,key] of candidates.entries()){
  try{const response=await fetch('https://api.tavily.com/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({api_key:key,query:'人工智能 监管 官方通报',max_results:1,search_depth:'basic',include_answer:false}),signal:AbortSignal.timeout(20000)});
   if(!response.ok){console.log(JSON.stringify({provider:'tavily',candidate:index+1,status:response.status}));continue;}
   const payload=await response.json() as any;if(!Array.isArray(payload.results)||!payload.results.length){console.log(JSON.stringify({provider:'tavily',candidate:index+1,status:'no_results'}));continue;}
   db.transaction(()=>{config.putSecret('service.tavily',key);config.set('service.tavily',{base_url:'https://api.tavily.com/search',enabled:true});});console.log(JSON.stringify({provider:'tavily',verified:true,stored_encrypted:true,results:payload.results.length}));verified=true;break;
  }catch{console.log(JSON.stringify({provider:'tavily',candidate:index+1,status:'network_error'}));}
 }
 if(!verified)console.log(JSON.stringify({provider:'tavily',verified:false,configuration_changed:false}));
}finally{db.close();}
