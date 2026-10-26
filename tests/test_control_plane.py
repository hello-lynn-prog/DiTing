from concurrent.futures import ThreadPoolExecutor
import json

from fastapi.testclient import TestClient
import pytest

from diting.api import create_app
from diting.config import Settings
from diting.db import Database
from diting.service import Conflict, Service
from diting.runtime import RuntimeRegistry
from diting.worker import Worker


@pytest.fixture
def service(tmp_path):
    return Service(Database(tmp_path / "state.sqlite3"), Settings(data_dir=tmp_path))


def make_task(service, title="调查近7天 AI 行业争议，预算30元，给我完整报告", **kwargs):
    sid = service.session()
    return service.send(sid, title, "request-0001", **kwargs)["task_id"]


def test_questions_do_not_trigger_research(service):
    sid = service.session()
    for i, q in enumerate(["什么是舆情研判？", "舆情研判是什么？", "能不能分析报告？", "怎么配置模型"]):
        assert service.send(sid, q, f"request-{i:04}")["task_id"] is None
    assert not service.tasks()


def test_explicit_research_persists_after_reopen(service):
    tid = make_task(service)
    reopened = Service(Database(service.db.path), service.settings)
    t = reopened.task(tid)
    assert t["budget"] == 30
    assert t["config"]["window_days"] == 7
    assert t["status"] == "queued"
    assert "lease_owner" not in t
    assert reopened.db.rows("SELECT COUNT(*) n FROM messages")[0]["n"] == 2


def test_chat_idempotency_under_concurrent_delivery(service):
    sid = service.session()
    with ThreadPoolExecutor(max_workers=8) as pool:
        result = list(pool.map(lambda _: service.send(sid, "调查 AI 行业", "same-request-key"), range(12)))
    assert len({r["task_id"] for r in result}) == 1
    assert len(service.tasks()) == 1
    with pytest.raises(Conflict):
        service.send(sid, "调查另一个主题", "same-request-key")


def test_single_execution_slot_and_priority(service):
    with service.db.transaction() as conn:
        auto = service._create_task(conn, "自动研究品牌", None, source="sentinel")
    user = make_task(service)
    with ThreadPoolExecutor(max_workers=6) as pool:
        claims = list(pool.map(lambda i: service.claim(f"worker-{i}"), range(6)))
    active = [r for r in claims if r]
    assert len(active) == 1
    assert active[0]["id"] == user
    assert service.task(auto)["status"] == "queued"


def test_expired_lease_recovers_and_rejects_stale_result(service):
    tid = make_task(service)
    old = service.claim("worker", seconds=-1)
    fresh = service.claim("worker")
    assert fresh["id"] == tid
    assert fresh["attempt"] == 2
    assert fresh["lease_owner"] != old["lease_owner"]
    assert not service.wait_runtime(tid, old["lease_owner"], "stale callback")
    assert service.wait_runtime(tid, fresh["lease_owner"], "profile missing")


def test_pause_fences_worker_and_retains_logs(service):
    tid = make_task(service)
    claimed = service.claim("worker")
    paused = service.action(tid, "pause", claimed["revision"])
    assert paused["status"] == "paused"
    assert not service.wait_runtime(tid, claimed["lease_owner"], "late")
    with pytest.raises(Conflict):
        service.action(tid, "resume", claimed["revision"])
    resumed = service.action(tid, "resume", paused["revision"])
    assert resumed["status"] == "queued"
    assert len(service.db.rows("SELECT * FROM events WHERE task_id=?", (tid,))) >= 4


def test_missing_runtime_blocks_honestly(service):
    tid = make_task(service)
    worker = Worker(service, RuntimeRegistry(service.settings))
    worker.tick()
    assert service.task(tid)["status"] == "waiting_runtime"
    assert not service.db.rows("SELECT * FROM reports")
    assert not service.db.rows("SELECT * FROM evidence")
    assert not service.db.rows("SELECT * FROM usage")


def test_archives_are_shared_but_task_refs_are_isolated(service):
    a, b = make_task(service), make_task(service, "调查另一个品牌")
    eid = service.archive(a, "https://example.org/a", "原文", "这是用户提供的实际原文材料，不代表已经联网核验。")
    assert service.archive(a, "https://example.org/a", "原文", "这是用户提供的实际原文材料，不代表已经联网核验。") == eid
    first = service.claim("worker")
    service.action(a, "cancel", first["revision"])
    lease = service.claim("worker")["lease_owner"]
    with pytest.raises(Conflict):
        service.add_claim(b, "错误跨任务引用", [{"evidence_id": eid, "quote": "用户提供的实际原文"}], lease_token=lease)
    assert service.archive(b, "https://example.org/a", "原文", "这是用户提供的实际原文材料，不代表已经联网核验。") == eid
    assert service.task(a)["evidence_revision"] == 1


def prepared(service):
    tid = make_task(service)
    lease = service.claim("worker")["lease_owner"]
    eid = service.archive(tid, "https://example.org/a", "测试输入", "测试输入原文：某机构发布了一份公开资料。")
    cid = service.add_claim(tid, "某机构发布公开资料", [{"evidence_id": eid, "quote": "某机构发布了一份公开资料"}], lease_token=lease)
    doc = {"sections": [{"title": "已确认事实", "text": "某机构发布公开资料", "claim_ids": [cid]}]}
    return tid, doc, lease


