#!/usr/bin/env node
/**
 * 一键启动：构建（如需要）→ 启动服务 → 等健康检查通过 → 打开浏览器。
 * 用法：node scripts/start.mjs [--port 7788] [--no-open]
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? Number(args[portArg + 1]) : 7788;
const noOpen = args.includes("--no-open");

function sh(command, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: root, stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

const needBuild = !fs.existsSync(path.join(root, "apps/server/dist/index.js"));
const needWeb = !fs.existsSync(path.join(root, "apps/web/dist/index.html"));

if (!fs.existsSync(path.join(root, "node_modules"))) {
  console.log("首次运行，安装依赖…");
  await sh("pnpm", ["install"]);
}
if (needBuild) {
  console.log("编译 TypeScript…");
  await sh("pnpm", ["build"]);
}
if (needWeb) {
  console.log("构建前端…");
  await sh("pnpm", ["build:web"]);
}

const server = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, SUPER_WORK_PORT: String(port) },
});

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const ok = await waitForHealth();
if (!ok) {
  console.error("服务启动失败（健康检查超时）");
  server.kill("SIGTERM");
  process.exit(1);
}

const url = `http://127.0.0.1:${port}`;
console.log(`\nSuper Work 已就绪：${url}\n`);
if (!noOpen) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {});
}

const shutdown = () => {
  server.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("exit", (code) => process.exit(code ?? 0));
