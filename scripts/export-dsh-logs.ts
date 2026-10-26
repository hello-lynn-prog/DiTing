import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';import {join,relative} from 'node:path';import {createHash} from 'node:crypto';
import {settings} from '../apps/server/settings.js';import {decodeDshLog} from '../packages/domain/dsh-log-reader.js';
const taskId=process.argv[2];if(!/^task_[a-f0-9]{32}$/.test(taskId||''))throw Error('需要任务编号');const cfg=settings(),root=join(cfg.dataDir,'dsh',taskId,'sessions');if(!existsSync(root))throw Error('任务尚无dsh会话');
const folder=join(cfg.dataDir,'exports',taskId,'dsh-readable-'+Date.now()),logs:Record<string,unknown>[]=[];mkdirSync(folder,{recursive:true});
function walk(directory:string){for(const item of readdirSync(directory,{withFileTypes:true})){const path=join(directory,item.name);if(item.isDirectory())walk(path);else if(item.name==='session.v4.jsonl.zstd'){
 const bytes=readFileSync(path),result=decodeDshLog(bytes),session=relative(root,directory).split(/[\\/]/).at(-1)!;writeFileSync(join(folder,session+'.jsonl'),result.text);
 logs.push({session,source:path,source_sha256:createHash('sha256').update(bytes).digest('hex'),frames:result.frames,consumed_bytes:result.consumed_bytes,trailing_bytes:result.trailing_bytes,status:result.status,error:result.error,decoded_chars:result.text.length});
}}}walk(root);
writeFileSync(join(folder,'manifest.json'),JSON.stringify({task_id:taskId,exported_at:new Date().toISOString(),scope:'read-only-point-in-time; a running session can have a partial final frame; original compressed log retained',logs},null,2));console.log(JSON.stringify({folder,sessions:logs.length,frames:logs.reduce((n,l)=>n+Number(l.frames),0),partial:logs.filter(l=>l.status==='partial').length}));
