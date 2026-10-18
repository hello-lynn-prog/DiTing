"""Conservative M0 intent rules. Replace with evaluated structured model routing in M1."""
import re


def classify(text, has_report=False):
    if re.search(r"什么是|是什么|什么意思|如何使用|怎么用|怎么配置|能不能|可以吗|有什么区别", text):
        return "question"
    if has_report and re.search(r"这份报告|报告中|报告里|报告的", text) and not re.search(r"重新|补充调查|再查|更新研究", text):
        return "report_question"
    if re.search(r"共创.*模板|模板.*共创", text):
        return "template"
    if re.search(r"调查|研判|研究|分析|帮我查|查一下|生成.*报告|出.*报告", text):
        if re.fullmatch(r"(?:请|帮我)?(?:研究一下|分析一下|调查一下|生成报告|研究|研判)[。！!\s]*", text):
            return "clarify"
        return "research"
    return "question"


def scope(text, default_budget):
    days = re.search(r"近\s*(\d{1,3})\s*天", text)
    budget = re.search(r"预算(?:上限)?[为是：:\s¥￥]*([0-9]+(?:\.[0-9]+)?)", text)
    amount = float(budget.group(1)) if budget else default_budget
    if not 0 < amount <= 10000:
        raise ValueError("研究预算须在 0 到 10000 元之间")
    return {"window_days": max(1, min(int(days.group(1)), 365)) if days else 7,
            "budget": amount, "template": "auto", "data_policy": "observed_or_cited_only"}
