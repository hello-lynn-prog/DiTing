import type {Row} from '../domain/db.js';

const size=(text:string)=>Array.from(text.replace(/^#{1,6}\s+.*$/gm,'').trim()).length;
const sameTitle=(a:string,b:string)=>a===b||a.startsWith(b+'：')||a.startsWith(b+':');
function allocate(total:number,weights:number[]){
  const sum=weights.reduce((a,b)=>a+b,0),raw=weights.map(w=>total*w/sum),out=raw.map(Math.floor);
  const order=raw.map((v,i)=>({i,remainder:v-out[i]})).sort((a,b)=>b.remainder-a.remainder||a.i-b.i);
  const missing=total-out.reduce((a,b)=>a+b,0);for(let i=0;i<missing;i++)out[order[i].i]++;
  return out;
}
function focus(title:string){
  if(/摘要|定性|核心洞察/.test(title))return ['直接给出本主题判断','概括具体事实与分歧','只保留重要影响'];
  if(/时间|演变|背景|起源/.test(title))return ['按真实发生时间串联具体事件','解释转折及前后因果','区分发布时间与事件时间'];
  if(/观点|情绪|焦点|角色/.test(title))return ['对照不同主体的具体立场','比较支持理由与反方解释','情感比例仅用本任务实际分类样本'];
  if(/动因|价值|心态|文化/.test(title))return ['用具体案例解释形成机制','区分事实关联与因果假说','讨论替代解释和适用范围'];
  if(/建议|评估|风险|机遇/.test(title))return ['对应前文具体风险与机会','提出可执行动作及触发条件','说明适用主体与观察指标'];
  return ['展开具体事实节点和案例','比较各方观点及反方解释','分析机制、影响和可执行动作'];
}
/** An editorial allocation, never a fact-sufficiency gate or automatic rewrite trigger. */
export function writingBudget(contract:Row,target=40000){
  target=Math.round(Math.max(500,Math.min(60000,Number.isFinite(target)?target:40000)));
  const titles:string[]=contract.main_sections||contract.outline?.map((c:Row)=>c.title)||[];
  if(!titles.length)return {target_chars:target,advisory:true,chapters:[]};
  const totals=allocate(target,titles.map(t=>/摘要|概览|综述/.test(t)?0.35:/观点|情绪|动因/.test(t)?1.3:1));
  return {target_chars:target,advisory:true,method:'deterministic-template-subsection-allocation-v1',instruction:'按材料承载能力展开，不以篇幅替代真实性，不因篇幅提示重写已保存全文。',chapters:titles.map((title,i)=>{
    const outline=(contract.outline||[]).find((c:Row)=>sameTitle(title,c.title)),subs:Row[]=outline?.subsections||[];
    const sizes=allocate(totals[i],subs.length?subs.map(()=>1):[1]);
    return {title,target_chars:totals[i],subsections:subs.map((s,j)=>({number:s.number,title:s.title,target_chars:sizes[j],min_chars:Math.round(sizes[j]*0.8),max_chars:Math.round(sizes[j]*1.2),focus:focus(s.title)}))};
  })};
}
export function subsectionCoverage(text:string,plan:Row){
  const headings=[...text.matchAll(/^###\s+([^\n]+)\r?$/gm)];
  return (plan.subsections||[]).map((sub:Row)=>{
    const index=headings.findIndex(h=>{const title=h[1].trim();return title===`${sub.number} ${sub.title}`||title===sub.title||title.startsWith(`${sub.number} ${sub.title}：`);});
    const content=index<0?'':text.slice(headings[index].index!+headings[index][0].length,index+1<headings.length?headings[index+1].index:text.length);
    const actual=size(content);return {...sub,present:index>=0,actual_chars:actual,status:index<0?'missing':actual<sub.min_chars?'below_plan':actual>sub.max_chars?'above_plan':'within_plan'};
  });
}
