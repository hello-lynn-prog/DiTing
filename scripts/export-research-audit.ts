/** Export one task's saved research, progress and draft without credentials or new model calls. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database, hash } from '../packages/domain/db.js';
import { Service } from '../packages/domain/service.js';
import { ReportPipeline } from '../packages/reporting/pipeline.js';
import { renderReport } from '../packages/reporting/report.js';
import { ROOT } from '../apps/server/settings.js';

const taskId = process.argv[2];
if (!/^task_[a-f0-9]{32}$/.test(taskId || '')) throw new Error('请提供明确 task_ 任务编号');
const dataDir = resolve(process.env.DITING_DATA_DIR || join(ROOT, 'data')), db = new Database(join(dataDir, 'diting.sqlite3'), ROOT);
try {
  const service = new Service(db), task = service.task(taskId), stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = join(dataDir, 'exports', taskId, 'recovery-' + stamp); mkdirSync(dir, { recursive: true });
  const bundle = {
    exported_at: new Date().toISOString(), time_zone: 'Asia/Shanghai', task,
    evidence: db.rows('SELECT e.* FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id WHERE te.task_id=? ORDER BY e.captured_at', taskId),
    claims: db.rows('SELECT * FROM claims WHERE task_id=? ORDER BY created_at', taskId),
    sentiment_inferences:db.rows('SELECT * FROM sentiment_inferences WHERE task_id=? ORDER BY created_at',taskId),
    platform_records:db.rows('SELECT * FROM content_records WHERE task_id=? ORDER BY rowid',taskId),
    visual_assets:db.rows('SELECT * FROM visual_assets WHERE task_id=? ORDER BY created_at',taskId),
    visual_observations:db.rows('SELECT * FROM visual_observations WHERE task_id=? ORDER BY created_at',taskId),
    reviews: db.rows('SELECT * FROM reviews WHERE task_id=?', taskId),
    artifacts: db.rows('SELECT * FROM artifacts WHERE task_id=? ORDER BY rowid', taskId),
    events: db.rows('SELECT * FROM events WHERE task_id=? ORDER BY id', taskId),
    acquisitions: db.rows('SELECT a.*,r.request_json,r.response_json,r.status_code FROM acquisitions a LEFT JOIN acquisition_responses r ON r.acquisition_id=a.id WHERE a.task_id=? ORDER BY a.created_at', taskId),
    calls: db.rows('SELECT * FROM model_calls WHERE task_id=? ORDER BY created_at', taskId),
    reservations: db.rows('SELECT * FROM model_reservations WHERE task_id=? ORDER BY created_at', taskId),
    reports: db.rows('SELECT * FROM reports WHERE task_id=? ORDER BY version', taskId),
    repaired_logs: db.rows("SELECT * FROM json_record_repairs WHERE table_name='events' AND row_key IN (SELECT CAST(id AS TEXT) FROM events WHERE task_id=?)", taskId),
  };
  const files: Record<string, string> = { 'audit.json': JSON.stringify(bundle, null, 2) };
  let draftStatus: string;
  try {
    const preview = new ReportPipeline(db, service, taskId).preview(), rendered = renderReport(db, taskId, preview.document);
    files['draft.json'] = JSON.stringify(preview, null, 2);
    files['draft.html'] = rendered.html.replace('<body>', '<body><aside style="background:#fff3d6;padding:16px;border:1px solid #d9a441">未发布草稿：尚未通过最终报告校验，供核对研究过程使用。</aside>');
    files['draft.md'] = '> 未发布草稿，须完成最终校验。\n\n' + rendered.markdown;
    draftStatus = `${preview.document.sections.length} 章 / ${preview.document.tables.length} 表；校验问题见 draft.json`;
  } catch (error) { draftStatus = error instanceof Error ? error.message : '暂无章节草稿'; }
  files['README.md'] = `# 研究过程存档\n\n任务：${task.title}\n\n状态：${task.status}\n\n${bundle.evidence.length} 条原文、${bundle.claims.length} 条结论、${bundle.reviews.length} 道门禁、${bundle.artifacts.length} 个阶段产物、${bundle.events.length} 条过程事件。\n\n报告草稿：${draftStatus}\n\n实际供应商用量与保守费用预留分别存档；未知费用不回填为零。全部 JSON 都是本任务现存数据快照，未新增检索或模型调用。\n`;
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  const manifest = { task_id: taskId, exported_at: bundle.exported_at, status: task.status, files: Object.entries(files).map(([name, content]) => ({ name, bytes: Buffer.byteLength(content), sha256: hash(content) })) };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2)); console.log(JSON.stringify({ directory: dir, status: task.status, draft: draftStatus, files: Object.keys(files) }, null, 2));
} finally { db.close(); }
