/** Download-only installer; runtime inference is TypeScript/ONNX and never calls Python. */
import {createReadStream,existsSync,mkdirSync,renameSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const manifest={"model_id": "tabularisai/multilingual-sentiment-analysis", "converted_repo": "maximka608/multilingual-sentiment-analysis-ONNX", "revision": "3022fd62fd378c1a05af00933495f98da1ea872d", "dtype": "fp32", "license": "cc-by-nc-4.0", "files": {"README.md": {"sha256": "57ed1f75bf177074d8b126c6bb3c189ce7906ae19d0dfd467715e987641295e2", "bytes": 10365}, "config.json": {"sha256": "1cea36cec2455b05b73012857046af3b8929ecc076432eea9f6428aaf2aa297e", "bytes": 957}, "tokenizer.json": {"sha256": "bf1b59b7b11c95f194f51708d918eea378e09d05f84c0e1656dc5180e8117088", "bytes": 2919362}, "tokenizer_config.json": {"sha256": "91955163d30880d1ef0928cfdd729baaf413401dc4456f3ab1a48b3eec2ec624", "bytes": 1228}, "special_tokens_map.json": {"sha256": "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a", "bytes": 695}, "vocab.txt": {"sha256": "fe0fda7c425b48c516fc8f160d594c8022a0808447475c1a7c6d6479763f310c", "bytes": 995526}, "onnx/model.onnx": {"sha256": "011cf31ba5c6ea46085c71eb3b13106de11ed7684d1629a3aa56a85551c94a23", "bytes": 541447608}}};
const directory=resolve(process.env.DITING_DATA_DIR||'data','models','multilingual-sentiment-v1');mkdirSync(directory,{recursive:true});
const digest=async(path:string)=>{const h=createHash('sha256');for await(const bytes of createReadStream(path))h.update(bytes);return h.digest('hex');};
for(const [file,expected] of Object.entries(manifest.files)){
 const destination=join(directory,file);mkdirSync(resolve(destination,'..'),{recursive:true});
 if(existsSync(destination)){if(await digest(destination)!==expected.sha256)throw Error('Existing model differs: '+file);console.log('verified '+file);continue;}
 const url='https://huggingface.co/'+manifest.converted_repo+'/resolve/'+manifest.revision+'/'+file,partial=destination+'.part';
 try{const response=await fetch(url,{signal:AbortSignal.timeout(600000)});if(!response.ok)throw Error('Model download HTTP '+response.status);const handle=await import('node:fs/promises').then(fs=>fs.open(partial,'w'));try{for await(const bytes of response.body as any)await handle.write(bytes);}finally{await handle.close();}}
 catch(error){if(process.platform!=='win32')throw error;const quote=(v:string)=>"'"+v.replaceAll("'","''")+"'";const command='Invoke-WebRequest -UseBasicParsing -Uri '+quote(url)+' -OutFile '+quote(partial);await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:900000});}
 if(await digest(partial)!==expected.sha256)throw Error('Downloaded SHA256 mismatch: '+file);renameSync(partial,destination);console.log('installed '+file);
}
await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));console.log('Independent sentiment assets ready; run npm run sentiment:check.');
