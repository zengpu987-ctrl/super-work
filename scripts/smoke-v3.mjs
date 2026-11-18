#!/usr/bin/env node
/**
 * Super Work v0.0.3 端到端冒烟（隔离实例 + 演示模型，不联网、不需要任何 API key）。
 *
 * 覆盖：
 *   ① 启动隔离实例（独立 SUPER_WORK_HOME + 随机端口）
 *   ② 上传：txt 与内联 1×1 PNG → kind / text / 预览 / 缩略图
 *   ③ 带附件发起并行运行 → 详情里的 attachments 与 guard
 *   ④ 预算：dailyTokenLimit=1 → 新运行 409 budget_exceeded → 恢复预算
 *   ⑤ 关键词：「画图 → 追加生图角色」命中测试 + 配合模式验证角色被追加
 *   ⑥ 自定义角色：custom_audit + 裁判的配合模式 → 恰好 2 次调用
 *   ⑦ 插件：GET /api/plugins ≥30 条且字段完整，至少 1 个 bridge 真实测试成功
 *   ⑧ GET /api/budgets/usage 结构正确（且已累计到用量）
 *
 * 用法：
 *   node scripts/smoke-v3.mjs
 *   node scripts/smoke-v3.mjs --verbose            # 打印服务端 stdout/stderr
 *   SMOKE_VERBOSE=1 node scripts/smoke-v3.mjs
 *   SMOKE_KEEP=1 node scripts/smoke-v3.mjs         # 失败时保留临时数据目录
 *
 * 退出码：全部通过 0，否则 1。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "super-work-smoke-v3-"));
const port = 7920 + Math.floor(Math.random() * 60);
const base = `http://127.0.0.1:${port}`;
const verbose = process.argv.includes("--verbose") || process.env.SMOKE_VERBOSE === "1";
const keepOnFailure = process.env.SMOKE_KEEP === "1";

/** 内联 1×1 透明 PNG（70 字节），用于上传接口的图片链路测试。 */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const MOCK_FAST = { provider: "mock", model: "mock-fast" };
const MOCK_THINKER = { provider: "mock", model: "mock-thinker" };

/** 生成一个最小合法 PDF（单页、标准字体），用于验证服务端 PDF 文本提取链路。 */
function makeMinimalPdf(text) {
  const objects = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };
  const stream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
  objects[4] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = {};
  for (let index = 1; index <= 5; index += 1) {
    offsets[index] = Buffer.byteLength(out);
    out += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let index = 1; index <= 5; index += 1) out += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

let failures = 0;
let passes = 0;
let settingsSnapshot = null;
let child = null;
let cleaned = false;
let serverExit = null;
const serverLog = [];

