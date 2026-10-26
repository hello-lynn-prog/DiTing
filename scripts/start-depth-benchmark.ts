import {writeFileSync,readFileSync,existsSync,readdirSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const clean=process.argv.includes('--clean'),dryRun=process.argv.includes('--dry-run');
const origin='http://127.0.0.1:8090',db=new DatabaseSync('data/diting.sqlite3',{readOnly:true});
const old=db.prepare('SELECT title FROM tasks WHERE id=?').get('task_5b7eb7f226ae4b3fa2f936c33f5972a6') as {title:string};
if(!old)throw Error('原始主题不存在');if(!dryRun&&Number((db.prepare("SELECT COUNT(*) n FROM tasks WHERE status='running'").get() as any).n))throw Error('已有研究运行，请先检查，不能并发启动第二条主研究');
const health=await(await fetch(origin+'/api/health')).json() as any;if(!health.runtime.ready)throw Error('研究执行条件未就绪');
const diagnostic='task_749f614c7a674d399645d2a26a604b19',spent=Number((db.prepare('SELECT COALESCE(SUM(COALESCE(actual_cost,reserved_cost)),0) cost FROM model_reservations WHERE task_id=?').get(diagnostic) as any).cost),budget=clean?Math.min(10,Math.floor((20-spent-1)*100)/100):20;if(budget<3)throw Error('本轮共同预算余量不足，不自动新增收费验收');
const title=old.title.replace(/预算上限[0-9.]+元/g,'预算上限'+budget+'元').replace('自动选适合的模板','采用社会公共热点事件分析报告模板')+'\n本轮是同主题全新端到端深度与效率验收，不继承旧结论和门禁。允许复用已归档公开原文作为语料库，保留原采集时间及复用记录；继续检索更新材料。启用本地独立情感模型。主体按六章及原始编号子节写，读取三引擎完整成果，不把资料目录当分析。记录各阶段时间与真实费用；若存在失败，保存明确原因和检查点。';
const finalTitle=clean?`请深度研判近7天AI行业争议，重点覆盖AI Agent落地、世界模型与物理AI、融资预期、安全治理四个方面，预算上限${budget}元。采用社会公共热点事件分析报告内置模板，完整保留六章及编号子节，按BettaFish完整报告约40000字规划，结合具体案例、多方观点、机制、影响与行动建议展开。按真实材料承载能力写，不凑字数、不编数据。报告使用中文，包含可验证的数据表、有用的图表和文末溯源。允许复用已归档公开原文作为语料库，保留原采集时间及复用记录，并检索更新材料；本次范围限公开网页，不另发起平台登录深采。`:title;
function fingerprint(root:string){const files:Record<string,string>={};function walk(dir:string){if(!existsSync(dir))return;for(const entry of readdirSync(dir)){const path=join(dir,entry);if(statSync(path).isDirectory())walk(path);else files[relative(process.cwd(),path).replace(/\\/g,'/')]=createHash('sha256').update(readFileSync(path)).digest('hex');}}walk(root);return files;}
const code_fingerprints={...fingerprint('dist/apps'),...fingerprint('dist/packages'),...fingerprint('assets/templates')};
if(dryRun){console.log(JSON.stringify({clean,budget,diagnostic_known_and_reserved:spent,title:finalTitle,compiled_files:Object.keys(code_fingerprints).length}));db.close();process.exit(0);}
const sessionResponse=await fetch(origin+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'同主题深度与效率验收 · 独立情感模型'})}),session=await sessionResponse.json() as any;
if(!sessionResponse.ok)throw Error('创建验收会话失败');
const response=await fetch(origin+'/api/sessions/'+session.id+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:finalTitle,request_id:'benchmark-'+(clean?'clean-':'diagnostic-')+Date.now()})}),result=await response.json() as any;
if(!response.ok||!result.task_id)throw Error('研究任务未成功入队');
const saved={clean,budget,diagnostic_task:diagnostic,task_id:result.task_id,session_id:session.id,reference_task:'task_5b7eb7f226ae4b3fa2f936c33f5972a6',benchmark_condition:'new agents/claims/gates; explicitly permitted warm public-archive reuse; fresh search still allowed; fixed backend/model after start; retain first publication and all failures',started_at:new Date().toISOString(),code_fingerprints,title:finalTitle};if(clean&&existsSync('data/diagnostics/depth-benchmark-current.json'))writeFileSync('data/diagnostics/depth-benchmark-diagnostic.json',readFileSync('data/diagnostics/depth-benchmark-current.json'));writeFileSync(clean?'data/diagnostics/depth-benchmark-clean.json':'data/diagnostics/depth-benchmark-current.json',JSON.stringify(saved,null,2));console.log(JSON.stringify({...saved,code_fingerprints:`${Object.keys(code_fingerprints).length} files recorded`}));db.close();
