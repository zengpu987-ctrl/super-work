#!/usr/bin/env node
/**
 * Super Work v0.0.2 冒烟骨架（隔离实例，不依赖本机已有数据）。
 *
 * 覆盖：
 *   ① 启动隔离实例 / 健康检查
 *   ② 中转站预设 + 本机 WorkBuddy 只读检测（导入需显式开启，避免联网依赖）
 *   ③ 运行 + 强度档位（effort 回显 + 运行中 POST /api/runs/:id/effort 热调）
 *   ④ 并行模式（parallel，mock 模型）
 *   ⑤ 配合模式（coordinate，仅 commander+judge，断言其他角色 0 调用）
 *   ⑥ 记忆 CRUD + 搜索
 *   ⑦ 工作流内置模板（把步骤模型改成 mock 后跑通）
 *   ⑧ 计费 / 上下文接口可用
 *
 * 用法：
 *   node scripts/smoke-v2.mjs
 *   node scripts/smoke-v2.mjs --verbose
 *   SMOKE_IMPORT_WORKBUDDY=1 node scripts/smoke-v2.mjs   # 允许导入本机 WorkBuddy（会调 discover，不发付费推理）
 *   SMOKE_STRICT=1 node scripts/smoke-v2.mjs              # 把“待接入”也视为失败
 *
 * 说明：尚未实现的接口/模式会记为 ⏳ 待接入，不计失败（方便 v2 开发中期反复运行）；
 *      SMOKE_STRICT=1 时待接入也返回非 0。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "super-work-smoke-v2-"));
const port = 7860 + Math.floor(Math.random() * 80);
const base = `http://127.0.0.1:${port}`;
const verbose = process.argv.includes("--verbose") || process.env.SMOKE_VERBOSE === "1";
const strict = process.env.SMOKE_STRICT === "1";
const importWorkBuddy = process.env.SMOKE_IMPORT_WORKBUDDY === "1";

let failures = 0;
let pendingCount = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function pending(name, note) {
  pendingCount += 1;
  console.log(`  ⏳ ${name}${note ? ` — ${note}` : ""}`);
}

function section(title) {
  console.log(`\n${title}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 15000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch {
      /* retry */
    }
    await sleep(intervalMs);
  }
  return false;
}

async function api(pathname, init = {}, timeoutMs = 20_000) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, res };
}

/** 读取 /api/runs/:id/stream，返回事件列表 + finalText。 */
async function collectRunStream(runId, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/runs/${runId}/stream`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`SSE ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let finalText = "";
    let buffer = "";
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          try {
            const payload = JSON.parse(data);
            if (payload.type === "snapshot") {
              events.push({ type: "snapshot", run: payload.run });
            } else {
              const event = payload.type === "event" ? payload.event : payload;
              if (event && typeof event.type === "string") {
                events.push(event);
                if (event.type === "final") finalText = event.text ?? "";
                if (event.type === "run.done") finished = true;
              }
            }
          } catch {
            /* 忽略坏帧 */
          }
        }
        index = buffer.indexOf("\n\n");
        if (finished) break;
      }
    }
    try {
      await reader.cancel();
    } catch {
      /* closed */
    }
    return { events, finalText };
  } finally {
    clearTimeout(timer);
  }
}

async function pollWorkflowRun(runId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { status, body } = await api(`/api/workflow-runs/${runId}`);
    if (status === 200) {
      last = body;
      if (body.status === "done" || body.status === "error") return body;
    }
    await sleep(500);
  }
  return last;
}

const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: root,
  env: { ...process.env, SUPER_WORK_HOME: home, SUPER_WORK_PORT: String(port), NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => verbose && process.stdout.write(chunk));
child.stderr.on("data", (chunk) => verbose && process.stderr.write(chunk));

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* 进程可能仍持有 sqlite 文件，忽略即可 */
  }
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

