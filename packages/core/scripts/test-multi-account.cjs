#!/usr/bin/env node
/**
 * Regression test for the multi-account auth store (`src/storage.ts`).
 *
 * Covers the things that break silently rather than loudly:
 *   - the v1 -> v2 migration must keep an existing user logged in
 *   - `save()` must NOT change the active account (the 60s token tick would
 *     otherwise switch accounts out from under the user)
 *   - removing the active account must not leave a dangling activeKey
 *   - a corrupt file must not cost the user every account
 *
 * Run: node scripts/test-multi-account.cjs
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { FileAuthStore, accountKey } = require("../out/storage.js");
const AUTH_FILE = "codebuddy-auth.json";

function auth(overrides) {
  return {
    accessToken: "at",
    refreshToken: "rt",
    savedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    userAgent: "test",
    ...overrides,
  };
}

const ALICE = auth({ uid: "1001", enterpriseId: "ent-a", nickname: "Alice" });
const BOB = auth({ uid: "1002", enterpriseId: "ent-b", nickname: "Bob" });

let passed = 0;
async function check(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") await result;
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-auth-test-"));
  const file = path.join(dir, AUTH_FILE);

  console.log("accountKey()");
  await check("enterprise + uid", () =>
    assert.strictEqual(accountKey({ uid: "1", enterpriseId: "e" }), "e:1")
  );
  await check("uid only", () => assert.strictEqual(accountKey({ uid: "1" }), "1"));
  await check("never empty", () => assert.strictEqual(accountKey({}), "default"));
  await check("an UNIDENTIFIED account gets a key of its own, not 'default'", () => {
    // Regression: the identity lookup used to always fail, so every account had
    // an empty uid and they all collapsed onto "default" — a second login then
    // OVERWROTE the first. The refresh token is the only stable thing left to
    // key on.
    const a = accountKey({ refreshToken: "rt-one" });
    const b = accountKey({ refreshToken: "rt-two" });
    assert.notStrictEqual(a, "default");
    assert.notStrictEqual(a, b, "two unidentified accounts must not share a key");
    assert.strictEqual(a, accountKey({ refreshToken: "rt-one" }), "must be stable");
  });

  console.log("v1 -> v2 migration");
  fs.writeFileSync(file, JSON.stringify(ALICE, null, 2));
  {
    const store = new FileAuthStore(dir);
    await check("existing session survives", async () => {
      const accounts = await store.list();
      assert.strictEqual(accounts.length, 1);
      assert.strictEqual(accounts[0].uid, "1001");
    });
    await check("file is upgraded to v2 on disk", () => {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      assert.strictEqual(raw.version, 2);
      assert.deepStrictEqual(Object.keys(raw.accounts), ["ent-a:1001"]);
    });
    await check("migrated account is active", async () => {
      assert.strictEqual(await store.getActiveKey(), "ent-a:1001");
      assert.strictEqual((await store.getActive()).uid, "1001");
    });
  }

  console.log("adding a second account");
  {
    const store = new FileAuthStore(dir);
    await store.upsert(BOB);
    await check("both accounts are stored", async () => {
      assert.strictEqual((await store.list()).length, 2);
    });
    await check("the new sign-in becomes active", async () => {
      assert.strictEqual(await store.getActiveKey(), "ent-b:1002");
    });
  }

  console.log("background token save must not steal focus");
  {
    const store = new FileAuthStore(dir);
    // Simulate the 60s tick refreshing the NON-active account.
    await store.save({ ...ALICE, accessToken: "at-refreshed" });
    await check("activeKey is unchanged", async () => {
      assert.strictEqual(await store.getActiveKey(), "ent-b:1002");
    });
    await check("the refreshed token was persisted", async () => {
      const alice = await store.get("ent-a:1001");
      assert.strictEqual(alice.accessToken, "at-refreshed");
    });
  }

  console.log("removing accounts");
  {
    const store = new FileAuthStore(dir);
    await store.remove("ent-b:1002");
    await check("only one account remains", async () => {
      assert.strictEqual((await store.list()).length, 1);
    });
    await check("activeKey falls back to a real account", async () => {
      assert.strictEqual(await store.getActiveKey(), "ent-a:1001");
    });
  }

  console.log("corrupt file is survivable");
  {
    fs.writeFileSync(file, "{ this is not json");
    const store = new FileAuthStore(dir);
    await check("does not throw, reports no accounts", async () => {
      assert.strictEqual((await store.list()).length, 0);
    });
    await store.upsert(BOB);
    await check("a write repairs the file", () => {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      assert.strictEqual(raw.version, 2);
      assert.deepStrictEqual(Object.keys(raw.accounts), ["ent-b:1002"]);
    });
  }

  console.log("concurrent upserts must not lose an account");
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "wb-auth-race-"));
    const store = new FileAuthStore(dir2);
    const many = Array.from({ length: 12 }, (_, i) =>
      auth({ uid: `u${i}`, enterpriseId: "e", nickname: `U${i}` })
    );
    await Promise.all(many.map((a) => store.upsert(a)));
    await check("all 12 accounts survived the race", async () => {
      assert.strictEqual((await store.list()).length, 12);
    });
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  console.log("clear()");
  {
    const store = new FileAuthStore(dir);
    await store.clear();
    await check("no accounts left", async () => {
      assert.strictEqual((await store.list()).length, 0);
    });
    await check("activeKey is null", async () => {
      assert.strictEqual(await store.getActiveKey(), null);
    });
  }

  console.log("two unidentified logins must not collide");
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "wb-auth-collide-"));
    const store = new FileAuthStore(dir2);
    await store.upsert(auth({ refreshToken: "rt-A", accessToken: "at-A" }));
    await store.upsert(auth({ refreshToken: "rt-B", accessToken: "at-B" }));
    await check("both accounts survive", async () => {
      assert.strictEqual((await store.list()).length, 2);
    });
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  console.log("repairing an identity (rename)");
  {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "wb-auth-rename-"));
    const store = new FileAuthStore(dir3);
    const unnamed = auth({ refreshToken: "rt-unnamed", accessToken: "at" });
    await store.upsert(unnamed);
    const oldKey = await store.getActiveKey();

    await check("starts under a token-derived key", () => {
      assert.ok(oldKey && oldKey.startsWith("unnamed-"), `got ${oldKey}`);
    });

    await store.rename(oldKey, { ...unnamed, uid: "u-42", nickname: "Real Name" });

    await check("the account moves, with NO duplicate left behind", async () => {
      const entries = await store.listEntries();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].key, "u-42");
      assert.strictEqual(entries[0].auth.nickname, "Real Name");
    });
    await check("activeKey follows the repair", async () => {
      assert.strictEqual(await store.getActiveKey(), "u-42");
    });
    await check("renaming to the same key is a no-op, not a duplicate", async () => {
      const current = await store.get("u-42");
      await store.rename("u-42", current);
      assert.strictEqual((await store.listEntries()).length, 1);
    });
    fs.rmSync(dir3, { recursive: true, force: true });
  }

  console.log(`\n${passed} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
