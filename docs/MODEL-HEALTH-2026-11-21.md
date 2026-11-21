# 模型可用性自检与修复报告（2026-11-21）

> 检查时间：2026-11-21 22:30–22:56（Asia/Shanghai）  
> 方式：隔离实例（复制本机数据）+ 逐模型真实 chat 调用；修复后对剩余可选项全量复测  
> **2026-11-21 23:24 修复**：模型调用超时 90s → 300s，KIMI 保底 180s；所有连接有效期统一显示「长期有效」。同一长问题复跑 64.2s 完成（run `run_mwqjw1qvcb01fd`）；KIMI 旧 token 过原到期点后复测仍通过（run `run_mwqk64jsae9bd4`）。

> **2026-11-21 23:10 追加**：新增 `deepseek-account`（DSH 账户）通道；V4.1 Flash 与 V4 Pro 各一次真实调用通过。当前文本健康池 **60/60**，可见模型 91、可用 62。详见 [DEEPSEEK-ACCOUNT.md](DEEPSEEK-ACCOUNT.md)。

> 证据：`docs/model-health-2026-11-21.json`

## 1. 最终结论

- 修复后可见模型：**89**；可用：**60**（58 个文本 + 2 个图片）
- 文本模型逐项复测：**58 / 58 全部通过**，失败 **0**
- 图片生成模型：**2** 个，未做文本 chat 检测（不消耗生图积分）
- 未连接/无凭证：**29** 个（未发请求）
- 已修复/处置：**14 个初始失败项** = 4 个 Claude 参数兼容修复 + 2 个 DeepSeek 目录下架 + 12 个 WorkBuddy 不可用模型禁用（全部不再出现在可选池）

## 2. 初始检测（修复前）

| 项目 | 数值 |
|---|---:|
| 目录模型 | 103 |
| 标记可用 | 74 |
| 文本实测 | 72 |
| 通过 | 58 |
| 失败 | 14 |
| 图片模型 | 2 |
| 未连接 | 29 |

## 3. 修复动作

### 3.1 Claude 中转参数兼容（恢复 4 个）

贾维斯严格 Claude 网关拒绝非默认 `temperature` 和 `reasoning_effort`。已在 `packages/providers/src/relay.ts` 中对 Claude/Anthropic 系模型不再发送这两个字段；档位仍通过 maxTokens 与 system 提示生效。恢复：`claude-fable-5-2`、`claude-haiku-5-5`、`claude-sonnet-5-5`、`claude-haiku-4-5`。

### 3.2 DeepSeek 目录与当前 Key 对齐（移除 2 个）

当前 DeepSeek Key 仅支持 `deepseek-flash` / `deepseek-v4-pro`；`deepseek-v4.1-flash`、`deepseek-v3.2` 返回 400。已从 `packages/core/src/catalog.ts` 的 DeepSeek 目录移除这两项。
> 需要 V4.1 Flash 时可使用 WorkBuddy 的 `deepseek-v4.1-flash`（本报告实测通过）；V3.2 可用 WorkBuddy 的 `deepseek-v3-2-volc`。

### 3.3 WorkBuddy 不可用模型禁用（12 个）

| 原因 | 模型 |
|---|---|
| 上游 service info not found | `hy4-preview-x`、`glm-5.0`、`glm-4.7`、`glm-4.6`、`glm-4.6v`、`minimax-m2.5`、`kimi-k2-thinking`、`hunyuan-2.0-thinking` |
| 上游返回空正文 | `hy4std`、`balanced-model`、`deep-model`、`kimi-k2.5` |
已在 WorkBuddy 中转账号中禁用；上游恢复后可在设置里重新启用。

### 3.4 瞬时失败复测

`step-5-preview` 在最终轮首次失败，连续两次复测均返回 `OK`，保留可用。

## 4. 修复后分组

| 平台 | 实测 | 通过 | 失败 |
|---|---:|---:|---:|
| deepseek | 2 | 2 | 0 |
| kimi | 6 | 6 | 0 |
| mock | 2 | 2 | 0 |
| openai | 10 | 10 | 0 |
| 贾维斯 · jws1 | 7 | 7 | 0 |
| 贾维斯 · 我的贾维斯 | 15 | 15 | 0 |
| WorkBuddy · 茉莉雨 | 16 | 16 | 0 |

## 5. 全部复测结果（58）

