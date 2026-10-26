import type {Database} from '../domain/db.js';
import {frozenResearchWindow} from '../domain/research-window.js';

/** Reserved coverage notes are computed from this task; they contain no new external claims. */
export function programAppendix(db:Database,taskId:string,title:string):string|null {
 const task=db.one('SELECT created_at,config_json FROM tasks WHERE id=?',taskId);if(!task)throw Error('任务不存在');
 const cfg=JSON.parse(task.config_json),pages=Number(db.one('SELECT COUNT(*) n FROM task_evidence WHERE task_id=?',taskId)!.n),claims=Number(db.one('SELECT COUNT(*) n FROM claims WHERE task_id=?',taskId)!.n),records=Number(db.one('SELECT COUNT(*) n FROM content_records WHERE task_id=?',taskId)!.n);
 switch(title){
 case '研究范围与方法':{const window=frozenResearchWindow(task.created_at,cfg.window_days||7),published=db.rows('SELECT m.published_at FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id LEFT JOIN evidence_metadata m ON m.evidence_id=e.id WHERE te.task_id=?',taskId).map(r=>r.published_at?Date.parse(r.published_at):NaN),counts={within:published.filter(t=>Number.isFinite(t)&&t>=Date.parse(window.start)&&t<=Date.parse(window.end)).length,before:published.filter(t=>Number.isFinite(t)&&t<Date.parse(window.start)).length,after:published.filter(t=>Number.isFinite(t)&&t>Date.parse(window.end)).length,unknown:published.filter(t=>!Number.isFinite(t)).length};return `本次研究时间窗于任务创建时冻结：${window.start_local} 至 ${window.end_local}（北京时间，精确回溯${window.days}×24小时）。材料发布日统计为窗内${counts.within}份、窗前${counts.before}份、窗后${counts.after}份，另有${counts.unknown}份发布时间未提供；窗外与日期未知材料仅作背景，不计入窗内样本。任务共归档${pages}份原文，保存${claims}条带引用的分析结论。正文区分报道、当事方表述与分析归纳；引用可以在文末回查。\n\n${cfg.sentiment?.enabled?'情感标签由独立本地五级分类器计算，每份文本最多使用前512个分词；低置信度保留为未知。新闻文本语气不等同于公众情绪。':'本任务未启用独立本地情感分类器，不将未分类文本解释为中性。'}统计表只描述已取得的样本，不外推总体。`;}
 case '平台样本分析':return records?null:'本任务没有归档登录平台的正文或评论记录，不据此测量微博、B站或全网声量。新闻文本的情感分类仅描述已归档文本，不代表公众意见比例。';
 case '局限与待核实事项':return '本报告反映当前取得的公开材料与样本。来源之间可能存在转载关系，域名数量不能直接当作独立信源数量。对来源未确认、缺少明确日期或没有取得当事方回应的事项，应结合文末研究局限与正文限定阅读；未采集到的内容不进入统计。';
 case '来源与统计附录':return '原文链接、引用位置和样本统计表列于文末，读者可据此复核具体表述。复用历史归档时保留原取得时间，不冒充本轮重新抓取。各统计图表以实际保存的数据为依据，不能将样本分布解释为全网趋势；不同主体、日期和单位的财务指标不应混加。';
 default:return null;
 }
}
