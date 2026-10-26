import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveLegacyRuntimeFiles, writeRollingLog } from '../packages/domain/rolling-log.js';

test('rolling logs cap daily files, expire old rolls, and archive legacy logs and probes separately', () => {
  const root = mkdtempSync(join(tmpdir(), 'diting-logs-'));
  const data = join(root, 'data'); mkdirSync(data);
  const now = new Date('2026-10-19T12:00:00.000Z');
  mkdirSync(join(data, 'logs'));
  const oldLog = join(data, 'logs', 'server-2026-09-01-0.jsonl'); writeFileSync(oldLog, 'expired');
  const oldDate = new Date('2026-09-01T00:00:00.000Z'); utimesSync(oldLog, oldDate, oldDate);
  writeRollingLog(join(data, 'logs'), 'info', ['first line'], { maxBytes: 30, filesPerDay: 2, now: () => now });
  writeRollingLog(join(data, 'logs'), 'info', ['second line'], { maxBytes: 30, filesPerDay: 2, now: () => now });
  writeRollingLog(join(data, 'logs'), 'info', ['third line'], { maxBytes: 30, filesPerDay: 2, now: () => now });
  assert.equal(readdirSync(join(data, 'logs')).filter(name => name.endsWith('.jsonl')).length, 2);
  const result = archiveLegacyRuntimeFiles(data, now);
  writeFileSync(join(data, 'server-old.stdout.log'), 'legacy log');
  writeFileSync(join(data, 'glm-reasoning-probe.json'), '{}');
  archiveLegacyRuntimeFiles(data, now);
  assert.equal(existsSync(join(data, 'server-old.stdout.log')), false);
  assert.equal(existsSync(join(data, 'glm-reasoning-probe.json')), false);
  assert.ok(readdirSync(result.legacyDir).some(name => name.startsWith('server-old.stdout')));
  assert.ok(readdirSync(result.probeDir).some(name => name.startsWith('glm-reasoning-probe')));
  assert.equal(existsSync(join(data, 'logs', 'server-2026-09-01-0.jsonl')), false);
});
