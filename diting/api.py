from contextlib import asynccontextmanager
import json

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, HttpUrl
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import ROOT, Settings
from .db import Database
from .runtime import RuntimeRegistry
from .service import Conflict, Missing, Service
from .hotlists import HotlistCollector
from .worker import Worker


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SessionInput(Input):
    title: str = Field(default="新的对话", min_length=1, max_length=100)
    report_id: str | None = None
    parent_task_id: str | None = None


class MessageInput(Input):
    text: str = Field(min_length=1, max_length=20000)
    request_id: str = Field(min_length=8, max_length=100)
    parent_id: str | None = None


class ActionInput(Input):
    action: str
    revision: int = Field(ge=1)


class SupplementInput(Input):
    text: str = Field(min_length=1, max_length=20000)


class EvidenceInput(Input):
    url: HttpUrl
    title: str = Field(min_length=1, max_length=500)
    content: str = Field(min_length=5, max_length=1_000_000)


class HotlistCollectInput(Input):
    provider: str = Field(default="both", pattern="^(newsnow|dailyhot|both)$")
    source_ids: list[str] | dict[str, list[str]] | None = None


def create_app(settings=None, start_worker=True):
    settings = settings or Settings.from_env()
    db = Database(settings.data_dir / "diting.sqlite3")
    service = Service(db, settings)
    registry = RuntimeRegistry(settings)
    hotlists = HotlistCollector(db, settings)
    worker = Worker(service, registry, settings.worker_interval)

    @asynccontextmanager
    async def lifespan(app):
        if start_worker:
            worker.start()
        yield
        worker.stop()

    app = FastAPI(title="DiTing Agent API", version="0.1.0", lifespan=lifespan)
    app.state.service, app.state.worker, app.state.registry = service, worker, registry
    app.state.hotlists = hotlists
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]", "testserver"])

    @app.middleware("http")
    async def same_origin(request: Request, call_next):
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            expected = f"{request.url.scheme}://{request.headers.get('host')}"
            if origin and origin != expected:
                return JSONResponse({"detail": "仅接受同源写操作"}, status_code=403)
            if request.headers.get("content-type", "").split(";")[0] != "application/json":
                return JSONResponse({"detail": "写请求必须使用 application/json"}, status_code=415)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(Conflict)
    async def conflict_handler(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(Missing)
    async def missing_handler(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(ValueError)
    async def value_handler(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.get("/api/health")
    def health():
        return {"status": "ok", "mode": "persistent_control_plane", "schema_version": 1,
                "runtime": registry.capabilities()}

    @app.get("/api/integrations")
    def integrations():
        return registry.capabilities()

    @app.get("/api/hotlists/sources")
    def hotlist_sources():
        return hotlists.sources()

    @app.get("/api/hotlists/latest")
    def hotlist_latest(limit: int = 100):
        return hotlists.latest(limit)

    @app.post("/api/hotlists/collect")
    def hotlist_collect(body: HotlistCollectInput):
        return hotlists.collect(body.provider, body.source_ids)

    @app.get("/api/sessions")
    def sessions():
        result = db.rows("SELECT * FROM sessions ORDER BY created_at DESC")
        for s in result:
            s["messages"] = db.rows("SELECT * FROM messages WHERE session_id=? ORDER BY rowid", (s["id"],))
        return result

    @app.post("/api/sessions", status_code=201)
    def session(body: SessionInput):
        return {"id": service.session(body.title, body.report_id, body.parent_task_id)}

    @app.post("/api/sessions/{sid}/messages")
    def send(sid: str, body: MessageInput):
        return service.send(sid, body.text, body.request_id, body.parent_id)

    @app.get("/api/tasks")
    def tasks():
        return service.tasks()

    @app.get("/api/tasks/{tid}")
    def task(tid: str):
        t = service.task(tid)
        t["events"] = db.rows("SELECT * FROM events WHERE task_id=? ORDER BY id", (tid,))
        t["evidence"] = db.rows("""SELECT e.* FROM evidence e JOIN task_evidence te
        ON te.evidence_id=e.id WHERE te.task_id=? ORDER BY e.captured_at""", (tid,))
        t["claims"] = db.rows("SELECT * FROM claims WHERE task_id=? ORDER BY created_at", (tid,))
        t["usage"] = db.rows("SELECT * FROM usage WHERE task_id=? ORDER BY created_at", (tid,))
        return t

    @app.post("/api/tasks/{tid}/actions")
    def action(tid: str, body: ActionInput):
        return service.action(tid, body.action, body.revision)

    @app.post("/api/tasks/{tid}/supplements", status_code=201)
    def supplement(tid: str, body: SupplementInput):
        service.supplement(tid, body.text)
        return {"saved": True}

    @app.post("/api/tasks/{tid}/evidence", status_code=201)
    def archive(tid: str, body: EvidenceInput):
        return {"id": service.archive(tid, str(body.url), body.title, body.content), "origin": "user_import"}

    @app.get("/api/events")
    def events(after_id: int = 0):
        return db.rows("SELECT * FROM events WHERE id>? ORDER BY id LIMIT 500", (max(0, after_id),))

    @app.get("/api/acquisitions")
    def acquisitions():
        return db.rows("SELECT * FROM acquisitions ORDER BY created_at DESC LIMIT 1000")

    @app.get("/api/usage")
    def usage():
        rows = db.rows("SELECT * FROM usage ORDER BY created_at")
        costs = [r["cost"] for r in rows if r["cost"] is not None]
        return {"calls": rows, "known_input": sum(r["input_tokens"] or 0 for r in rows),
                "known_output": sum(r["output_tokens"] or 0 for r in rows),
                "known_cache": sum(r["cache_tokens"] or 0 for r in rows),
                "unknown_usage_calls": sum(r["input_tokens"] is None or r["output_tokens"] is None for r in rows),
                "unknown_cost_calls": sum(r["cost"] is None for r in rows),
                "known_cost": sum(costs) if costs else None}

    @app.get("/api/reports")
    def reports():
        result = db.rows("SELECT * FROM reports ORDER BY created_at DESC")
        for r in result:
            r["document"] = json.loads(r.pop("document_json"))
        return result

    @app.get("/api/notifications")
    def notifications():
        return db.rows("SELECT * FROM outbox ORDER BY created_at DESC LIMIT 500")

    @app.get("/", response_class=HTMLResponse)
    def index():
        prototype = ROOT / "prototypes" / "diting-v5" / "dist" / "index.html"
        html = prototype.read_text(encoding="utf-8")
        # Always use the built v5 as the UI baseline, never overwrite the reference prototype.
        html = html.replace("<head>", '<head><base href="/prototype/">', 1)
        html = html.replace("<body>", '<body><div id="live-loading-mask" role="status" '
                            'style="position:fixed;inset:0;z-index:999999;background:#f5f6fb;'
                            'display:grid;place-items:center;color:#756697;font:15px system-ui">'
                            '正在连接持久任务服务…</div>', 1)
        return html.replace("</body>", '<script src="/app/live-bridge.js"></script></body>')

    app.mount("/app", StaticFiles(directory=ROOT / "web"), name="application")
    app.mount("/prototype", StaticFiles(directory=ROOT / "prototypes" / "diting-v5" / "dist"), name="prototype")
    return app

