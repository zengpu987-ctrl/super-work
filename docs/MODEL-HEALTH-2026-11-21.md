# 模型可用性自检报告（2026-11-21）

> 检查时间：2026-11-21 22:30–22:42（Asia/Shanghai）  
> 检查方式：隔离实例（复制本机数据）+ 逐模型真实 chat 调用  
> 证据：`docs/model-health-2026-11-21.json`

## 1. 结论

- 目录模型：**103**；标记可用：**74**
- 逐项实测（文本模型）：**72** 个
- 通过：**58**；失败：**14**；通过率 **80.6%**
- 图片生成模型：**2** 个（不适用文本 chat 检测，未消耗生图积分）
- 未连接/目录不可用：**29** 个（无凭证，未发请求）

## 2. 检查方法

1. 复制 `~/.super-work` 到临时目录，启动隔离服务（端口 7894），避免污染用户历史；
2. 从 `/api/models` 读取目录，过滤 `available=true`；图片模型（`imageGen=true`）跳过；
3. 对每个文本模型单独创建一次最小运行：`Reply with exactly one word: OK`，`effort=low`，`maxTokens=64`（失败项用 512 复测）；
4. 轮询运行状态，记录返回文本/错误/耗时；失败项再次用更大输出预算复测；
5. 对上游明确拒绝的参数问题做代码修复后复测（见 §5）。

## 3. 分组结果

| 平台 | 实测 | 通过 | 失败 | 说明 |
|---|---:|---:|---:|---|
| deepseek | 4 | 2 | 2 | 目录含 2 个当前 Key 不支持的模型 |
| kimi | 6 | 6 | 0 | 6 个会员/编码模型全部可用 |
| mock | 2 | 2 | 0 | 演示模型 |
| openai | 10 | 10 | 0 | 10 个 GPT 模型全部可用 |
| 贾维斯 · jws1 | 7 | 7 | 0 | 7 个 GPT/Codex 模型全部可用 |
| 贾维斯 · 我的贾维斯 | 15 | 15 | 0 | 15 个 Claude 模型全部可用（修复后） |
| WorkBuddy · 茉莉雨 | 28 | 16 | 12 | 8 个上游无此模型 + 4 个返回空正文；2 个图片模型未测 |

## 4. 逐项结果

### 4.1 全部实测结果（逐项）

