/** Model-facing wire examples. IDs are placeholders; the task context supplies real IDs. */
export const reportStageDataGuide = [
  'data直接传对象，不嵌套stage/data。template:{template_id:"当前模板ID",reason:"按研究目的选择的理由"}。',
  'evidence_map:{claim_ids:["本任务结论ID"],evidence_ids:["本任务原文ID"]}。',
  'layout:{chapters:[{id:"c1",title:"模板原章节名",goal:"本章分析重点"}]}，覆盖required_outline主章及附录。',
  'length:{chapters:[{id:"c1",min_chars:1500,max_chars:2500}]}，根据writing_plan逐子节预算分配，不能把完整专题全部缩成千字短章。',
  'chapter:{id:"c1",title:"已保存布局标题",text:"### 1.1 模板原子节名\\n\\n中文分析正文",claim_numbers:[1],visuals:[]}，claim_numbers来自当前任务，和claim_ids二选一。',
  '定量visual仅{kind:"dataset",title:"图名",dataset_id:"认证底表ID",style:"bar"}，不接收caption或items；style可为bar/donut/line。',
  '定性visual仅{kind:"matrix"或"flow",title:"图名",caption:"分析归纳依据",items:[{label:"主体",text:"基于本章材料的分析",claim_numbers:[1]}]}，items至少2项。kind不能填bar/line/swot/pest。after_subsection可选。',
  'repair:{issues:[],actions:[]}；两字段都是字符串数组，不是单个字符串。六章主体保存后，本阶段自动补齐程序附录。'
].join('\n');

