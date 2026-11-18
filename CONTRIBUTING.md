# 参与贡献 / Contributing to Super Work

> 欢迎模型厂商工程师、开源作者、独立开发者、设计师与研究者。无论你是修一个 typo、补一个 provider 适配器，还是提出新的编排协议，我们都欢迎。

## 1. 先选一种参与方式

| 方式 | 适合 | 入口 |
|---|---|---|
| 提问 / 讨论 | 使用问题、想法、选型 | [Discussions](https://github.com/zengpu987-ctrl/super-work/discussions) |
| 报 Bug | 可复现的问题 | Issues → Bug report |
| 提功能 | 新能力/大改 | Issues → Proposal（先讨论） |
| 改文档 | 使用说明、翻译、示例 | 直接 fork + PR，`good first issue` |
| 写代码 | Provider、UI、编排、测试 | fork + PR，见下方流程 |
| 共建 | 长期维护、厂商适配 | 在 Discussions 的「合作与招募」发自我介绍 |

## 2. 开发环境

要求：macOS / Linux（Web 端任意平台可跑）、Node.js ≥ 22、pnpm ≥ 9。

```bash
git clone https://github.com/zengpu987-ctrl/super-work.git
cd super-work
pnpm install
pnpm build:all      # tsc -b + vite build（会复制离线 three.js）
pnpm test           # 184+ 项单元/集成测试
pnpm dev            # 服务端 7788 + Vite 5178
```

- 本机数据目录默认 `~/.super-work`；跑测试/冒烟请用隔离目录：`SUPER_WORK_HOME=/tmp/sw-dev`。
- 没有 API Key 也能跑：内置 mock/演示模型。
- 提交前至少运行 `pnpm typecheck` 与 `pnpm test`。

## 3. 代码结构

```
packages/core         契约：类型、事件、模型目录、太阳位置、文件协议
packages/providers    各家模型适配器（OpenAI 兼容 / Anthropic / Gemini / 订阅 / mock）
packages/orchestrator 编排模式与运行时（并行/配合/Chat/议会/辩论/接力...）
packages/memory       记忆、上下文
packages/workflow     工作流
packages/files        文件解析
apps/server           Fastify HTTP/SSE、凭证、持久化、导出
apps/web              React 19 UI、3D 地球、样式
apps/mac              macOS 原生壳（WKWebView）
docs/                 设计、评测、使用说明、开放源码计划
paper/                中英双语论文与构建脚本
```

## 4. 提交规范

- 分支：`feat/<topic>`、`fix/<topic>`、`docs/<topic>`。
- Commit：`feat(scope): ...` / `fix(scope): ...` / `docs(scope): ...`，中文或英文均可。
- PR 必须说明：解决了什么、如何验证、是否有破坏性变更、截图（UI 变更）。
- 不提交任何真实 API Key、token、cookie、`.super-work` 数据或用户隐私。
- 新增 provider 请同时提交：目录条目、适配器、至少一个单测、`docs/MODELS.md` 更新。
- 依赖新增请说明许可证，并更新 `THIRD-PARTY-NOTICES.md`。

## 5. Review 与合并

- 至少 1 位维护者 approve；核心模块（orchestrator/server 持久化/凭证）需要 2 位。
- CI 必须绿：typecheck、test、web build。
- 维护者会在 7 天内给出首次反馈；大 PR 请先开 Proposal 讨论，避免白做。

## 6. 成为长期维护者

持续 3 个月、合并 ≥ 5 个有意义的 PR、熟悉至少一个子系统，可申请 `reviewer`；reviewer 稳定参与 2 个月后可提名 `maintainer`。详见 `GOVERNANCE.md`。

## 7. 许可证与署名

贡献即同意以 **Apache-2.0** 授权，并同意在 `NOTICE`/发布说明中署名（除非你要求匿名）。请保留文件头与第三方声明。

## English quick start

Fork → branch → `pnpm install && pnpm build:all && pnpm test` → PR with a clear problem statement, verification steps, and screenshots. English PRs and issues are welcome. Read `GOVERNANCE.md` for decision-making and `CODE_OF_CONDUCT.md` for community expectations.
