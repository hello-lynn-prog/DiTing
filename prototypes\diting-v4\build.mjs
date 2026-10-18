import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const v2=fs.readFileSync(path.resolve(root,'../diting-v3/dist/v2-reference.html'),'utf8');
let child=fs.readFileSync(path.resolve(root,'../diting-v3/dist/index.html'),'utf8');
child=child.replaceAll('118.4k','184.3k');
const css=fs.readFileSync(path.join(root,'enhancements.css'),'utf8');
const js=fs.readFileSync(path.join(root,'enhancements.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'deep-report.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'consolidation.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'report-center.js'),'utf8');
const childExtra=`<style>.sidebar,.topbar,.prototype-bar,.footer-note{display:none!important}.shell{margin-left:0!important}.main{padding:15px!important}.main>.page-heading{display:none}.stats .stat:nth-child(1){border-top:3px solid #3b6ef5}.stats .stat:nth-child(2){border-top:3px solid #18a678}.stats .stat:nth-child(3){border-top:3px solid #7c5cf0}.stats .stat:nth-child(4){border-top:3px solid #e8930c}.claim-title{font-size:13px}.claim-text{font-size:12px}.evidence-chip{font-size:11px}.gate p,.kv{font-size:12px}.v4-embed-top{background:#eef3ff;border:1px solid #dce5ff;padding:10px 15px;border-radius:8px;margin:0 15px 5px;font:12px 'Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:space-between;color:#5572bb}.v4-embed-top button{background:#3b6ef5;border:0;padding:7px 12px;border-radius:6px;color:white;cursor:pointer}</style>`;
const childBridge=`<script>
function v4ChildSnapshot(){parent.postMessage({kind:'diting-v4:snapshot',topic:state.topic,phase:state.phase,claims:C,evidence:E.map(e=>({...e,quote:e.quote.replace(/<[^>]*>/g,'')}))},'*');}
window.addEventListener('message',e=>{if(e.source!==parent)return;if(e.data?.kind==='diting-v4:request-snapshot')v4ChildSnapshot();if(e.data?.kind==='diting-v4:new-research')newResearch();});
document.addEventListener('click',()=>setTimeout(v4ChildSnapshot,0));
document.querySelector('#v4-embed-ask').addEventListener('click',()=>{v4ChildSnapshot();parent.postMessage({kind:'diting-v4:ask-report'},'*');});
v4ChildSnapshot();
<\/script>`;
child=child.replace('</head>',childExtra+'</head>').replace('<main class="main" id="view">','<div class="v4-embed-top"><span>研究流程 · 补证 / 核实 / 质疑 / 证据链</span><button id="v4-embed-ask">对话追问当前研究 ↗</button></div><main class="main" id="view">').replace('</body>',childBridge+'</body>');
for(const [i,b] of [...child.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries())new vm.Script(b[1],{filename:'embedded-research-'+i+'.js'});
const attr=s=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const direct=[['usage','⚡','Token 与费用'],['llm','🔮','LLM 模型与路由'],['agent','🤖','Agent 与引擎'],['mcp','🔌','MCP 服务'],['skill','📚','Skill 技能'],['tools','🛠','Tool 工具'],['keys','🔑','Key 与服务配置'],['rules','🛡','采集守则'],['approve','✅','审批中心'],['logs','📋','运行日志'],['conf','⚙','系统配置']];
let html=v2.replace('<title>舆情 Agent 控制台 · 交互原型</title>','<title>DiTing 舆情 Agent · 完整控制台 v4</title>');
// No RSS feed is implemented: remove controls and obsolete promises.
html=html.replace(/<button\b[^>]*>[^<]*RSS[^<]*<\/button>/g,'');
html=html.split('\n').filter(line=>!line.includes('title="订阅本源 RSS"')).join('\n');
html=html.replaceAll('每分类一份独立日报 + RSS','每分类一份独立日报')
 .replaceAll('归档 + RSS','归档')
 .replaceAll(' / 订阅 RSS','')
 .replaceAll('已推送飞书 + RSS','飞书推送示例')
 .replaceAll('按分类订阅 RSS（飞书/邮件/阅读器），归档长期可回看可搜索','按分类归档，长期可回看可搜索');
html=html.replace('</style>',css+'\n</style>');
html=html.replace('<div class="logo">YUQING<small>舆情研判 AGENT</small></div>','<div class="logo">谛听 <span style="font-size:12px;color:#7c5cf0">DiTing</span><small>舆情研判 AGENT · 完整控制台 v4</small></div>');
const scrollStart=html.indexOf('    <div class="grp">功能</div>');
const scrollEnd=html.indexOf('    <!-- 用户登录卡片');
html=html.slice(0,scrollStart)+'<div class="v4-side-scroll">'+html.slice(scrollStart,scrollEnd)+'</div>'+html.slice(scrollEnd);
html=html.replace('<a data-p="topics">','<a data-p="research"><span class="ic" style="color:#7c5cf0">◈</span>研判工作台<span class="v4-new">NEW</span></a><a data-p="topics">');
html=html.replace('<main class="main">','<main class="main"><div class="v4-status-strip"><span class="v4-badge">完整交互原型 v4</span><span>所有内容为演示样例 · 未连接模型或后端 · dsh 为固定底座</span><button class="btn" onclick="v4Go(\'chat\')">💬 打开对话</button></div>');
html=html.replace('  </main>','<section class="page" id="p-research"><div class="topbar"><h1>研判工作台</h1><span class="sub">保留证据、门禁与有界补证流程</span><button class="btn dark" onclick="v4AskReport(\'ai\')" style="margin-left:auto">💬 追问当前研究</button></div><iframe id="v4-research-frame" title="证据研判工作台" style="width:100%;height:1080px;border:1px solid #e3e8f5;border-radius:12px;margin-top:14px;background:#f5f7fb" srcdoc="'+attr(child)+'"></iframe></section><section class="page" id="p-usage"></section><section class="page" id="p-keys"></section>  </main>');
html=html.replace("const links = document.querySelectorAll('#nav a, aside .nav a');","const links = document.querySelectorAll('#nav a, aside .nav a, aside .v4-direct');");
html=html.replace("el.addEventListener('change', () => showToast('已保存：' + el.dataset.k + ' → ' + el.value))","el.addEventListener('change', () => showToast(el.type==='password' ? '密钥字段已修改（仅本次页面，未连接后端）' : '本地配置草稿：' + el.dataset.k + ' → ' + el.value))");
html=html.replace(/value="sk-ant-demo-[^"]*"/g,'value="" placeholder="输入本次演示 Key · 不写入文件"');
html=html.replaceAll('LangGraph 可替换','dsh 成员任务').replaceAll('系统全局状态 · 实时刷新','完整工作空间 · 演示数据').replaceAll('全局运行参数 · 改完即生效','全局运行参数 · 原型内的配置草稿');
html=html.replace('</body>',`<button id="v4-floating-chat" onclick="v4ToggleQuick()" aria-label="打开随时问对话窗口">💬 <span>随时问</span></button><div id="v4-quick-root"></div><div id="v4-modal-root"></div><script>${js}</script></body>`);
html=html.replace('<a data-p="research">','<a data-p="deepreport"><span class="ic" style="color:#8b294c">📑</span>深度报告</a><a data-p="research">');
html=html.replace('<section class="page" id="p-usage">','<section class="page" id="p-deepreport"></section><section class="page" id="p-usage">');
const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
for(const [i,b] of blocks.entries())new vm.Script(b[1],{filename:'v4-script-'+i+'.js'});
fs.mkdirSync(path.join(root,'dist'),{recursive:true});
fs.writeFileSync(path.join(root,'dist/index.html'),html,'utf8');
console.log(`Built v4: ${Buffer.byteLength(html)} bytes; ${blocks.length} root scripts syntax checked. All v2 pages retained.`);
