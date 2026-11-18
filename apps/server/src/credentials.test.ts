import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AppSettings, Credential } from "@super-work/core";
import type { Paths } from "./config.js";
import { CredentialManager, isSameLocalAccount } from "./credentials.js";
import { createLogger } from "./log.js";
import { Storage, type StoredCredential } from "./storage.js";

interface Setup {
  dir: string;
  storage: Storage;
  credFile: string;
  creds: CredentialManager;
}

function setup(): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "super-work-creds-"));
  const storage = new Storage({
    home: dir,
    dbFile: path.join(dir, "test.db"),
    keyFile: path.join(dir, "secret.key"),
  } as unknown as Paths);
  const credFile = path.join(dir, ".credentials.yaml");
  const settings = {
    language: "zh",
    allowLocalReuse: true,
    localCredentialPath: credFile,
  } as AppSettings;
  const creds = new CredentialManager(storage, settings, createLogger("test"));
  return { dir, storage, credFile, creds };
}

/** DSH 凭证文件是 YAML，但 YAML 是 JSON 的超集：直接写 JSON 最省事也不会歧义。 */
function writeDshCredentials(
  file: string,
  opts: {
    access: string;
    expires: number;
    accountId: string;
    kimiAccess?: string;
    kimiExpires?: number;
  },
): void {
  const dsh = {
    version: 1,
    records: {
      "llm-pi-ai/openai-codex": {
        kind: "grant",
        payload: {
          type: "oauth",
          access: opts.access,
          refresh: `refresh-${opts.access}`,
          expires: opts.expires,
          accountId: opts.accountId,
        },
      },
    },
    refs: opts.kimiAccess
      ? {
          KIMI_SUBSCRIPTION_TOKEN: JSON.stringify({
            access: opts.kimiAccess,
            refresh: `refresh-${opts.kimiAccess}`,
            expires: opts.kimiExpires ?? opts.expires,
          }),
        }
      : {},
  };
  fs.writeFileSync(file, JSON.stringify(dsh, null, 2));
  // local-reuse 按 mtime 缓存：强制换一个 mtime，保证测试读到新内容。
  const stamp = new Date(Date.now() + 1_000);
  fs.utimesSync(file, stamp, stamp);
}

test("import-local：再次导入同一本机账户必须刷新令牌与健康状态", async () => {
  const { dir, storage, credFile, creds } = setup();
  try {
    const past = Date.now() - 60_000;
    writeDshCredentials(credFile, { access: "old-access", expires: past, accountId: "acct_same123" });
    const first = await creds.importLocal("openai", "dsh:openai-codex");
    assert.equal(first.healthy, false, "过期令牌导入时应如实标记不可用");
    assert.equal(first.expiresAt, past);

    const future = Date.now() + 3_600_000;
    writeDshCredentials(credFile, {
      access: "fresh-access",
      expires: future,
      accountId: "acct_same123",
    });
    const second = await creds.importLocal("openai", "dsh:openai-codex");

    assert.equal(second.id, first.id, "同一本机账户应复用同一条凭证记录，不产生重复行");
    assert.equal(second.healthy, true, "重新导入后健康状态必须跟着刷新");
    assert.equal(second.expiresAt, future, "重新导入后过期时间必须跟着刷新");
    const row = storage.getCredentialRow(first.id)!;
    const credential = storage.decryptedCredential(row) as Credential;
    assert.equal(credential.oauth?.access, "fresh-access", "本地库里的 access 令牌必须换成新的");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("import-local：订阅凭证与 API Key 即使都没有 accountLabel 也不能互相顶替", () => {
  const base = {
    provider: "kimi" as const,
    source: "local" as const,
    label: "Kimi",
    createdAt: 1,
    updatedAt: 1,
    healthy: true,
  };
  const subscriptionRow: StoredCredential = { ...base, id: "cred_sub", mode: "device-code" };
  const apiKeyRow: StoredCredential = { ...base, id: "cred_key", mode: "api-key" };

  const subscriptionCredential: Credential = {
    provider: "kimi",
    mode: "device-code",
    source: "local",
    oauth: { access: "membership-token" },
  };
  const apiKeyCredential: Credential = {
    provider: "kimi",
    mode: "api-key",
    source: "local",
    apiKey: "sk-moonshot",
  };

  assert.equal(isSameLocalAccount(subscriptionRow, subscriptionCredential), true);
  assert.equal(isSameLocalAccount(apiKeyRow, apiKeyCredential), true);
  assert.equal(
    isSameLocalAccount(subscriptionRow, apiKeyCredential),
    false,
    "订阅行不能被当成 Moonshot API Key 的同一账户",
  );
  assert.equal(isSameLocalAccount(apiKeyRow, subscriptionCredential), false);
});
