
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES(1);
CREATE TABLE IF NOT EXISTS sessions(
 id TEXT PRIMARY KEY, title TEXT NOT NULL, report_id TEXT, parent_task_id TEXT REFERENCES tasks(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks(
 id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL,
 status TEXT NOT NULL, stage INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 1,
 parent_id TEXT REFERENCES tasks(id), session_id TEXT REFERENCES sessions(id),
 budget REAL NOT NULL CHECK(budget>0), config_json TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 evidence_revision INTEGER NOT NULL DEFAULT 0, block_reason TEXT,
 lease_owner TEXT, lease_until TEXT,
 CHECK(status IN ('queued','running','paused','waiting_runtime','waiting_input',
 'waiting_approval','waiting_evidence','review','completed','failed','cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_task ON tasks((1)) WHERE status='running';
CREATE TABLE IF NOT EXISTS events(
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id),
 kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages(
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
 content TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests(
 session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
 content_hash TEXT NOT NULL, result_json TEXT NOT NULL,
 PRIMARY KEY(session_id,request_id)
);
CREATE TABLE IF NOT EXISTS evidence(
 id TEXT PRIMARY KEY, source_url TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
 content_hash TEXT NOT NULL, origin TEXT NOT NULL, captured_at TEXT NOT NULL,
 UNIQUE(source_url,content_hash)
);
CREATE TABLE IF NOT EXISTS task_evidence(
 task_id TEXT NOT NULL REFERENCES tasks(id), evidence_id TEXT NOT NULL REFERENCES evidence(id),
 PRIMARY KEY(task_id,evidence_id)
);
CREATE TABLE IF NOT EXISTS evidence_metadata(
 evidence_id TEXT PRIMARY KEY REFERENCES evidence(id) ON DELETE CASCADE,
 published_at TEXT, author TEXT, publisher TEXT, method TEXT NOT NULL,
 raw_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_relations(
 task_id TEXT NOT NULL REFERENCES tasks(id), evidence_a TEXT NOT NULL REFERENCES evidence(id), evidence_b TEXT NOT NULL REFERENCES evidence(id),
 relation TEXT NOT NULL, similarity REAL NOT NULL, method TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,evidence_a,evidence_b), CHECK(evidence_a<evidence_b)
);
CREATE TABLE IF NOT EXISTS claims(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), text TEXT NOT NULL,
 references_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claim_dataset_refs(
 claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE, dataset_id TEXT NOT NULL REFERENCES artifacts(id),
 row_key TEXT NOT NULL, value REAL NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(claim_id,dataset_id,row_key,value)
);
CREATE TABLE IF NOT EXISTS reviews(
 task_id TEXT NOT NULL REFERENCES tasks(id), gate TEXT NOT NULL,
 evidence_revision INTEGER NOT NULL, claims_hash TEXT NOT NULL,
 passed INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,gate)
);
CREATE TABLE IF NOT EXISTS reports(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL,
 title TEXT NOT NULL, document_json TEXT NOT NULL, input_hash TEXT NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(task_id,version)
);
CREATE TABLE IF NOT EXISTS usage(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL,
 provider TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cache_tokens INTEGER,
 cost REAL, attempt INTEGER NOT NULL, created_at TEXT NOT NULL,
 CHECK(input_tokens IS NULL OR input_tokens>=0),
 CHECK(cache_tokens IS NULL OR cache_tokens>=0),
 CHECK(output_tokens IS NULL OR output_tokens>=0),
 CHECK(input_tokens IS NULL OR cache_tokens IS NULL OR cache_tokens<=input_tokens)
);
CREATE TABLE IF NOT EXISTS acquisitions(
 id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), source TEXT NOT NULL,
 operation TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hotlist_snapshots(
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, source_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
 item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count>=0),
 error TEXT, observed_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hotlist_snapshots_lookup
 ON hotlist_snapshots(provider,source_id,created_at DESC);
CREATE TABLE IF NOT EXISTS hotlist_items(
 id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES hotlist_snapshots(id),
 item_key TEXT NOT NULL, title TEXT NOT NULL, url TEXT, rank INTEGER NOT NULL CHECK(rank>0),
 heat_value REAL, heat_label TEXT, raw_json TEXT NOT NULL, content_hash TEXT NOT NULL,
 UNIQUE(snapshot_id,item_key)
);
CREATE INDEX IF NOT EXISTS hotlist_items_snapshot_rank
 ON hotlist_items(snapshot_id,rank);
CREATE TABLE IF NOT EXISTS daily_digests(
 id TEXT PRIMARY KEY,report_date TEXT NOT NULL,title TEXT NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS daily_digests_date ON daily_digests(report_date,created_at DESC);
CREATE TABLE IF NOT EXISTS outbox(
 id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, task_id TEXT REFERENCES tasks(id),
 event_type TEXT NOT NULL, channel TEXT NOT NULL, payload_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending_configuration', attempts INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, next_attempt_ms INTEGER, last_error TEXT
);
