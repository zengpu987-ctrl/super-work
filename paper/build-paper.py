#!/usr/bin/env python3
"""Build the bilingual paper DOCX from paper/super-work-paper.md.

Requires: python-docx. PDF conversion is intentionally left to LibreOffice:
  soffice --headless --convert-to pdf --outdir paper paper/super-work-paper.docx
"""
from pathlib import Path
import re
import sys

try:
    from docx import Document
    from docx.shared import Pt, Cm, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
except ImportError:
    sys.exit("python-docx is required: pip install python-docx")

ROOT = Path(__file__).resolve().parent.parent
PAPER = ROOT / "paper"
MD = (PAPER / "super-work-paper.md").read_text(encoding="utf-8")
OUT = PAPER / "super-work-paper.docx"

INK = RGBColor(0x1B, 0x27, 0x23)
MUTED = RGBColor(0x5B, 0x6B, 0x64)
ACCENT = RGBColor(0x17, 0x5A, 0x49)
EN_FONT = "Times New Roman"
ZH_FONT = "Songti SC"

doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
sec.top_margin = Cm(2.0)
sec.bottom_margin = Cm(2.0)
sec.left_margin = Cm(2.1)
sec.right_margin = Cm(2.1)


def set_font(run, size=None, bold=None, color=None, italic=None, en=EN_FONT, zh=ZH_FONT):
    run.font.name = en
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.append(rFonts)
    rFonts.set(qn("w:ascii"), en)
    rFonts.set(qn("w:hAnsi"), en)
    rFonts.set(qn("w:eastAsia"), zh)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if color is not None:
        run.font.color.rgb = color


def shade(cell, color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), color)
    tcPr.append(shd)


def add_inline(p, text, size=10.5, color=INK, italic=False):
    for part in re.split(r"(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)", text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            r = p.add_run(part[2:-2])
            set_font(r, size, True, color, italic)
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            r = p.add_run(part[1:-1])
            set_font(r, size, False, color, True)
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            r = p.add_run(part[1:-1])
            set_font(r, size - 0.5, False, RGBColor(0x2A, 0x4A, 0x40), italic, en="Menlo", zh="Menlo")
        else:
            r = p.add_run(part)
            set_font(r, size, False, color, italic)


def body(text, size=10.0, first_indent=True, space_after=2):
    p = doc.add_paragraph()
    p.paragraph_format.line_spacing = 1.27
    p.paragraph_format.space_after = Pt(space_after)
    if first_indent:
        p.paragraph_format.first_line_indent = Cm(0.55)
    add_inline(p, text.strip(), size)


def heading(text, level):
    p = doc.add_paragraph()
    p.paragraph_format.keep_with_next = True
    p.paragraph_format.space_before = Pt(12 if level == 1 else 8)
    p.paragraph_format.space_after = Pt(4)
    r = p.add_run(text)
    set_font(r, 14 if level == 1 else 11.2, True, ACCENT if level == 1 else INK)
    if level == 1:
        pPr = p._p.get_or_add_pPr()
        pbdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "6")
        bottom.set(qn("w:space"), "3")
        bottom.set(qn("w:color"), "8FBFA9")
        pbdr.append(bottom)
        pPr.append(pbdr)


def add_table(rows):
    cols = max(len(r) for r in rows)
    table = doc.add_table(rows=0, cols=cols)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    head = rows[0][0] if rows else ""
    if head == "Mode":
        widths = [2.1, 3.3, 4.9, 4.6]
    elif head == "Level":
        widths = [2.1, 3.6, 2.6, 7.0]
    elif head == "Format":
        widths = [6.1, 4.7, 4.1]
    elif head == "Model":
        widths = [4.2, 3.0, 2.8, 2.2, 5.4]
    else:
        widths = None
    for ri, row in enumerate(rows):
        tr = table.add_row()
        trPr = tr._tr.get_or_add_trPr()
        trPr.append(OxmlElement("w:cantSplit"))
        if ri == 0:
            trPr.append(OxmlElement("w:tblHeader"))
        for ci in range(cols):
            cell = tr.cells[ci]
            cell.text = ""
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.15
            add_inline(p, row[ci] if ci < len(row) else "", 8.4)
            if ri == 0:
                for run in p.runs:
                    run.bold = True
                    run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
                shade(cell, "1F3A34")
            if widths and ci < len(widths):
                cell.width = Cm(widths[ci])
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def add_figure(alt, path):
    img = ROOT / "paper" / path
    if not img.exists():
        return
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(2)
    width = Cm(11.4) if "earth" in path else Cm(14.0)
    p.add_run().add_picture(str(img), width=width)
    cap = doc.add_paragraph()
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    cap.paragraph_format.space_after = Pt(7)
    r = cap.add_run(alt)
    set_font(r, 8.4, False, MUTED, italic=True)


