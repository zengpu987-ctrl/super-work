# Super Work · macOS 应用

把本机工作台打包成原生 Mac 应用：Swift + WKWebView 外壳，**不引入任何 npm 依赖**，
启动后是一个有 Dock 图标、独立窗口的应用，而不是浏览器标签页或终端窗口。

- 产品名：`Super Work`
- Bundle ID：`com.superwork.app`
- 版本：`0.0.2`
- 产物：`apps/mac/build/Super Work.app`
- 系统要求：macOS 13+、Node.js 22+；构建还需要 Xcode Command Line Tools（`swiftc`）

## 构建

```bash
bash apps/mac/build.sh          # → apps/mac/build/Super Work.app
bash apps/mac/build.sh --open   # 构建完立即启动
```

构建是幂等的：每次重建 `.app`，不修改仓库里其它文件；最后会做 ad-hoc 签名与
`codesign --verify`。首次构建若 `resources/AppIcon.icns` 缺失，会尝试用
`make-icon.py`（需要 Pillow）重新生成，失败则退回系统默认图标。

## 启动行为

1. 先探测 `http://127.0.0.1:7788/api/health`（最多重试 3 次，避免和开发服务器重启抢跑）；
2. **已在运行 → 直接复用**，退出应用时**不会**终止它；
3. 没在运行 → 用绝对路径 Node 执行 `scripts/start.mjs --no-open --port 7788`，
   轮询健康检查后载入界面；首次启动可能需要安装依赖/编译，最多等 5 分钟；
4. 退出应用（⌘Q、⌘W、`kill -TERM`、`kill -INT`）只结束**自己拉起**的 node 进程。

界面支持：⌘R 重新载入、⇧⌘R 重启服务、⌃⌘F 全屏、⌘= / ⌘- / ⌘0 缩放、⌘W 关闭、⌘Q 退出。
默认窗口 1440×900（屏幕不够时按可视区域缩放），最小 1024×700。

## 首次启动会发生什么

第一次双击 `.app` 时（仓库里还没有构建产物的情况下），启动会比平时慢：

1. **先探测** `http://127.0.0.1:7788/api/health`；没有服务才继续下面的步骤；
2. 如果需要，`scripts/start.mjs` 会依次执行：
   - `pnpm install`（仅当 `node_modules/` 不存在时）；
   - `pnpm build`（编译 TypeScript：core / providers / orchestrator / server 等）；
   - `pnpm build:web`（Vite 构建前端，生成 `apps/web/dist`）；
   - 然后启动本机服务并等待健康检查通过。
3. 前端构建 + TypeScript 编译在普通机器上通常 **1~3 分钟**，冷启动最多可能到 **5 分钟**；
   加载窗口会显示已等待的秒数，超过 5 分钟会弹出失败提示并可直接打开日志。
4. 就绪后窗口自动载入工作台。

环境与数据：

- **运行**需要 **Node.js 22+**（应用会依次尝试 `/Users/zp/bin/node`、`/opt/homebrew/bin/node`、
  `/usr/local/bin/node`、登录 shell、`/usr/bin/env node`，也可用 `SUPER_WORK_NODE` 指定）。
- **首次构建**还需要 `pnpm` 在 PATH 里（构建脚本会把构建机的 node/pnpm 目录写进 `.app` 作为提示）。
  Xcode Command Line Tools 只有**重新构建应用本身**时才需要，运行 `.app` 不需要。
- 服务端数据在 **`~/.super-work/`**：`config.json`、`super-work.db`、`secret.key`
  （凭证 AES-256-GCM 加密，只留在本机）。
- 应用自己的配置与日志：
  - 配置：`~/Library/Application Support/SuperWork/config.json`（端口 / 仓库路径 / Node 路径覆盖）
  - 日志：`~/Library/Logs/SuperWork/app.log`（外壳：复用/拉起/加载/退出）
    与 `~/Library/Logs/SuperWork/server.log`（服务端 stdout/stderr，含首次构建输出）

## 开机自启（登录项）

两种方式任选其一：

1. **系统设置**：`系统设置 → 通用 → 登录项与扩展 → 登录时打开`，点 `+` 选择
   `Super Work.app`（放在 `/Applications` 或 `apps/mac/build/` 都可以）；
2. **Dock**：把 `Super Work.app` 拖进 Dock，右键应用图标 → `选项` → 勾选
   `登录时打开`。

登录后应用会自动探测/拉起本机服务并显示工作台窗口。注意：

- 不要再把仓库根目录的 `启动 Super Work.command` 也加入登录项，否则会出现两个启动入口
  （应用会复用已运行的服务，但没必要）。
- 如果希望开机后**不弹出窗口**、只后台跑服务，当前版本不支持静默启动；`⌘Q` 会同时停止
  应用自己拉起的服务。需要常驻后台请用 launchd 自行跑 `node apps/server/dist/index.js`。
- 登录项依赖仓库目录存在（或 `config.json` 里配置了正确的 `root`），移动目录后要重新指定。

## 安装到 /Applications

1. 构建：`bash apps/mac/build.sh`
2. 打开 `apps/mac/build/`，把 **Super Work.app** 拖到 `/Applications`（或拖进 Dock）；
3. 首次打开如果被 Gatekeeper 拦（本构建未做开发者签名/公证），右键 → 打开，或在
   「系统设置 → 隐私与安全性」里点「仍要打开」。

