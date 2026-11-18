#!/usr/bin/env node
/**
 * 开发模式：先做一次完整编译，然后并行起
 *   1) tsc -b --watch（packages + server 类型与产物）
 *   2) tsx watch 服务端（7788）
 *   3) vite 前端（5178，代理 /api 到 7788）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

function run(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" },
    ...options,
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null && !shuttingDown) {
      console.error(`[dev] ${label} 退出（code ${code}）`);
    }
  });
  children.push({ label, child });
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 300);
}

let shuttingDown = false;
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

import { execFileSync } from "node:child_process";
try {
  execFileSync(process.execPath, [path.join(root, "scripts/prepare-web.mjs")], { stdio: "inherit" });
} catch {
  console.warn("[dev] three.js 离线资源准备失败（3D 预览可能不可用）");
}

console.log("[dev] 首次编译 packages + server …");
const build = spawn("pnpm", ["exec", "tsc", "-b"], { cwd: root, stdio: "inherit" });
build.on("exit", (code) => {
  if (code !== 0) {
    console.error("[dev] 编译失败，修复后重新运行 pnpm dev");
    process.exit(code ?? 1);
  }
  console.log("[dev] 编译完成，启动服务端与前端 …");
  run("server", "pnpm", ["exec", "tsx", "watch", "apps/server/src/index.ts"]);
  run("web", "pnpm", ["exec", "vite", "--config", "apps/web/vite.config.ts"]);
  run("tsc-watch", "pnpm", ["exec", "tsc", "-b", "--watch", "--preserveWatchOutput"]);
});
