import {join} from 'node:path';
import {writeFileSync,mkdirSync} from 'node:fs';
import {NativeSentimentEngine} from '../packages/sentiment/engine.js';
const dataDir=process.env.DITING_DATA_DIR||join(process.cwd(),'data');mkdirSync(join(dataDir,'diagnostics'),{recursive:true});const engine=new NativeSentimentEngine(join(dataDir,'models/multilingual-sentiment-v1'));
const texts=['这个产品太棒了，用起来很方便，我非常满意！','太差了，根本不能用，售后也不解决问题，非常失望。','该公司今天发布了产品说明。','I absolutely love this product. It works perfectly!','This is terrible. It broke immediately and support refused to help.'];
const started=performance.now(),predictions=await engine.predict(texts);
const result={model_version:engine.version,total_ms:performance.now()-started,results:predictions.map((p,i)=>({text:texts[i],...p}))};writeFileSync(join(dataDir,'diagnostics/sentiment-real-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
