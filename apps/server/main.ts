import { createApp } from './app.js';
import { settings } from './settings.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backupDatabase } from '../../scripts/backup.js';
import { archiveLegacyRuntimeFiles, installRollingConsoleLog } from '../../packages/domain/rolling-log.js';
import { Database } from '../../packages/domain/db.js';
import { recoverModelQueue } from '../../packages/domain/model-queue.js';
const config = settings(); mkdirSync(config.dataDir, { recursive: true });
const lock = join(config.dataDir, 'server.lock');
if (existsSync(lock)) {
  const previous = Number(readFileSync(lock, 'utf8'));
  if (!Number.isInteger(previous) || previous <= 0) throw new Error('服务锁无效，请核实本目录没有正在运行的服务');
  let alive = true; try { process.kill(previous, 0); } catch { alive = false; }
  if (alive) throw new Error('此数据目录已有服务运行，请先停止它，避免两套业务后端同时写入');
  unlinkSync(lock);
}
writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
const runtimeFiles = archiveLegacyRuntimeFiles(config.dataDir);
installRollingConsoleLog(config.dataDir);
console.info('Runtime logs and diagnostics are separated', runtimeFiles);
const releaseLock = () => { if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock); };
process.on('exit', releaseLock);
const database = join(config.dataDir, 'diting.sqlite3');
if (existsSync(database)) {
  const baseline = new DatabaseSync(database, { readOnly: true });
  const version = (baseline.prepare('SELECT MAX(version) v FROM schema_version').get() as any)?.v; baseline.close();
  if (version < 2) { const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(/[^\d]/g, ''); const result = await backupDatabase(database, join(config.dataDir, 'backups', `pre-ts-${stamp}`)); console.log('Pre-migration database backup:', result?.database); }
}
const recoveryDb = new Database(database, config.root);
const staleModelCalls = recoverModelQueue(recoveryDb);
recoveryDb.close();
if (staleModelCalls) console.info(`Recovered ${staleModelCalls} abandoned model queue entries; completed call and usage records were preserved`);
const { app } = await createApp();
const port = Number(process.env.DITING_PORT || process.env.PORT || 8090);
const address=await app.listen({ host: '127.0.0.1', port });
console.log(`DiTing TypeScript console: ${address}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
