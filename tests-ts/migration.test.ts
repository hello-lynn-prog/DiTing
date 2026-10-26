import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database, encode } from '../packages/domain/db.js';
import { Service } from '../packages/domain/service.js';
import { ROOT } from '../apps/server/settings.js';
import { backupDatabase } from '../scripts/backup.js';

test('actual Python baseline data and claim hashes survive TS schema migration and a SQLite backup', { skip: !existsSync(join(ROOT, '.venv/Scripts/python.exe')) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diting-migrate-')), source = join(dir, 'legacy.sqlite3');
  const fixture = `import json,sys\nfrom pathlib import Path\nfrom diting.db import Database\nfrom diting.service import Service\nfrom diting.config import Settings\ns=Service(Database(Path(sys.argv[1])),Settings())\nsid=s.session('Migration fixture')\ntid=s.send(sid,'调查明确的迁移测试主题','migration-request')['task_id']\nrun=s.claim('test')\neid=s.archive(tid,'https://example.org/migration','明确测试材料','明确测试原文：这是迁移验收资料，不是真实新闻。')\ns.add_claim(tid,'这是迁移验收资料',[{'evidence_id':eid,'quote':'这是迁移验收资料，不是真实新闻'}],lease_token=run['lease_owner'])\nprint(json.dumps({'task_id':tid,'review_input':s.review_input(tid),'lease':run['lease_owner']}))`;
  const manifest = JSON.parse(execFileSync(join(ROOT, '.venv/Scripts/python.exe'), ['-c', fixture, source], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
  const old = new DatabaseSync(source, { readOnly: true });
  const tables = (old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[]).map(t => t.name);
  const before = Object.fromEntries(tables.map(t => [t, old.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])); old.close();
  const backup = await backupDatabase(source, join(dir, 'backup')); assert.ok(backup);
  const db = new Database(source, ROOT), service = new Service(db);
  for (const table of tables) {
    if (table === 'schema_version') continue;
    assert.equal(encode(db.rows(`SELECT * FROM ${table} ORDER BY rowid`)), encode(before[table]), `must retain all ${table} rows exactly`);
  }
  assert.deepEqual(service.reviewInput(manifest.task_id), manifest.review_input);
  assert.equal(service.rawTask(manifest.task_id).lease_owner, manifest.lease);
  assert.equal(db.one('SELECT MAX(version) v FROM schema_version')!.v, 5); db.close();
});
