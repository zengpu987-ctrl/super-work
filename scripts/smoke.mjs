#!/usr/bin/env node
/**
 * 端到端冒烟测试：起一个隔离实例（独立数据目录 + 独立端口），
 * 用演示模型跑一次"议会"模式，校验流式事件与最终答案。
 * 不联网、不需要任何 API key。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "super-work-smoke-"));
const port = 7790 + Math.floor(Math.random() * 60);
const base = `http://127.0.0.1:${port}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitFor(predicate, timeoutMs = 15000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: root,
  env: { ...process.env, SUPER_WORK_HOME: home, SUPER_WORK_PORT: String(port), NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (b) => process.env.SMOKE_VERBOSE && process.stdout.write(b));
child.stderr.on("data", (b) => process.env.SMOKE_VERBOSE && process.stderr.write(b));

function cleanup() {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => fs.rmSync(home, { recursive: true, force: true }), 200);
}

try {
  console.log("① 启动隔离实例");
  const up = await waitFor(async () => {
    const res = await fetch(`${base}/api/health`);
    return res.ok;
  });
  check("服务健康检查", up);
  if (!up) throw new Error("服务未启动");

  console.log("② 检查模型目录");
  const models = await (await fetch(`${base}/api/models`)).json();
  const mockAvailable = models.models.filter((m) => m.provider === "mock" && m.available);
  check("演示模型可用", mockAvailable.length >= 2, `找到 ${mockAvailable.length} 个`);
  check("模型目录覆盖 11 家", new Set(models.models.map((m) => m.provider)).size >= 11);

  console.log("③ 发起一次议会式联合运行（演示模型）");
  const created = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "用三句话说明多模型联合工作的价值，并给出一个可落地的团队用法。",
      mode: "council",
      participants: [
        { provider: "mock", model: "mock-fast", role: "深度分析" },
        { provider: "mock", model: "mock-thinker", role: "长文与代码" },
        { provider: "mock", model: "mock-fast", role: "风险审查" },
      ],
      options: { critique: false, synthesize: true },
    }),
  });
  check("创建运行返回 201", created.status === 201, `实际 ${created.status}`);
  const createdBody = await created.json();
  const runId = createdBody.id;
  check("返回 runId", typeof runId === "string" && runId.startsWith("run_"));

  console.log("④ 订阅流式事件");
  const eventTypes = [];
  const texts = new Map();
  let finalText = "";
  const reader = await fetch(`${base}/api/runs/${runId}/stream`);
  check("SSE 状态 200", reader.status === 200);
  const decoder = new TextDecoder();
  let buffer = "";
  const stream = reader.body.getReader();
  const deadline = Date.now() + 45000;
  outer: while (Date.now() < deadline) {
    const { done, value } = await stream.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      let payload;
      try {
        payload = JSON.parse(dataLine.slice(6));
      } catch {
        continue;
      }
      const ev = payload.type === "snapshot" ? { type: "snapshot" } : payload.event;
      eventTypes.push(ev.type);
      if (ev.type === "model.delta") {
        texts.set(ev.participantId, (texts.get(ev.participantId) ?? "") + ev.text);
      }
      if (ev.type === "final") {
        finalText = ev.text;
      }
      if (ev.type === "run.done") break outer;
    }
  }
  stream.cancel().catch(() => {});

  check("收到 snapshot", eventTypes.includes("snapshot"));
  check("收到 run.start", eventTypes.includes("run.start"));
  check("所有参与者都有 model.start", eventTypes.filter((t) => t === "model.start").length >= 3);
  check("流式 delta 数量充足", eventTypes.filter((t) => t === "model.delta").length >= 20);
  check("所有参与者都有 model.done", eventTypes.filter((t) => t === "model.done").length >= 3);
  check("收到 run.done", eventTypes.includes("run.done"));
  check("最终答案非空", finalText.length > 40, `长度 ${finalText.length}`);
  check("参与者输出都有内容", [...texts.values()].filter((t) => t.length > 10).length >= 3);

  console.log("⑤ 回读运行详情与历史");
  const detail = await (await fetch(`${base}/api/runs/${runId}`)).json();
  check("详情状态 done", detail.status === "done", detail.status);
  check("详情有最终答案", (detail.finalText ?? "").length > 40);
  check("详情含 usage", detail.usage && Number(detail.usage.outputTokens ?? 0) > 0);
  const list = await (await fetch(`${base}/api/runs?limit=5`)).json();
  check("运行历史可读", Array.isArray(list) && list.length >= 1 && list[0].id === runId);

  console.log("⑥ 检查设置与 provider 状态");
  const providers = await (await fetch(`${base}/api/providers`)).json();
  check("provider 列表含 12 项", providers.length >= 12, `实际 ${providers.length}`);
  check("provider 状态含本机可复用发现", providers.every((p) => Array.isArray(p.localAccounts)));
  const settings = await (await fetch(`${base}/api/settings`)).json();
  check("设置可读", typeof settings.allowLocalReuse === "boolean");

  console.log(failures === 0 ? "\n冒烟测试全部通过 🎉" : `\n冒烟测试失败 ${failures} 项`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  console.error("\n冒烟测试异常：", error);
  cleanup();
  process.exit(1);
}
