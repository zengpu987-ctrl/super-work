# v0.0.1 验证记录

> 原则：下面的每一条都真实执行过，不是"应该能行"。命令与关键输出都记录在此。
> 验证时间：2026-11-18（Asia/Shanghai），Node v24.19.0，macOS arm64。

## 1. 构建与单元测试

```bash
pnpm install              # 6 个 workspace 项目，esbuild 构建脚本已放行
pnpm build                # tsc -b：core → providers / orchestrator → server
pnpm build:web            # vite build
```

结果：

- `pnpm build` → exit 0（strict TS，无错误）。
- `pnpm build:web` → `✓ 55 modules transformed`，产物 `apps/web/dist`（JS 343 KB / CSS 61 KB）。
- `pnpm test` → **68 tests / 68 pass / 0 fail**（providers 34 + orchestrator 34）。

覆盖要点：OpenAI 兼容 / Anthropic / Gemini / ChatGPT Responses / Kimi 会员 / mock 六类适配器的
流式解析与错误映射；五种协作模式的事件序列、容错、取消、思考吃光预算提示、final.delta 一致性、
按阶段的发言记录（stages）与首答保留；SSE 解析器边界（CRLF、多行 data、跨 chunk、[DONE]）。

## 2. 端到端冒烟（离线、无 key）

```bash
pnpm smoke
```

隔离实例（临时数据目录 + 随机端口）→ 发起三模型议会运行 → 订阅 SSE → 回读详情/历史。
22 项断言全部通过，包括：snapshot、run.start、≥3 个 model.start/done、≥20 个 delta、
final 非空、usage 有输出 token、历史可读、provider 列表 12 项。

## 3. 真实模型调用（本机凭证复用）

| 验证项 | 方法 | 结果 |
|---|---|---|
| DeepSeek API | 从 DSH 凭证导入 `DEEPSEEK_API_KEY`，跑 `deepseek-chat` | ✅ 返回 365 字答案，usage 557 tokens |
| Kimi 会员订阅 | 导入 DSH 的 `KIMI_SUBSCRIPTION_TOKEN`，跑 `k3.1-pro` | ✅ 返回「1+1 等于 2。」+ 125 字 reasoning，usage 674 tokens（走 `api.kimi.com/coding/v1/messages`） |
| Kimi 设备码登录 | `POST /api/providers/kimi/auth/start` | ✅ 真实返回 `user_code=23ZU-PDQY`、`verification_uri=https://www.kimi.com/code/authorize_device`、expires 1800s |
| ChatGPT OAuth 启动 | `POST /api/providers/openai/auth/start` | ✅ 生成 `https://auth.openai.com/oauth/authorize?...client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_challenge=…`，本地 1455 回调服务就绪 |
| ChatGPT 订阅调用 | 复用 DSH 登录态跑 `gpt-6.1-terra` | ⚠️ 未完成：DSH 里存的 access token 已于 2026-11-12 过期，refresh token 已被 DSH 轮换（401 `token_expired`）。属于凭证时效问题，不是适配器缺陷；报错信息已带可操作提示。**在本应用里点"订阅登录"重新授权即可**。 |
| 代理 | 启动时自动读取 macOS 系统代理（Hiddify `127.0.0.1:12334`） | ✅ 诊断接口显示 proxy 生效；ChatGPT 401 说明请求确实到达了 OpenAI（否则是连接超时） |

### 复用登录态的安全处理（验证后修正）

最初实现会刷新本机复用的 refresh token，实测 Kimi 刷新成功后**轮换了令牌**，可能反过来让 DSH 掉登录。
已改为：**只刷新本应用内登录（source=user）的凭证**；本机复用的凭证只从源文件重读、绝不网络刷新、绝不回写。
过期时给出明确指引（先在 DSH 里用一次 / 或在本应用重新授权）。

## 4. 运行语义

