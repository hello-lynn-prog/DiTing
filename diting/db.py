from contextlib import contextmanager, closing
import json
from pathlib import Path
import sqlite3
from datetime import datetime, timezone
from uuid import uuid4


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def uid(prefix):
    return prefix + "_" + uuid4().hex


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


SCHEMA = """
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
CREATE TABLE IF NOT EXISTS claims(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), text TEXT NOT NULL,
 references_json TEXT NOT NULL, created_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS outbox(
 id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, task_id TEXT REFERENCES tasks(id),
 event_type TEXT NOT NULL, channel TEXT NOT NULL, payload_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending_configuration', attempts INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=15000")
        return conn

    @contextmanager
    def transaction(self):
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def rows(self, sql, params=()):
        with closing(self.connect()) as conn:
            return [dict(r) for r in conn.execute(sql, params)]


def event(conn, task_id, kind, payload):
    conn.execute("INSERT INTO events(task_id,kind,payload_json,created_at) VALUES(?,?,?,?)",
                 (task_id, kind, encode(payload), now()))


def notify(conn, task_id, event_type, payload, version=1):
    conn.execute("""INSERT OR IGNORE INTO outbox
    (id,dedupe_key,task_id,event_type,channel,payload_json,created_at) VALUES(?,?,?,?,?,?,?)""",
                 (uid("notification"), f"{task_id}:{event_type}:{version}", task_id,
                  event_type, "in_app", encode(payload), now()))

