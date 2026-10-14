# -*- coding: utf-8 -*-
"""
多议题热度环比 / 爆发·回落判定 —— 参考实现

输入：快照记录（平台, 议题, 榜位, 榜长, 日期）
输出：每个议题的日热度分序列 + 状态（爆发/升温/持平/回落/新增）

判定规则（三个条件同时约束，缺一不可）：
  爆发🔴  环比 >= RISE(3.0) 且 共振平台 >= 2 且 今日绝对分 >= FLOOR(50)
  升温🔺  环比 >= 1.3（未达爆发）
  回落🔻  环比 <= FALL(0.6)
  持平➖  其余
  新增🆕  昨日无数据的新词：不看环比，绝对分过下限 + 多平台共振 即触发"建议题"

接真实库时：把 demo 数据换成
  SELECT platform, topic_id, rank, board_size, date(fetched_at) FROM snapshot ...
  （或议题未建时 topic_id 为空的候选词记录，走 candidates 通道）
"""
from collections import defaultdict

RISE, FALL = 3.0, 0.6      # 环比阈值：3倍算爆发，0.6以下算回落
FLOOR = 50                 # 绝对分下限：防止小基数"4倍"假爆发
RESONANCE = 2              # 至少几个平台同日共振才算真爆发
JUMP = 20                  # 单平台榜位跃升多少名算"该平台共振"

ICONS = {"burst": "🔴爆发", "rise": "🔺升温", "flat": "➖持平",
         "fall": "🔻回落", "new": "🆕新增候选"}


def rank_score(rank: int, board_size: int) -> float:
    """榜位 → 归一化分数（0~100）。各平台榜长不同，必须归一化后才能跨平台相加。"""
    if rank is None or rank < 1 or board_size < 1:
        return 0.0
    return round((1 - (rank - 1) / board_size) * 100, 1)


def daily_scores(records):
    """records: [(date, platform, topic_id, rank, board_size), ...]
    -> {topic_id: {date: score}}  同议题同平台同日取最高榜位（避免同日多次快照重复计分）"""
    best = {}   # (topic, date, platform) -> best score
    for d, plat, topic, rank, size in records:
        k = (topic, d, plat)
        s = rank_score(rank, size)
        if s > best.get(k, 0):
            best[k] = s
    out = defaultdict(lambda: defaultdict(float))
    for (topic, d, _plat), s in best.items():
        out[topic][d] += s          # 跨平台相加（已各自归一化）
    return out


def resonance(record_day, prev_day):
    """共振平台数：今日在榜 且 榜位较昨日跃升 >= JUMP 名的平台个数
    record_day / prev_day: {platform: (rank, size)}"""
    n = 0
    for plat, (rank, size) in record_day.items():
        if plat in prev_day:
            jumped = prev_day[plat][0] - rank
            if jumped >= JUMP:
                n += 1
        elif rank <= 10:            # 新冲进前10也算强共振
            n += 1
    return n


def classify(today, yesterday, reson):
    if yesterday <= 0:
        return "new" if (today >= FLOOR and reson >= RESONANCE) else "ignore"
    ratio = today / yesterday
    if ratio >= RISE and today >= FLOOR and reson >= RESONANCE:
        return "burst"
    if ratio >= 1.3:
        return "rise"
    if ratio <= FALL:
        return "fall"
    return "flat"


def evaluate(records, dates=None):
    """主入口：给全部快照记录，返回每个议题逐日状态。
    dates: 参与判定的日期升序列表（默认自动取记录里最后两天做环比，其余天仅出分数）"""
    scores = daily_scores(records)
    rows = []
    for topic, series in sorted(scores.items()):
        days = sorted(series)
        use = dates or days
        prev = None
        for d in use:
            today = series.get(d, 0.0)
            if prev is None:
                # 整条序列只有今天（议题史上首次出现）→ 走"新增候选"判定
                if d == days[-1] and len(days) == 1:
                    day_recs = {p: (r, s) for (dd, p, t, r, s) in records
                                if t == topic and dd == d}
                    state = classify(today, 0, resonance(day_recs, {}))
                else:
                    state = "-"      # 有历史的议题，首日仅作基期
            else:
                day_recs = {p: (r, s) for (dd, p, t, r, s) in records
                            if t == topic and dd == d}
                prev_recs = {p: (r, s) for (dd, p, t, r, s) in records
                             if t == topic and dd == prev}
                reson = resonance(day_recs, prev_recs)
                state = classify(today, series.get(prev, 0.0), reson)
            rows.append((topic, d, today, state))
            prev = d
    return rows


# ---------------- CLI：demo / JSON 服务模式 ----------------
def _demo() -> None:
    D, P = "09-22", "09-23"     # 昨日 / 今日
    R = [                        # (日期, 平台, 议题, 榜位, 榜长)
        # A 闲鱼涉黄：昨天中位，今天前排 → 升温（未到3倍）
        (D, "weibo",  "A", 9,  50), (D, "zhihu", "A", 30, 100), (D, "toutiao", "A", 18, 60),
        (P, "weibo",  "A", 1,  50), (P, "zhihu", "A", 3,  100), (P, "toutiao", "A", 2,  60),
        # B 黑灰产治理：平稳
        (D, "weibo",  "B", 12, 50), (D, "toutiao", "B", 20, 60),
        (P, "weibo",  "B", 11, 50), (P, "toutiao", "B", 22, 60),
        # C 二手平台口碑：昨天尾部，今天双平台冲前10 → 爆发
        (D, "weibo",  "C", 40, 50), (D, "zhihu", "C", 70, 100),
        (P, "weibo",  "C", 6,  50), (P, "zhihu", "C", 8,  100),
        # D 全新关键词：昨日无记录，今日多平台前10 → 新增候选（建议题）
        (P, "weibo",  "D", 4,  50), (P, "douyin", "D", 2, 60), (P, "zhihu", "D", 9, 100),
    ]
    print(f"{'议题':<4} {'日期':<6} {'热度分':>7}  状态")
    print("-" * 36)
    for topic, d, score, state in evaluate(R):
        icon = ICONS.get(state, state)
        if state == "-":
            icon = "(基期)"
        print(f"{topic:<4} {d:<6} {score:>7.1f}  {icon}")


def _run_json() -> None:
    """服务模式（供 dsh 插件 spawn 调用）：
    stdin : {"records": [[日期, 平台, 议题, 榜位, 榜长], ...]}
    stdout: {"rows": [[议题, 日期, 热度分, 状态], ...]}"""
    import json
    import sys
    payload = json.load(sys.stdin)
    records = [tuple(r) for r in payload["records"]]
    json.dump({"rows": evaluate(records)}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    import sys
    if "--json" in sys.argv:
        _run_json()
    else:
        _demo()
