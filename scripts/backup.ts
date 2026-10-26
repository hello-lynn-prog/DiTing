import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export async function backupDatabase(path: string, folder: string) {
  if (!existsSync(path)) return null;
  mkdirSync(folder, { recursive: true }); const file = join(folder, 'diting.sqlite3');
  if (existsSync(file)) throw new Error('备份目标已存在，未覆盖已有备份');
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    const counts = Object.fromEntries(tables.map(t => [t.name, source.prepare(`SELECT COUNT(*) n FROM "${t.name.replaceAll('"', '""')}"`).get()!.n]));
    await backup(source, file);
    const master = join(dirname(path), 'master.key'); if (existsSync(master)) copyFileSync(master, join(folder, 'master.key'));
    const result = { database: file, tables: counts, created_at: new Date().toISOString(), key_backed_up: existsSync(master) };
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(result, null, 2)); return result;
  } finally { source.close(); }
}
