import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AppSettings } from "@super-work/core";
import { discoverLocalAccounts, localAccountCredential } from "./local-reuse.js";

test("local-reuse：从 DSH 的 deepseek-account-platform 记录发现 DeepSeek 账户", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "super-work-local-reuse-"));
  try {
    const file = path.join(dir, ".credentials.yaml");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        records: {
          "deepseek-account-platform/default": {
            kind: "grant",
            payload: { version: 1, token: "dsh-deepseek-account-token", issuer: "https://platform.deepseek.com" },
          },
        },
        refs: {},
      }),
    );
    const settings = { language: "zh", allowLocalReuse: true, localCredentialPath: file } as AppSettings;
    const accounts = discoverLocalAccounts(settings);
    const account = accounts.find((a) => a.provider === "deepseek-account");
    assert.ok(account, "应发现 deepseek-account 本机账户");
    assert.equal(account?.id, "dsh:deepseek-account");
    assert.equal(account?.mode, "token");
    assert.equal(account?.usable, true);
    const credential = localAccountCredential(settings, "dsh:deepseek-account");
    assert.equal(credential?.provider, "deepseek-account");
    assert.equal(credential?.mode, "token");
    assert.equal(credential?.pasted?.access, "dsh-deepseek-account-token");
    assert.equal(credential?.baseUrl, "https://api.deepseek.com/anthropic/v1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
