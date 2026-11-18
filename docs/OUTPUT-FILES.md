# 模型文件输出（各种类型文件，不只有文字）

> 2026-11-19。截图：[v4-files-tab.png](screenshots/v4-files-tab.png)（文件页签 + 预览）、
> [v4-chat-files.png](screenshots/v4-chat-files.png)（Chat 里的文件产物）。

## 1. 问题

此前模型只能产出文字；Artifact 体系只接了生图与 3D 代码两种，用户要文档 / 表格 / PPT / PDF 时只能拿到一大段文字。
本版补上「模型声明文件 → 服务端落盘 / 转格式 → 前端下载与预览」的完整链路。

## 2. 模型侧协议

在 system prompt 末尾统一追加「文件输出（重要）」提示：成品放进带文件名的代码块（可多个）：

````md
```file name="文件名.ext"
<文件正文>
```
````

兼容 `filename=` / `path=`、`file:名字.ext`、`语言 名字.ext` 等写法。
普通代码块不受影响；文件块正文会从回答中剔除，替换为 `[已生成文件：xxx]`，回答里不会重复整篇内容。

## 3. 支持的格式

| 类型 | 扩展名 | 处理方式 |
|---|---|---|
| 文本 / 数据 / 网页 | md、txt、csv、tsv、json、jsonl、html、svg、xml、yaml、toml、ics、rtf | 直接写盘 |
| 代码 | py、ts、tsx、js、jsx、css、sql、sh、java、go、rs、c、cpp、rb、php、kt、swift、lua… | 直接写盘 |
| Office | docx、xlsx、pptx | 从 Markdown / CSV / JSON 正文转换（纯 JS：docx / xlsx / pptxgenjs） |
| PDF | pdf | 本机 `cupsfilter`（text/plain → PDF，中文正常） |
| 其他未知扩展名 | — | 按 UTF-8 文本保存 |

## 4. 链路

1. orchestrator 每次 chat 调用成功后解析文件块，发 `artifact` 事件（`kind:"file"`，带正文与 mime）；
   本地流式已经吐出的内容在最终 `final` 事件里替换为干净文本；参与者卡片文本同样使用清洗后的版本。
2. server `processArtifact` 用 `apps/server/src/export.ts` 落盘：同名文件自动加短 id 前缀；
   转换失败时保留正文并写入 `meta.error`，前端显示可复制的错误，不丢内容。
3. 文件通过 `GET /api/artifacts/:runId/:file` 下载：支持中文 / 空格文件名（禁止目录穿越），
   按扩展名返回正确 Content-Type。
4. 前端：最终答案新增「文件 n」页签（下载 / 预览 / 类型 / 大小 / 是否已转换 / 错误提示）；
   Chat 模式在模型气泡下直接列出文件与图片产物。

## 5. 验证

- 单元测试：orchestrator 文件块解析与清洗、普通代码块不受影响；server 文本 / CSV / docx / xlsx / pptx / PDF 生成。
- `pnpm test` 全绿（**172 项**）。
- 端到端（隔离实例 + 本地假模型，SSE 返回 6 个文件块）：
  - 最终答案只剩 `[已生成文件：…]` 与说明；
  - 生成 md 212B、csv 101B、docx 9.7KB、xlsx 16.3KB、pptx 51.7KB、pdf 14KB；
  - 下载校验：md/csv UTF-8、docx/xlsx/pptx 为合法 ZIP（可解出 document.xml / workbook.xml / slide*.xml）、pdf 以 `%PDF-` 开头；
  - xlsx 读回 4 行数据、docx 正文、pptx 两页文字均正确；PDF 能渲染出中文。
  - Headless Edge：文件页签 6 个文件可下载、Markdown 预览正常；Chat 气泡下 6 个文件无控制台报错。

## 6. 边界

- 文件正文仍是文本协议；图片继续走「生图角色」，二进制内容（音频 / 视频）不通过文件块传输。
- docx / xlsx / pptx / pdf 是从文本转换的基础排版，不保留复杂样式；超过模型输出上限的内容会被模型自身截断。
