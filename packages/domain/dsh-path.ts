import {existsSync} from 'node:fs';import {resolve,join} from 'node:path';
export function findDshRoot(root:string,configured?:string,exists=(path:string)=>existsSync(path)){
 if(configured?.trim())return resolve(root,configured.trim());
 const candidates=[resolve(root,'vendor/deepseek-harness'),resolve(root,'../deepseek-harness'),'D:/Study/deepseek_harness/deepseek-harness'];
 return candidates.find(path=>exists(join(path,'packages/sdk/client/lib/index.js')))||candidates[0];
}
