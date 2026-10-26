import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, encode } from '../packages/domain/db.js';
import { repairLegacyJson } from '../packages/domain/json.js';
import { ROOT } from '../apps/server/settings.js';

test('canonical JSON keeps existing hashes stable and handles optional properties as standard JSON', () => {
  assert.equal(encode({ b: [1, { z: 'text', a: null }], a: true }), '{"a": true, "b": [1, {"a": null, "z": "text"}]}');
  assert.deepEqual(JSON.parse(encode({ version: undefined, rows: [undefined, NaN], note: 'undefined' })), { rows: [null, null], note: 'undefined' });
  assert.throws(() => encode(undefined), TypeError);
  const original = '{"note":"quoted undefined and \\\"undefined\\\"", "version": undefined}';
  assert.deepEqual(JSON.parse(repairLegacyJson(original)!), { note: 'quoted undefined and "undefined"', version: null });
  assert.equal(repairLegacyJson('{"broken": nope}'), null);
});

test('opening an old database repairs malformed optional log fields and retains the exact original', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'diting-json-')), 'state.sqlite3');
  let db = new Database(file, ROOT);
  const raw = '{"message":"技能读取失败", "version": undefined}';
  db.run('INSERT INTO events(task_id,kind,payload_json,created_at) VALUES(NULL,?,?,?)', 'skill.failed', raw, new Date().toISOString());
  db.close(); db = new Database(file, ROOT);
  assert.equal(db.one('SELECT COUNT(*) n FROM events WHERE NOT json_valid(payload_json)')!.n, 0);
  assert.equal(db.one('SELECT original_json FROM json_record_repairs')!.original_json, raw);
  db.event(null, 'skill.failed', { message: 'optional version', version: undefined });
  assert.equal(db.one('SELECT COUNT(*) n FROM events WHERE NOT json_valid(payload_json)')!.n, 0);
  db.close();
});
