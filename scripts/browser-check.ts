/** Real Chromium against an isolated app/DB. No credentials, paid models or origin requests. */
import {mkdirSync,mkdtempSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
import {chromium} from 'playwright';import assert from 'node:assert/strict';
import {ROOT} from '../apps/server/settings.js';import {createApp} from '../apps/server/app.js';
const parent=join(ROOT,'data','qa');mkdirSync(parent,{recursive:true});const folder=mkdtempSync(join(parent,'browser-'));
const {app,db}=await createApp({dataDir:folder,runtimeEnabled:false},false);
const executable=process.env.DITING_CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch({headless:true,...executable?{executablePath:executable}:{}});
const failures:string[]=[],pages:Record<string,unknown>[]=[];
try{
 await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw Error('test listener missing');const base='http://127.0.0.1:'+address.port;
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>failures.push(error.message));page.on('response',response=>{if(response.url().startsWith(base+'/api/')&&response.status()>=400)failures.push('API '+response.status()+' '+new URL(response.url()).pathname);});
 await page.route('**/*',route=>{const url=route.request().url();return url.startsWith(base)||url.startsWith('data:')?route.continue():route.abort('blockedbyclient');});
 await page.goto(base,{waitUntil:'networkidle'});await page.waitForSelector('body[data-live-ready]',{timeout:20000});
 for(const id of ['dash','chat','tasks','hot','sigs','src','crawl','report','tpl','custom','usage','llm','agent','mcp','skill','tools','keys','rules','approve','logs','conf']){
  await page.evaluate(value=>(window as any).v4Go(value),id);await page.waitForTimeout(100);
  const panel=page.locator('#p-'+id);assert.equal(await panel.count(),1,'missing '+id);assert.ok(await panel.isVisible(),'hidden '+id);assert.ok((await panel.innerText()).trim().length>5,'empty '+id);
  pages.push({id,visible:true,buttons:await panel.locator('button').count(),text_chars:(await panel.innerText()).length});
  if(['dash','chat','src','report','custom'].includes(id))await page.screenshot({path:join(folder,id+'.png'),fullPage:true});
 }
 await page.evaluate(()=>(window as any).v4Go('src'));const configuredSources=await page.evaluate(async()=>{const response=await fetch('/api/hotlists/sources');return (await response.json()).configured.length;});assert.equal(await page.locator('#p-src .src-card').count(),configuredSources,'source cards must match the live directory');
 await page.evaluate(()=>(window as any).v4Go('chat'));for(const label of ['系统自选','用户上传','人机共创'])assert.equal(await page.getByRole('button',{name:label}).count(),1,'missing template mode '+label);assert.ok(await page.getByRole('button',{name:'系统自选'}).getAttribute('aria-pressed')==='true');await page.getByRole('button',{name:'用户上传'}).click();assert.equal(await page.getByRole('button',{name:'上传 Markdown'}).count(),1);await page.getByRole('button',{name:'系统自选'}).click();
 await page.evaluate(()=>(window as any).v4Go('hot'));await page.getByRole('button',{name:'热点日报'}).click();await page.getByText('多主题热点日报',{exact:false}).waitFor({timeout:5000});assert.ok((await page.locator('#wf-hot-body').innerText()).includes('多主题热点日报'));assert.equal(db.one('SELECT COUNT(*) n FROM tasks')!.n,0,'template choices and daily digest navigation must not start research');
 const saveTemplate=async(name:string,origin:'user_import'|'co_created')=>page.evaluate(async({name,origin})=>{const r=await fetch('/api/templates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,origin,markdown:`# ${name}\n## 报告摘要\n## 事实背景\n## 多方观点\n## 影响分析\n## 风险研判\n## 结论与建议`})});if(!r.ok)throw Error(await r.text());return r.json();},{name,origin});
 const userTemplate=await saveTemplate('浏览器上传模板','user_import'),coTemplate=await saveTemplate('浏览器共创模板','co_created');await page.evaluate(async()=>{await (window as any).nativeSync();(window as any).v4Go('chat');});await page.getByRole('button',{name:'用户上传'}).click();await page.getByLabel('选择报告模板').selectOption(userTemplate.id);await page.evaluate(()=>(window as any).v4Send('调查上传模板流程验收主题'));await page.waitForFunction(async()=>((await (await fetch('/api/tasks')).json()) as any[]).some(t=>t.title.includes('调查上传模板流程验收主题')));let tasks=await page.evaluate(async()=>fetch('/api/tasks').then(r=>r.json()));assert.equal(tasks.find((t:any)=>t.title.includes('调查上传模板流程验收主题')).config.template_selection.mode,'user_import');
 await page.getByRole('button',{name:'人机共创'}).click();await page.getByLabel('选择报告模板').selectOption(coTemplate.id);await page.evaluate(()=>(window as any).v4Send('调查共创模板流程验收主题'));await page.waitForFunction(async()=>((await (await fetch('/api/tasks')).json()) as any[]).some(t=>t.title.includes('调查共创模板流程验收主题')));tasks=await page.evaluate(async()=>fetch('/api/tasks').then(r=>r.json()));assert.equal(tasks.find((t:any)=>t.title.includes('调查共创模板流程验收主题')).config.template_selection.mode,'co_created');
 await page.evaluate(()=>(window as any).v4Go('tpl'));assert.equal(await page.locator('#p-tpl .native-card').count(),8,'six built-in templates and two saved custom templates');
 await page.evaluate(()=>(window as any).v4Go('llm'));assert.equal(await page.locator('[data-native-route]').count(),9);
 assert.equal(db.one('SELECT COUNT(*) n FROM tasks')!.n,2,'only the two explicit template-flow checks may create tasks; navigation must not start research');
 assert.deepEqual(failures,[],'real-browser errors');
 const result={status:'passed',pages,failures,scope:'isolated-real-chromium-ui-navigation-no-live-business-acceptance',production_certified:false,folder,checked_at:new Date().toISOString()};writeFileSync(join(folder,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){writeFileSync(join(folder,'result.json'),JSON.stringify({status:'failed',error:String(error),pages,failures,production_certified:false},null,2));throw error;}
finally{await browser.close();await app.close();}
