/** Reviewed Chinese translations and presentation changes, with original quotations retained in evidence. */
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {Database,encode} from '../packages/domain/db.js';
import {Service} from '../packages/domain/service.js';
import {reviseReport} from '../packages/reporting/revision.js';
const root=process.cwd(),data=join(root,'data'),db=new Database(join(data,'diting.sqlite3'),root),service=new Service(db);
const sourceId=process.argv[2],source=db.one('SELECT * FROM reports WHERE id=?',sourceId);if(!source)throw Error('请提供报告ID');
const document=JSON.parse(source.document_json);delete document.exports;delete document.tables;
const translations:Record<string,string>={
  "Anthropic's revenue numbers are one sign among many that the bubble might be closer to popping than anyone thought.":'该评论把 Anthropic 的收入表现视为泡沫可能更接近破裂的一个信号',
  'Naive extrapolations suggest Anthropic will fall short of its $100B run rate revenue target.':'该评论认为，简单外推后，Anthropic 可能达不到其千亿美元年化收入目标',
  'each dollar of this capex so far has been justified and is actually making an attractive IRR based on our calculations.':'与会者认为，迄今这类资本开支有合理依据，按其测算仍有吸引力的内部收益率',
  'The rest are practicing what Gartner calls agent washing: rebranding chatbots, RPA scripts and AI assistants as agents.':'该评论援引 Gartner 对“智能体洗白”的批评，指一些供应商只是把聊天机器人、流程自动化脚本和 AI 助手重新包装为智能体',
  'If a vendor proposes a multi-agent system for a three-step process, ask them to justify every agent.':'该评论建议，对于简单流程也推荐多智能体方案的供应商，应要求其逐个解释智能体的必要性',
  "It's from a single test run where a selection method picked one of eight generated videos for each task":'报道质疑，所报成绩来自单次运行，而且每个任务会从八段生成视频中挑选一段',
  'Without the selection method, Odyssey-3 Pro averaged 63.37 points across four runs':'报道称，不采用该挑选方法时，Odyssey-3 Pro 在四次运行中的平均成绩为 63.37 分',
  "SAFA has no equivalent backstop, and given congressional gridlock and federal resistance to AI deceleration, it's unlikely to get one.":'该评论认为，SAFA 缺少相应的监管后盾；在美国国会僵局和联邦层面对放慢 AI 发展速度的抵触情绪下，这种支持短期内也难以形成',
};
let replacements=0;
for(const section of document.sections)for(const [english,chinese] of Object.entries(translations)){
  const escaped=english.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp('[“"]'+escaped+'[”"]','g');
  section.text=section.text.replace(pattern,()=>{replacements++;return chinese;});
}
const result=await reviseReport(db,service,sourceId,document,data);writeFileSync(join(data,'diagnostics','editorial-final-result.json'),encode({...result,translations:replacements}));console.log(JSON.stringify({...result,translations:replacements}));db.close();
