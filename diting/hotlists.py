"""Snapshot discovery data from local NewsNow and DailyHotApi instances."""
import hashlib
import json
import math
import re
from urllib.parse import quote
from uuid import uuid4

import httpx

from .db import encode, now, uid


SOURCE_IDS = {
    "newsnow": ("zhihu", "weibo"),
    "dailyhot": ("zhihu", "weibo"),
}
SOURCE_PATHS = {
    "newsnow": "/api/s?id={source}",
    "dailyhot": "/{source}",
}


class SourceError(RuntimeError):
    pass


def _items(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        raise SourceError("响应不是 JSON 对象或列表")
    status = str(payload.get("status", "")).lower()
    if status in {"error", "failed", "failure"} or payload.get("success") is False:
        raise SourceError(str(payload.get("message") or payload.get("error") or "数据源返回失败状态"))
    for key in ("items", "data", "results", "list", "hotList"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            for nested in ("items", "data", "results", "list"):
                if isinstance(value.get(nested), list):
                    return value[nested]
    raise SourceError("响应中没有可识别的榜单列表")


def _text(value):
    if value is None:
        return None
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        value = str(value).strip()
        return value or None
    return None


def _normalize(row, rank):
    if not isinstance(row, dict):
        return None
    title = next((_text(row.get(key)) for key in ("title", "name", "word", "text") if _text(row.get(key))), None)
    if not title:
        return None
    url = next((_text(row.get(key)) for key in ("url", "link", "mobileUrl", "href") if _text(row.get(key))), None)
    item_id = next((_text(row.get(key)) for key in ("id", "itemId", "mid", "key") if _text(row.get(key))), None)
    raw_heat = next((row.get(key) for key in ("heat", "hot", "score", "view", "count") if row.get(key) is not None), None)
    extra = row.get("extra")
    if raw_heat is None and isinstance(extra, dict):
        raw_heat = next((extra.get(key) for key in ("heat", "hot", "score", "view", "count")
                         if extra.get(key) is not None), None)
    heat_value = float(raw_heat) if isinstance(raw_heat, (int, float)) and not isinstance(raw_heat, bool) and math.isfinite(raw_heat) else None
    heat_label = _text(raw_heat) if raw_heat is not None else None
    canonical = encode(row)
    key_source = item_id or url or title
    item_key = hashlib.sha256(key_source.encode("utf-8")).hexdigest()
    content_hash = hashlib.sha256(encode([title, url, raw_heat]).encode("utf-8")).hexdigest()
    return {"item_key": item_key, "title": title, "url": url, "rank": rank,
            "heat_value": heat_value, "heat_label": heat_label,
            "raw_json": canonical, "content_hash": content_hash}


class HotlistCollector:
    def __init__(self, db, settings, transport=None):
        self.db, self.settings, self.transport = db, settings, transport

    def _fetch(self, provider, source_id):
        base = self.settings.newsnow_base_url if provider == "newsnow" else self.settings.dailyhot_base_url
        path = SOURCE_PATHS[provider].format(source=quote(source_id, safe=""))
        url = base.rstrip("/") + path
        with httpx.Client(timeout=self.settings.source_timeout_seconds, trust_env=False,
                          transport=self.transport) as client:
            response = client.get(url)
            response.raise_for_status()
            try:
                payload = response.json()
            except ValueError as exc:
                raise SourceError("数据源没有返回有效 JSON") from exc
        rows = _items(payload)
        normalized = []
        seen = set()
        for index, row in enumerate(rows, start=1):
            item = _normalize(row, index)
            if item and item["item_key"] not in seen:
                normalized.append(item)
                seen.add(item["item_key"])
        if not normalized:
            raise SourceError("榜单响应为空或缺少标题，未保存为空成功快照")
        return normalized

    def collect(self, provider="both", source_ids=None):
        if provider not in {"newsnow", "dailyhot", "both"}:
            raise ValueError("provider 只能是 newsnow、dailyhot 或 both")
        providers = ("newsnow", "dailyhot") if provider == "both" else (provider,)
        results = []
        for current in providers:
            ids = SOURCE_IDS[current] if source_ids is None else source_ids.get(current, SOURCE_IDS[current]) if isinstance(source_ids, dict) else source_ids
            if not isinstance(ids, (list, tuple)) or not ids or len(ids) > 30:
                raise ValueError("每个数据源须提供 1 到 30 个 source id")
            for source_id in ids:
                source_id = str(source_id).strip()
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", source_id):
                    raise ValueError("source id 只允许字母、数字、下划线和连字符")
                results.append(self._collect_one(current, source_id))
        return {"snapshots": results,
                "succeeded": sum(row["status"] == "succeeded" for row in results),
                "failed": sum(row["status"] == "failed" for row in results)}

    def _collect_one(self, provider, source_id):
        created_at = now()
        try:
            items = self._fetch(provider, source_id)
            status, error = "succeeded", None
        except (httpx.HTTPError, SourceError, ValueError) as exc:
            items, status, error = [], "failed", str(exc)[:500]
        snapshot_id = uid("hot")
        with self.db.transaction() as conn:
            previous = conn.execute("""SELECT id FROM hotlist_snapshots
                WHERE provider=? AND source_id=? AND status='succeeded'
                ORDER BY created_at DESC LIMIT 1""", (provider, source_id)).fetchone()
            previous_ranks = {}
            if previous:
                previous_ranks = {r["item_key"]: r["rank"] for r in conn.execute(
                    "SELECT item_key,rank FROM hotlist_items WHERE snapshot_id=?", (previous["id"],))}
            conn.execute("""INSERT INTO hotlist_snapshots
                (id,provider,source_id,status,item_count,error,observed_at,created_at)
                VALUES(?,?,?,?,?,?,?,?)""", (snapshot_id, provider, source_id, status,
                                                len(items), error, created_at, created_at))
            for item in items:
                conn.execute("""INSERT OR IGNORE INTO hotlist_items
                    (id,snapshot_id,item_key,title,url,rank,heat_value,heat_label,raw_json,content_hash)
                    VALUES(?,?,?,?,?,?,?,?,?,?)""", (uid("hotitem"), snapshot_id, item["item_key"],
                    item["title"], item["url"], item["rank"], item["heat_value"], item["heat_label"],
                    item["raw_json"], item["content_hash"]))
            detail = error or f"保存 {len(items)} 条榜单条目；榜单热度值沿用数据源口径，不代表全网讨论量。"
            conn.execute("""INSERT INTO acquisitions
                (id,task_id,source,operation,status,detail,created_at)
                VALUES(?,NULL,?,?,?, ?,?)""", (uid("acq"), f"{provider}:{source_id}", "snapshot", status, detail, created_at))
        return {"id": snapshot_id, "provider": provider, "source_id": source_id,
                "status": status, "item_count": len(items), "error": error,
                "observed_at": created_at,
                "rank_changes": sum(1 for item in items if item["item_key"] in previous_ranks
                                     and previous_ranks[item["item_key"]] != item["rank"])}

    def latest(self, limit=100):
        limit = max(1, min(int(limit), 500))
        rows = self.db.rows("""SELECT s.* FROM hotlist_snapshots s
            WHERE s.id=(SELECT newer.id FROM hotlist_snapshots newer
              WHERE newer.provider=s.provider AND newer.source_id=s.source_id
              ORDER BY newer.created_at DESC LIMIT 1)
            ORDER BY s.created_at DESC""")
        result = []
        for snapshot in rows:
            items = self.db.rows("SELECT * FROM hotlist_items WHERE snapshot_id=? ORDER BY rank LIMIT ?",
                                 (snapshot["id"], limit))
            previous = self.db.rows("""SELECT item_key,rank FROM hotlist_items
                WHERE snapshot_id=(SELECT id FROM hotlist_snapshots WHERE provider=? AND source_id=?
                  AND status='succeeded' AND id<>? ORDER BY created_at DESC LIMIT 1)""",
                                    (snapshot["provider"], snapshot["source_id"], snapshot["id"]))
            before = {row["item_key"]: row["rank"] for row in previous}
            for item in items:
                item["rank_change"] = before.get(item["item_key"])
                if item["rank_change"] is not None:
                    item["rank_change"] -= item["rank"]
                item["raw"] = json.loads(item.pop("raw_json"))
            result.append({**snapshot, "items": items})
        return result

    def sources(self):
        rows = self.db.rows("""SELECT provider,source_id,status,item_count,error,observed_at
            FROM hotlist_snapshots s WHERE id=(SELECT newer.id FROM hotlist_snapshots newer
              WHERE newer.provider=s.provider AND newer.source_id=s.source_id
              ORDER BY newer.created_at DESC LIMIT 1) ORDER BY provider,source_id""")
        return {"configured": {
                    "newsnow": {"base_url": self.settings.newsnow_base_url, "source_ids": list(SOURCE_IDS["newsnow"])},
                    "dailyhot": {"base_url": self.settings.dailyhot_base_url, "source_ids": list(SOURCE_IDS["dailyhot"])},
                }, "latest": rows}
