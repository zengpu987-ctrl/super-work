# 插件中心说明 / Plugins

Super Work 的插件中心**不加载第三方任意代码**，而是扫描本机 DSH profile 的插件清单，按能力做三档标注，并对可桥接能力做短命令自检。这样既保留扩展性，又不把本机暴露给不可信插件。

## 1. 三档标注

| 标注 | 含义 | 行为 |
|---|---|---|
| 已原生迁移 `native/migrated` | 能力已在 Super Work 内部重写 | 直接使用内置功能（记忆、上下文、计费、WorkBuddy、Kimi 订阅、DeepSeek 登录态等） |
| 可桥接 `bridge` | 通过本机 CLI/MCP 调用 | 显示桥接命令与测试结果；需要本机已安装对应工具 |
| 仅 DSH `ui-only` | 依赖 DSH 专属 UI/运行时 | 仅展示，不在 Super Work 内执行 |

## 2. 当前内置/可桥接能力（v0.0.3）

| 能力 | 类型 | 状态 | 接入方式 |
|---|---|---|---|
| 记忆（空间/条目/召回） | native | migrated | `packages/memory` + 设置页 |
| 上下文洞察 | native | migrated | 运行中每次调用组成 |
| 计费（用量/成本/CSV/DSH 账本） | native | migrated | 设置 → 计费 |
| WorkBuddy 中转站 | native | migrated | 设置 → 中转站 |
| Kimi 会员订阅 | native | migrated | 设置 → KIMI → 设备码 |
| DeepSeek 登录态复用 | native | migrated | 设置 → DeepSeek → 本机复用 |
| 文件/文献归档 | native | migrated | 记忆附件 |
| 插件中心 | native | migrated | 设置 → 插件 |
| 音视频剪辑/转码 | bridge | bridge-ready | 系统 `ffmpeg` |
| Wolfram 计算 | bridge | bridge-ready | `wolframscript` |
| arXiv 检索 | bridge | pending | 本机 Python 3 已探测，检索 API 待接 |
| 生图 / 媒体生成 | bridge | pending | 已由 WorkBuddy/图像模型覆盖 |
| HyperFrames / Remotion | bridge | pending | 需 Node 渲染管线 |
| GitHub 只读路由 | bridge | pending | 可用 GitHub API 直连替代 |
| 科研绘图 / OCR / 识图 | bridge | pending | 可接 matplotlib / 视觉模型 |
| 主题、侧栏、壁纸等 UI 插件 | ui-only | pending | DSH 专属，不迁移 |

> 完整分类以 `packages/plugins/src/index.ts` 的 `PLUGIN_CLASSIFICATION` 为准。

## 3. 使用方式

1. 打开 设置 → 插件；
2. 点「扫描」读取本机 DSH 插件（只读 `~/.dsh/profiles/desktop` 的 manifest）；
3. 对 `bridge-ready` 的插件点「测试」，查看命令路径与返回；
4. 在任务中通过自然语言或工作流调用对应能力（例如「用 ffmpeg 把这段视频转成 720p」）；
5. 启用/停用仅影响 Super Work 的显示与调用，不修改 DSH 原配置。

## 4. 开发新插件

- **原生能力**：在 `packages/*` 实现，接入 orchestrator/server，并补测试；
- **桥接能力**：在 `packages/plugins/src/index.ts` 增加分类与 `PluginBridgeSpec`（命令 + 自检参数），只允许受控白名单；
- **UI 扩展**：当前不做任意 JS 注入；如需 UI 插件，请先提 Proposal（安全模型见 `SECURITY.md`）；
- 第三方插件的许可证与行为由作者负责；提交时请在 `THIRD-PARTY-NOTICES.md` 补充。

## 5. 安全边界

- 不执行插件包内的任意脚本，只运行显式声明的命令；
- 桥接命令有超时、输出截断与路径校验；
- 不读取插件目录之外的私有文件；
- 若插件需要凭证，统一走本机加密凭证库，不写入插件目录。