> 应用内保存了构建时的仓库绝对路径。**移动仓库目录**（或把应用拷到别的 Mac）后，
> 需要用下面的配置覆盖重新指定 `root`，否则会提示找不到 `scripts/start.mjs`。

## 配置覆盖

优先级：**环境变量 > `config.json` > 构建时写入的兜底值 > 自动探测**。

环境变量（临时、脚本化场景）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `SUPER_WORK_ROOT` | 仓库根目录 | 构建时记录 / 应用向上探测 |
| `SUPER_WORK_PORT` | 服务端口 | `7788` |
| `SUPER_WORK_NODE` | `node` 可执行文件绝对路径 | 自动探测（`/Users/zp/bin/node`、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、登录 shell、`/usr/bin/env node`） |

Finder 双击启动时环境变量不一定透传，推荐改用户配置：

`~/Library/Application Support/SuperWork/config.json`

```json
{
  "root": "/Users/you/super-work",
  "port": 7788,
  "node": "/opt/homebrew/bin/node"
}
```

改完重启应用生效。在终端里也可以直接带环境变量运行可执行文件：

```bash
SUPER_WORK_PORT=7799 "apps/mac/build/Super Work.app/Contents/MacOS/SuperWork"
```

## 日志与排查

| 文件 | 内容 |
|---|---|
| `~/Library/Logs/SuperWork/app.log` | 外壳事件：复用/拉起/健康检查/界面加载/退出 |
| `~/Library/Logs/SuperWork/server.log` | 服务端 stdout / stderr（含编译错误） |

菜单 **Super Work → 打开日志目录 / 打开项目目录** 可直接跳转。

常见问题：

- **提示找不到 Node**：`node -v` 确认已安装 22+；或用 `config.json` 的 `node` 指向绝对路径。
- **端口被占用**：应用会先复用健康服务；若占用者不是 Super Work，改 `port` 后重启。
- **启动超时**：看 `server.log`；手动 `pnpm install && pnpm build && pnpm build:web` 后可秒启动。
- **窗口空白**：菜单 ⇧⌘R 重新拉起服务；必要时看 Web Inspector（Safari → 开发 → 该应用）。

## 卸载

1. **退出应用**：`⌘Q`（会停止应用自己拉起的服务；复用的外部服务不会被杀）；
2. **移除登录项**：系统设置 → 通用 → 登录项与扩展，选中 Super Work 点 `−`；
   Dock 里的图标右键 → 选项 → 取消「登录时打开」；
3. **删除应用**：从 `/Applications`（或 Dock）删除 `Super Work.app`，
   Dock 图标右键 → 选项 → 从 Dock 中移除；
4. **可选清理应用壳自己的配置与日志**（不影响服务端数据）：

```bash
rm -rf ~/Library/Application\ Support/SuperWork ~/Library/Logs/SuperWork
```

5. **服务端数据**在 `~/.super-work/`（`config.json` / `super-work.db` / `secret.key` /
   `artifacts/`），与项目目录一样**不会**被卸载步骤删除；确认不再使用后可手动：

```bash
rm -rf ~/.super-work
```

卸载后确认没有残留：

```bash
pgrep -fl "Super Work.app" || echo "应用已退出"
lsof -nP -iTCP:7788 -sTCP:LISTEN || echo "服务已停止"
```

如果 7788 仍有非 Super Work 的进程占用，按需处理（应用本身已不会在后台运行）。

## 目录结构

```
apps/mac/
├── build.sh                 # 一键构建（swiftc + Info.plist + 图标 + ad-hoc 签名）
├── src/                     # Swift 源码
│   ├── main.swift           # 入口
│   ├── AppDelegate.swift    # 窗口 / 菜单 / 启动流程 / WKWebView 导航策略
│   ├── AppConfig.swift      # 路径、配置覆盖、Node/仓库探测、运行日志
│   ├── ServerController.swift # 探测复用、拉起服务、健康检查、退出清理
│   └── LoadingPage.swift    # 启动/失败加载页（纯内联 HTML，无外部资源）
├── resources/
│   ├── Info.plist           # Bundle 元数据 + ATS localhost 例外
│   ├── AppIcon.icns         # 生成好的图标（深底 + 渐变 S）
│   ├── icon-preview.png     # 1024 预览
│   └── make-icon.py         # 图标生成脚本（Pillow）
└── build/                   # 构建产物（不进 git）
```

## 已知限制

- **不是自包含运行时**：依赖本机 Node 22+ 与仓库目录（或配置 `root`）；没有把 Node 与
  `node_modules` 打进 `.app`。
- **未做 Apple 公证**：ad-hoc 签名只适合本机自用；拷到别的 Mac 会被 Gatekeeper 拦截，
  需要 `xattr -dr com.apple.quarantine` 或重新签名。
- **未启用 App Sandbox**：因此读写仓库与 `~/.super-work` 不受沙箱限制；
  `Info.plist` 里只加 `NSAllowsLocalNetworking`（ATS）放行 `127.0.0.1` 的 HTTP。
  应用内不加载任何外部页面或 CDN；点到的外部链接（如 OAuth）交给系统浏览器打开。
