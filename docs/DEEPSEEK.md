# DeepSeek 工作细节 / DeepSeek Integration & Development Notes

> 本文公开 Super Work 中 DeepSeek 的接入、参数映射、计费口径与开发工作流，便于复现与协作。

## 1. 接入概览

| 项 | 值 |
|---|---|
| Provider id | `deepseek` |
| 协议 | OpenAI 兼容（`openai-compat`） |
| 默认 Base URL | `https://api.deepseek.com/v1` |
| 凭证方式 | API Key / 本机 DSH 复用 / 粘贴 Bearer token |
| 目录更新时间 | 2026-11-18（以官方 `/models` 为准） |
| 购买/文档 | https://platform.deepseek.com/api_keys |

## 2. 模型目录（本项目内置）

| 模型 ID | 名称 | 上下文 | 最大输出 | 推理 | 视觉 |
|---|---|---:|---:|---|---|
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1,000,000 | 128,000 | ✅ | ✅ |
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash | 1,000,000 | 384,000 | ✅ | ✅ |
| `deepseek-flash` | DeepSeek Flash | 1,000,000 | 128,000 | ✅ | — |
| `deepseek-v3.2` | DeepSeek V3.2（兼容） | 131,072 | 目录默认 | — | — |

> 目录会随「同步模型」更新；若上游新增/下线，以 `GET /models` 与 `packages/core/src/catalog.ts` 为准。

## 3. 请求与参数

- 统一走 OpenAI Chat Completions 流式接口（SSE）：`POST /chat/completions`，`stream: true`。
- 请求字段：`model`、`messages`、`temperature`、`max_tokens`、`stream`，以及可选的 `reasoning_effort`（若上游支持）。
- 推理内容：适配器兼容 `reasoning_content` / `reasoning` 字段，界面上折叠为「思考过程」。
- 失败处理：401/403 提示凭证过期；429 指数退避；超时按设置中断并保留已流出内容。
- Token 统计：优先使用上游 `usage`；缺失时本地估算（`packages/core/src/tokens.ts`）。

### 五档强度映射（本项目全局规则）

| 档位 | maxTokens 倍率 | 温度 | 行为提示 |
|---|---:|---:|---|
| Low | 0.5× | 0.30 | 最少推理，直接结论 |
| Medium | 1.0× | 0.50 | 结论 + 关键依据（默认） |
| Fast | 1.3× | 0.40 | 结构化步骤/代码，少铺陈 |
| Max | 2.0× | 0.60 | 假设、反例、权衡、验证 |
| Ultra | 3.0× | 0.70 | 穷尽方案、边界条件、完整交付与风险清单 |

倍率会按模型 `maxOutputTokens` 夹紧；运行中改档只影响下一次调用。

## 4. 计费口径（默认单价，可在设置修改）

| 模型 | 输入（元/百万 token） | 输出（元/百万 token） |
|---|---:|---:|
| deepseek-v4-pro | 4 | 16 |
| deepseek-v4.1-flash | 1 | 4 |
| deepseek-flash | 0.5 | 2 |

- 计费按输入/输出分别累计，含缓存命中差异由用户单价表自行校准；
- 订阅/中转额度与 API 计费口径不同，本项目按本地单价表估算，不代替厂商账单；
- 支持导入 DSH TokenLedger 历史账本。

## 5. 文件产物

DeepSeek 模型可通过统一文件协议交付成品（不需要函数调用）：

````md
```file name="报告.docx"
# 标题
正文……
```
````

服务端把 Markdown/CSV 转换为 docx/xlsx/pptx/pdf，并写入 `~/.super-work/artifacts/<runId>/`。协议细节见 `docs/OUTPUT-FILES.md`。

## 6. 本项目的 DeepSeek 开发工作流

- 开发环境：**DeepSeek Harness（DSH）** + `deepseek-flash` 智能体；模型负责代码实现、测试、UI 走查与文档；
- 工作方式：先用 `pnpm test`/隔离实例建立可复现证据，再改代码；每个功能配套截图或端到端验证；
- 验证基线：184 项测试、`pnpm build:all`、隔离端口 + 假模型/演示模型 e2e；
- 代码风格：TypeScript strict、ESM、无原生依赖；提交信息采用 `feat/fix/docs(scope)`；
- 可复现：`SUPER_WORK_HOME=/tmp/sw-dev pnpm dev`，不触碰真实用户数据；
- 安全：不在日志/截图/issue 中出现 Key；真实凭证只存本机加密库。

### 给 DeepSeek 工程师的协作点

1. `reasoning_content` 在长上下文/多轮中的稳定性与截断策略；
2. 1M 上下文的 token 计费、缓存命中与成本可视化；
3. 结构化输出与文件协议（减少二次解析）；
4. 多模型编排下 DeepSeek 作为「强推理/裁判」的基准与提示词；
5. 适配器兼容性测试（流式、错误码、并发限流）。

欢迎在 GitHub Discussions 开帖，或提交 `provider/deepseek` 相关 PR。

## 7. 已知限制

- 目录/价格为内置快照，需手动同步或改价；
- 不同上游对 `reasoning_effort` 的支持不一致，本项目以提示词 + maxTokens 为主；
- 本机复用依赖 DSH 凭证文件格式，DSH 升级可能需适配；
- 订阅额度与 API Key 的计费口径不同，预算为估算值。
