# 模型目录（2026-11-21 更新）

> 本文件记录 Super Work 内置模型池的当前版本与来源。内置目录只在发版时更新；
> 运行期可用顶栏「同步模型」按钮（`POST /api/models/refresh`）从各家上游拉最新目录并合并进模型池。

## 各平台当前模型

| 平台 | 当前模型 | 依据 |
|---|---|---|
| DeepSeek（API Key） | `deepseek-v4-pro`、`deepseek-flash` | 本机 key 实测 `GET /v1/models` 仅返回这两项；V4.1-Flash / V3.2 已从该通道目录移除 |
| DeepSeek 账户（DSH） | `deepseek-flash`（V4.1 Flash）、`deepseek-v4-pro` | DSH Account token（`x-dsh-auth-token`）+ `https://api.deepseek.com/anthropic/v1/messages`；2026-11-21 实测 V4 / VP 均通过 |
| KIMI | API：`kimi-k3.1-pro`、`kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`；会员：`k3.1-pro`、`k3`、`k3-256k`、`kimi-for-coding`（K2.8）、`kimi-for-coding-highspeed`（K2.7 2x）、`k3.1-pro-highspeed` | 会员实时接口 `GET https://api.kimi.com/coding/v1/models`（2026-11-19 实测，6 条）；API 侧本机 key 实测 Moonshot `/v1/models` |
| GPT / OpenAI | 订阅：`gpt-6.2-sol`（500K）、`gpt-6.2-astra`（272K）、`gpt-6.1-terra/sol`、`gpt-6-astra/luna/sol`、`gpt-5.6-luna/sol/terra`；API 与订阅同名模型按 `via=any` 处理 | Codex 实时目录 `GET https://chatgpt.com/backend-api/codex/models?client_version=…`（2026-11-19 实测，10 条 `visibility=list`） |
| Claude | `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-4-5` | 官方文档 Opus/Sonnet 5.5 页面 |
| GLM / 智谱 | `glm-5.3`、`glm-5.3-flash`、`glm-5.2`、`glm-4.7`、`glm-4.6v` | 智谱文档 GLM-5.3 / 5.3-Flash；QwenCloud 日志（2026-08-28、10-26） |
| 千问 / Qwen | `qwen4-max`、`qwen3.8-max`、`qwen3.8-flash`、`qwen3.8-omni-flash` | QwenCloud Model releases（qwen4-max 2026-11-16；qwen3.8 系列 9-10 月） |
| 火山引擎 / 豆包 | `doubao-seed-evolving`、`doubao-seed-2.1`、`deepseek-v4.1-flash`（方舟） | 火山方舟「最新模型」文档（Seed-Evolving）与 Seed2.1 发布；具体接入点 ID 以控制台为准 |
| MiniMax | `MiniMax-M3`、`MiniMax-M3.1-Flash`、`MiniMax-M2.7`、`MiniMax-M2.5` | MiniMax 官方 release notes（M3 2026-06-01、M3.1 Flash 2026-10-19） |
| Gemini | `gemini-3.1-pro`、`gemini-3.1-flash`、`gemini-3-pro`（兼容） | Google AI 文档 Gemini 3.1 Pro / 3.1 Flash |
| Grok / xAI | `grok-4.7`、`grok-4.1`（兼容）、`grok-code-fast-1` | AWS Bedrock Grok 4.7 模型卡 |
| WorkBuddy | 当前启用 18 个：`kimi-k3.1-pro`、`glm-5.3(flash)`、`deepseek-v4-pro`、`hunyuan-image-alpha` 等；12 个上游不可用项已禁用 | 本机登录态实测 `/v2/enterprises/personal/models`（2026-11-18）；2026-11-21 健康检查后禁用不可用项 |
| 中转站 | 用户导入的上游模型 | 设置 → 中转站，「测试并拉取模型」 |

## 模型池同步

- **入口**：顶部工具条右侧「同步模型」按钮（或直接 `POST /api/models/refresh`）。
- **行为**：
  1. 对已连接的 provider 逐个拉目录（12s 超时）：ChatGPT 订阅走 `GET {base}/models?client_version=…`、Kimi 会员走 `GET {base}/models`（`discoverModels`，实时目录）；其余平台仍走 OpenAI 兼容的 `GET /models`；
  1.1 结果用 `mergeDiscoveredModels` 合并进 `settings.customModels`（持久化）：新 id 追加、已有 id 只更新名称/上下文等元数据（保留 tags 等本地字段）、不删除已下线模型；
  2. 对已启用的中转站 / WorkBuddy 账号重新拉一次上游目录并写回；
  3. 返回 `{updated, errors, total}`，UI 用 toast 反馈成功/失败平台。
- **不做**：不会删除你手动添加的模型，也不会自动删除已下线模型（避免误删历史运行用到的 ID）。

## 更新方式（维护者）

```bash
# 1) 编译后启动服务
pnpm build && pnpm start
# 2) 已连接平台后触发同步，把最新模型合并进设置
curl -X POST http://127.0.0.1:7788/api/models/refresh
# 3) 如需把结果固化为内置目录：读取 ~/.super-work/config.json 的 customModels，
#    把其中的稳定版本按 provider 填回 packages/core/src/catalog.ts
```
