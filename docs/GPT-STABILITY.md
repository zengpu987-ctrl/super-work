# GPT / ChatGPT 订阅调用稳定性（2026-11-21）

## 根因

多轮对话把历史 assistant 消息原样放进 OpenAI Responses 请求，但 `responsesContent()` 对**所有角色**都使用 `input_text`。
Codex 后端只允许：

- user / system：`input_text`
- assistant：`output_text`

因此第二轮开始会返回 400：
`Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'.`

## 修复

1. **角色映射**（`packages/providers/src/images.ts`）
   - assistant → `output_text`，且不发送 `input_image`
   - user → `input_text` / `input_image`
   - 新增单测：assistant 历史消息必须是 `output_text`
2. **401/403 自动恢复**（`apps/server/src/registry.ts` + `credentials.ts`）
   - 订阅 token 过期/被撤销时先强制刷新一次（仅 source=user，避免轮换 DSH 共用 token）
   - 本机复用凭证会重新读取 DSH 文件，拿到新 token 后自动重试一次
3. **429 / 5xx 重试**：上游临时错误等待 1.2s 重试一次
4. **超时**：Web 默认单模型超时 90s → **180s**；性能面板可调到 300s
5. **错误提示**：本机复用登录过期时提示「先在 DSH 刷新或在本应用重新授权」

## 验证

- 单轮 `gpt-6.1-terra`：done
- 第二轮（带 assistant 历史）：done，`history.rounds=1`
- `gpt-6.2-sol`：单轮 + 第二轮均 done
- `pnpm test` 192/192；provider 协议测试 77/77

## 仍有边界

- ChatGPT 订阅额度/上游限流（429）只重试一次，持续失败会如实报错；
- 本机复用 DSH token **不会**主动刷新（避免轮换使 DSH 失效），DSH 过期需在 DSH 刷新后重新导入；
- 模型被上游下架时会返回 400，需要在模型池换用目录内模型。
