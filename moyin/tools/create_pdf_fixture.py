from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas


output = Path(__file__).resolve().parents[1] / "output" / "pdf" / "phase3-sensitive-fixture.pdf"
output.parent.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont("FixtureCJK", "C:/Windows/Fonts/simhei.ttf"))

canvas = Canvas(str(output), pagesize=A4, pageCompression=1)
width, height = A4

pages = [
    (
        "客户资料 - 第 1 页",
        [
            ("客户：", "张三", "FixtureCJK"),
            ("手机：", "13812345678", "Helvetica"),
            ("邮箱：", "alice@example.com", "Helvetica"),
            ("身份证：", "11010519491231002X", "Helvetica"),
        ],
    ),
    (
        "服务记录 - 第 2 页",
        [
            ("联系人：", "李四", "FixtureCJK"),
            ("手机：", "13987654321", "Helvetica"),
            ("邮箱：", "lisi@example.cn", "Helvetica"),
            ("服务器：", "192.168.10.8", "Helvetica"),
        ],
    ),
]

for page_number, (title, lines) in enumerate(pages, start=1):
    canvas.setFillColor(HexColor("#F6F3EA"))
    canvas.rect(0, 0, width, height, stroke=0, fill=1)
    canvas.setFillColor(HexColor("#174C3A"))
    canvas.setFont("FixtureCJK", 24)
    canvas.drawString(56, height - 78, title)
    canvas.setStrokeColor(HexColor("#CBD5CD"))
    canvas.line(56, height - 96, width - 56, height - 96)
    canvas.setFillColor(HexColor("#18211E"))
    canvas.setFont("FixtureCJK", 18)
    y = height - 150
    for label, value, value_font in lines:
        canvas.setFont("FixtureCJK", 18)
        canvas.drawString(72, y, label)
        canvas.setFont(value_font, 18)
        canvas.drawString(170, y, value)
        y -= 54
    canvas.setFont("FixtureCJK", 10)
    canvas.setFillColor(HexColor("#6F7772"))
    canvas.drawRightString(width - 56, 40, f"墨隐 PDF 涂黑测试 · {page_number}/2")
    canvas.showPage()

canvas.save()
print(output)