| 结果 | 平台 | 模型 | 耗时 | 备注 |
|---|---|---|---:|---|
| 失败 | WorkBuddy · 茉莉雨 | `balanced-model` | 9048ms | WorkBuddy 返回空正文 |
| 失败 | WorkBuddy · 茉莉雨 | `deep-model` | 8050ms | WorkBuddy 返回空正文 |
| 通过 | WorkBuddy · 茉莉雨 | `deepseek-v3-2-volc` | 4023ms | ### WorkBuddy · DeepSeek-V3.2  OK |
| 通过 | WorkBuddy · 茉莉雨 | `deepseek-v4-flash` | 2015ms | ### WorkBuddy · Deepseek-V4-Flash  OK |
| 通过 | WorkBuddy · 茉莉雨 | `deepseek-v4-pro` | 7045ms | ### WorkBuddy · DeepSeek-V4-Pro  OK |
| 通过 | WorkBuddy · 茉莉雨 | `deepseek-v4.1-flash` | 4028ms | ### WorkBuddy · DeepSeek-V4.1-Flash  OK |
| 通过 | WorkBuddy · 茉莉雨 | `default` | 3021ms | ### WorkBuddy · Default  OK |
| 失败 | WorkBuddy · 茉莉雨 | `glm-4.6` | 1007ms | WorkBuddy 上游无此模型/服务 |
| 失败 | WorkBuddy · 茉莉雨 | `glm-4.6v` | 2009ms | WorkBuddy 上游无此模型/服务 |
| 失败 | WorkBuddy · 茉莉雨 | `glm-4.7` | 1008ms | WorkBuddy 上游无此模型/服务 |
| 失败 | WorkBuddy · 茉莉雨 | `glm-5.0` | 2015ms | WorkBuddy 上游无此模型/服务 |
| 通过 | WorkBuddy · 茉莉雨 | `glm-5.2` | 4030ms | ### WorkBuddy · GLM-5.2  OK |
| 通过 | WorkBuddy · 茉莉雨 | `glm-5.3` | 5029ms | ### WorkBuddy · GLM-5.3  OK |
| 通过 | WorkBuddy · 茉莉雨 | `glm-5.3-flash` | 4026ms | ### WorkBuddy · GLM-5.3-Flash  OK |
| 失败 | WorkBuddy · 茉莉雨 | `hunyuan-2.0-thinking` | 2008ms | WorkBuddy 上游无此模型/服务 |
| 通过 | WorkBuddy · 茉莉雨 | `hunyuan-chat` | 3020ms | ### WorkBuddy · Hunyuan-Turbos  OK |
| 失败 | WorkBuddy · 茉莉雨 | `hy4-preview-x` | 3024ms | WorkBuddy 上游无此模型/服务 |
| 失败 | WorkBuddy · 茉莉雨 | `hy4std` | 6036ms | WorkBuddy 返回空正文 |
| 失败 | WorkBuddy · 茉莉雨 | `kimi-k2-thinking` | 2012ms | WorkBuddy 上游无此模型/服务 |
| 失败 | WorkBuddy · 茉莉雨 | `kimi-k2.5` | 11076ms | WorkBuddy 返回空正文 |
| 通过 | WorkBuddy · 茉莉雨 | `kimi-k2.8-preview` | 12068ms | ### WorkBuddy · Kimi-K2.8-Preview  OK |
| 通过 | WorkBuddy · 茉莉雨 | `kimi-k3-1` | 4024ms | ### WorkBuddy · Kimi-K3  OK |
| 通过 | WorkBuddy · 茉莉雨 | `kimi-k3.1-pro` | 6031ms | ### WorkBuddy · Kimi-K3.1-Pro  OK |
| 通过 | WorkBuddy · 茉莉雨 | `mimo-v2.6-pro` | 4024ms | ### WorkBuddy · Xiaomi MiMo-V2.6-Pro  OK |
| 失败 | WorkBuddy · 茉莉雨 | `minimax-m2.5` | 1004ms | WorkBuddy 上游无此模型/服务 |
| 通过 | WorkBuddy · 茉莉雨 | `minimax-m3.1-flash` | 3013ms | ### WorkBuddy · MiniMax-M3.1-Flash  OK |
| 通过 | WorkBuddy · 茉莉雨 | `space-bunny` | 3015ms | ### WorkBuddy · Space-Bunny  OK |
| 通过 | WorkBuddy · 茉莉雨 | `step-5-preview` | 6032ms | ### WorkBuddy · Step-5-Preview  OK |
| 通过 | deepseek | `deepseek-flash` | 1010ms | ### DeepSeek · DeepSeek Flash  OK |
| 失败 | deepseek | `deepseek-v3.2` | 1010ms | DeepSeek 当前 Key 不支持该模型名 |
| 通过 | deepseek | `deepseek-v4-pro` | 2023ms | ### DeepSeek · DeepSeek V4 Pro  OK |
| 失败 | deepseek | `deepseek-v4.1-flash` | 1008ms | DeepSeek 当前 Key 不支持该模型名 |
| 通过 | kimi | `k3` | 3014ms | ### KIMI · Kimi K3（会员）  OK |
| 通过 | kimi | `k3-256k` | 3015ms | ### KIMI · Kimi K3 256K  OK |
| 通过 | kimi | `k3.1-pro` | 4024ms | ### KIMI · Kimi K3.1 Pro（会员）  OK |
| 通过 | kimi | `k3.1-pro-highspeed` | 9062ms | ### KIMI · K3.1 Pro Highspeed（2x）  OK |
| 通过 | kimi | `kimi-for-coding` | 3020ms | ### KIMI · Kimi For Coding（K2.8）  OK |
| 通过 | kimi | `kimi-for-coding-highspeed` | 2018ms | ### KIMI · Kimi For Coding Highspeed（K2.7 2x）  OK |
| 通过 | mock | `mock-fast` | 1004ms | ### 演示模型 · Demo Fast  结论（模型自检）：「Reply with exactly one wor…」 |
| 通过 | mock | `mock-thinker` | 1008ms | ### 演示模型 · Demo Thinker  结论（模型自检 · 经推演）：经推演，「Reply with exac |
| 通过 | openai | `gpt-5.6-luna` | 5030ms | ### GPT / OpenAI · GPT-5.6 Luna  OK |
| 通过 | openai | `gpt-5.6-sol` | 6035ms | ### GPT / OpenAI · GPT-5.6 Sol  OK |
| 通过 | openai | `gpt-5.6-terra` | 3021ms | ### GPT / OpenAI · GPT-5.6 Terra  OK |
| 通过 | openai | `gpt-6-astra` | 4023ms | ### GPT / OpenAI · GPT-6 Astra  OK |
| 通过 | openai | `gpt-6-luna` | 5027ms | ### GPT / OpenAI · GPT-6 Luna  OK |
| 通过 | openai | `gpt-6-sol` | 3021ms | ### GPT / OpenAI · GPT-6 Sol  OK |
| 通过 | openai | `gpt-6.1-sol` | 5026ms | ### GPT / OpenAI · GPT-6.1 Sol  OK |
| 通过 | openai | `gpt-6.1-terra` | 3020ms | ### GPT / OpenAI · GPT-6.1 Terra  OK |
| 通过 | openai | `gpt-6.2-astra` | 5030ms | ### GPT / OpenAI · GPT-6.2 Astra  OK |
| 通过 | openai | `gpt-6.2-sol` | 3022ms | ### GPT / OpenAI · GPT-6.2 Sol  OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::codex-auto-review` | 5036ms | ### 中转站 · Codex Auto Review  OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-5.6-sol` | 4022ms | ### 中转站 · GPT-5.6 Sol  OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-6-astra` | 5033ms | ### 中转站 · GPT-6 Astra  OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-6-sol` | 4027ms | ### 中转站 · GPT-6 Sol  OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-6.1-sol` | 5025ms | ### 中转站 · GPT-6.1 Sol  OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-6.2-astra` | 7046ms | ### 中转站 · gpt-6.2-astra  OK |
| 通过 | 贾维斯 · jws1 | `relay_3c5b998780::gpt-6.2-sol` | 6042ms | ### 中转站 · gpt-6.2-sol  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-fable-5` | 5029ms | ### 中转站 · claude-fable-5  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-fable-5-1` | 2010ms | ### 中转站 · claude-fable-5-1  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-fable-5-2` | 3021ms | 修复 temperature 后通过 |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-haiku-4-5` | 3021ms | 修复 temperature + reasoning_effort 后通过 |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-haiku-5-5` | 1007ms | 修复 temperature 后通过 |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-4-5` | 2014ms | ### 中转站 · claude-opus-4-5  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-4-6` | 6037ms | ### 中转站 · claude-opus-4-6  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-4-7` | 3020ms | ### 中转站 · claude-opus-4-7  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-4-8` | 2013ms | ### 中转站 · claude-opus-4-8  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-5` | 2008ms | ### 中转站 · claude-opus-5  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-opus-5-5` | 2015ms | ### 中转站 · claude-opus-5-5  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-sonnet-4-5` | 4030ms | ### 中转站 · claude-sonnet-4-5  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-sonnet-4-6` | 5033ms | ### 中转站 · claude-sonnet-4-6  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-sonnet-5` | 3019ms | ### 中转站 · claude-sonnet-5  OK |
| 通过 | 贾维斯 · 我的贾维斯 | `relay_c1bb6d6cbd::claude-sonnet-5-5` | 4024ms | 修复 temperature 后通过 |

