import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Database, encode, now, uid, type Row } from './db.js';

export const slotIds = ['chat', 'planner', 'insight', 'media', 'query', 'forum', 'report', 'keyword', 'mindspider'] as const;
export const routeSchema = z.object({ id: z.enum(slotIds), name: z.string().max(80).default(''),
  protocol: z.enum(['openai-completions', 'anthropic-messages']).default('openai-completions'),
  provider: z.string().min(1).max(80), base_url: z.string().url().refine(u => { const url = new URL(u); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }),
  model: z.string().min(1).max(160), enabled: z.boolean().default(false),
  rates: z.object({ input: z.number().nonnegative(), cache: z.number().nonnegative(), output: z.number().nonnegative() }).optional(),
  api_key: z.string().max(16000).optional(), max_tokens: z.number().int().min(256).max(65536).default(8192) }).strict();
export type Route = Omit<z.infer<typeof routeSchema>, 'api_key'> & { key_ref: string };

export class Configuration {
  private key: Buffer;
  constructor(readonly db: Database, dataDir: string) {
    const file = join(dataDir, 'master.key');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(file); if (this.key.length !== 32) throw new Error('本机密钥文件无效；请恢复备份，不能重建覆盖');
  }
  get<T>(key: string, fallback: T): T { const row = this.db.one('SELECT value_json FROM configuration WHERE key=?', key); return row ? JSON.parse(row.value_json) : fallback; }
  set(key: string, value: unknown) {
    this.db.run(`INSERT INTO configuration VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=configuration.revision+1,updated_at=excluded.updated_at`, key, encode(value), now());
  }
  putSecret(id: string, value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
    this.db.run('INSERT OR REPLACE INTO secrets VALUES(?,?,?)', id, blob, now());
  }
  secret(id: string): string | undefined {
    const row = this.db.one('SELECT ciphertext FROM secrets WHERE id=?', id); if (!row) return;
    const blob = Buffer.from(row.ciphertext, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(12, 28)); return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
  }
  hasSecret(id: string) { return !!this.db.one('SELECT id FROM secrets WHERE id=?', id); }
  publicRoutes() { return slotIds.map(id => { const r = this.get<Route | null>(`llm.${id}`, null); return r ? { ...r, key_configured: this.hasSecret(r.key_ref) } : { id, name: id, enabled: false, provider: '', model: '', base_url: '', max_tokens: 8192, key_configured: false }; }); }
  saveRoute(input: unknown) {
    const { api_key, ...route } = routeSchema.parse(input);
    const previous = this.get<Route | null>(`llm.${route.id}`, null);
    const key_ref = api_key?.trim() ? `llm.${route.id}.${uid('key')}` : previous?.key_ref || `llm.${route.id}`;
    this.db.transaction(() => { if (api_key?.trim()) this.putSecret(key_ref, api_key.trim()); this.set(`llm.${route.id}`, { ...route, key_ref }); });
    return this.publicRoutes().find(r => r.id === route.id);
  }
  seedResearchRoutesFromChat() {
    const source = this.get<Route | null>('llm.chat', null);
    if (!source || !source.enabled || !this.hasSecret(source.key_ref)) throw new Error('请先保存并启用对话模型槽');
    const targets = ['planner', 'insight', 'media', 'query', 'forum', 'report', 'keyword'] as const;
    const created: string[] = [];
    this.db.transaction(() => {
      for (const id of targets) {
        if (this.get<Route | null>(`llm.${id}`, null)) continue;
        this.set(`llm.${id}`, { ...source, id, name: id }); created.push(id);
      }
    });
    return { created, routes: this.publicRoutes() };
  }
  route(role: string): Route | null {
    const id = slotIds.includes(role as any) ? role : 'planner';
    const r = this.get<Route | null>(`llm.${id}`, null); return r?.enabled && this.hasSecret(r.key_ref) ? r : null;
  }
  publicServices() { return ['tavily', 'bocha', 'anspire', 'firecrawl', 'feishu', 'wecom'].map(id => ({ id, ...this.get<Row>(`service.${id}`, {}), key_configured: this.hasSecret(`service.${id}`),health:this.get<Row>(`service.health.${id}`,{status:'not_tested'}) })); }
}
