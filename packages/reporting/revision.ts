import { Database, encode, hash, now, uid, type Row } from '../domain/db.js';
import { Conflict, Service } from '../domain/service.js';
import { exportFiles, validateReport,resolveTemplate } from './report.js';

/** An explicit editorial revision of reviewed claims, without rerunning research. */
export async function reviseReport(db: Database, service: Service, sourceId: string, input: Row, dataDir: string, options:{upgradeTemplate?:boolean;replaceTemplate?:boolean;reason?:string}={}) {
  const source = db.one('SELECT * FROM reports WHERE id=?', sourceId);
  if (!source) throw new Conflict('原报告不存在');
  const previous = JSON.parse(source.document_json), taskId = source.task_id;
  const allowed = new Set(previous.sections.flatMap((s: Row) => s.claim_ids));
  const check = () => {
    const task = service.rawTask(taskId), current = service.reviewInput(taskId);
    if (task.status !== 'completed') throw new Conflict('研究任务尚未结束，请等待当前任务');
    if (hash(encode({ config: JSON.parse(task.config_json), ...current, document: previous })) !== source.input_hash) throw new Conflict('原报告研究版本已变化，须重新研判');
    const latest = db.one('SELECT id FROM reports WHERE task_id=? ORDER BY version DESC LIMIT 1', taskId);
    if (latest?.id !== sourceId) throw new Conflict('已有更新的报告，请基于最新版本修订');
    if (input.template_id !== previous.template_id&&!options.replaceTemplate) throw new Conflict('文字修订不能改变已经选定的模板');
    if (input.sections.some((s: Row) => s.claim_ids.some((id: string) => !allowed.has(id)))) throw new Conflict('文字修订不能新增未经原报告使用的结论');
    const valid = db.rows('SELECT * FROM reviews WHERE task_id=?', taskId).filter(r => r.passed && r.evidence_revision === current.evidence_revision && r.claims_hash === current.claims_hash);
    if (new Set(valid.map(r => r.gate)).size !== 3) throw new Conflict('原报告门禁已失效，须重新审查');
    return current;
  };
  check();
  const stage=db.rows("SELECT data_json FROM artifacts WHERE task_id=? AND kind='report_stage' ORDER BY rowid DESC",taskId).map(a=>JSON.parse(a.data_json)).find(a=>a.stage==='template'&&a.data?.template_id===previous.template_id);
  const priorContract=db.one("SELECT data_json FROM artifacts WHERE task_id=? AND kind='report_template_revision' AND json_extract(data_json,'$.report_id')=? ORDER BY rowid DESC LIMIT 1",taskId,sourceId);
  const contract=(options.upgradeTemplate||options.replaceTemplate)?resolveTemplate(db,input.template_id):priorContract?JSON.parse(priorContract.data_json).contract:stage?.data?.contract;
  const document = validateReport(db, taskId, { ...input, reader_version: 2 },contract);
  check();
  const exports = await exportFiles(db, taskId, {...document,template_contract:contract}, dataDir);
  return db.transaction(() => {
    const current = check(), task = service.rawTask(taskId), final = { ...document, exports };
    let root = task; for (let i = 0; root.parent_id && i < 64; i++) root = service.rawTask(root.parent_id);
    const version = (db.one('WITH RECURSIVE family(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN family f ON t.parent_id=f.id) SELECT MAX(r.version) n FROM reports r JOIN family f ON r.task_id=f.id', root.id)?.n || 0) + 1;
    const report_id = uid('report');
    db.run('INSERT INTO reports VALUES(?,?,?,?,?,?,?)', report_id, taskId, version, document.title, encode(final), hash(encode({ config: JSON.parse(task.config_json), ...current, document: final })), now());
    if(contract)db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',uid('artifact'),taskId,'report_template_revision','report',encode({source_report_id:sourceId,report_id,contract,upgrade:!!options.upgradeTemplate,template_changed:input.template_id!==previous.template_id,reason:options.reason||null}),now());
    db.event(taskId, 'report.editorial_revision', { message: '报告已完成人工文字修订，保留原版与原审查证据', source_report_id: sourceId, report_id, version, author: 'codex_editorial', evidence_changed: false });
    db.notify(taskId, 'report.updated', { report_id, version }, version);
    return { report_id, version, exports };
  });
}
