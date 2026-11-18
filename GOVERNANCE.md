# 治理 / Governance

## 目标

让 Super Work 成为一个**可长期演进、厂商中立、社区共建**的本地多模型工作台：任何人可以 fork、修改、分发；有贡献的人可以逐步获得评审与合并权限。

## 角色

| 角色 | 权限 | 产生方式 |
|---|---|---|
| User | 使用、提 issue/discussion | 任何人 |
| Contributor | fork、PR、文档、翻译 | 首个被合并的 PR |
| Reviewer | 评审 PR、triage issue | 维护者提名 + 2 位现有 reviewer 同意 |
| Maintainer | 合并、发布、仓库设置 | 现有 maintainer 2/3 同意 |
| Vendor liaison | 厂商模型/额度/协议对接 | 厂商或社区推荐，维护者确认 |

## 决策

- 日常改动：PR + 1 位 reviewer approve。
- 架构/协议/破坏性变更：先 Proposal issue，7 天讨论期，维护者多数同意。
- 许可证、治理、商标变更：2/3 maintainer 同意，并在 release notes 公示。
- 厂商适配：遵循「可插拔、不绑定单一厂商」原则；不接受排他性默认路由。

## 发布

- 语义化版本 `MAJOR.MINOR.PATCH`，当前 `0.0.x` 快速迭代。
- 每个 release：变更摘要、已知问题、升级说明、第三方声明更新。
- 安全修复走私下流程，发布后公开 advisory。

## 行为与利益冲突

- 遵守 `CODE_OF_CONDUCT.md`。
- 厂商雇员参与时需在 PR/issue 中披露所属关系；涉及自家模型评分的基准需公开方法。
- 维护者不得将社区资产用于排他性商业引流。

## 如何扩大参与（"人人可编辑"）

GitHub 不支持匿名直接写入；本项目的开放方式是：

1. **公共仓库 + Apache-2.0**：任何人可 fork、修改、再分发（保留 NOTICE）。
2. **Fork + PR**：任何 GitHub 账号都可提议修改；文档、翻译、示例同样欢迎。
3. **Wiki / Discussions**：用于协作笔记、FAQ、路线讨论（见 `docs/COMMUNITY.md`）。
4. **Codespaces / GitHub Web 编辑器**：无需本地环境即可改一行文档并发起 PR。
5. **信任升级**：持续贡献者可获得 reviewer / maintainer 写权限。
