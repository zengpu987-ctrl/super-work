# 论文构建 / Paper Build

本目录包含中英双语论文《Super Work: A Local-First Multi-Model Orchestration Workbench》的源文与构建脚本。

## 文件

- `super-work-paper.md`：论文源文（英文 Part I + 中文 Part II）。
- `super-work-paper.docx`：由脚本生成的 Word 版本。
- `super-work-paper.pdf`：12 页 PDF（LibreOffice 导出）。
- `figures/`：架构图、运行流水线、地球截图、评分图。
- `build-paper.py`：Markdown → DOCX 生成器（依赖 `python-docx`）。

## 构建

```bash
python3 -m pip install python-docx
python3 paper/build-paper.py
# 可选：用 LibreOffice 转 PDF
soffice --headless --convert-to pdf --outdir paper paper/super-work-paper.docx
```

论文使用 Apache-2.0 发布；引用请使用根目录 `CITATION.cff`。

## 结构

- 标题页：英文/中文摘要、关键词。
- Part I（English）：Introduction → Related Work → Architecture → Orchestration → Context/Cost → Artifacts → Earth → Evaluation → Limitations → Roadmap → Appendices → References。
- 第二部分（中文）：对应章节的中文版本与「参与方式与复现」附录。

页面数由 `paper/build-paper.py` 的排版参数控制；当前 A4、10.2pt、1.3 行距、12 页。
