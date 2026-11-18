import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { materializeOutputFile } from "./export.js";

test("export：文本 / CSV / Markdown 直接落盘", async () => {
  const md = await materializeOutputFile("方案.md", "# 标题\n正文");
  assert.equal(md.filename, "方案.md");
  assert.equal(md.mime, "text/markdown");
  assert.equal(md.converted, false);
  assert.equal(md.bytes.toString("utf8"), "# 标题\n正文");

  const csv = await materializeOutputFile("数据.csv", "a,b\n1,2");
  assert.equal(csv.mime, "text/csv");
  assert.equal(csv.converted, false);
});

test("export：docx / xlsx / pptx 生成合法 Office 容器", async () => {
  const docx = await materializeOutputFile("报告.docx", "# 标题\n\n- 结论\n- 下一步");
  assert.equal(docx.converted, true);
  assert.equal(docx.bytes.subarray(0, 2).toString("latin1"), "PK");
  assert.ok(docx.bytes.length > 2000);

  const xlsx = await materializeOutputFile("表格.xlsx", "项目,金额\n投放,8000\n奖励,3000");
  assert.equal(xlsx.converted, true);
  assert.equal(xlsx.bytes.subarray(0, 2).toString("latin1"), "PK");

  const pptx = await materializeOutputFile("汇报.pptx", "## 第一页\n- 要点一\n## 第二页\n- 要点二");
  assert.equal(pptx.converted, true);
  assert.equal(pptx.bytes.subarray(0, 2).toString("latin1"), "PK");
});

test("export：PDF 走本机 cupsfilter（可用时）生成 %PDF", { skip: !fs.existsSync("/usr/sbin/cupsfilter") }, async () => {
  const pdf = await materializeOutputFile("说明.pdf", "第一行\n第二行");
  assert.equal(pdf.converted, true);
  assert.equal(pdf.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
});
