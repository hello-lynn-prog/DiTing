"""Read-only QA for one stored report; Python is used for PDF inspection, not inference/runtime."""
import json
import re
import sqlite3
import sys
from pathlib import Path

import fitz
from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8")
root = Path(__file__).resolve().parent.parent
report_id = sys.argv[1]
db = sqlite3.connect(f"file:{(root / 'data/diting.sqlite3').as_posix()}?mode=ro", uri=True)
db.row_factory = sqlite3.Row
record = db.execute("SELECT * FROM reports WHERE id=?", (report_id,)).fetchone()
if not record:
    raise ValueError("报告不存在")
document = json.loads(record["document_json"])
directory = Path(document["exports"]["dir"])
pdf_file = next(directory.glob("*.pdf"))
html_file = next(directory.glob("*.html"))
pdf = fitz.open(pdf_file)
out = root / "data/diagnostics" / ("quality-" + report_id)
out.mkdir(parents=True, exist_ok=True)
appendices = {"研究范围与方法", "平台样本分析", "局限与待核实事项", "来源与统计附录"}
main = [s for s in document["sections"] if s["title"] not in appendices]
body = "\n".join(s["text"] for s in main)
pages = [{"page": i + 1, "chars": len(page.get_text().strip()), "width": page.rect.width, "height": page.rect.height} for i, page in enumerate(pdf)]
quality = {
    "report_id": report_id, "task_id": record["task_id"], "version": record["version"],
    "title": document["title"], "main_chars": len(body), "main_han_chars": len(re.findall(r"[\u3400-\u9fff]", body)),
    "chapters": [{"title": s["title"], "chars": len(s["text"]), "subsections": re.findall(r"^###\s+(.+)", s["text"], re.M), "visuals": len(s.get("visuals", []))} for s in main],
    "svg_count": html_file.read_text(encoding="utf-8").count("<svg"),
    "technical_markers_in_main": re.findall(r"\b(?:evidence|artifact|claim|dataset|task)_[a-f0-9]{8,}\b", body),
    "editorial_warnings": document.get("editorial_warnings", []), "pdf_pages": pages,
    "nearly_blank_pages": [p["page"] for p in pages if p["chars"] < 20],
    "note": "结构、文本和版面检查，不是事实真值或统计代表性认证。图表需结合底表和来源抽检。",
}
(out / "quality.json").write_text(json.dumps(quality, ensure_ascii=False, indent=2), encoding="utf-8")
font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 16)
for start in range(0, len(pdf), 20):
    count = min(20, len(pdf) - start)
    sheet = Image.new("RGB", (5 * 260, ((count + 4) // 5) * 390), "#dce2eb")
    draw = ImageDraw.Draw(sheet)
    for position in range(count):
        index = start + position
        pix = pdf[index].get_pixmap(matrix=fitz.Matrix(0.4, 0.4), alpha=False)
        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        image.thumbnail((246, 355))
        x, y = (position % 5) * 260 + 7, (position // 5) * 390 + 24
        sheet.paste(image, (x, y))
        draw.text((x, y - 23), str(index + 1), fill="#1d2b40", font=font)
    sheet.save(out / f"pages-{start + 1:02d}-{start + count:02d}.png")
print(json.dumps({"directory": str(out), "report_id": report_id, "main_chars": len(body), "pages": len(pdf), "svg_count": quality["svg_count"], "nearly_blank_pages": quality["nearly_blank_pages"]}, ensure_ascii=False))
