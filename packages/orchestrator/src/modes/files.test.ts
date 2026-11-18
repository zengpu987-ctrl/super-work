import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "@super-work/core";
import { createFakeDeps, makeArgs, makeParticipant, runOrchestrator } from "./testkit.js";

const p1 = makeParticipant("p1", { role: "交付" });

test("文件输出：解析 ```file name=...``` 为 artifact，正文从回答里剔除", async () => {
  const answer = [
    "下面给你三个文件：",
    "",
    '```file name="方案.md"',
    "# 方案",
    "正文内容",
    "```",
    "",
    '```file name="数据.csv"',
    "a,b",
    "1,2",
    "```",
    "",
    "以上文件可直接下载。",
  ].join("\n");
  const { deps } = createFakeDeps(() => ({ chunks: [answer] }));
  const args = makeArgs({ mode: "parallel", participants: [p1] });
  const { result, events } = await runOrchestrator(args, deps);

  const artifacts = events.filter(
    (event): event is Extract<RunEvent, { type: "artifact" }> => event.type === "artifact",
  );
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0]?.artifact.title, "方案.md");
  assert.equal(artifacts[0]?.artifact.mime, "text/markdown");
  assert.equal(artifacts[0]?.artifact.text, "# 方案\n正文内容");
  assert.equal(artifacts[1]?.artifact.title, "数据.csv");
  assert.equal(artifacts[1]?.artifact.mime, "text/csv");

  assert.ok(!result.finalText.includes("```file"), "最终答案不应包含原始文件块");
  assert.ok(result.finalText.includes("[已生成文件：方案.md]"));
  assert.ok(result.finalText.includes("以上文件可直接下载。"));
});

test("文件输出：普通代码块不受影响", async () => {
  const answer = "示例代码：\n\n```ts\nconst a = 1;\n```\n\n结束";
  const { deps } = createFakeDeps(() => ({ chunks: [answer] }));
  const args = makeArgs({ mode: "parallel", participants: [p1] });
  const { result, events } = await runOrchestrator(args, deps);
  const artifacts = events.filter((event) => event.type === "artifact");
  assert.equal(artifacts.length, 0);
  assert.ok(result.finalText.includes("const a = 1;"));
});