### 4.2 失败明细

| 平台 | 模型 | 类别 | 上游错误（截断） |
|---|---|---|---|
| deepseek | `deepseek-v4.1-flash` | DeepSeek 当前 Key 不支持该模型名 | 所有模型调用都失败了：deepseek 请求失败（HTTP 400）：{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash. (request_id: 5e27c109-e666-4980-ba40-58dc8ecbadbe)","type":"i |
| deepseek | `deepseek-v3.2` | DeepSeek 当前 Key 不支持该模型名 | 所有模型调用都失败了：deepseek 请求失败（HTTP 400）：{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v3.2. (request_id: 02d6489f-490e-4703-af1d-8a66f1667542)","type":"invalid |
| WorkBuddy · 茉莉雨 | `hy4std` | WorkBuddy 返回空正文 | 所有模型都没有产出内容（检查连接状态或提高 maxTokens） |
| WorkBuddy · 茉莉雨 | `balanced-model` | WorkBuddy 返回空正文 | 所有模型都没有产出内容（检查连接状态或提高 maxTokens） |
| WorkBuddy · 茉莉雨 | `deep-model` | WorkBuddy 返回空正文 | 所有模型都没有产出内容（检查连接状态或提高 maxTokens） |
| WorkBuddy · 茉莉雨 | `hy4-preview-x` | WorkBuddy 上游无此模型/服务 | 所有模型调用都失败了：workbuddy 请求失败（HTTP 400）：{"code":11102,"msg":"model [hy4-preview-x] service info not found","requestId":"31403a2c-e951-4745-8122-c4b6518009ae","retry_policy":{"retry":false},"displayMsg":{"en":"Model unavailab |
| WorkBuddy · 茉莉雨 | `glm-5.0` | WorkBuddy 上游无此模型/服务 | 所有模型调用都失败了：workbuddy 请求失败（HTTP 400）：{"code":11102,"msg":"model [glm-5.0] service info not found","requestId":"98b59eb9-5477-480b-aa6b-3a7acdb1ec51","retry_policy":{"retry":false},"displayMsg":{"en":"Model unavailable. Pl |
| WorkBuddy · 茉莉雨 | `glm-4.7` | WorkBuddy 上游无此模型/服务 | 所有模型调用都失败了：workbuddy 请求失败（HTTP 400）：{"code":11102,"msg":"model [glm-4.7] service info not found","requestId":"18a10f05-d90d-4c6f-a795-f0ae0e785c46","retry_policy":{"retry":false},"displayMsg":{"en":"Model unavailable. Pl |
| WorkBuddy · 茉莉雨 | `glm-4.6` | WorkBuddy 上游无此模型/服务 | 所有模型调用都失败了：workbuddy 请求失败（HTTP 400）：{"code":11102,"msg":"model [glm-4.6] service info not found","requestId":"919ecdc9-69e3-4f70-8d3d-957e160b9b58","retry_policy":{"retry":false},"displayMsg":{"en":"Model unavailable. Pl |
| WorkBuddy · 茉莉雨 | `glm-4.6v` | WorkBuddy 上游无此模型/服务 | 所有模型调用都失败了：workbuddy 请求失败（HTTP 400）：{"code":11102,"msg":"model [glm-4.6v] service info not found","requestId":"a5e16cc7-6ebe-438b-a76c-51d0376d0c93","retry_policy":{"retry":false},"displayMsg":{"en":"Model unavailable. P |
| WorkBuddy · 茉莉雨 | `minimax-m2.5` | WorkBuddy 上游无此模型/服务 | 所有模型调用都失败了：workbuddy 请求失败（HTTP 400）：{"code":11102,"msg":"model [minimax-m2.5] service info not found","requestId":"3c22731c-772a-4410-88e9-207a09fb7550","retry_policy":{"retry":false},"displayMsg":{"en":"Model unavailabl |
| WorkBuddy · 茉莉雨 | `kimi-k2.5` | WorkBuddy 返回空正文 | 所有模型都没有产出内容（检查连接状态或提高 maxTokens） |
| WorkBuddy · 茉莉雨 | `kimi-k2-thinking` | WorkBuddy 上游无此模型/服务 | 所有模型调用都失败了：workbuddy 请求失败（HTTP 400）：{"code":11102,"msg":"model [kimi-k2-thinking] service info not found","requestId":"ed744c87-acfc-44c6-a68a-83477f6aa455","retry_policy":{"retry":false},"displayMsg":{"en":"Model unavai |
| WorkBuddy · 茉莉雨 | `hunyuan-2.0-thinking` | WorkBuddy 上游无此模型/服务 | 所有模型调用都失败了：workbuddy 请求失败（HTTP 400）：{"code":11102,"msg":"model [hunyuan-2.0-thinking] service info not found","requestId":"88d693bb-3470-43a8-b7ba-535bd9d8dcb8","retry_policy":{"retry":false},"displayMsg":{"en":"Model un |

## 5. 本次修复与恢复

检查中发现：贾维斯中转的严格 Claude 网关会拒绝 **非默认 temperature** 和 **reasoning_effort**，导致 4 个模型 400。
已在 `packages/providers/src/relay.ts` 中做兼容：对 Claude/Anthropic 系模型不发送 `temperature` 与 `reasoning_effort`，档位仍通过 maxTokens 和 system 强度提示生效。
修复后复测：

- `relay_c1bb6d6cbd::claude-fable-5-2`：修复 temperature 后通过
- `relay_c1bb6d6cbd::claude-haiku-5-5`：修复 temperature 后通过
- `relay_c1bb6d6cbd::claude-sonnet-5-5`：修复 temperature 后通过
- `relay_c1bb6d6cbd::claude-haiku-4-5`：修复 temperature + reasoning_effort 后通过

修复后 `pnpm test` 187 项全绿，生产服务已重启。

## 6. 图片模型（未做文本检测）

- workbuddy / `hunyuan-image-alpha`（Hunyuan Image Alpha，imageGen=true）
- workbuddy / `hunyuan-image-alpha-edit`（Hunyuan Image Alpha Edit，imageGen=true）

## 7. 未连接/目录不可用（未发请求）

- **anthropic**：3 个
- **gemini**：3 个
- **kimi**：4 个
- **minimax**：4 个
- **qwen**：4 个
- **volcengine**：3 个
- **xai**：3 个
- **zhipu**：5 个

明细：

- kimi / `kimi-k3.1-pro`
- kimi / `kimi-k3`
- kimi / `kimi-k2.7-code`
- kimi / `kimi-k2.6`
- anthropic / `claude-opus-5-5`
- anthropic / `claude-sonnet-5-5`
- anthropic / `claude-haiku-4-5`
- zhipu / `glm-5.3`
- zhipu / `glm-5.3-flash`
- zhipu / `glm-5.2`
- zhipu / `glm-4.7`
- zhipu / `glm-4.6v`
- qwen / `qwen4-max`
- qwen / `qwen3.8-max`
- qwen / `qwen3.8-flash`
- qwen / `qwen3.8-omni-flash`
- volcengine / `doubao-seed-evolving`
- volcengine / `doubao-seed-2.1`
- volcengine / `deepseek-v4.1-flash`
- minimax / `MiniMax-M3`
- minimax / `MiniMax-M3.1-Flash`
- minimax / `MiniMax-M2.7`
- minimax / `MiniMax-M2.5`
- gemini / `gemini-3.1-pro`
- gemini / `gemini-3.1-flash`
- gemini / `gemini-3-pro`
- xai / `grok-4.7`
- xai / `grok-4.1`
- xai / `grok-code-fast-1`

## 8. 建议

1. **DeepSeek**：`deepseek-v4.1-flash`、`deepseek-v3.2` 不在当前 Key 的支持列表（仅 deepseek-flash/deepseek-v4-pro）；建议在钥匙绑定模型里隐藏或提示“当前 Key 不支持”。
2. **WorkBuddy**：`hy4-preview-x`、`glm-5.0`、`glm-4.7`、`glm-4.6`、`glm-4.6v`、`minimax-m2.5`、`kimi-k2-thinking`、`hunyuan-2.0-thinking` 返回 service info not found，建议重新同步模型并在当前账号下禁用；`hy4std`/`balanced-model`/`deep-model`/`kimi-k2.5` 返回空正文，建议标记为不可用或改用可用的同族模型。
3. **图片模型**：`hunyuan-image-alpha`、`hunyuan-image-alpha-edit` 未做生图实测；需要单独的生图可用性检测（会消耗积分）。
4. **未连接平台**：Claude、GLM、Qwen、豆包、MiniMax、Gemini、Grok 共 29 个模型因无凭证未检测；连接后可复用本脚本。
5. **产品化**：把“模型健康”做成设置页的一键检测/定时探针，失败模型在模型池中置灰并显示原因（与 issue #1 的 P0 对应）。

## 9. 复现

```bash
# 隔离副本，避免污染真实历史
cp -R ~/.super-work /tmp/sw-model-check
SUPER_WORK_HOME=/tmp/sw-model-check SUPER_WORK_PORT=7894 node apps/server/dist/index.js
# 然后按 /api/models 逐个 POST /api/runs（单参与者、parallel、synthesize=false）
```

> 说明：本次为真实调用检测，失败结果受上游模型上下架、账号权限、额度和瞬时网络影响；报告是 2026-11-21 22:42 的快照，不是永久结论。