def page_break():
    doc.add_page_break()


# ---------------- cover ----------------
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(18)
r = p.add_run("Super Work")
set_font(r, 28, True, ACCENT)
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("A Local-First Multi-Model Orchestration Workbench")
set_font(r, 15, True, INK)
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("本地优先的多模型编排工作台")
set_font(r, 13, True, INK)
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(10)
r = p.add_run("Super Work Contributors\nOpen-source project · https://github.com/zengpu987-ctrl/super-work\nv0.0.3 · 2026-11-19 · Apache-2.0")
set_font(r, 9.2, False, MUTED)

# ---------------- abstract ----------------
lines = MD.splitlines()
i = 0
# skip title line
while i < len(lines) and not lines[i].startswith("## Abstract"):
    i += 1
i += 1
abstract_en = []
while i < len(lines) and not lines[i].startswith("**Keywords:**"):
    if lines[i].strip():
        abstract_en.append(lines[i].strip())
    i += 1
kw_en = lines[i].replace("**Keywords:**", "").strip() if i < len(lines) else ""
i += 1
while i < len(lines) and not lines[i].startswith("## 摘要"):
    i += 1
i += 1
abstract_zh = []
while i < len(lines) and not lines[i].startswith("**关键词"):
    if lines[i].strip():
        abstract_zh.append(lines[i].strip())
    i += 1
kw_zh = lines[i].replace("**关键词：**", "").replace("**关键词:**", "").strip() if i < len(lines) else ""

p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(14)
r = p.add_run("Abstract")
set_font(r, 10.5, True, ACCENT)
for para in abstract_en:
    body(para, 9.4, first_indent=False, space_after=2)
p = doc.add_paragraph()
p.paragraph_format.space_after = Pt(6)
add_inline(p, "**Keywords:** " + kw_en, 9.2)

p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(8)
r = p.add_run("摘要")
set_font(r, 10.5, True, ACCENT)
for para in abstract_zh:
    body(para, 9.4, first_indent=False, space_after=2)
p = doc.add_paragraph()
add_inline(p, "**关键词：** " + kw_zh, 9.2)

page_break()

# ---------------- body ----------------
i = next((idx for idx, line in enumerate(lines) if line.startswith("# Part I")), 0)
in_refs = False
while i < len(lines):
    line = lines[i]
    stripped = line.strip()
    if not stripped or stripped == "---":
        i += 1
        continue
    if stripped.startswith("# Part I"):
        heading("Part I — English", 1)
        i += 1
        continue
    if stripped.startswith("# 第二部分"):
        page_break()
        heading("第二部分 — 中文", 1)
        i += 1
        continue
    if stripped.startswith("## "):
        title = stripped[3:].strip()
        if title == "Abstract" or title == "摘要":
            i += 1
            continue
        if title.startswith("References"):
            page_break()
            in_refs = True
        if title.startswith("参考文献"):
            i += 1
            continue
        heading(title, 1)
        i += 1
        continue
    if stripped.startswith("![") and "](" in stripped:
        m = re.match(r"!\[([^\]]*)\]\(([^)]+)\)", stripped)
        if m:
            add_figure(m.group(1), m.group(2))
        i += 1
        continue
    if stripped.startswith("|"):
        rows = []
        while i < len(lines) and lines[i].strip().startswith("|"):
            cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
            if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                rows.append(cells)
            i += 1
        if rows:
            add_table(rows)
        continue
    if stripped.startswith("> 中文部分引用同英文参考文献"):
        i += 1
        continue
    if in_refs:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.7)
        p.paragraph_format.first_line_indent = Cm(-0.7)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.line_spacing = 1.2
        add_inline(p, stripped, 9.2)
        i += 1
        continue
    # skip cover metadata lines inside body
    if stripped.startswith("**Authors:**") or stripped.startswith("**Affiliation:**") or stripped.startswith("**Version:**"):
        i += 1
        continue
    body(stripped)
    i += 1

# ---------------- footer ----------------
footer = sec.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = footer.add_run("Super Work · v0.0.3 · ")
set_font(r, 8, False, MUTED)
fld = OxmlElement("w:fldSimple")
fld.set(qn("w:instr"), "PAGE")
run = OxmlElement("w:r")
t = OxmlElement("w:t")
t.text = "1"
run.append(t)
fld.append(run)
footer._p.append(fld)

doc.save(OUT)
print(f"saved {OUT} ({OUT.stat().st_size} bytes)")
