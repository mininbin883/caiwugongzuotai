from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


output = Path(__file__).resolve().parents[1] / "output" / "office" / "phase5-sensitive.docx"
output.parent.mkdir(parents=True, exist_ok=True)

document = Document()
section = document.sections[0]
section.top_margin = Inches(0.75)
section.bottom_margin = Inches(0.75)
section.left_margin = Inches(0.85)
section.right_margin = Inches(0.85)

styles = document.styles
styles["Normal"].font.name = "Microsoft YaHei"
styles["Normal"].font.size = Pt(10.5)
title_style = styles["Title"]
title_style.font.name = "Microsoft YaHei"
title_style.font.size = Pt(24)
title_style.font.color.rgb = RGBColor(0, 0, 0)
title_style.font.underline = False
title_properties = title_style.element.get_or_add_pPr()
for border in title_properties.findall(qn("w:pBdr")):
    title_properties.remove(border)

title = document.add_paragraph(style="Title")
title.add_run("客户资料脱敏测试")
intro = document.add_paragraph("本文件用于验证原格式脱敏。输出应保留标题、段落、表格、页眉和页脚布局，仅替换敏感值。")
intro.paragraph_format.space_after = Pt(10)

paragraph = document.add_paragraph()
paragraph.add_run("客户：").bold = True
paragraph.add_run("张")
paragraph.add_run("三")

paragraph = document.add_paragraph()
paragraph.add_run("手机：").bold = True
paragraph.add_run("138")
paragraph.add_run("1234")
paragraph.add_run("5678")

paragraph = document.add_paragraph()
paragraph.add_run("联系人：").bold = True
paragraph.add_run("李")
paragraph.add_run("四")

table = document.add_table(rows=1, cols=2)
table.style = "Table Grid"
table.autofit = False
table.columns[0].width = Inches(1.35)
table.columns[1].width = Inches(4.9)
headers = table.rows[0].cells
headers[0].text = "字段"
headers[1].text = "内容"
for cell in headers:
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    shading = OxmlElement("w:shd")
    shading.set(qn("w:fill"), "174C3A")
    cell._tc.get_or_add_tcPr().append(shading)
    for run in cell.paragraphs[0].runs:
        run.font.color.rgb = RGBColor(255, 255, 255)
        run.bold = True

rows = [
    ("电子邮箱", "alice@example.com"),
    ("身份证号", "11010519491231002X"),
    ("项目地址", "192.168.10.8"),
]
for label, value in rows:
    cells = table.add_row().cells
    cells[0].text = label
    cells[1].text = value
    for cell in cells:
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER

document.add_paragraph("普通说明文字保持不变。")

header = section.header.paragraphs[0]
header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
header.add_run("内部文档 · 服务器 10.20.30.40")
footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
footer.add_run("墨隐 Office 原格式脱敏测试")

document.save(output)
print(output)