| 场景 | 结果 |
|---|---|
| 五种模式（council / debate / vote / pipeline / auto） | ✅ 全部 `done`，finalText 非空，事件完整 |
| 单模型失败 | ✅ 只发 `model.error`，其余模型继续，最终答案仍产出 |
| 全员失败 / 空产出 | ✅ 落库为 `error`，错误信息包含底层原因（如 401 的可操作提示） |
| 运行中取消 | ✅ 状态 `error`「运行已取消」，流关闭 |
| 思考吃光 maxTokens | ✅ `notice(warn)` 提示提高 maxTokens（Kimi 实测 220 token 全花在 reasoning） |
| 历史持久化 | ✅ 重启服务后运行记录、参与者、usage 均可回读 |
| 凭证加密 | ✅ DB 内 `payload` 为 `v1.<iv>.<tag>.<cipher>`，明文 token 检索为 0 条 |
| 本机凭证过期检测 | ✅ 导入即 `healthy:false` + detail「访问令牌已过期」 |

## 5. UI 实测（Edge headless + CDP，1600×1000）

- 空状态：品牌头部、三步引导、6 条示例命令、连接状态、"用演示模型试跑"入口；
- 演示运行：阶段条、参与者卡片「作答 / 互评」阶段切换、流式文本与 token/耗时、最终答案自动滚入视野；
- 设置：11 家 provider 列表、API Key / 订阅登录 / 本机复用 / 粘贴凭证四个 tab、
  自定义 baseUrl、代理检测与保存、语言切换；
- 离线降级：后端不可达时显示"本机服务未连接 · 离线预览"提示条，不白屏。

截图见 [`docs/screenshots`](screenshots/)。

## 6. 已知边界

1. ChatGPT 订阅的浏览器授权需要用户本人完成（无法自动化），OAuth 启动与回调链路已验证；
2. Gemini / Claude 官方 CLI 登录流未接入（v0.0.2），当前用 API Key 或粘贴 OAuth token；
3. 本机复用是"快照"语义：若 DSH 后续刷新了 token，需要在本应用重新导入（应用会自动在调用前重读文件）；
4. 演示模型的回答是模板化的，用于展示协作流程，不代表模型真实能力。

## 7. Web 交互实测（Edge headless + CDP，可信鼠标/键盘事件）

在真实后端（7788）+ 最新 dist 上逐项点过，console 无报错、无页面异常：

| 交互 | 结果 |
|---|---|
| 5 种模式切换 | ✅ 分段控件、右栏模式说明、阶段预期同步变化 |
| 参与模型增/删/排序/改角色 | ✅ 含同一模型多实例的独立操作 |
| 按阶段查看（作答 / 互评） | ✅ stages 存在时出现「N 阶段」标记与切换，切换后文本与滚动位置正确 |
| 裁判卡过滤 | ✅ judge 结果不占参与者卡，最终答案头部显示裁判模型 |
| 最终答案自动进入视野 | ✅ 首条 final.delta 触发 scrollIntoView（respect reduced-motion） |
| 复制最终答案 | ✅ 按钮状态变为「已复制」（剪贴板 API 失败时 textarea 兜底） |
| 重新综合 / 继续追问 | ✅ 新运行携带原始命令与多方答案 / 命令台预填追问上下文 |
| 停止运行 | ✅ 状态「运行已取消」，出现重试入口，toast 提示 |
| 设置保存 / 代理检测 | ✅ PUT 后 GET 验证生效；系统无代理时提示手动填写 |
| 本机复用导入 / 删除 | ✅ DSH 账户导入后变「1 个连接」，删除恢复未连接 |
| 响应式 | ✅ 1200px 右栏抽屉、960px 左栏抽屉，命令台完整可见 |
| 离线降级 | ✅ 后端不可达时 catalog 兜底 + 顶部提示条，不白屏 |

## 8. 收尾修正（验证中发现并已修复）

1. `connect` / `import-local` 返回 `{status, warning?}`，与 DESIGN 原来写的裸对象不一致 → 文档已按实现更新，客户端兼容两种形状并展示 warning。
2. 粘贴凭证的「额外 Header JSON」原先被服务端忽略 → core `ConnectRequest` 增加可选 `extraHeaders`，服务端校验并写入 `pasted.extraHeaders`，六类适配器均已支持。
3. 本机复用的「DSH 凭证文件」占位条目已从发现列表移除；本机复用只列真实可导入账户。
4. 测试产生的 `~/.super-work` 数据已清空，用户首次启动为干净状态。
