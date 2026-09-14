#!/usr/bin/env node
/**
 * Regression test for `src/storage.ts` / `src/settings.ts` shared BETWEEN
 * PROCESSES.
 *
 * The dsh plugin and `wbaw serve` both default to `~/.workbuddy-anywhere`, so
 * two live processes read-modify-write the same `codebuddy-auth.json`. That
 * used to lose accounts, and the failure was quiet enough to be worth pinning
 * down precisely:
 *
 *   1. STALE CACHE. `read()` returned the first snapshot it ever loaded and
 *      never revalidated it. A process that had been running a while would
 *      therefore spread a snapshot predating every account the other process
 *      added, and write that stale copy back — deleting them. Deterministic,
 *      not a race: no concurrency was needed, just "another process wrote,
 *      then I wrote". The 60s token-refresh tick does that on its own.
 *   2. READ-MODIFY-WRITE WINDOW. Even reading fresh, two writers can both read
 *      and then both write, and the second drops the first's change. Atomic
 *      rename prevents a *corrupt* file, not a lost update.
 *
 * Sections 1 and 3 are deterministic. Sections 2 and 4 spawn real processes
 * that genuinely overlap, which is the only way to exercise the cross-process
 * lock; their outcome also depends on how the interleaving falls, so read the
 * notes there before treating a pass as proof.
 *
 * Run: node scripts/test-storage-crossproc.cjs
 */

const assert = require("assert");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { FileAuthStore } = require("../out/storage.js");

const CHILD = path.join(__dirname, "test-storage-crossproc.child.cjs");

function auth(uid, region) {
  return {
    accessToken: `at-${uid}`,
    refreshToken: `rt-${uid}`,
    savedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    userAgent: "test",
    uid,
    region,
  };
}

const authFile = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, "codebuddy-auth.json"), "utf8"));

/**
 * Run children CONCURRENTLY.
 *
 * Deliberately not `execFileSync` in a loop: that runs them one after another,
 * so they never contend and the test passes without testing anything. All
 * children are started first, then awaited together.
 */
function runChildren(args) {
  return Promise.all(
    args.map(
      (a) =>
        new Promise((resolve, reject) => {
          execFile(
            process.execPath,
            [CHILD, ...a],
            { encoding: "utf8" },
            (err, stdout, stderr) =>
              err ? reject(new Error(`${a.join(" ")}: ${stderr || err.message}`)) : resolve(stdout)
          );
        })
    )
  );
}

let passed = 0;
async function check(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") await result;
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function main() {
  // ── 1. A stale reader must not erase another writer's accounts ────────────
  // Deterministic: no concurrency involved at all.
  console.log("a long-running process must not clobber accounts it never saw");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-xproc-cache-"));
    const longRunning = new FileAuthStore(dir); // dsh, started earlier
    const other = new FileAuthStore(dir); // desktop app / `wbaw serve`

    await longRunning.upsert(auth("alice", "cn"));
    // The other process adds accounts; `longRunning` is never told.
    await other.upsert(auth("bob", "cn"));
    await other.upsert(auth("carol", "intl"));
    await check("disk holds all three", () =>
      assert.deepStrictEqual(Object.keys(authFile(dir).accounts).sort(), [
        "alice",
        "bob",
        "intl:carol",
      ])
    );

    // What the 60s refresh tick does: a single-account write.
    await longRunning.save({ ...auth("alice", "cn"), accessToken: "at-alice-2" });

    await check("the refresh kept bob", () =>
      assert.ok(authFile(dir).accounts["bob"], "bob was deleted by a stale write")
    );
    await check("the refresh kept carol", () =>
      assert.ok(authFile(dir).accounts["intl:carol"], "carol was deleted")
    );
    await check("and it did persist alice's new token", () =>
      assert.strictEqual(authFile(dir).accounts["alice"].accessToken, "at-alice-2")
    );
    await check("the long-running process SEES the new accounts too", async () =>
      assert.deepStrictEqual(
        (await longRunning.list()).map((a) => a.uid).sort(),
        ["alice", "bob", "carol"]
      )
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 2. Real processes, genuinely overlapping ─────────────────────────────
  console.log("separate OS processes contending for one credential file");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-xproc-lock-"));
    const procs = 6;
    const perProc = 4;

    // Every child starts at once, so their read-modify-write cycles overlap.
    // Each child upserts ONLY its own accounts, so with a working lock the
    // union is deterministic; the value here is catching a broken or missing
    // lock (which shows up as lost accounts or a corrupt file), not in
    // measuring how often it breaks.
    await runChildren(
      Array.from({ length: procs }, (_, p) => ["auth", dir, String(p), String(perProc)])
    );

    const keys = Object.keys(authFile(dir).accounts);
    await check(`all ${procs * perProc} accounts from ${procs} parallel processes survived`, () =>
      assert.strictEqual(keys.length, procs * perProc)
    );
    await check("no temp files were left behind", () => {
      const stray = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
      assert.deepStrictEqual(stray, []);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 3. A lock left behind by a killed process must not wedge anyone ───────
  console.log("an abandoned lock file is stolen, not waited on");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-xproc-stale-"));
    const file = path.join(dir, "codebuddy-auth.json");
    const lock = `${file}.lock`;

    // A lock nobody will ever release, backdated past the stale threshold.
    fs.writeFileSync(lock, "");
    const old = Date.now() - 60_000;
    fs.utimesSync(lock, old / 1000, old / 1000);

    const store = new FileAuthStore(dir);
    const started = Date.now();
    await store.upsert(auth("rescue", "cn"));
    await check("the write went through", () => {
      assert.deepStrictEqual(Object.keys(authFile(dir).accounts), ["rescue"]);
    });
    await check("and it did not wait for the timeout", () => {
      assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started}ms`);
    });
    await check("the stale lock was cleared", () => assert.ok(!fs.existsSync(lock)));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 4. Parallel settings writers ─────────────────────────────────────────
  console.log("parallel settings writers must not drop each other's keys");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-xproc-settings-"));
    const writers = 8;

    // Each child owns a distinct key, so a correctly serialised update leaves
    // all of them present. NOTE: this cannot force the sub-millisecond overlap
    // that loses an update — the read and write inside `update()` are not
    // interruptible from outside — so it is a stress check, not a proof. It
    // fails loudly on a *broken* lock and on a non-atomic write (interleaved
    // `writeFile` calls corrupt the JSON), which is what it is here for.
    await runChildren(
      Array.from({ length: writers }, (_, i) => ["settings", dir, String(i)])
    );

    const settingsPath = path.join(dir, "workbuddy-settings.json");
    await check("the settings file is still valid JSON", () => {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(settingsPath, "utf8")));
    });
    await check(`all ${writers} keys survived`, () => {
      const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const missing = Array.from({ length: writers }, (_, i) => `probe${i}`).filter(
        (k) => onDisk[k] === undefined
      );
      assert.deepStrictEqual(missing, [], `missing keys: ${missing.join(", ")}`);
    });
    await check("region still has its default", () => {
      const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.ok(onDisk.region === "cn" || onDisk.region === "intl");
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
