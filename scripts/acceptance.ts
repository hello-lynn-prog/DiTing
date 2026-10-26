/** Repeatable acceptance evidence. Native cases use explicit synthetic providers, not paid keys. */
import {spawn} from 'node:child_process';import {mkdirSync,mkdtempSync,writeFileSync,createWriteStream,readFileSync} from 'node:fs';
import {join} from 'node:path';import {createHash} from 'node:crypto';import {ROOT,settings} from '../apps/server/settings.js';
const parent=join(settings().dataDir,'qa');mkdirSync(parent,{recursive:true});const folder=mkdtempSync(join(parent,'acceptance-'));
const cases:{name:string;args:string[];scope:string}[]=[
 {name:'typecheck',args:['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json'],scope:'static'},
 {name:'unit-and-dom',args:['--import','tsx','--test','--test-concurrency=1','tests-ts/*.test.ts'],scope:'isolated-automated'},
 {name:'build',args:['node_modules/typescript/bin/tsc','-p','tsconfig.json'],scope:'build'},
];
if(process.argv.includes('--native'))for(const [name,flags] of [
 ['native-report',['--full','--engine-sections','--glm-profile','--large-materials']],['native-followup',['--followup']],
 ['native-fail-closed',['--fail-closed']],['native-cancel',['--cancel']],['native-skills',['--skills']],
 ['native-mcp-http',['--mcp']],['native-mcp-stdio',['--mcp-stdio']],['native-mcp-denial',['--mcp','--mcp-fail']],
 ['native-crawl-approval',['--crawl-approval']],['native-crawl-session',['--crawl-session']],
 ['native-approval-feedback',['--approval-feedback']],
] as [string,string[]][])cases.push({name,args:['--import','tsx','scripts/runtime-check.ts',...flags],scope:'native-dsh-synthetic-not-real-business'});
if(process.argv.includes('--browser'))cases.push({name:'browser',args:['--import','tsx','scripts/browser-check.ts'],scope:'isolated-chromium'});
const results:Record<string,unknown>[]=[],started=new Date().toISOString();
const save=()=>writeFileSync(join(folder,'result.json'),JSON.stringify({started_at:started,updated_at:new Date().toISOString(),status:results.length===cases.length?(results.every(r=>r.status==='passed')?'passed':'failed'):'running',results,production_certified:false,note:'Only the named checks ran. Real models, logged platforms, notifications, source availability, report quality and 24h observation need their own evidence.'},null,2));
save();
for(const item of cases){
 const log=join(folder,item.name+'.log'),output=createWriteStream(log),began=Date.now();console.log('START '+item.name);
 const exit=await new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,item.args,{cwd:ROOT,windowsHide:true,env:process.env,stdio:['ignore','pipe','pipe']});child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});child.once('error',reject);child.once('close',resolve);});
 await new Promise<void>(resolve=>output.end(resolve));const sha256=createHash('sha256').update(readFileSync(log)).digest('hex');results.push({name:item.name,status:exit===0?'passed':'failed',scope:item.scope,exit_code:exit,elapsed_seconds:Math.round((Date.now()-began)/100)/10,log,sha256});save();console.log((exit===0?'PASS ':'FAIL ')+item.name);
 if(exit!==0&&['typecheck','build'].includes(item.name))break;
}
save();console.log(JSON.stringify({folder,passed:results.filter(r=>r.status==='passed').length,total:cases.length,production_certified:false}));if(results.some(r=>r.status==='failed')||results.length!==cases.length)process.exitCode=1;
