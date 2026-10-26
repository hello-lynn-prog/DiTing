import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const day = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export interface RollingLogOptions { maxBytes?: number; filesPerDay?: number; retentionDays?: number; now?: () => Date; }

/** Writes bounded daily JSONL logs while preserving console output for the invoking terminal. */
export function writeRollingLog(directory: string, level: string, values: unknown[], options: RollingLogOptions = {}) {
  mkdirSync(directory, { recursive: true });
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const filesPerDay = options.filesPerDay ?? 3;
  const retentionDays = options.retentionDays ?? 14;
  const timestamp = (options.now ?? (() => new Date()))();
  const prefix = `server-${day(timestamp)}`;
  const rendered = values.map(value => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }).join(' ');
  const line = JSON.stringify({ at: timestamp.toISOString(), level, message: rendered }) + '\n';
  let index = 0;
  while (index < filesPerDay) {
    const candidate = join(directory, `${prefix}-${index}.jsonl`);
    if (!existsSync(candidate) || statSync(candidate).size + Buffer.byteLength(line) <= maxBytes) break;
    index++;
  }
  if (index < filesPerDay) {
    appendFileSync(join(directory, `${prefix}-${index}.jsonl`), line, { mode: 0o600 });
  }
  const cutoff = timestamp.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(directory)) {
    if (!/^server-\d{4}-\d{2}-\d{2}-\d+\.jsonl$/.test(name)) continue;
    const path = join(directory, name);
    if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
  }
}

/** Archive logs/probes created by older launch workflows without discarding their contents. */
export function archiveLegacyRuntimeFiles(dataDir: string, now = new Date()) {
  const logDir = join(dataDir, 'logs'), legacyDir = join(logDir, 'legacy'), probeDir = join(dataDir, 'diagnostics', 'probes');
  mkdirSync(legacyDir, { recursive: true }); mkdirSync(probeDir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  for (const name of readdirSync(dataDir)) {
    const isLog = /^server-.*\.(?:stdout|stderr)\.log$/i.test(name);
    const isProbe = /probe.*\.json$/i.test(name);
    if (!isLog && !isProbe) continue;
    const source = join(dataDir, name), destinationDir = isLog ? legacyDir : probeDir;
    let destination = join(destinationDir, name);
    if (existsSync(destination)) destination = join(destinationDir, name.replace(/(\.[^.]+)$/, `-${stamp}$1`));
    renameSync(source, destination);
  }
  return { logDir, legacyDir, probeDir };
}

export function installRollingConsoleLog(dataDir: string) {
  const logDir = join(dataDir, 'logs');
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => {
      try { writeRollingLog(logDir, level === 'log' ? 'info' : level, values); } catch { /* logging must never prevent service startup */ }
      original(...values);
    };
  }
  process.on('uncaughtExceptionMonitor', error => {
    try { writeRollingLog(logDir, 'fatal', [error instanceof Error ? error.stack || error.message : error]); } catch { /* best effort */ }
  });
  process.on('unhandledRejection', reason => {
    try { writeRollingLog(logDir, 'error', [reason instanceof Error ? reason.stack || reason.message : reason]); } catch { /* best effort */ }
  });
}
