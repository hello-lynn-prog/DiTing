/** Pinned, hash-verified model installation. Never downloads implicitly in a research run. */
import {readFileSync,existsSync,createReadStream,mkdirSync,renameSync,writeFileSync} from 'node:fs';import {join,dirname} from 'node:path';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {ROOT,settings} from '../apps/server/settings.js';
const manifest=JSON.parse(readFileSync(join(ROOT,'assets/semantic-model.manifest.json'),'utf8')),directory=join(settings().dataDir,'models/paraphrase-multilingual-MiniLM-L12-v2');
const digest=async(file:string)=>{const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');};
for(const [file,expected] of Object.entries(manifest.files) as [string,{sha256:string}][]){
 if(file.includes('..')||file.startsWith('/')||file.includes(':'))throw Error('Invalid manifest path');const destination=join(directory,file);mkdirSync(dirname(destination),{recursive:true});
 if(existsSync(destination)){if(await digest(destination)!==expected.sha256)throw Error('Existing model differs: '+file);console.log('verified '+file);continue;}
 const url='https://huggingface.co/'+manifest.converted_repo+'/resolve/'+manifest.revision+'/'+file,partial=destination+'.part';
 try{const response=await fetch(url,{signal:AbortSignal.timeout(300000)});if(!response.ok)throw Error('HTTP '+response.status);const handle=await import('node:fs/promises').then(fs=>fs.open(partial,'w'));try{for await(const bytes of response.body as any)await handle.write(bytes);}finally{await handle.close();}}
 catch(error){if(process.platform!=='win32')throw error;const quote=(v:string)=>"'"+v.replaceAll("'","''")+"'";await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','Invoke-WebRequest -UseBasicParsing -Uri '+quote(url)+' -OutFile '+quote(partial)],{windowsHide:true,timeout:300000});}
 if(await digest(partial)!==expected.sha256)throw Error('Downloaded SHA256 mismatch: '+file);renameSync(partial,destination);console.log('installed '+file);
}
writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));console.log('Local MiniLM assets installed. Run npm run sampling:check to verify real inference.');