function check(name, cond, detail) {
  if (cond) {
    passes += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${name}${detail !== undefined ? ` — ${formatDetail(detail)}` : ""}`);
  }
}

function formatDetail(detail) {
  if (typeof detail === "string") return detail;
  try {
    const text = JSON.stringify(detail);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return String(detail);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 20_000, intervalMs = 200) {
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
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
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

const json = (value) => JSON.stringify(value);

/* ------------------------------ 设置读写 ------------------------------ */

async function getSettings() {
  const { status, body } = await api("/api/settings");
  if (status !== 200 || !body || typeof body !== "object") {
    throw new Error(`GET /api/settings 失败（${status}）`);
  }
  return body;
}

async function putSettings(patch) {
  return api("/api/settings", { method: "PUT", body: json(patch) });
}

/** 恢复若干个 settings 键（原值为 undefined 时写 null，服务端视为未设置）。 */
async function restoreSettings(keys, snapshot) {
  if (!snapshot) return;
  const patch = {};
  for (const key of keys) patch[key] = snapshot[key] ?? null;
  const { status, body } = await putSettings(patch);
  check(`恢复设置：${keys.join(" / ")}`, status === 200, status === 200 ? undefined : body);
}

/* -------------------------------- 运行 -------------------------------- */

async function waitRun(runId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { status, body } = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (status === 200 && body) {
      last = body;
      if (body.status === "done" || body.status === "error") return body;
    }
    await sleep(400);
  }
  return last;
}

async function runAndWait(payload, label, timeoutMs = 90_000) {
  const created = await api("/api/runs", { method: "POST", body: json(payload) });
  check(`${label}：创建运行返回 201`, created.status === 201, created.body ?? `实际 ${created.status}`);
  if (created.status !== 201) return null;
  const runId = created.body?.id;
  check(`${label}：返回 runId`, typeof runId === "string" && runId.startsWith("run_"), runId);
  if (typeof runId !== "string") return null;
  const detail = await waitRun(runId, timeoutMs);
  check(`${label}：运行结束（done）`, detail?.status === "done", detail ? { status: detail.status, error: detail.error } : "轮询超时");
  return detail;
}

/* ------------------------------ 子进程生命周期 ------------------------------ */

function startServer() {
  const entry = path.join(root, "apps/server/dist/index.js");
  if (!fs.existsSync(entry)) {
    throw new Error("apps/server/dist/index.js 不存在：请先运行 pnpm build");
  }
  child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      SUPER_WORK_HOME: home,
      SUPER_WORK_PORT: String(port),
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    serverLog.push(text);
    if (serverLog.length > 200) serverLog.shift();
    if (verbose) process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    serverLog.push(text);
    if (serverLog.length > 200) serverLog.shift();
    if (verbose) process.stderr.write(text);
  });
  child.on("exit", (code, signal) => {
    serverExit = { code, signal };
    if (!cleaned && code !== 0 && code !== null) {
      console.error(`\n⚠️  服务进程提前退出（code=${code}, signal=${signal}）`);
    }
  });
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    child?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  const keep = keepOnFailure && failures > 0;
  if (keep) {
    console.log(`\nℹ️  SMOKE_KEEP=1：临时数据保留在 ${home}`);
  } else {
    setTimeout(() => {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }, 300);
  }
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  console.log("Super Work v0.0.3 冒烟（隔离实例）");
  console.log(`  数据目录：${home}`);
  console.log(`  端口：${port}`);

  section("① 启动隔离实例");
  startServer();
  const up = await waitFor(async () => {
    if (serverExit) return true; // 服务已退出：尽快失败，别等满 30 秒
    const { status, body } = await api("/api/health", {}, 3_000);
    return status === 200 && body?.ok !== false;
  }, 30_000);
  check("服务健康检查 /api/health", up && !serverExit);
  if (!up || serverExit) {
    console.error(
      serverExit
        ? `\n服务进程已退出（code=${serverExit.code}, signal=${serverExit.signal}）`
        : "\n服务未在 30 秒内就绪",
    );
    console.error("\n服务端日志（末 40 行）：");
    console.error(serverLog.slice(-40).join("").trim() || "（无输出）");
    throw new Error("服务未启动");
  }
  settingsSnapshot = await getSettings();
  check("GET /api/settings 可用", Boolean(settingsSnapshot));

  /* ------------------------------- ② 上传 ------------------------------- */
  section("② 上传附件（txt + 内联 PNG）");

  const txtContent = "Super Work 附件冒烟测试。\nmarker-attach-v3-001：这段文字应被提取并注入运行。\n第三行。";
  const txtBase64 = Buffer.from(txtContent, "utf8").toString("base64");
  const txtUpload = await api("/api/uploads", {
    method: "POST",
    body: json({
      name: "smoke-note.txt",
      mime: "text/plain",
      size: Buffer.byteLength(txtContent, "utf8"),
      dataBase64: txtBase64,
    }),
  });
  check("上传 txt 返回 200", txtUpload.status === 200, txtUpload.body);
  const txtAttachment = txtUpload.body?.attachment;
  check("txt：返回附件 id", typeof txtAttachment?.id === "string" && txtAttachment.id.startsWith("up_"), txtAttachment?.id);
  check(
    "txt：kind 为 text/code（纯文本类）",
    txtAttachment?.kind === "text" || txtAttachment?.kind === "code",
    `实际 kind=${txtAttachment?.kind}`,
  );
  check("txt：提取文本含标记", String(txtAttachment?.text ?? "").includes("marker-attach-v3-001"));
  check("txt：preview 非空且含标记", String(txtAttachment?.preview ?? "").includes("marker-attach-v3-001"), txtAttachment?.preview);
  check("txt：chars 统计 > 0", typeof txtAttachment?.chars === "number" && txtAttachment.chars > 0, txtAttachment?.chars);

  const pngBytes = Buffer.from(PNG_1X1_BASE64, "base64");
  const pngUpload = await api("/api/uploads", {
    method: "POST",
    body: json({
      name: "smoke-pixel.png",
      mime: "image/png",
      size: pngBytes.length,
      dataBase64: PNG_1X1_BASE64,
    }),
  });
  check("上传 PNG 返回 200", pngUpload.status === 200, pngUpload.body);
  const pngAttachment = pngUpload.body?.attachment;
  check("PNG：kind=image", pngAttachment?.kind === "image", pngAttachment?.kind);
  check("PNG：不做 OCR（text 为空）", (pngAttachment?.text ?? "") === "", pngAttachment?.text);
  check("PNG：size 正确", pngAttachment?.size === pngBytes.length, pngAttachment?.size);
  check(
    "PNG：返回缩略 dataUrl 预览",
    typeof pngAttachment?.dataUrl === "string" && pngAttachment.dataUrl.startsWith("data:image/"),
    pngAttachment?.dataUrl ? `${String(pngAttachment.dataUrl).slice(0, 40)}…` : "(无 dataUrl)",
  );

  const pdfText = "Hello Super Work PDF";
  const pdfBytes = makeMinimalPdf(pdfText);
  const pdfUpload = await api("/api/uploads", {
    method: "POST",
    body: json({
      name: "smoke-sample.pdf",
      mime: "application/pdf",
      size: pdfBytes.length,
      dataBase64: pdfBytes.toString("base64"),
    }),
  });
  check("上传 PDF 返回 200", pdfUpload.status === 200, pdfUpload.body);
  const pdfAttachment = pdfUpload.body?.attachment;
  check("PDF：kind=pdf", pdfAttachment?.kind === "pdf", pdfAttachment?.kind);
  check("PDF：无解析错误", !pdfAttachment?.error, pdfAttachment?.error);
  check("PDF：提取文本（pdf-parse）", String(pdfAttachment?.text ?? "").includes(pdfText), pdfAttachment?.text ?? pdfAttachment?.error);
  check("PDF：chars 统计 > 0", typeof pdfAttachment?.chars === "number" && pdfAttachment.chars > 0, pdfAttachment?.chars);

  /* -------------------------- ③ 带附件发起运行 -------------------------- */
  section("③ 带附件运行（并行 / 演示模型）");

  const attachedRun = await runAndWait(
    {
      command: "请总结附件内容，并用一句话说明这个冒烟测试覆盖了什么。",
      mode: "parallel",
      participants: [MOCK_FAST, MOCK_THINKER],
      attachments: [
        {
          id: txtAttachment?.id,
          name: txtAttachment?.name ?? "smoke-note.txt",
          mime: txtAttachment?.mime ?? "text/plain",
          kind: txtAttachment?.kind ?? "text",
          size: txtAttachment?.size,
          text: txtAttachment?.text,
        },
      ],
      options: { critique: false },
    },
    "附件运行",
  );

  if (attachedRun) {
    const detail = await api(`/api/runs/${encodeURIComponent(attachedRun.id)}`);
    const run = detail.body ?? {};
    check("详情：attachments 包含刚上传的附件", Array.isArray(run.attachments) && run.attachments.some((a) => a?.id === txtAttachment?.id), run.attachments?.map((a) => a?.id));
    check(
      "详情：attachments 带提取字数",
      Array.isArray(run.attachments) && (run.attachments.find((a) => a?.id === txtAttachment?.id)?.chars ?? 0) > 0,
      run.attachments?.[0]?.chars,
    );
    check("详情：guard 存在", Boolean(run.guard) && typeof run.guard === "object", run.guard);
    check("详情：guard.attachments 记录附件", Array.isArray(run.guard?.attachments) && run.guard.attachments.length >= 1, run.guard?.attachments);
    check("详情：guard.cheapMode 为布尔", typeof run.guard?.cheapMode === "boolean", run.guard?.cheapMode);
    check("详情：两个 mock 参与者都有结果", Array.isArray(run.results) && run.results.length === 2, run.results?.length);
    check("详情：最终答案非空", typeof run.finalText === "string" && run.finalText.trim().length > 0, run.finalText?.slice(0, 60));
  }

  /* ------------------------------- ④ 预算 ------------------------------- */
  section("④ 预算拦截（dailyTokenLimit=1 → 409）");

  const budgetSnapshot = settingsSnapshot;
  try {
    const budgets = { ...(budgetSnapshot?.budgets ?? {}), currency: "CNY", dailyTokenLimit: 1 };
    const saved = await putSettings({ budgets });
    check("设置 dailyTokenLimit=1", saved.status === 200, saved.body);

    const blocked = await api("/api/runs", {
      method: "POST",
      body: json({
        command: "这条运行应当被今日 token 预算拦住。",
        mode: "parallel",
        participants: [MOCK_FAST],
      }),
    });
    check("预算超限：创建运行返回 409", blocked.status === 409, `实际 ${blocked.status}`);
    check("预算超限：错误码为 budget_exceeded", blocked.body?.error?.code === "budget_exceeded", blocked.body?.error ?? blocked.body);
    check(
      "预算超限：错误信息可读（提到预算/上限）",
      /预算|上限|token/i.test(String(blocked.body?.error?.message ?? "")),
      blocked.body?.error?.message,
    );
  } finally {
    await restoreSettings(["budgets"], budgetSnapshot);
  }

  /* ------------------------------- ⑤ 关键词 ------------------------------- */
  section("⑤ 关键词规则（画图 → 追加生图角色）");

  const keywordSnapshot = settingsSnapshot;
  try {
    const rule = {
      id: "kw_smoke_draw",
      enabled: true,
      keyword: "画图",
      match: "contains",
      action: { type: "role", role: "image", participants: [MOCK_FAST] },
      priority: 10,
      note: "冒烟：命中后追加生图角色",
    };
    const saved = await putSettings({ keywords: [rule] });
    check("设置关键词规则", saved.status === 200, saved.body);

    const tested = await api("/api/keywords/test", {
      method: "POST",
      body: json({ command: "帮我画图：一只在键盘上睡觉的猫。" }),
    });
    check("关键词测试返回 200", tested.status === 200, tested.body);
    check("关键词命中 matched ≥ 1", Array.isArray(tested.body?.matched) && tested.body.matched.length >= 1, tested.body?.matched);
    const effects = Array.isArray(tested.body?.effects) ? tested.body.effects.join(" | ") : "";
    check("关键词效果包含追加 image 角色", /追加角色\s*image/.test(effects), effects || tested.body?.effects);

    const keywordRun = await runAndWait(
      {
        command: "帮我画图：一只在键盘上睡觉的猫，并说明你会怎么画。",
        mode: "coordinate",
        coordination: [{ role: "judge", participants: [MOCK_THINKER] }],
        options: { critique: false },
      },
      "关键词配合运行",
    );
    if (keywordRun) {
      const detail = await api(`/api/runs/${encodeURIComponent(keywordRun.id)}`);
      const run = detail.body ?? {};
      const roles = Array.isArray(run.participants) ? run.participants.map((p) => p?.role) : [];
      check("关键词运行：生图角色被追加（participants 含「生图」）", roles.includes("生图"), roles);
      check("关键词运行：结果包含被追加的生图参与者", Array.isArray(run.results) && run.results.length >= 2, run.results?.length);
    }
  } finally {
    await restoreSettings(["keywords"], keywordSnapshot);
  }

  /* ----------------------------- ⑥ 自定义角色 ----------------------------- */
  section("⑥ 自定义角色（custom_audit + 裁判 = 恰好 2 次调用）");

  const roleSnapshot = settingsSnapshot;
  try {
    const role = {
      id: "custom_audit",
      name: "安全审计",
      description: "冒烟用自定义角色：只做安全与边界审查。",
      kind: "text",
      order: 100,
    };
    const saved = await putSettings({ customRoles: [role] });
    check("设置自定义角色 custom_audit", saved.status === 200, saved.body);

    const roleRun = await runAndWait(
      {
        command: "审计这次实现的风险，只列出安全与边界问题。",
        mode: "coordinate",
        coordination: [
          { role: "custom_audit", participants: [MOCK_FAST] },
          { role: "judge", participants: [MOCK_THINKER] },
        ],
        options: { critique: false },
      },
      "自定义角色配合运行",
    );
    if (roleRun) {
      const detail = await api(`/api/runs/${encodeURIComponent(roleRun.id)}`);
      const run = detail.body ?? {};
      const roleNames = Array.isArray(run.participants) ? run.participants.map((p) => p?.role) : [];
      check("自定义角色运行：results 恰好 2 条", Array.isArray(run.results) && run.results.length === 2, run.results?.length);
      check("自定义角色运行：participants 含「安全审计」", roleNames.includes("安全审计"), roleNames);
      check("自定义角色运行：participants 含裁判角色", roleNames.some((n) => String(n).includes("裁判")), roleNames);
    }
  } finally {
    await restoreSettings(["customRoles"], roleSnapshot);
  }

  /* -------------------------------- ⑦ 插件 -------------------------------- */
  section("⑦ 插件中心（≥30 条 + 至少 1 条 bridge 真实测试）");

  const pluginsRes = await api("/api/plugins", {}, 30_000);
  check("GET /api/plugins 返回 200", pluginsRes.status === 200, pluginsRes.body);
  const plugins = Array.isArray(pluginsRes.body) ? pluginsRes.body : Array.isArray(pluginsRes.body?.plugins) ? pluginsRes.body.plugins : [];
  check(`插件条目 ≥ 30（实际 ${plugins.length}）`, plugins.length >= 30, plugins.length);

  const kinds = new Set(["native", "bridge", "ui-only", "unsupported"]);
  const statuses = new Set(["migrated", "bridge-ready", "pending", "failed"]);
  const invalid = plugins.filter((plugin) => {
    if (!plugin || typeof plugin !== "object") return true;
    if (typeof plugin.id !== "string" || !plugin.id) return true;
    if (typeof plugin.name !== "string" || !plugin.name) return true;
    if (typeof plugin.version !== "string" || !plugin.version) return true;
    if (typeof plugin.description !== "string") return true;
    if (!kinds.has(plugin.kind)) return true;
    if (!statuses.has(plugin.status)) return true;
    if (plugin.source !== "dsh" && plugin.source !== "builtin") return true;
    if (typeof plugin.enabled !== "boolean") return true;
    if (plugin.bridge !== undefined) {
      if (typeof plugin.bridge?.command !== "string" || !plugin.bridge.command) return true;
      if (!Array.isArray(plugin.bridge.testArgs) || plugin.bridge.testArgs.some((a) => typeof a !== "string")) return true;
    }
    return false;
  });
  check("插件字段完整（id/name/version/kind/status/source/enabled/bridge）", plugins.length > 0 && invalid.length === 0, invalid.slice(0, 3).map((p) => p?.id ?? p));

  const testable = plugins
    .filter((plugin) => plugin?.bridge?.command)
    .map((plugin) => {
      const command = String(plugin.bridge.command);
      let rank = 50;
      if (/ffmpeg/i.test(command)) rank = 0;
      else if (/python3/i.test(command)) rank = 1;
      else if (/git$/i.test(command)) rank = 2;
      else if (/modlens/i.test(command)) rank = 3;
      else if (/sips|textutil/i.test(command)) rank = 4;
      return { plugin, rank };
    })
    .sort((a, b) => a.rank - b.rank);

  check("存在可桥接插件（bridge.command）", testable.length >= 1, plugins.filter((p) => p?.bridge).length);

  let bridgeOk = null;
  const attempts = [];
  for (const { plugin } of testable.slice(0, 4)) {
    const tested = await api(`/api/plugins/${encodeURIComponent(plugin.id)}/test`, { method: "POST" }, 40_000);
    const result = tested.body?.result;
    attempts.push({ id: plugin.id, command: plugin.bridge?.command, status: tested.status, ok: result?.ok, message: result?.message });
    if (tested.status === 200 && result && result.ok === true) {
      bridgeOk = { plugin, result, tested };
      break;
    }
  }
  check(
    "POST /api/plugins/:id/test 至少 1 条 bridge 真实返回 ok",
    Boolean(bridgeOk),
    attempts.length ? attempts : "没有可尝试的 bridge 插件",
  );
  if (bridgeOk) {
    check(
      "bridge 测试返回延迟与输出/消息",
      typeof bridgeOk.result.latencyMs === "number" &&
        bridgeOk.result.latencyMs >= 0 &&
        typeof bridgeOk.result.message === "string" &&
        bridgeOk.result.message.length > 0,
      bridgeOk.result,
    );
    check(
      `bridge 测试对象为系统命令（${bridgeOk.plugin.bridge?.command ?? "?"}）`,
      /ffmpeg|python3|git|modlens|sips|textutil/i.test(String(bridgeOk.plugin.bridge?.command ?? "")),
      bridgeOk.plugin.bridge,
    );
  }

  /* ----------------------------- ⑧ 预算用量 ----------------------------- */
  section("⑧ 预算用量接口结构");

  const usageRes = await api("/api/budgets/usage");
  check("GET /api/budgets/usage 返回 200", usageRes.status === 200, usageRes.body);
  const usage = usageRes.body ?? {};
  check(
    "usage.today 结构（tokens/cost/currency）",
    usage.today &&
      typeof usage.today.tokens === "number" &&
      typeof usage.today.cost === "number" &&
      (usage.today.currency === "CNY" || usage.today.currency === "USD"),
    usage.today,
  );
  check(
    "usage.limits 结构（warnAtPercent 数字）",
    usage.limits && typeof usage.limits === "object" && typeof usage.limits.warnAtPercent === "number",
    usage.limits,
  );
  check("usage.blocked 为布尔", typeof usage.blocked === "boolean", usage.blocked);
  check("usage.cheapMode 为布尔", typeof usage.cheapMode === "boolean", usage.cheapMode);
  check(
    "usage.percent 为数字或未设置",
    usage.percent === undefined || typeof usage.percent === "number",
    usage.percent,
  );
  check(`今天已累计 token（${usage.today?.tokens ?? 0}）`, typeof usage.today?.tokens === "number" && usage.today.tokens > 0, usage.today?.tokens);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`\n❌ 冒烟中止：${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (settingsSnapshot) {
    try {
      await restoreSettings(["budgets", "keywords", "customRoles"], settingsSnapshot);
    } catch {
      /* 服务可能已退出，忽略 */
    }
  }
  cleanup();
  console.log(`\n结果：${passes} 项通过，${failures} 项失败`);
  process.exitCode = failures === 0 ? 0 : 1;
}