| 结果 | 平台 | 模型 | 耗时 | 备注 |
|---|---|---|---:|---|
| 通过 | WorkBuddy · 茉莉雨 | `deepseek-v3-2-volc` | 6037ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `deepseek-v4-flash` | 4027ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `deepseek-v4-pro` | 4025ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `deepseek-v4.1-flash` | 4033ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `default` | 3019ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `glm-5.2` | 4028ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `glm-5.3` | 3027ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `glm-5.3-flash` | 3022ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `hunyuan-chat` | 4028ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `kimi-k2.8-preview` | 10064ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `kimi-k3-1` | 8052ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `kimi-k3.1-pro` | 5026ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `mimo-v2.6-pro` | 4031ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `minimax-m3.1-flash` | 4022ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `space-bunny` | 4028ms | OK |
| 通过 | WorkBuddy · 茉莉雨 | `step-5-preview` | 6029ms | 复测两次通过（瞬时失败） |
| 通过 | deepseek | `deepseek-flash` | 1011ms | OK |
| 通过 | deepseek | `deepseek-v4-pro` | 2021ms | OK |
| 通过 | kimi | `k3` | 3019ms | OK |
| 通过 | kimi | `k3-256k` | 4027ms | OK |
| 通过 | kimi | `k3.1-pro` | 3025ms | OK |
| 通过 | kimi | `k3.1-pro-highspeed` | 5034ms | OK |
| 通过 | kimi | `kimi-for-coding` | 3015ms | OK |
| 通过 | kimi | `kimi-for-coding-highspeed` | 1011ms | OK |
| 通过 | mock | `mock-fast` | 1008ms | OK |
| 通过 | mock | `mock-thinker` | 1008ms | OK |
| 通过 | openai | `gpt-5.6-luna` | 3024ms | OK |
| 通过 | openai | `gpt-5.6-sol` | 4030ms | OK |
| 通过 | openai | `gpt-5.6-terra` | 4029ms | OK |
| 通过 | openai | `gpt-6-astra` | 3025ms | OK |
| 通过 | openai | `gpt-6-luna` | 3021ms | OK |
| 通过 | openai | `gpt-6-sol` | 3022ms | OK |
| 通过 | openai | `gpt-6.1-sol` | 3016ms | OK |
| 通过 | openai | `gpt-6.1-terra` | 3016ms | OK |
| 通过 | openai | `gpt-6.2-astra` | 6035ms | OK |
| 通过 | openai | `gpt-6.2-sol` | 5038ms | OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::codex-auto-review` | 4030ms | OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-5.6-sol` | 3018ms | OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-6-astra` | 4030ms | OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-6-sol` | 5035ms | OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-6.1-sol` | 4028ms | OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-6.2-astra` | 5027ms | OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-6.2-sol` | 7039ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-fable-5` | 9046ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-fable-5-1` | 4030ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-fable-5-2` | 3020ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-haiku-4-5` | 3022ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-haiku-5-5` | 3019ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-4-5` | 3021ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-4-6` | 3018ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-4-7` | 2008ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-4-8` | 2014ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-5` | 3023ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-5-5` | 4028ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-sonnet-4-5` | 3018ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-sonnet-4-6` | 2017ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-sonnet-5` | 4025ms | OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-sonnet-5-5` | 3023ms | OK |

## 6. 图片模型（未做文本检测）

- workbuddy / `hunyuan-image-alpha`（Hunyuan Image Alpha）
- workbuddy / `hunyuan-image-alpha-edit`（Hunyuan Image Alpha Edit）

## 7. 未连接/无凭证（未发请求）

- **anthropic**：3 个
- **gemini**：3 个
- **kimi**：4 个
- **minimax**：4 个
- **qwen**：4 个
- **volcengine**：3 个
- **xai**：3 个
- **zhipu**：5 个

## 8. 说明与剩余边界

- 本次修复改变了**可选模型目录**：下架/禁用项不会继续在模型池中制造失败；不是把上游不存在的模型“变出来”。
- 图片模型未做生图实测（避免消耗 WorkBuddy/中转积分）；需要时可单独跑生图检测。
- 未连接平台 29 个模型仍需凭证；连接后可复用同一隔离脚本。
- 失败/可用性是 2026-11-21 的快照；上游模型上下架、额度、网络变化会影响后续结果。

## 9. 复现

```bash
cp -R ~/.super-work /tmp/sw-model-check
SUPER_WORK_HOME=/tmp/sw-model-check SUPER_WORK_PORT=7894 node apps/server/dist/index.js
# 按 /api/models 逐个 POST /api/runs（单参与者、parallel、synthesize=false）
```
