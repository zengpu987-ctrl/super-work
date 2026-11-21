# DSH 插件适配表（v0.0.5）

> 自动生成自 `GET /api/plugins`；36 项全部有可运行动作。

| 插件 | 版本 | 类型 | 状态 | 动作 | 能力 |
|---|---|---|---|---|---|
| `@liustack/modlens` | 3.27.2 | bridge | bridge-ready | 视觉读取 | 视觉读取（WorkBuddy 视觉模型） |
| `@local/dsh-arxiv` | 0.1.0 | bridge | bridge-ready | 检索 arXiv 论文 | arXiv 检索（官方 API 已接） |
| `@local/dsh-sci-plot` | 0.1.0 | bridge | bridge-ready | 绘制数据图 | 科研绘图（matplotlib PNG） |
| `@local/dsh-superman-ocr` | 0.1.0 | bridge | bridge-ready | OCR 识别 | OCR（WorkBuddy 视觉模型） |
| `@local/dsh-vision-complete` | 1.0.0 | bridge | bridge-ready | 识图 / OCR | 识图/OCR（WorkBuddy 视觉模型） |
| `dsh-ffmpeg` | 0.6.3 | bridge | bridge-ready | 检测 ffmpeg | 音视频剪辑/转码 |
| `dsh-github-router` | 0.4.1 | bridge | bridge-ready | 读取 GitHub 仓库文件 | GitHub 只读（API / raw，支持 token） |
| `dsh-hyperframes` | 0.7.0 | bridge | bridge-ready | 生成动效 HTML、能力说明 | 动效 HTML 生成（完整渲染需 DSH） |
| `dsh-image-gen` | 0.9.1 | bridge | bridge-ready | 生成图片 | 生图（WorkBuddy 图像模型，已适配） |
| `dsh-media-gen` | 0.1.4 | bridge | bridge-ready | 图片转视频 | 媒体合成（图片 → MP4，ffmpeg） |
| `dsh-remotion` | 0.6.0 | bridge | bridge-ready | 生成动效 HTML、能力说明 | 动效 HTML 生成（完整渲染需 DSH） |
| `dsh-wolfram` | 0.2.1 | bridge | bridge-ready | 科学计算 | Wolfram 计算（MCP） |
| `@local/dsh-kimi-subscription` | 0.1.0 | native | migrated | 打开能力 | Kimi 会员订阅通道 |
| `@local/dsh-superman` | 0.1.0 | native | migrated | 打开能力 | 文件/文献归档（记忆库附件已覆盖） |
| `dsh-connect-workbuddy` | 5.12.3 | native | migrated | 打开能力 | WorkBuddy 中转站（账号/模型/生图） |
| `dsh-context` | 0.77.0 | native | migrated | 打开能力 | 上下文洞察（每次调用组成） |
| `dsh-deepseek-web` | 1.1.1 | native | migrated | 打开能力 | DeepSeek 网页登录态复用 |
| `dsh-find-plugin` | 0.4.0 | native | migrated | 打开能力 | 插件中心（查看/测试/启停） |
| `dsh-hindsight-memory` | 0.1.7 | native | migrated | 打开能力 | 记忆召回（FTS + 注入） |
| `dsh-mnemon` | 0.5.36 | native | migrated | 打开能力 | 记忆系统（空间/条目/召回） |
| `dsh-tokenledger` | 0.1.0 | native | migrated | 打开能力 | 计费（用量/成本/CSV/DSH 账本导入） |
| `@local/dsh-cosmos-launch` | 1.5.1 | ui-only | adapted | 播放入场动画 | 入场动画（原生） |
| `@local/dsh-deep-connect` | 4.3.1 | unsupported | adapted | 跨机接力适配 | 跨机接力（宿主适配说明） |
| `@local/dsh-figurelabs` | 1.0.0 | ui-only | adapted | 能力说明 | 未分类（DSH 专属或待评估） |
| `@local/dsh-github-forum` | 0.1.0 | ui-only | linked | 打开 GitHub 讨论 | GitHub 讨论入口 |
| `@local/dsh-theme-market` | 0.1.0 | ui-only | adapted | 切换主题 | 主题市场（玻璃/极光/森林） |
| `@local/dsh-tools-settings` | 0.2.0 | ui-only | adapted | 打开设置 | 工具设置（Super Work 设置页） |
| `@local/dsh-wolfram-longrun` | 0.1.0 | ui-only | adapted | 能力说明 | 未分类（DSH 专属或待评估） |
| `@xmanrui/dsh-im` | 5.7.0 | unsupported | adapted | Webhook 通知 | IM 通知（Webhook） |
| `dsh-better-sidebar` | 0.28.2 | ui-only | adapted | 侧栏布局 | 侧栏增强（自适应布局） |
| `dsh-claude-style` | 0.19.5 | ui-only | adapted | 衬线阅读风格 | 阅读风格（科学衬线/无衬线） |
| `dsh-im` | 1.0.5 | unsupported | adapted | Webhook 通知、能力说明 | IM 通知（Webhook） |
| `dsh-pet-indesktop` | 0.5.0-summon.2 | ui-only | adapted | Jarvis 悬浮球 | Jarvis 悬浮球（原生） |
| `dsh-wallpaper-bg` | 0.5.13 | ui-only | adapted | 更换背景 | 动态壁纸（极光/森林背景） |
| `dsh-wechat-daily` | 0.1.0 | unsupported | adapted | 生成日报 Markdown | 日报 Markdown 生成 |
| `dshmarket` | 1.70.2 | ui-only | linked | 打开插件市场 | 插件市场（npm 搜索入口） |
