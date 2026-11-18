# 答案输出规范（v0.0.3.1）

> 目标：纯文本不再乱码；公式、表格、代码、图片、文件、视频按 ChatGPT 的阅读与下载习惯统一呈现。

## 1. 字体

本地打包、离线可用（`apps/web/src/main.tsx` 引入）：

| 用途 | 字体 |
|---|---|
| 正文（科学衬线） | STIX Two Text + Noto Serif SC（中文） |
| 数学公式 | STIX Two Math + KaTeX_Main/KaTeX_Math（KaTeX 自带全部字形） |
| 无衬线界面 | Noto Sans SC + 系统 PingFang/SF |
| 代码 | JetBrains Mono |
| 符号/表情 | STIX Two Math、Apple Color Emoji 兜底 |

- 公式由 KaTeX 渲染（`$...$`、`$$...$$`、`\(...\)`、`\[...\]`），不再显示裸 `$` 或方块；
- 中文生僻字（龘/𠮷/㐀）、数学符号（∑ ∂ ∇ ∞ ≈ ≤ ≥ ≠ ↔ ⇒）、勾选符号（★ ☑ ✓）已实测有字形；
- 字体随构建产物打包，不依赖 CDN 或用户本机安装。

## 2. 纯文本 / Markdown

最终答案、Chat 回复、历史轮次、工作流结果统一走 `<RichText>`：
标题、列表、表格、引用、链接、粗斜体、行内代码、代码块、公式、图片全部按 Markdown 渲染；
渲染前经 DOMPurify（html+svg+mathMl）净化，链接 `target=_blank rel=noopener`。

## 3. 代码块

带工具栏：语言、文件名、**复制**、**下载**；
默认文件名 `snippet-N.<ext>`，模型用 ` ```python filename=check.py ` 指定文件名时按指定名下载。

## 4. 文件

模型按文件协议产出的文件（txt/md/csv/json/代码/PDF/DOCX/XLSX/PPTX…）进入「文件」页签：
类型徽标、文件名、大小、下载、文本预览、转换失败原因；PDF/DOCX/XLSX/PPTX 由服务端从文本生成。

## 5. 图片

「图片」页签网格 + 灯箱：左右切换、下载、复制图片、新窗口打开；生图产物实时到达。

## 6. 视频 / 音频

- 答案里的视频链接（`.mp4/.webm/.mov`）与音频链接（`.mp3/.wav/.m4a`）自动转为内嵌播放器 + 下载入口；
- 运行产物支持 `kind:"video"/"audio"`（服务端下载落盘、按 MIME 提供），UI 显示播放器、大小、下载；
- 视频链接支持裸 URL（模型直接粘贴）与 Markdown 链接两种写法。

## 7. 其他

- 最终答案支持「复制」与「下载 .md」；
- 流式期间使用统一的富文本渲染，不闪回纯文本；
- 输出区字号/行高/最大宽度沿用 Kimi v3 指挥舱规格。
