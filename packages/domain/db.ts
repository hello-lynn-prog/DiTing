import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, repairLegacyJson } from './json.js';

export type Row = Record<string, any>;
export const now = () => new Date().toISOString().replace('Z', '000+00:00');
export const uid = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
/** Stable encoding also matches the Python baseline's sorted JSON for string-valued claims. */
export const encode = canonicalJson;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class Database {
  readonly handle: DatabaseSync;
  private transactionDepth=0;
  private savepointSequence=0;
  constructor(readonly path: string, root: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.handle = new DatabaseSync(path);
    this.handle.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL;');
    this.handle.exec(readFileSync(join(root, 'packages/domain/schema.sql'), 'utf8'));
    this.handle.exec(`
      CREATE TABLE IF NOT EXISTS configuration(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,ciphertext TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_calls(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),session_id TEXT REFERENCES sessions(id),role TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,cache_tokens INTEGER,cost REAL,status TEXT NOT NULL,attempt INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_reservations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),reserved_cost REAL NOT NULL,actual_cost REAL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_queue(seq INTEGER PRIMARY KEY AUTOINCREMENT,call_id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL REFERENCES tasks(id),role TEXT NOT NULL,state TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_queue_clock(id INTEGER PRIMARY KEY CHECK(id=1),last_started INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_account_clocks(scope TEXT PRIMARY KEY,last_started INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_queue_scopes(call_id TEXT PRIMARY KEY REFERENCES model_queue(call_id) ON DELETE CASCADE,scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS visual_assets(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),evidence_id TEXT NOT NULL REFERENCES evidence(id),source_url TEXT NOT NULL,final_url TEXT NOT NULL,content_hash TEXT NOT NULL,media_type TEXT NOT NULL,byte_size INTEGER NOT NULL,frames_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,evidence_id,content_hash));
      CREATE TABLE IF NOT EXISTS visual_observations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),asset_id TEXT NOT NULL REFERENCES visual_assets(id),evidence_id TEXT NOT NULL REFERENCES evidence(id),call_id TEXT NOT NULL REFERENCES model_calls(id),request_hash TEXT NOT NULL,observation_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),root_session_id TEXT NOT NULL,child_session_id TEXT NOT NULL UNIQUE,role TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,role TEXT NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),operation TEXT NOT NULL,request_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,decided_at TEXT);
      CREATE TABLE IF NOT EXISTS monitors(id TEXT PRIMARY KEY,title TEXT NOT NULL,keywords_json TEXT NOT NULL,enabled INTEGER NOT NULL,interval_minutes INTEGER NOT NULL,auto_research INTEGER NOT NULL,budget REAL NOT NULL,next_run_at TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signals(id TEXT PRIMARY KEY,monitor_id TEXT REFERENCES monitors(id),event_key TEXT NOT NULL UNIQUE,title TEXT NOT NULL,reason TEXT NOT NULL,evidence_json TEXT NOT NULL,task_id TEXT REFERENCES tasks(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hotlist_responses(snapshot_id TEXT PRIMARY KEY REFERENCES hotlist_snapshots(id),payload_json TEXT NOT NULL,origin_url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_records(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),platform TEXT NOT NULL,record_id TEXT NOT NULL,record_type TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,author TEXT,published_at TEXT,metrics_json TEXT NOT NULL,raw_json TEXT NOT NULL,evidence_id TEXT NOT NULL REFERENCES evidence(id),captured_at TEXT NOT NULL,UNIQUE(task_id,platform,record_id,record_type));
      CREATE TABLE IF NOT EXISTS crawl_batches(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),platform TEXT NOT NULL,scope_json TEXT NOT NULL,status TEXT NOT NULL,lease_token TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS crawl_pages(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES crawl_batches(id),request_hash TEXT NOT NULL,operation TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL,payload_json TEXT,error TEXT,attempts INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(batch_id,request_hash));
      CREATE TABLE IF NOT EXISTS content_provenance(content_id TEXT PRIMARY KEY REFERENCES content_records(id),batch_id TEXT REFERENCES crawl_batches(id),parent_record_id TEXT,page_url TEXT NOT NULL,query TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS json_record_repairs(table_name TEXT NOT NULL,row_key TEXT NOT NULL,column_name TEXT NOT NULL,original_json TEXT NOT NULL,repaired_json TEXT NOT NULL,repaired_at TEXT NOT NULL,PRIMARY KEY(table_name,row_key,column_name));
      CREATE TABLE IF NOT EXISTS acquisition_responses(acquisition_id TEXT PRIMARY KEY REFERENCES acquisitions(id),request_json TEXT NOT NULL,response_json TEXT,status_code INTEGER,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sentiment_prediction_cache(input_hash TEXT NOT NULL,model_version TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(input_hash,model_version));
      CREATE TABLE IF NOT EXISTS sentiment_inferences(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),evidence_id TEXT NOT NULL REFERENCES evidence(id),model_version TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,evidence_id,model_version));
      INSERT OR IGNORE INTO schema_version VALUES(2);
      INSERT OR IGNORE INTO schema_version VALUES(3);
      INSERT OR IGNORE INTO schema_version VALUES(4);
      INSERT OR IGNORE INTO schema_version VALUES(5);
    `);
    // Additive migration: older databases keep their signal history and gain a read marker.
    if (!this.rows('PRAGMA table_info(signals)').some(column => column.name === 'read_at')) {
      this.handle.exec('ALTER TABLE signals ADD COLUMN read_at TEXT');
    }
    const outboxColumns=new Set(this.rows('PRAGMA table_info(outbox)').map(column=>column.name));
    if(!outboxColumns.has('next_attempt_ms'))this.handle.exec('ALTER TABLE outbox ADD COLUMN next_attempt_ms INTEGER');
    if(!outboxColumns.has('last_error'))this.handle.exec('ALTER TABLE outbox ADD COLUMN last_error TEXT');
    this.transaction(() => {
      for (const row of this.rows('SELECT id,payload_json FROM events WHERE NOT json_valid(payload_json)')) {
        const repaired = repairLegacyJson(row.payload_json);
        if (repaired === null) continue;
        this.run('INSERT OR IGNORE INTO json_record_repairs VALUES(?,?,?,?,?,?)', 'events', String(row.id), 'payload_json', row.payload_json, repaired, now());
        this.run('UPDATE events SET payload_json=? WHERE id=?', repaired, row.id);
      }
    });
  }
  rows(sql: string, ...params: SQLInputValue[]): Row[] { return this.handle.prepare(sql).all(...params) as Row[]; }
  one(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.handle.prepare(sql).get(...params) as Row | undefined; }
  run(sql: string, ...params: SQLInputValue[]) { return this.handle.prepare(sql).run(...params); }
  transaction<T>(fn: () => T): T {
    const nested=this.transactionDepth>0,savepoint='diting_'+(++this.savepointSequence);
    this.handle.exec(nested?'SAVEPOINT '+savepoint:'BEGIN IMMEDIATE');this.transactionDepth++;
    try { const result = fn(); this.handle.exec(nested?'RELEASE SAVEPOINT '+savepoint:'COMMIT'); return result; }
    catch (error) { this.handle.exec(nested?'ROLLBACK TO SAVEPOINT '+savepoint:'ROLLBACK');if(nested)this.handle.exec('RELEASE SAVEPOINT '+savepoint);throw error; }
    finally{this.transactionDepth--;}
  }
  event(taskId: string | null, kind: string, payload: Row) {
    this.run('INSERT INTO events(task_id,kind,payload_json,created_at) VALUES(?,?,?,?)', taskId, kind, encode(payload), now());
  }
  notify(taskId: string | null, type: string, payload: Row, version: number | string = 1) {
    this.run(`INSERT OR IGNORE INTO outbox(id,dedupe_key,task_id,event_type,channel,payload_json,created_at)
      VALUES(?,?,?,?,?,?,?)`, uid('notification'), `${taskId}:${type}:${version}`, taskId, type, 'in_app', encode(payload), now());
  }
  close() { this.handle.close(); }
}
