from datetime import datetime, timedelta, timezone
import hashlib
import json
import math

from .db import Database, encode, event, notify, now, uid
from .intent import classify, scope


class Conflict(ValueError):
    pass


class Missing(LookupError):
    pass


class Service:
    def __init__(self, db: Database, settings):
        self.db, self.settings = db, settings

    @staticmethod
    def _task(conn, task_id):
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise Missing("任务不存在")
        return dict(row)

    @staticmethod
    def _public_task(t):
        t = dict(t)
        t["config"] = json.loads(t.pop("config_json"))
        t.pop("lease_owner")
        t.pop("lease_until")
        return t

    def task(self, task_id):
        rows = self.db.rows("SELECT * FROM tasks WHERE id=?", (task_id,))
        if not rows:
            raise Missing("任务不存在")
        return self._public_task(rows[0])

    def tasks(self):
        return [self._public_task(t) for t in self.db.rows("SELECT * FROM tasks ORDER BY created_at DESC")]

    def session(self, title="新的对话", report_id=None, parent_task_id=None):
        sid = uid("session")
        with self.db.transaction() as conn:
            if report_id and not conn.execute("SELECT 1 FROM reports WHERE id=?", (report_id,)).fetchone():
                raise Missing("报告不存在")
            if parent_task_id:
                self._task(conn, parent_task_id)
            conn.execute("INSERT INTO sessions VALUES(?,?,?,?,?)", (sid, title, report_id, parent_task_id, now()))
        return sid

    def _create_task(self, conn, title, session_id, parent_id=None, source="chat"):
        config = scope(title, self.settings.default_budget)
        config.update({"executor": "dsh", "pipeline": "bettafish-full-v1",
                       "config_version": 1, "max_supplement_rounds": 3,
                       "delivery": ["html", "markdown", "pdf"],
                       "gates": ["sufficiency", "verifier", "advocate"]})
        if parent_id:
            self._task(conn, parent_id)
        tid = uid("task")
        stamp = now()
        conn.execute("""INSERT INTO tasks(id,title,source,status,parent_id,session_id,budget,
        config_json,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?,?)""",
                     (tid, title, source, parent_id, session_id, config["budget"], encode(config), stamp, stamp))
        event(conn, tid, "task.created", {"message": "独立研究任务已入队", "config": config})
        return tid

    def send(self, session_id, text, request_id, parent_id=None):
        fingerprint = hashlib.sha256(encode([text, parent_id]).encode()).hexdigest()
        with self.db.transaction() as conn:
            s = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
            if not s:
                raise Missing("对话不存在")
            previous = conn.execute("SELECT * FROM requests WHERE session_id=? AND request_id=?",
                                    (session_id, request_id)).fetchone()
            if previous:
                if previous["content_hash"] != fingerprint:
                    raise Conflict("相同请求编号不能用于不同内容")
                return json.loads(previous["result_json"])
            parent_id = parent_id or s["parent_task_id"]
            intent = classify(text, bool(s["report_id"]))
            tid = None
            if intent == "research":
                if not parent_id and s["report_id"]:
                    parent_id = conn.execute("SELECT task_id FROM reports WHERE id=?", (s["report_id"],)).fetchone()[0]
                tid = self._create_task(conn, text, session_id, parent_id)
                answer = "研究任务已保存并入队。范围和预算见任务卡；执行器未就绪时会明确等待，不会生成演示报告。"
            elif intent == "clarify":
                answer = "请说明具体研究主题或对象，例如‘调查近7天 AI 行业争议，给我完整报告’。无需填写其他表单。"
            elif intent == "template":
                answer = "请说明报告面向谁、主题及必备章节。模板共创不启动采集；当前开放式模型问答尚待接入。"
            elif intent == "report_question":
                answer = "本次对话已绑定报告版本。报告追问不重新采集；真实模型问答尚未配置，当前不会编造进一步判断。"
            elif "舆情" in text:
                answer = "舆情监测关注发生了什么、哪些讨论升温；研判还需要核实事实、比较来源与反证。热榜不能代表全部公众。此答复来自内置说明，未调用模型。"
            else:
                answer = "对话已保存。当前尚未连接开放式问答模型；明确提出研究需求可建立持久任务。普通提问不会自动启动采集。"
            stamp = now()
            for role, content in [("user", text), ("assistant", answer)]:
                conn.execute("INSERT INTO messages VALUES(?,?,?,?,?,?)",
                             (uid("message"), session_id, role, content, tid if role == "assistant" else None, stamp))
            if conn.execute("SELECT COUNT(*) FROM messages WHERE session_id=?", (session_id,)).fetchone()[0] == 2:
                conn.execute("UPDATE sessions SET title=? WHERE id=?", (text[:35], session_id))
            result = {"intent": intent, "task_id": tid, "answer": answer}
            conn.execute("INSERT INTO requests VALUES(?,?,?,?)", (session_id, request_id, fingerprint, encode(result)))
            return result

    def action(self, task_id, action, expected_revision):
        allowed = {
            "pause": ({"queued", "running", "waiting_runtime", "waiting_evidence"}, "paused"),
            "resume": ({"paused", "waiting_runtime", "failed", "waiting_input"}, "queued"),
            "cancel": ({"queued", "running", "paused", "waiting_runtime", "waiting_evidence",
                        "waiting_input", "waiting_approval", "review", "failed"}, "cancelled"),
        }
        if action not in allowed:
            raise ValueError("未知任务操作")
        with self.db.transaction() as conn:
            t = self._task(conn, task_id)
            if t["revision"] != expected_revision:
                raise Conflict("任务已变化，请刷新后操作")
            states, target = allowed[action]
            if t["status"] not in states:
                raise Conflict("当前任务状态不支持此操作")
            conn.execute("""UPDATE tasks SET status=?,updated_at=?,revision=revision+1,
            attempt=attempt+?,lease_owner=NULL,lease_until=NULL,block_reason=NULL WHERE id=?""",
                         (target, now(), int(t["status"] == "failed" and action == "resume"), task_id))
            event(conn, task_id, "task." + action, {"message": f"任务状态更新为 {target}，已取得材料保留"})
        return self.task(task_id)

    def claim(self, owner, seconds=90):
        stamp = now()
        token = owner + ":" + uid("lease")
        with self.db.transaction() as conn:
            expired = conn.execute("SELECT id FROM tasks WHERE status='running' AND lease_until<?", (stamp,)).fetchall()
            for row in expired:
                conn.execute("""UPDATE tasks SET status='queued',attempt=attempt+1,revision=revision+1,
                lease_owner=NULL,lease_until=NULL WHERE id=?""", (row[0],))
                event(conn, row[0], "task.recovered", {"message": "执行租约已过期，保留原记录后重新排队"})
            if conn.execute("SELECT 1 FROM tasks WHERE status='running'").fetchone():
                return None
            t = conn.execute("""SELECT * FROM tasks WHERE status='queued'
            ORDER BY CASE source WHEN 'chat' THEN 0 ELSE 1 END,created_at,id LIMIT 1""").fetchone()
            if not t:
                return None
            deadline = (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="microseconds")
            conn.execute("""UPDATE tasks SET status='running',lease_owner=?,lease_until=?,
            updated_at=?,revision=revision+1 WHERE id=?""", (token, deadline, stamp, t["id"]))
            event(conn, t["id"], "task.claimed", {"message": "任务获得执行槽"})
            return dict(conn.execute("SELECT * FROM tasks WHERE id=?", (t["id"],)).fetchone())

    def wait_runtime(self, task_id, owner, reason):
        with self.db.transaction() as conn:
            result = conn.execute("""UPDATE tasks SET status='waiting_runtime',block_reason=?,
            lease_owner=NULL,lease_until=NULL,updated_at=?,revision=revision+1
            WHERE id=? AND status='running' AND lease_owner=?""", (reason, now(), task_id, owner))
            if result.rowcount:
                event(conn, task_id, "runtime.unavailable", {"message": reason})
            return bool(result.rowcount)

    def supplement(self, task_id, text):
        with self.db.transaction() as conn:
            t = self._task(conn, task_id)
            if t["status"] in {"completed", "cancelled"}:
                raise Conflict("已结束任务需创建补充研究，不能修改冻结输入")
            event(conn, task_id, "task.supplement", {"message": text})

    def archive(self, task_id, url, title, content):
        digest = hashlib.sha256(content.encode()).hexdigest()
        with self.db.transaction() as conn:
            t = self._task(conn, task_id)
            if t["status"] in {"completed", "cancelled"}:
                raise Conflict("已结束任务的材料不能改写")
            eid = uid("evidence")
            conn.execute("INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?,?,?)",
                         (eid, url, title, content, digest, "user_import", now()))
            eid = conn.execute("SELECT id FROM evidence WHERE source_url=? AND content_hash=?", (url, digest)).fetchone()[0]
            inserted = conn.execute("INSERT OR IGNORE INTO task_evidence VALUES(?,?)", (task_id, eid))
            if inserted.rowcount:
                conn.execute("UPDATE tasks SET evidence_revision=evidence_revision+1,revision=revision+1 WHERE id=?", (task_id,))
                event(conn, task_id, "evidence.imported", {"message": "已保存用户提供的原文；未声称联网核验", "evidence_id": eid})
                conn.execute("INSERT INTO acquisitions VALUES(?,?,?,?,?,?,?)",
                             (uid("acquisition"), task_id, url, "user_import", "saved",
                              "用户提供的原文；未执行联网抓取", now()))
            return eid

    # These methods are worker-side contracts, intentionally not exposed as approval HTTP routes.
    @staticmethod
    def _require_run(task, lease_token):
        if (task["status"] != "running" or not lease_token or task["lease_owner"] != lease_token
                or not task["lease_until"] or task["lease_until"] <= now()):
            raise Conflict("执行租约已失效，不能写入迟到的研究结果")

    def add_claim(self, task_id, text, references, *, lease_token):
        with self.db.transaction() as conn:
            t = self._task(conn, task_id)
            self._require_run(t, lease_token)
            if not references:
                raise Conflict("结论必须挂证据")
            for ref in references:
                evidence = conn.execute("""SELECT e.content FROM evidence e JOIN task_evidence te ON te.evidence_id=e.id
                WHERE te.task_id=? AND e.id=?""", (task_id, ref["evidence_id"])).fetchone()
                if not evidence or len(ref.get("quote", "").strip()) < 5 or ref["quote"] not in evidence[0]:
                    raise Conflict("引用必须来自本任务的已归档原文片段")
            cid = uid("claim")
            conn.execute("INSERT INTO claims VALUES(?,?,?,?,?)", (cid, task_id, text, encode(references), now()))
            event(conn, task_id, "claim.created", {"message": "已建立待审结论", "claim_id": cid})
            return cid

    @staticmethod
    def _claims_hash(conn, task_id):
        rows = [dict(r) for r in conn.execute("SELECT id,text,references_json FROM claims WHERE task_id=? ORDER BY id", (task_id,))]
        return hashlib.sha256(encode(rows).encode()).hexdigest()

    def review_input(self, task_id):
        with self.db.transaction() as conn:
            t = self._task(conn, task_id)
            return {"evidence_revision": t["evidence_revision"], "claims_hash": self._claims_hash(conn, task_id)}

    def review(self, task_id, gate, passed, reason, *, lease_token, input_version):
        if gate not in {"sufficiency", "verifier", "advocate"}:
            raise ValueError("未知审查门禁")
        with self.db.transaction() as conn:
            t = self._task(conn, task_id)
            self._require_run(t, lease_token)
            current = {"evidence_revision": t["evidence_revision"], "claims_hash": self._claims_hash(conn, task_id)}
            if current != input_version:
                raise Conflict("审查期间输入已变化，必须按新版本重新审查")
            conn.execute("INSERT OR REPLACE INTO reviews VALUES(?,?,?,?,?,?,?)",
                         (task_id, gate, t["evidence_revision"], self._claims_hash(conn, task_id), int(passed), reason, now()))
            event(conn, task_id, "review.recorded", {"message": reason, "gate": gate, "passed": passed})

    def publish_report(self, task_id, document, *, lease_token):
        """Accept a validated ReportEngine document, never generate figures or factual prose here."""
        with self.db.transaction() as conn:
            t = self._task(conn, task_id)
            self._require_run(t, lease_token)
            claims = {r[0] for r in conn.execute("SELECT id FROM claims WHERE task_id=?", (task_id,))}
            if not claims or not document.get("sections"):
                raise Conflict("缺少结论或完整章节输入")
            for section in document["sections"]:
                refs = section.get("claim_ids", [])
                if not refs or not set(refs).issubset(claims):
                    raise Conflict("每个事实章节必须引用本任务结论")
            chash = self._claims_hash(conn, task_id)
            reviews = {r["gate"] for r in conn.execute("SELECT * FROM reviews WHERE task_id=?", (task_id,))
                       if r["passed"] and r["evidence_revision"] == t["evidence_revision"] and r["claims_hash"] == chash}
            if reviews != {"sufficiency", "verifier", "advocate"}:
                raise Conflict("三道门禁未通过，或证据/结论变更使审查失效")
            rid = uid("report")
            bundle = encode({"config": json.loads(t["config_json"]), "evidence_revision": t["evidence_revision"],
                             "claims_hash": chash, "document": document})
            conn.execute("INSERT INTO reports VALUES(?,?,?,?,?,?,?)",
                         (rid, task_id, 1, t["title"], encode(document), hashlib.sha256(bundle.encode()).hexdigest(), now()))
            conn.execute("""UPDATE tasks SET status='completed',stage=8,updated_at=?,revision=revision+1,
            lease_owner=NULL,lease_until=NULL WHERE id=?""", (now(), task_id))
            event(conn, task_id, "report.stored", {"message": "已验证输入的成品已入库", "report_id": rid})
            notify(conn, task_id, "report.completed", {"report_id": rid}, 1)
            return rid

    def record_usage(self, task_id, role, provider, input_tokens, output_tokens, cache_tokens,
                     rates=None, attempt=1):
        values = (input_tokens, output_tokens, cache_tokens)
        if any(v is not None and (not isinstance(v, int) or v < 0) for v in values):
            raise ValueError("usage 必须是非负整数或未知")
        if input_tokens is not None and cache_tokens is not None and cache_tokens > input_tokens:
            raise ValueError("缓存命中不能大于总输入")
        cost = None
        if rates and (not {"input", "cache", "output"}.issubset(rates) or any(not isinstance(v, (float, int)) or not math.isfinite(v) or v < 0 for v in rates.values())):
            raise ValueError("计费单价必须是非负有限数")
        if rates and all(v is not None for v in values):
            cost = ((input_tokens - cache_tokens) * rates["input"] + cache_tokens * rates["cache"]
                    + output_tokens * rates["output"]) / 1_000_000
        with self.db.transaction() as conn:
            self._task(conn, task_id)
            conn.execute("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?,?)",
                         (uid("usage"), task_id, role, provider, *values, cost, attempt, now()))

