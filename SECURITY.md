# 安全策略 / Security Policy

## 报告漏洞 / Reporting a Vulnerability

请**不要**在公开 issue 中披露安全漏洞或用户数据。使用 GitHub 仓库的 **Security → Advisories → Report a vulnerability**（私密公告），或在 Discussions 中联系维护者请求私下渠道。

报告请包含：

- 影响版本 / commit；
- 复现步骤与最小 PoC；
- 影响面（凭证泄漏、任意文件读写、SSRF、XSS、提权等）；
- 建议的修复方向（如有）。

我们会在 7 天内确认收到，30 天内给出修复计划；修复发布后经你同意再公开致谢。

## 安全边界

- 服务只监听 `127.0.0.1`，默认不对外网开放；如自行暴露端口，请加反向代理与鉴权。
- 凭证使用 AES-256-GCM 加密，密钥在 `~/.super-work/secret.key`（权限 600）。
- 本机复用只读 `~/.dsh/.credentials.yaml`，不会上传。
- 请不要在 issue/截图/日志中提交 API Key、Bearer token、cookie 或 `.super-work` 数据目录内容。
- 第三方模型/中转站会接收你发送的 prompt；请遵守各平台条款与数据合规要求。