def gates(service, tid, lease):
    for name in ["sufficiency", "verifier", "advocate"]:
        service.review(tid, name, True, "测试审查输入，不代表生产核验", lease_token=lease, input_version=service.review_input(tid))


def test_report_requires_all_gates_and_current_evidence(service):
    tid, doc, lease = prepared(service)
    with pytest.raises(Conflict):
        service.publish_report(tid, doc, lease_token=lease)
    gates(service, tid, lease)
    service.archive(tid, "https://example.org/b", "新材料", "新增的原文材料会使原来证据版本的审查失效。")
    with pytest.raises(Conflict):
        service.publish_report(tid, doc, lease_token=lease)
    gates(service, tid, lease)
    rid = service.publish_report(tid, doc, lease_token=lease)
    assert service.task(tid)["status"] == "completed"
    row = service.db.rows("SELECT * FROM reports WHERE id=?", (rid,))[0]
    assert len(row["input_hash"]) == 64
    assert len(service.db.rows("SELECT * FROM outbox")) == 1
    with pytest.raises(Conflict):
        service.archive(tid, "https://example.org/c", "改写", "不能修改已经冻结的报告输入。")


def test_new_claim_invalidates_previous_reviews(service):
    tid, doc, lease = prepared(service)
    gates(service, tid, lease)
    eid = service.db.rows("SELECT evidence_id FROM task_evidence WHERE task_id=?", (tid,))[0]["evidence_id"]
    service.add_claim(tid, "另一个待审表述", [{"evidence_id": eid, "quote": "某机构发布了一份公开资料"}], lease_token=lease)
    with pytest.raises(Conflict):
        service.publish_report(tid, doc, lease_token=lease)


def test_cache_is_not_counted_twice_and_unknown_is_not_free(service):
    tid = make_task(service)
    service.record_usage(tid, "Query", "test", 1000, 100, 400, {"input": 2, "cache": .2, "output": 8})
    service.record_usage(tid, "Query", "test", None, None, None)
    rows = service.db.rows("SELECT * FROM usage ORDER BY created_at")
    assert rows[0]["cost"] == pytest.approx(.00208)
    assert rows[1]["cost"] is None
    with pytest.raises(ValueError):
        service.record_usage(tid, "Query", "test", 100, 10, 101)


def test_parent_task_survives_session_reload(service):
    parent = make_task(service)
    sid = service.session(parent_task_id=parent)
    recreated = Service(Database(service.db.path), service.settings)
    child = recreated.send(sid, "补充调查同一主题的反例", "child-request")["task_id"]
    assert recreated.task(child)["parent_id"] == parent


def test_api_persistence_validation_and_same_origin(tmp_path):
    settings = Settings(data_dir=tmp_path)
    with TestClient(create_app(settings, start_worker=False)) as client:
        sid = client.post("/api/sessions", json={}).json()["id"]
        response = client.post(f"/api/sessions/{sid}/messages", json={"text": "调查 AI", "request_id": "api-request"})
        assert response.status_code == 200
        tid = response.json()["task_id"]
        assert client.post(f"/api/tasks/{tid}/actions", json={"action": "cancel", "revision": 999}).status_code == 409
        assert client.post("/api/sessions", json={}, headers={"Origin": "https://unrelated.invalid"}).status_code == 403
        assert client.post("/api/sessions", content="{}").status_code == 415
        assert client.get("/").status_code == 200
        assert "/app/live-bridge.js" in client.get("/").text
        assert client.get("/app/live-bridge.js").status_code == 200
    with TestClient(create_app(settings, start_worker=False)) as client:
        assert client.get("/api/tasks").json()[0]["id"] == tid
        assert len(client.get("/api/sessions").json()[0]["messages"]) == 2


def test_cancel_cannot_complete_from_a_late_report(service):
    tid, doc, lease = prepared(service)
    gates(service, tid, lease)
    service.action(tid, "cancel", service.task(tid)["revision"])
    with pytest.raises(Conflict):
        service.publish_report(tid, doc, lease_token=lease)
    assert not service.db.rows("SELECT * FROM reports")


def test_review_returned_after_new_evidence_is_rejected(service):
    tid, doc, lease = prepared(service)
    version = service.review_input(tid)
    service.archive(tid, "https://example.org/new", "新证据", "审查执行期间加入的新原文材料。")
    with pytest.raises(Conflict):
        service.review(tid, "verifier", True, "旧版本审查迟到", lease_token=lease, input_version=version)
    assert not service.db.rows("SELECT * FROM reviews")


def test_old_executor_cannot_submit_after_resume(service):
    tid, doc, old_lease = prepared(service)
    gates(service, tid, old_lease)
    t = service.action(tid, "pause", service.task(tid)["revision"])
    service.action(tid, "resume", t["revision"])
    current = service.claim("new-worker")
    assert current["lease_owner"] != old_lease
    with pytest.raises(Conflict):
        service.publish_report(tid, doc, lease_token=old_lease)
    with pytest.raises(Conflict):
        service.review(tid, "verifier", True, "旧执行器", lease_token=old_lease, input_version=service.review_input(tid))


def test_usage_rejects_non_finite_prices(service):
    tid = make_task(service)
    with pytest.raises(ValueError):
        service.record_usage(tid, "Query", "test", 10, 5, 1, {"input": float("nan"), "cache": 1, "output": 1})


def test_no_public_endpoint_can_force_review_pass(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path), start_worker=False)) as client:
        assert client.post("/api/reviews", json={"passed": True}).status_code == 404
