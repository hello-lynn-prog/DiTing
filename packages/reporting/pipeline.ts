import { z } from 'zod';
import { Database, encode, now, uid, type Row } from '../domain/db.js';
import { Service } from '../domain/service.js';
import { resolveTemplate, validateReport,reportMetadataSchema } from './report.js';
import {reportVisualSchema,validateVisuals} from './visuals.js';
import {bindReportQuotes} from './quote-binding.js';
import {reportClaimNumbers} from './claim-numbers.js';
import {stagePayload} from './stage-payload.js';
import {programAppendix} from './program-appendices.js';
import {patchChapterText} from './text-patch.js';
import {writingBudget,subsectionCoverage} from './word-budget.js';
import {canonicalChapterTitle} from './chapter-title.js';

function minimumChapterChars(title: string): number {
  if (/摘要|概览/.test(title)) return 700;
  if (/来源|附录/.test(title)) return 100;
  if (/范围|方法|局限/.test(title)) return 300;
  if (/样本|平台/.test(title)) return 500;
  return 900;
}

export class ReportPipeline {
  constructor(readonly db: Database, readonly service: Service, readonly taskId: string) {}
  private stages(): Row[] {
    const version = this.service.reviewInput(this.taskId);
    const rows = this.db.rows("SELECT * FROM artifacts WHERE task_id=? AND kind='report_stage' ORDER BY rowid", this.taskId).map(a => ({ ...a, payload: JSON.parse(a.data_json) })).filter(a => encode(a.payload.input_version) === encode(version));
    const start = rows.map(a => a.payload.stage).lastIndexOf('template'); return start >= 0 ? rows.slice(start) : rows;
  }
  private latest(stage: string):any { const data=this.stages().filter(a => a.payload.stage === stage).at(-1)?.payload.data;if(stage==='layout'&&data){const required=this.latest('template')?.contract?.sections||[];return {...data,chapters:data.chapters.map((c:Row)=>({...c,title:canonicalChapterTitle(c.title,required)}))};}return data; }
  private writingPlan(){const config=JSON.parse(this.service.rawTask(this.taskId).config_json);return writingBudget(this.latest('template')?.contract||{},config.report_profile?.target_chars||40000);}
  progress() {
    const rows = this.stages(), layout = this.latest('layout'), lengths = this.latest('length'),writing_plan=this.writingPlan();
    const chapters = (layout?.chapters || []).map((c: Row) => {
      const saved = rows.filter(a => a.payload.stage === 'chapter' && a.payload.data.id === c.id).at(-1);
      const plan=writing_plan.chapters.find(p=>c.title===p.title||c.title.startsWith(p.title+'：')||c.title.startsWith(p.title+':'));
      return { id: c.id, title: c.title, saved: !!saved, artifact_id: saved?.id || null, actual_chars: saved ? Array.from(saved.payload.data.text).length : 0, ...lengths?.chapters?.find((p: Row) => p.id === c.id),...(plan?{writing_target:plan.target_chars,subsections:subsectionCoverage(saved?.payload.data.text||'',plan)}:{}) };
    });
    const version=this.service.reviewInput(this.taskId),candidate=this.db.rows("SELECT id,data_json FROM artifacts WHERE task_id=? AND kind='report_candidate' ORDER BY rowid DESC",this.taskId).find(a=>encode(JSON.parse(a.data_json).input_version)===encode(version));
    const failure=this.db.one("SELECT data_json FROM artifacts WHERE task_id=? AND kind='report_validation' ORDER BY rowid DESC LIMIT 1",this.taskId);
    return { template_id: this.latest('template')?.template_id || null, latest_stage: rows.at(-1)?.payload.stage || null, writing_plan,chapters,candidate_id:candidate?.id||null,last_validation_error:failure?JSON.parse(failure.data_json).message:null,finalize_contract:{required:['title','template_id','dataset_ids','limitations'],limitations:'字符串数组；没有额外局限时使用已审查的范围局限',frameworks:'可选。每个 SWOT/PEST 格子都是 {text,claim_ids} 对象数组；不得提交无引用字符串'}, next:candidate?'报告候选已校验；主 Agent 直接 report_publish，不要重新成稿': !layout ? '完成报告规划' : chapters.some((c: Row) => !c.saved) ? '仅补写未保存章节' : '章节已保存；仅提交元数据完成 report_draft，按具体事实错误局部修订；不要重做调查或报告规划' };
  }
  private readerSections(sections:Row[]){
      const labels=new Map<string,string>();
      for(const e of this.db.rows('SELECT evidence_id FROM task_evidence WHERE task_id=?',this.taskId))labels.set(e.evidence_id,'已归档原文');
      for(const c of this.db.rows('SELECT id FROM claims WHERE task_id=?',this.taskId))labels.set(c.id,'已核验结论');
      for(const a of this.db.rows('SELECT id,kind FROM artifacts WHERE task_id=?',this.taskId))labels.set(a.id,a.kind==='dataset'?'统计附表':'已保存研究材料');
      for(const v of this.db.rows('SELECT id FROM visual_observations WHERE task_id=?',this.taskId))labels.set(v.id,'画面观察');
      labels.set(this.taskId,'本次研究');
      const replacements:{id:string;label:string}[]=[];
      const evidence=this.db.rows('SELECT e.id,e.content FROM evidence e JOIN task_evidence t ON t.evidence_id=e.id WHERE t.task_id=?',this.taskId);
      const bindings:Row[]=[],diagramBindings:Row[]=[],appendixInputs:Row[]=[];
      const cleaned=sections.map((s:Row)=>{
        const coverage=programAppendix(this.db,this.taskId,s.title);
        if(coverage){if(s.text!==coverage||s.claim_ids?.length||s.visuals?.length)appendixInputs.push({...s,reason:'保留模型原输入；覆盖/方法/局限/来源说明仅按本任务程序事实生成'});return {title:s.title,text:coverage,claim_ids:[]};}
        const explicit=(s.visuals||[]).flatMap((v:Row)=>(v.items||[]).flatMap((item:Row)=>item.claim_ids||[])),added=explicit.filter((id:string)=>!s.claim_ids.includes(id));if(added.length)diagramBindings.push({title:s.title,added_claim_ids:[...new Set(added)],method:'explicit-diagram-reference-rollup'});
        const bound=bindReportQuotes(s.text,evidence);if(bound.references.length||bound.ambiguous.length)bindings.push({title:s.title,...bound});
        return {...s,claim_ids:[...new Set([...s.claim_ids,...explicit])],references:bound.references,text:s.text.replace(/\b(?:evidence|claim|dataset|artifact|task|visual)_[a-f0-9]{8,}(?:…|\.\.\.)?/g,(id:string)=>{const key=id.replace(/…|\.\.\./g,''),matches=labels.has(key)?[key]:[...labels.keys()].filter(k=>k.startsWith(key));if(matches.length!==1)throw new Error(`章节“${s.title}”含无法关联本任务的内部引用：${id}`);const label=labels.get(matches[0])!;replacements.push({id,label});return label;})};
      });
    return {sections:cleaned,bindings,replacements,diagramBindings,appendixInputs};
  }
  preview() {
    const stages = this.stages(), layout = this.latest('layout'), template = this.latest('template');
    const chapters = layout?.chapters || [];
    const sections = chapters.flatMap((c: Row) => {
      const saved = stages.filter(a => a.payload.stage === 'chapter' && a.payload.data.id === c.id).at(-1)?.payload.data;
      return saved ? [{ title: canonicalChapterTitle(saved.title,template.contract.sections), text: saved.text, claim_ids: saved.claim_ids, visuals:saved.visuals }] : [];
    });
    if (!sections.length) throw new Error('当前证据版本尚无已保存报告章节');
    const datasets = new Map<string, Row>();
    for (const row of this.db.rows("SELECT id,data_json FROM artifacts WHERE task_id=? AND kind='dataset' ORDER BY rowid", this.taskId)) {
      const data = JSON.parse(row.data_json); datasets.set(data.dimension, { id: row.id, ...data });
    }
    const document: Row = { title: '研究报告草稿（未发布）', template_id: template.template_id, reader_version:2, sections:this.readerSections(sections).sections, dataset_ids: [...datasets.values()].map(d => d.id), limitations: ['当前是已保存章节的过程预览，尚未完成最终校验；表格和结论应连同局限逐项核对。'] };
    const errors: string[] = [];
    try { validateReport(this.db, this.taskId, document, template.contract); } catch (error) { errors.push(error instanceof Error ? error.message : '报告校验未通过'); }
    const draftDocument: Row = { ...document, tables: [...datasets.values()] };
    return { status: 'draft', published: false, progress: this.progress(), validation_errors: errors, document: draftDocument };
  }
  private save(kind: string, data: Row) { const id = uid('artifact'); this.db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)', id, this.taskId, kind, 'report', encode(data), now()); return id; }
  repairChapter(submissionId:string,patch:unknown){
    const row=this.db.one("SELECT data_json FROM artifacts WHERE id=? AND task_id=? AND kind IN ('report_chapter_submission','report_stage')",submissionId,this.taskId);if(!row)throw Error('章节检查点不存在或不属于本任务');const saved=JSON.parse(row.data_json);if(saved.stage&&saved.stage!=='chapter')throw Error('只能修复章节产物，不能覆盖规划阶段');
    if(encode(saved.input_version)!==encode(this.service.reviewInput(this.taskId)))throw Error('章节检查点证据版本已变化，须按当前门禁版本重新核对');
    const base=stagePayload('chapter',saved.data),normalized=reportClaimNumbers(this.db,this.taskId,stagePayload('chapter',patch)),parsed=z.object({id:z.string().optional(),title:z.string().optional(),text:z.string().min(10).max(50000).optional(),replacements:z.array(z.object({old:z.string().min(1).max(10000),new:z.string().max(10000)}).strict()).min(1).max(30).optional(),claim_ids:z.array(z.string()).optional(),visuals:z.array(reportVisualSchema).max(6).optional()}).strict().parse(normalized);
    if(parsed.id!==undefined&&parsed.id!==base.id)throw Error('修复补丁不能改变原章节id');if(parsed.text!==undefined&&parsed.replacements)throw Error('text和replacements二选一，不要重新提交整章');const {id:ignored,replacements,...changes}=parsed;
    if(replacements){changes.text=patchChapterText(base.text,replacements);this.save('report_text_patch',{submission_id:submissionId,replacements,input_version:this.service.reviewInput(this.taskId),method:'exact-unique-non-overlapping-original-spans'});}
    const next={...base,...changes};delete next.editorial_warnings;if(changes.claim_ids)delete next.claim_numbers;
    const result=this.record('chapter',next);this.db.event(this.taskId,'report.chapter_repaired',{message:'复用章节检查点，仅修改指定字段；完整章节仍通过引用与结构检查',submission_id:submissionId,chapter_id:saved.data.id,changed_fields:Object.keys(changes)});return result;
  }
  record(stage: string, input: unknown) {
    try{return this.recordChecked(stage,input);}catch(error){if(stage==='chapter'){const artifact_id=this.save('report_chapter_submission',{data:input,input_version:this.service.reviewInput(this.taskId),error:error instanceof Error?error.message:'章节校验失败',status:'rejected'});throw new Error(`章节全文已保留：${artifact_id}。仅修本章具体字段后report_chapter_repair：${error instanceof Error?error.message:'校验失败'}`);}throw error;}
  }
  private recordChecked(stage:string,input:unknown):Row{
    input=reportClaimNumbers(this.db,this.taskId,stagePayload(stage,input));
    let data: Row;
    if (['evidence_map','layout','length'].includes(stage) && this.latest(stage)) throw new Error('该规划阶段已有有效版本；需要重做时请从 template 建立新成稿版本');
    if (stage === 'template') {
      data = z.object({ template_id: z.string(), reason: z.string().min(5).max(2000) }).strict().parse(input);
      const taskConfig=JSON.parse(this.service.rawTask(this.taskId).config_json),choice=taskConfig.template,selection=taskConfig.template_selection||{mode:choice==='auto'?'auto':'legacy',selected_by:choice==='auto'?'report_agent':'task_configuration'};
      if(choice&&choice!=='auto'&&choice!==data.template_id)throw new Error('用户已选定报告骨架，请使用任务配置中的模板');
      data.contract = resolveTemplate(this.db, data.template_id);
      // Persist the actual source of the choice so an automatically selected
      // template cannot later be described as user-selected.
      data.selection_mode=selection.mode;
      data.selected_by=selection.selected_by;
      data.selection_note=selection.mode==='auto'?'用户选择了“系统自选”；Report成员根据研究主题匹配此模板。':'模板来自任务配置。';
      const previous = this.stages().findLast(a => a.payload.stage === 'template');
      if (previous && encode(previous.payload.data.contract) === encode(data.contract)) return { artifact_id: previous.id, stage, reused: true, checkpoint: this.progress() };
    } else if (stage === 'evidence_map') {
      if (!this.latest('template')) throw new Error('请先选择模板');
      data = z.object({ claim_ids: z.array(z.string()).min(1), evidence_ids: z.array(z.string()).min(1) }).strict().parse(input);
      for (const id of data.claim_ids) if (!this.db.one('SELECT id FROM claims WHERE task_id=? AND id=?', this.taskId, id)) throw new Error('材料映射包含其他任务的结论');
      for (const id of data.evidence_ids) if (!this.db.one('SELECT evidence_id FROM task_evidence WHERE task_id=? AND evidence_id=?', this.taskId, id)) throw new Error('材料映射包含其他任务的证据');
    } else if (stage === 'layout') {
      if (!this.latest('evidence_map')) throw new Error('请先整理证据与结论映射');
      data = z.object({ chapters: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), title: z.string().min(1).max(150), goal: z.string().min(5).max(2000) }).strict()).min(9).max(30) }).strict().parse(input);
      if (new Set(data.chapters.map((c: Row) => c.id)).size !== data.chapters.length) throw new Error('章节 ID 重复');
      const required:string[]=this.latest('template')?.contract?.sections||[];data.chapters=data.chapters.map((c:Row)=>({...c,title:canonicalChapterTitle(c.title,required)}));
      const missing=required.filter(name=>!data.chapters.some((c:Row)=>c.title===name||c.title.startsWith(name+'：')||c.title.startsWith(name+':')));
      if(missing.length)throw Error('布局缺少模板章节：'+missing.join('、')+'；请在写正文前补齐布局');
      if(new Set(data.chapters.map((c:Row)=>c.title)).size!==data.chapters.length)throw Error('章节标题重复');
    } else if (stage === 'length') {
      const layout = this.latest('layout'); if (!layout) throw new Error('请先规划章节');
      data = z.object({ chapters: z.array(z.object({ id: z.string(), min_chars: z.number().int().min(30).max(10000), max_chars: z.number().int().min(30).max(50000) }).strict()).min(9).max(30) }).strict().parse(input);
      if (data.chapters.length !== layout.chapters.length || new Set(data.chapters.map((c: Row) => c.id)).size !== layout.chapters.length || data.chapters.some((c: Row) => c.min_chars > c.max_chars || !layout.chapters.some((p: Row) => p.id === c.id))) throw new Error('篇幅规划与章节布局不一致');
      const undersized = data.chapters.filter((p: Row) => p.min_chars < minimumChapterChars(layout.chapters.find((c: Row) => c.id === p.id).title));
      if (undersized.length){data.editorial_warnings=undersized.map((p:Row)=>`${layout.chapters.find((c:Row)=>c.id===p.id).title}建议${minimumChapterChars(layout.chapters.find((c:Row)=>c.id===p.id).title)}字以上；已保存，按材料承载能力写作，避免填充或重复重写`);this.db.event(this.taskId,'report.editorial_warning',{message:data.editorial_warnings.join('；'),stage:'length'});}
    } else if (stage === 'chapter') {
      const layout = this.latest('layout'), lengths = this.latest('length'); if (!layout || !lengths) throw new Error('请先完成布局和篇幅规划');
      data = z.object({ id: z.string(), title: z.string(), text: z.string().min(10).max(50000), visuals:z.array(reportVisualSchema).max(6).optional(), claim_ids: z.array(z.string()) }).strict().parse(input);
      data.title=canonicalChapterTitle(data.title,this.latest('template')?.contract?.sections||[]);
      const planned = layout.chapters.find((p: Row) => p.id === data.id), length = lengths.chapters.find((p: Row) => p.id === data.id);
      if (!planned || planned.title !== data.title) throw new Error(`章节 ${data.id} 标题不符合已保存布局，请沿用原章节 ID 和标题`);
      if (!length) throw new Error('缺少章节篇幅规划');
      if(!data.claim_ids.length){const text=programAppendix(this.db,this.taskId,data.title);if(!text)throw Error('分析正文必须引用已审查结论，不能提交空引用');this.save('report_appendix_input',{data,input_version:this.service.reviewInput(this.taskId),note:'仅保留模型输入，不将无引用附录当作事实；读者说明由程序根据当前任务生成'});data.text=text;delete data.visuals;this.db.event(this.taskId,'report.appendix_generated',{message:'按当前任务数据生成覆盖说明，不要求模型编造结论引用',title:data.title});}
      data.claim_ids=[...new Set([...data.claim_ids,...(data.visuals||[]).flatMap((v:Row)=>(v.items||[]).flatMap((i:Row)=>i.claim_ids||[]))])];
      const invalid=data.claim_ids.filter((id:string)=>!this.db.one('SELECT id FROM claims WHERE task_id=? AND id=?',this.taskId,id));
      if(invalid.length)throw new Error(`章节引用不属于本任务：${invalid.join('、')}。仅修本章这些claim_ids，使用task_context已列出的确切编号；不要重做调查、规划或其他已保存章节。`);
      validateVisuals([data],new Set(data.claim_ids),this.db.rows("SELECT id,data_json FROM artifacts WHERE task_id=? AND kind='dataset'",this.taskId).map(a=>({id:a.id,...JSON.parse(a.data_json)})));
      const actual=Array.from(data.text).length;
      if(/平台样本分析/.test(data.title)&&Number(this.db.one('SELECT COUNT(*) n FROM content_records WHERE task_id=?',this.taskId)!.n)>0&&actual<500)throw Error(`本任务有平台样本，“平台样本分析”至少需要500字的引用支持分析；当前${actual}字。请使用report_materials里的实际样本、指标与发布时间覆盖写作，不要提交泛化说明`);
      if(actual<length.min_chars||actual>length.max_chars){data.editorial_warnings=[`实际 ${actual} 字符，建议 ${length.min_chars}–${length.max_chars}；已保存，不因篇幅反复重写`];this.db.event(this.taskId,'report.editorial_warning',{message:`章节“${data.title}”：${data.editorial_warnings[0]}`,chapter_id:data.id});}
    } else if (stage === 'repair') {
      const currentLayout=this.latest('layout');for(const c of currentLayout?.chapters||[])if(!this.stages().some(a=>a.payload.stage==='chapter'&&a.payload.data.id===c.id)&&programAppendix(this.db,this.taskId,c.title))this.record('chapter',{id:c.id,title:c.title,text:'本节由程序按已归档任务数据生成。',claim_ids:[]});
      const layout = this.latest('layout'); if (!layout || layout.chapters.some((c: Row) => !this.stages().some(a => a.payload.stage === 'chapter' && a.payload.data.id === c.id))) throw new Error('尚有章节未完成');
      data = z.object({ issues: z.array(z.string()).max(100), actions: z.array(z.string()).max(100) }).strict().parse(input);
    } else throw new Error('未知成稿阶段');
    const artifact_id = this.save('report_stage', { stage, data, input_version: this.service.reviewInput(this.taskId) });
    this.db.event(this.taskId, 'report.stage', { message: `Report 已保存 ${stage}${stage === 'chapter' ? '：' + data.title : ''}`, artifact_id });
    const plan=stage==='chapter'?this.writingPlan().chapters.find(p=>data.title===p.title||data.title.startsWith(p.title+'：')||data.title.startsWith(p.title+':')):null;
    return { artifact_id, stage, ...(['template','layout','length'].includes(stage)?{required_outline:this.latest('template')?.contract?.outline||[],writing_plan:this.writingPlan(),writing_instruction:'首次写作按子节预算和focus展开具体案例、观点与机制；按主章组织，保留 ### 1.1 事件定性 等子节。目标为编辑建议，不能编造或为凑字重复重写；章内图可用 after_subsection 指定位置'}:{}), ...(stage === 'chapter' ? { actual_chars: Array.from(data.text).length,warnings:data.editorial_warnings||[],...(plan?{subsections:subsectionCoverage(data.text,plan)}:{}),next:'章节已保存；篇幅提示不要求重新提交，请继续下一章' } : {}) };
  }
  finalize(input: Row) {
    input=reportClaimNumbers(this.db,this.taskId,input);
    const template = this.latest('template'), layout = this.latest('layout');
    if (!template || !layout || !this.latest('repair')) throw new Error('成稿阶段未齐备，不能跳过逐章写作直接提交整篇回答');
    const sections = layout.chapters.map((c: Row) => {
      const chapter = this.stages().filter(a => a.payload.stage === 'chapter' && a.payload.data.id === c.id).at(-1)?.payload.data;
      if (!chapter) throw new Error('缺少已保存章节'); return { title: canonicalChapterTitle(chapter.title,template.contract.sections), text: chapter.text, claim_ids: chapter.claim_ids, visuals:chapter.visuals };
    });
    if (input.template_id !== template.template_id) throw new Error('最终文档与已保存模板不一致');
    if (input.sections !== undefined && encode(input.sections) !== encode(sections)) throw new Error('最终文档与已保存章节不一致，请先提交修订章节');
    let document: Row;
    this.save('report_submission',{input,input_version:this.service.reviewInput(this.taskId)});
    try {
      const metadata=reportMetadataSchema.parse({title:input.title,template_id:input.template_id,dataset_ids:input.dataset_ids,limitations:input.limitations,frameworks:input.frameworks});
      const {sections:cleaned,bindings,replacements,diagramBindings,appendixInputs}=this.readerSections(sections);
      if(appendixInputs.length)this.save('report_appendix_normalization',{inputs:appendixInputs,input_version:this.service.reviewInput(this.taskId),method:'reserved-program-coverage-only; analysis-prose-unchanged'});
      if(diagramBindings.length)this.save('report_diagram_reference_binding',{bindings:diagramBindings,input_version:this.service.reviewInput(this.taskId)});
      if(bindings.length)this.save('report_quote_binding',{bindings,method:'verbatim-match-in-task-archive',note:'同一引文命中多页仅记录来源位置，不据此认定独立交叉印证',input_version:this.service.reviewInput(this.taskId)});
      if(replacements.length)this.save('report_prose_cleanup',{replacements,input_version:this.service.reviewInput(this.taskId)});
      document = validateReport(this.db, this.taskId, { ...metadata, reader_version: 2, sections:cleaned }, template.contract);
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '报告校验未通过';
      const artifact_id = this.save('report_validation', { passed: false, message, input_version: this.service.reviewInput(this.taskId) });
      this.db.event(this.taskId, 'report.validation_failed', { message, artifact_id });
      throw error;
    }
    const input_version = this.service.reviewInput(this.taskId);
    this.save('report_ir', { document, input_version });
    this.save('report_quality', { passed: true, checks: ['完整章节', '本任务结论关联', '数字来源', '统计底表复算', '图表数据口径'],editorial_warnings:document.editorial_warnings, input_version });
    return { artifact_id: this.save('report_candidate', { document, template_contract: template.contract, input_version }),editorial_warnings:document.editorial_warnings,next:'候选已通过事实和结构检查；编辑提示不要求重写，由主 Agent 发布' };
  }
}