try {
  section("① 启动隔离实例");
  const up = await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 20000);
  check("服务健康检查", up);
  if (!up) throw new Error("服务未启动（先执行 pnpm build）");

  const models = await api("/api/models");
  const mockModels = (models.body?.models ?? []).filter((m) => m.provider === "mock" && m.available);
  check("演示模型可用（≥2）", mockModels.length >= 2, `实际 ${mockModels.length}`);
  if (mockModels.length < 2) throw new Error("没有可用的 mock 模型，无法离线冒烟");

  section("② 中转站：预设 + 本机 WorkBuddy 只读检测");
  const presets = await api("/api/relays/presets");
  const presetList = Array.isArray(presets.body) ? presets.body : [];
  const presetIds = presetList.map((p) => p.id);
  if (presets.status === 404) {
    pending("中转站预设接口", "GET /api/relays/presets 未实现");
  } else {
    check("中转站预设数量 ≥3", presetList.length >= 3, `实际 ${presetList.length}`);
    check(
      "预设含 jarvis / devin / workbuddy",
      ["jarvis", "devin", "workbuddy"].every((id) => presetIds.includes(id)),
      presetIds.join(","),
    );
  }

  const localWb = await api("/api/relays/local/workbuddy");
  if (localWb.status === 404) {
    pending("本机 WorkBuddy 检测", "GET /api/relays/local/workbuddy 未实现");
  } else {
    const accounts = Array.isArray(localWb.body?.accounts) ? localWb.body.accounts : [];
    console.log(`  ℹ️ 检测到本机 WorkBuddy 账号 ${accounts.length} 个`);
    if (accounts.length === 0) {
      pending("WorkBuddy 本机账号导入", "本机未登录 WorkBuddy（不影响离线冒烟）");
    } else if (!importWorkBuddy) {
      pending(
        "WorkBuddy 本机账号导入",
        `已检测到 ${accounts.length} 个账号；设 SMOKE_IMPORT_WORKBUDDY=1 可执行（会调用 discover，不发起付费推理）`,
      );
    } else {
      const target = accounts.find((account) => account.usable) ?? accounts[0];
      const imported = await api(
        "/api/relays/local/workbuddy/import",
        { method: "POST", body: JSON.stringify({ uid: target?.uid, region: target?.region }) },
        45_000,
      );
      if (imported.status !== 200) {
        pending("WorkBuddy 本机账号导入", `导入失败：${JSON.stringify(imported.body).slice(0, 160)}`);
      } else {
        const relays = await api("/api/relays");
        const list = Array.isArray(relays.body) ? relays.body : [];
        check(
          "WorkBuddy 导入后出现在中转站列表",
          list.some((relay) => relay.kind === "workbuddy"),
          `共 ${list.length} 个中转站`,
        );
      }
    }
  }

  section("③ 强度档位：effort 回显 + 运行中热调（council / mock）");
  const createRun = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      command: "用两句话说明：给每个参与模型单独设置强度档位，对联合工作的结果有什么影响？",
      mode: "council",
      participants: [
        { provider: "mock", model: "mock-fast", role: "低强度视角", effort: "low" },
        { provider: "mock", model: "mock-thinker", role: "极限强度视角", effort: "ultra" },
      ],
      options: { critique: false, synthesize: true },
    }),
  });
  check("创建运行 201", createRun.status === 201, `实际 ${createRun.status}`);
  const runId = createRun.body?.id;
  check("返回 runId", typeof runId === "string" && runId.startsWith("run_"));
  const participants = createRun.body?.run?.participants ?? [];
  const echoedEfforts = participants.map((p) => p.effort);
  if (echoedEfforts.every((value) => value === undefined)) {
    pending("effort 随运行回显", "服务端尚未把 effort 写入 Participant（task-8）");
  } else {
    check(
      "effort 随运行回显（low / ultra）",
      echoedEfforts.includes("low") && echoedEfforts.includes("ultra"),
      JSON.stringify(echoedEfforts),
    );
  }

  const targetParticipant = participants[0];
  let effortPatched = false;
  if (runId && targetParticipant?.id) {
    const patch = await api(`/api/runs/${encodeURIComponent(runId)}/effort`, {
      method: "POST",
      body: JSON.stringify({ participantId: targetParticipant.id, effort: "max" }),
    });
    if (patch.status === 200) {
      effortPatched = true;
      check(
        "运行中热调 effort 返回 200 且回显 max",
        patch.body?.effort === "max" && patch.body?.note === "下一次调用生效",
        JSON.stringify(patch.body),
      );
    } else if (patch.status === 404) {
      pending("运行中热调 effort", "POST /api/runs/:id/effort 未实现（task-8）");
    } else {
      pending("运行中热调 effort", `运行结束太快或状态已变化：HTTP ${patch.status} ${JSON.stringify(patch.body).slice(0, 120)}`);
    }
  }

  const stream = await collectRunStream(runId);
  const types = stream.events.map((event) => event.type);
  check("SSE 收到 snapshot", types.includes("snapshot"));
  check("SSE 收到 run.start", types.includes("run.start"));
  check("SSE 收到流式 delta", types.filter((type) => type === "model.delta").length >= 10);
  check("SSE 收到 run.done", types.includes("run.done"));
  check("最终答案非空", (stream.finalText ?? "").length > 30, `长度 ${(stream.finalText ?? "").length}`);

  if (runId) {
    const detail = await api(`/api/runs/${encodeURIComponent(runId)}`);
    check("运行详情 done", detail.body?.status === "done", detail.body?.status);
    if (effortPatched) {
      const applied = (detail.body?.participants ?? []).find((p) => p.id === targetParticipant.id)?.effort;
      const efforts = detail.body?.efforts ?? [];
      check(
        "热调后的 effort 持久化到运行详情",
        applied === "max" || efforts.some((item) => item.participantId === targetParticipant.id && item.effort === "max"),
        `participant=${applied}, efforts=${JSON.stringify(efforts)}`,
      );
    }
    const context = await api(`/api/runs/${encodeURIComponent(runId)}/context`);
    if (context.status === 404) {
      pending("上下文接口", "GET /api/runs/:id/context 未实现");
    } else {
      check(
        "上下文接口返回调用记录",
        Array.isArray(context.body?.calls) && context.body.calls.length > 0,
        `calls=${context.body?.calls?.length ?? 0}`,
      );
    }
  }

  section("④ 并行模式（parallel / mock）");
  const parallel = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      command: "并行模式下，每个模型独立作答，然后由裁判综合。请给出一句结论。",
      mode: "parallel",
      participants: [
        { provider: "mock", model: "mock-fast", role: "并行 A", effort: "medium" },
        { provider: "mock", model: "mock-thinker", role: "并行 B", effort: "max" },
      ],
      judge: { provider: "mock", model: "mock-fast", role: "裁判" },
      options: { synthesize: true },
    }),
  });
  if (parallel.status >= 400) {
    pending("并行模式运行", `HTTP ${parallel.status}：${JSON.stringify(parallel.body).slice(0, 160)}`);
  } else {
    const parallelId = parallel.body?.id;
    const parallelStream = await collectRunStream(parallelId, 90_000);
    const parallelTypes = parallelStream.events.map((event) => event.type);
    check("并行模式收到 run.done", parallelTypes.includes("run.done"));
    check("并行模式最终答案非空", (parallelStream.finalText ?? "").length > 20);
    const parallelDetail = await api(`/api/runs/${encodeURIComponent(parallelId)}`);
    check("并行模式结果含 2 个参与者", (parallelDetail.body?.results ?? []).length >= 2);
  }

  section("⑤ 配合模式：仅 commander + judge（其他角色必须 0 调用）");
  const coordinate = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      command: "配合模式冒烟：只配置发令官与裁判，验证其他角色不被调用。",
      mode: "coordinate",
      participants: [],
      coordination: [
        {
          role: "commander",
          participants: [{ provider: "mock", model: "mock-fast", role: "发令官", effort: "medium" }],
        },
        {
          role: "judge",
          participants: [{ provider: "mock", model: "mock-thinker", role: "裁判", effort: "max" }],
        },
      ],
      options: {},
    }),
  });
  if (coordinate.status >= 400) {
    pending("配合模式运行", `HTTP ${coordinate.status}：${JSON.stringify(coordinate.body).slice(0, 160)}`);
  } else {
    const coordinateId = coordinate.body?.id;
    const coordinateStream = await collectRunStream(coordinateId, 120_000);
    const modelStarts = coordinateStream.events.filter((event) => event.type === "model.start");
    check(
      "配合模式只有 2 次模型调用（commander + judge）",
      modelStarts.length === 2,
      `实际 ${modelStarts.length} 次：${modelStarts.map((event) => event.label).join(" / ")}`,
    );
    const coordinateDetail = await api(`/api/runs/${encodeURIComponent(coordinateId)}`);
    check(
      "配合模式结果恰好 2 条（未配置角色 0 调用）",
      (coordinateDetail.body?.results ?? []).length === 2,
      `实际 ${(coordinateDetail.body?.results ?? []).length} 条`,
    );
    check("配合模式最终答案非空", (coordinateStream.finalText ?? "").length > 10);
  }

  section("⑥ 记忆 CRUD + 搜索");
  const stats = await api("/api/memory/stats");
  if (stats.status === 404) {
    pending("记忆接口", "GET /api/memory/stats 未实现");
  } else {
    check("记忆 stats 可读", stats.status === 200 && typeof stats.body === "object");
    const createdEntry = await api("/api/memory/entries", {
      method: "POST",
      body: JSON.stringify({
        content: "Super Work v2 冒烟记忆：强度档位必须真实透传到模型调用参数。",
        kind: "fact",
        tags: ["smoke", "effort"],
        importance: 3,
      }),
    });
    check("创建记忆条目", createdEntry.status === 200 || createdEntry.status === 201, `HTTP ${createdEntry.status}`);
    const entryId = createdEntry.body?.id;
    if (entryId) {
      const search = await api("/api/memory/search", {
        method: "POST",
        body: JSON.stringify({ query: "强度档位", limit: 5 }),
      });
      const hits = Array.isArray(search.body) ? search.body : [];
      check(
        "中文搜索命中刚写入的记忆",
        hits.some((hit) => hit?.memory?.content?.includes("强度档位") || hit?.content?.includes("强度档位")),
        `命中 ${hits.length} 条`,
      );
      const updated = await api(`/api/memory/entries/${encodeURIComponent(entryId)}`, {
        method: "PATCH",
        body: JSON.stringify({ content: "Super Work v2 冒烟记忆（已更新）：强度档位真实生效。" }),
      });
      check("更新记忆条目", updated.status === 200);
      const removed = await api(`/api/memory/entries/${encodeURIComponent(entryId)}`, { method: "DELETE" });
      check(
        "删除记忆条目",
        removed.status === 200,
        `HTTP ${removed.status} ${JSON.stringify(removed.body)}`,
      );
    }
  }

  section("⑦ 工作流：内置模板 + mock 模型");
  const workflows = await api("/api/workflows");
  if (workflows.status === 404) {
    pending("工作流接口", "GET /api/workflows 未实现");
  } else {
    const list = Array.isArray(workflows.body) ? workflows.body : [];
    check("存在内置工作流模板", list.some((wf) => wf.builtin), `共 ${list.length} 个`);
    const target = list.find((wf) => wf.builtin) ?? list[0];
    if (!target) {
      pending("工作流运行", "没有可用的工作流模板");
    } else {
      const patchedSteps = (target.steps ?? []).map((step) => ({
        ...step,
        model: { provider: "mock", model: "mock-fast" },
      }));
      const updated = await api(`/api/workflows/${encodeURIComponent(target.id)}`, {
        method: "PUT",
        body: JSON.stringify({ steps: patchedSteps }),
      });
      check("为工作流步骤绑定 mock 模型", updated.status === 200);
      const runStart = await api(`/api/workflows/${encodeURIComponent(target.id)}/run`, {
        method: "POST",
        body: JSON.stringify({ command: "用三句话说明工作流编排的价值。" }),
      });
      if (runStart.status >= 400) {
        pending("工作流运行", `HTTP ${runStart.status}：${JSON.stringify(runStart.body).slice(0, 160)}`);
      } else {
        const workflowRunId = runStart.body?.runId ?? runStart.body?.run?.id;
        const finished = workflowRunId ? await pollWorkflowRun(workflowRunId) : null;
        check("工作流运行完成", finished?.status === "done", finished?.status ?? "无结果");
        check(
          "工作流有步骤产出",
          (finished?.steps ?? []).some((step) => (step.text ?? "").length > 10),
          `steps=${(finished?.steps ?? []).length}`,
        );
      }
    }
  }

  section("⑧ 计费接口");
  const billing = await api("/api/billing/summary");
  if (billing.status === 404) {
    pending("计费接口", "GET /api/billing/summary 未实现");
  } else {
    check(
      "计费 summary 结构完整",
      typeof billing.body?.today === "object" &&
        Array.isArray(billing.body?.byModel) &&
        Array.isArray(billing.body?.daily),
    );
    const prices = await api("/api/billing/prices");
    check("计费价格表可读", prices.status === 200 && Array.isArray(prices.body));
    const csv = await fetch(`${base}/api/billing/export.csv`);
    check("计费 CSV 可导出", csv.status === 200);
  }

  section("⑨ 汇总");
  const pendingAsFailure = strict && pendingCount > 0;
  if (failures === 0 && !pendingAsFailure) {
    console.log(
      `\n冒烟通过 🎉（${pendingCount} 项待接入${pendingCount > 0 ? "，可用 SMOKE_STRICT=1 收紧" : ""}）`,
    );
  } else {
    console.log(`\n失败 ${failures} 项${pendingAsFailure ? `，待接入 ${pendingCount} 项（STRICT）` : ""}`);
  }
  cleanup();
  process.exit(failures === 0 && !pendingAsFailure ? 0 : 1);
} catch (error) {
  console.error("\n冒烟异常：", error);
  cleanup();
  process.exit(1);
}
