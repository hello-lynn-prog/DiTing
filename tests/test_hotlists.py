import httpx

from diting.api import create_app
from diting.config import Settings
from diting.db import Database
from diting.hotlists import HotlistCollector


def test_collects_both_providers_and_persists_source_rankings(tmp_path):
    calls = []

    def respond(request):
        calls.append(str(request.url))
        if request.url.host == "newsnow.test":
            return httpx.Response(200, json={"status": "success", "id": "zhihu", "items": [
                {"id": "q-1", "title": "问答热榜", "url": "https://example.org/q", "extra": {"heat": "2.3万"}},
                {"id": "q-1", "title": "重复项", "url": "https://example.org/q"},
                {"id": "q-2", "title": "第二条"},
            ]})
        return httpx.Response(200, json={"code": 200, "data": [
            {"id": "w-1", "title": "微博榜单", "url": "https://example.org/w", "hot": 1234},
        ]})

    settings = Settings(data_dir=tmp_path, newsnow_base_url="http://newsnow.test",
                        dailyhot_base_url="http://dailyhot.test")
    db = Database(tmp_path / "state.sqlite3")
    collector = HotlistCollector(db, settings, httpx.MockTransport(respond))
    result = collector.collect("both", {"newsnow": ["zhihu"], "dailyhot": ["weibo"]})

    assert result["succeeded"] == 2
    assert result["failed"] == 0
    assert sorted(calls) == ["http://dailyhot.test/weibo", "http://newsnow.test/api/s?id=zhihu"]
    latest = collector.latest()
    assert len(latest) == 2
    newsnow = next(row for row in latest if row["provider"] == "newsnow")
    assert newsnow["item_count"] == 2
    assert newsnow["items"][0]["heat_label"] == "2.3万"
    assert newsnow["items"][0]["heat_value"] is None
    assert db.rows("SELECT COUNT(*) n FROM acquisitions")[0]["n"] == 2


def test_rank_change_is_computed_from_snapshots_not_model_estimates(tmp_path):
    order = ["a", "b"]

    def respond(_request):
        return httpx.Response(200, json={"items": [
            {"id": key, "title": key.upper(), "url": f"https://example.org/{key}"}
            for key in order
        ]})

    settings = Settings(data_dir=tmp_path, newsnow_base_url="http://newsnow.test")
    collector = HotlistCollector(Database(tmp_path / "state.sqlite3"), settings, httpx.MockTransport(respond))
    collector.collect("newsnow", ["zhihu"])
    order[:] = ["b", "a"]
    collector.collect("newsnow", ["zhihu"])
    latest = collector.latest()[0]
    assert [(row["title"], row["rank"], row["rank_change"]) for row in latest["items"]] == [
        ("B", 1, 1), ("A", 2, -1),
    ]


def test_failed_and_empty_source_responses_are_audited(tmp_path):
    def respond(request):
        if request.url.path.endswith("zhihu"):
            return httpx.Response(200, json={"status": "error", "message": "upstream down"})
        return httpx.Response(200, json={"items": []})

    settings = Settings(data_dir=tmp_path, dailyhot_base_url="http://dailyhot.test")
    db = Database(tmp_path / "state.sqlite3")
    collector = HotlistCollector(db, settings, httpx.MockTransport(respond))
    result = collector.collect("dailyhot", ["zhihu", "weibo"])
    assert result["failed"] == 2
    snapshots = collector.latest()
    assert all(row["status"] == "failed" and row["item_count"] == 0 for row in snapshots)
    assert all(row["status"] == "failed" for row in db.rows("SELECT status FROM acquisitions"))


def test_api_exposes_manual_collection_and_snapshot_reads(tmp_path):
    settings = Settings(data_dir=tmp_path, newsnow_base_url="http://newsnow.test")
    app = create_app(settings, start_worker=False)

    def respond(_request):
        return httpx.Response(200, json={"items": [{"id": "1", "title": "一条真实格式榜单"}]})

    app.state.hotlists.transport = httpx.MockTransport(respond)
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        posted = client.post("/api/hotlists/collect", json={
            "provider": "newsnow", "source_ids": ["zhihu"],
        })
        assert posted.status_code == 200
        assert posted.json()["succeeded"] == 1
        assert client.get("/api/hotlists/latest").json()[0]["items"][0]["title"] == "一条真实格式榜单"
        assert client.get("/api/hotlists/sources").json()["latest"][0]["status"] == "succeeded"


def test_source_ids_are_not_allowed_to_inject_paths_or_queries(tmp_path):
    settings = Settings(data_dir=tmp_path)
    collector = HotlistCollector(Database(tmp_path / "state.sqlite3"), settings)
    try:
        collector.collect("newsnow", ["../admin"])
    except ValueError as exc:
        assert "source id" in str(exc)
    else:
        raise AssertionError("invalid source id was accepted")
