/** User-requested public-event outline; reuse reviewed analysis and archive, no model/search calls. */
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {Database,encode,type Row} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {templates,resolveTemplate,validateReport,renderReport} from '../packages/reporting/report.js';
import {reviseReport} from '../packages/reporting/revision.js';
const root=process.cwd(),data=join(root,'data'),db=new Database(join(data,'diting.sqlite3'),root),service=new Service(db);
const sourceId=process.argv[2],source=db.one('SELECT * FROM reports WHERE id=?',sourceId);if(!source)throw Error('需要现有报告ID');
const prior=JSON.parse(source.document_json),old:Row[]=prior.sections.slice(0,6);
if(prior.template_id!=='policy')throw Error('此映射针对已审阅的政策／行业报告');
const split=(s:Row)=>{const pieces=s.text.split(/^###\s+/m);return {intro:pieces[0].trim(),parts:pieces.slice(1).map((p:string)=>{const [head,...rest]=p.split('\n');return {head,body:rest.join('\n').trim()};})};};
const blocks=old.map(split),part=(i:number,j:number)=>{const p=blocks[i].parts[j];return p?`#### ${p.head}\n\n${p.body}`:'';};
const sub=(heading:string,...content:string[])=>`### ${heading}\n\n${content.filter(Boolean).join('\n\n')}`;
const union=(indices:number[])=>[...new Set<string>(indices.flatMap(i=>old[i].claim_ids))];
const refs=(indices:number[])=>indices.flatMap(i=>old[i].references||[]);
const diagram=(i:number,j:number,after_subsection:string)=>({...old[i].visuals[j],after_subsection});
const builtin=templates.find(t=>t.id==='public-event')!;
const make=(i:number,text:string,indices:number[],visuals:Row[]=[])=>({title:builtin.main_sections[i],text,claim_ids:union(indices),references:refs(indices),visuals});
const sections=[
 make(0,[sub('1.1 事件定性',blocks[0].intro),sub('1.2 核心洞察',...blocks[0].parts.slice(0,4).map((_:unknown,j:number)=>part(0,j))),sub('1.3 关联性与建议',blocks[0].parts[4].body)].join('\n\n'),[0],[diagram(0,0,'1.2')]),
 make(1,[sub('2.1 事件背景与起源',blocks[1].intro,part(1,0),part(1,2)),sub('2.2 舆论发酵时间线',part(1,1),part(1,4)),sub('2.3 当前态势',part(1,3))].join('\n\n'),[1],[diagram(1,0,'2.2')]),
 make(2,[sub('3.1 核心传播链条',
 '本轮材料呈现出一条由技术发布进入专业核验，再扩展到投资与治理议题的分析路径。厂商以接口开放、研究预览、产品公告和评测成绩提供最初的信息入口；专业媒体将这些表述置于运行方法、可复现性和生产应用条件下重新审视；财经报道与投资评论把技术预期转化为估值、收入与资本开支问题；采购和安全讨论最终追问实际成本、权限与问责。',
 '这些环节的关联来自议题内容，而不是已经测得的社交转发网络。理解这条路径的价值，在于识别信息在进入下一层讨论时发生了什么变化：技术承诺被解释为商业预期，商业预期又被转换成采购与治理要求。判断某条消息能否支撑下一步决策，必须先核对转换过程中省略了哪些前提。',
 '例如，Odyssey 的基准成绩进入专业媒体后，讨论重点转向运行次数和挑选方法；Anthropic 的收入表述进入投资评论后，形成泡沫论与反泡沫论的对照；智能体安全事件进入治理议题后，问题从模型能力转向组织权限和责任。它们共同说明，报道的扩散不只是信息量增加，也会改变公众接触议题时的解释框架。'),
 sub('3.2 引爆点分析',
 '最容易引起争议的是“看起来可以直接比较，实际上前提不同”的信息。融资与估值给出清楚的价格锚点，但不同轮次、市场和会计口径并不能直接并列；评测榜单呈现一个简洁的名次，却可能隐藏多次生成后的挑选；产品演示容易展示成功路径，却较少展现长期运行、异常处理和总成本。',
 '因此，本轮争议的引爆机制可以概括为：醒目的承诺先形成预期，核验材料随后暴露条件，双方再围绕条件是否合理展开争论。投资者需要确定兑现时间，采购方需要确定成本与责任，厂商则希望突出能力与进展。这些诉求没有天然一致的评价尺度，所以同一份材料会被不同主体用于相反的叙事。',
 '治理议题还叠加了标题与程序阶段的差异。把征求意见写成已经完成立项或已经形成生效规则，会使受众误判政策进度。监测中应把这种程序性表述变化视为需要核对的传播节点；研判重点是具体文字如何改变预期，而不是仅看标题是否吸引注意。'),
 sub('3.3 关键传播角色',
 '| 角色 | 本轮材料中的代表 | 对议题的作用 | 阅读时需要核对 |\n|---|---|---|---|\n| 技术与产品发布者 | Odyssey、NEURA、Pi 相关发布方 | 提供能力、产品与评测叙事 | 条件、测试方法与实际可用范围 |\n| 专业核验者 | The Decoder 等技术媒体 | 追问榜单方法与运行条件 | 是否有独立复测及厂商回应 |\n| 投资与财经解释者 | 财经报道、Crypto Briefing、投资评论作者 | 将技术进展解释为收入与估值预期 | 原始披露、会计口径与假设 |\n| 场景与采购观察者 | 工博会报道、企业选型评论 | 将演示能力转化为交付问题 | 成本、生产环境和组织权限 |\n| 安全与治理参与者 | METR、Pillar、SAFA 相关材料 | 提出评估、事件报告与责任要求 | 资金来源、独立性与约束力 |',
 '关键角色的价值应按其提供的可核查信息衡量。厂商最了解产品，却有选择呈现的动机；媒体能够提出问题，却未必掌握原始经营或测试资料；安全组织能够归纳事件，也可能拥有自身商业利益。把角色和材料类型一并阅读，才能避免把同一条转述误认成多次独立确认。')].join('\n\n'),[0,1,2,3,4]),
 make(3,[sub('4.1 核心议题与讨论焦点',blocks[2].intro,part(2,1),part(2,2)),sub('4.2 多元观点呈现',part(2,0),part(2,3),part(2,4)),sub('4.3 社会情绪分析',
 '本节依据公开报道和评论中的表达研判，不外推到全体公众。围绕能力开放和产业机会的积极期待，与对估值兑现、演示包装和权限失控的审慎态度同时存在；两类表达往往关注不同的问题，而不是简单的支持或反对 AI。',
 '技术发布者强调可用性与进展，使用方更关心失败成本和责任边界，投资评论则把技术预期放在财务兑现的时间轴上。其共同心理线索是希望减少不可见的风险：能否复现、能否算清成本、发生异常后能否处置。讨论从惊叹能力转向追问条件，表明评价尺度正在从展示效果走向兑现能力。',
 '因此，对情绪的响应不宜只调整宣传措辞。更有效的回应是针对不同对象提供相应材料：向技术受众公开测试协议，向采购方公开运行与异常成本，向投资者澄清披露口径，向受影响组织说明权限和处置机制。配套图表展示本批归档材料的标签与议题分布，帮助观察材料构成。')].join('\n\n'),[0,2,3,4],[diagram(2,0,'4.2')]),
 make(4,[sub('5.1 事件背后的社会心态',...blocks[3].parts.map((_:unknown,j:number)=>part(3,j)),part(4,0),part(4,1),part(4,2),part(4,3)),sub('5.2 衍生文化与网络Meme',
 '本轮材料中，“泡沫”“智能体洗白”和“演示繁荣”等标签，把复杂技术与商业判断压缩成容易被识别的叙事。它们具有提示问题的作用：泡沫指向预期与兑现的距离，智能体洗白指向命名与实际能力的距离，演示繁荣指向展示与生产部署的距离。',
 '这些表达也可能遮蔽差异。并非所有资本开支都可以用同一套盈利周期评估，也不是所有采用多智能体的方案都缺乏必要性。若标签先于具体条件，就容易把不同商业模式、架构和风险混在一起，使争论从核对事实转向立场识别。',
 '报告把这些话语作为理解争议的线索，而不把它们写成已经测得传播规模的网络热梗。回应时应把标签重新拆成可以回答的问题：预期基于什么资料、方案为何需要这些环节、效果如何验证、责任如何落实。下面的 PEST 归纳将政策、经济、社会和技术条件放回同一个解释框架。')].join('\n\n'),[0,1,2,3,4],[diagram(3,0,'5.1'),diagram(4,0,'5.1')]),
 make(5,[sub('6.1 风险评估',...blocks[5].parts.slice(0,5).map((_:unknown,j:number)=>part(5,j))),sub('6.2 机遇评估',
 '争议本身也提供了明确的改进方向。能力、成本和责任之间的落差越受到关注，能够公开测试条件、解释架构选择并提供异常处置记录的团队，就越容易形成可以被外部理解的差异化。这里的机遇并不等于短期市场规模预测，而是企业可以主动改善的交付与沟通环节。',
 '对采购方，机会在于把模糊的技术承诺转换为验收条款；对产品方，在于把可复现性与权限控制做成产品能力；对研究和监测团队，在于持续比较披露材料、实际进展和回应，而不是仅整理高热度消息。独立评估、透明披露和面向场景的验证有可能成为连接技术供给与实际信任的支点。'),
 sub('6.3 最终行动建议（介入/关注/规避）',...blocks[5].parts.slice(5).map((_:unknown,j:number)=>part(5,j+5)),
 '| 行动方向 | 适用事项 | 执行要点 |\n|---|---|---|\n| 介入 | 采购验证、复现实验、权限治理和材料披露 | 选择能写清条件和验收结果的具体工作 |\n| 关注 | 融资交割、正式标准、独立评估公开及厂商回应 | 按事件节点更新判断，区分传闻、观点和已发生事实 |\n| 规避 | 无法解释的架构复杂度、将演示等同交付、混用财务与测试口径 | 不以榜单、标签或单一转述替代尽调与验收 |')].join('\n\n'),[0,3,4,5],[diagram(5,0,'6.1'),diagram(5,1,'6.3')]),
 ...prior.sections.slice(6),
];
// The diagram links describe an analysis pathway, never an invented social propagation network.
sections[2].visuals=[{kind:'flow',title:'从发布到决策的议题转换',after_subsection:'3.1',caption:'根据已归档材料归纳的议题关联，非社交转发网络实测。',items:[{label:'技术发布',text:'接口、预览、产品与榜单提供信息入口。',claim_ids:old[1].claim_ids.slice(0,4)},{label:'专业核验',text:'媒体追问测试方法、运行条件和复现。',claim_ids:old[2].claim_ids.slice(0,4)},{label:'财经解释',text:'资本与收入叙事形成不同估值判断。',claim_ids:old[0].claim_ids.slice(0,4)},{label:'采购与治理',text:'成本、权限与责任成为决策问题。',claim_ids:old[4].claim_ids.slice(0,4)}]}];
for(const dimension of ['topic','sentiment']){const table=prior.tables.find((t:Row)=>t.dimension===dimension);if(table)sections[3].visuals.push({kind:'dataset',title:dimension==='topic'?'归档材料的议题分布':'归档材料的情感标签分布',dataset_id:table.id,style:dimension==='sentiment'?'donut':'bar',after_subsection:'4.3'});}
const input={title:prior.title,template_id:'public-event',reader_version:2,sections,dataset_ids:prior.dataset_ids,limitations:prior.limitations,frameworks:prior.frameworks};
const verified=validateReport(db,source.task_id,input,resolveTemplate(db,'public-event'));
if(verified.editorial_warnings.some((s:string)=>s.includes('尚缺模板子节')))throw Error('仍有未归位的模板子节');
writeFileSync(join(data,'diagnostics','public-event-preview.html'),renderReport(db,source.task_id,{...verified,template_contract:resolveTemplate(db,'public-event')}).html);
const result=await reviseReport(db,service,sourceId,input,data,{replaceTemplate:true,upgradeTemplate:true,reason:'用户明确要求按所附公共热点事件六章及编号子节组织；仅重新编排已有研究和分析，不新增调查事实'});
writeFileSync(join(data,'diagnostics','public-event-layout-result.json'),encode(result));console.log(JSON.stringify(result));db.close();
