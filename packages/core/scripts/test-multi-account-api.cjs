#!/usr/bin/env node
/**
 * End-to-end test for ACCOUNT SELECTION over HTTP.
 *
 * The model being pinned down:
 *
 * 1. THERE IS NOTHING TO AUTHORIZE. The server hosts the accounts, so a caller
 *    is not proving an identity — it is choosing whose quota to spend.
 *
 * 2. THE ACCOUNT KEY TRAVELS IN THE STANDARD SLOT, so a client's ordinary
 *    "API key" field is all it takes:
 *
 *        Authorization: Bearer <account-key>
 *
 *    Keys are discovered by querying `GET /api/state` -> `accounts[].key`.
 *    No marker at all means "use the currently selected account". There is
 *    deliberately no second channel: an `?account=` query string is IGNORED,
 *    because two ways to say the same thing is a precedence rule to get wrong.
 *
 * 3. An UNKNOWN key is a 400. Falling back to the active account would spend
 *    somebody the caller never asked for.
 *
 * 4. There is NO authorization to defeat: the server hosts the accounts, and
 *    `--token` was removed along with the query channel it made necessary.
 *
 * Tokens are fake and expiry is a year out, so the refresh tick never fires
 * and running this cannot rotate a real credential.
 *
 * Run: node scripts/test-multi-account-api.cjs
 */

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, "..", "out", "cli.js");
const ALICE = "ent-a:1001";
const BOB = "ent-b:1002";

function account(uid, ent, nick, at) {
  return {
    accessToken: at,
    refreshToken: `fake-rt-${uid}`,
    savedAt: Date.now(),
    // Far future on purpose: guarantees the 60s tick has nothing to refresh,
    // so this test can never rotate a token.
    expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
    userAgent: "e2e",
    uid,
    enterpriseId: ent,
    nickname: nick,
  };
}

let passed = 0;
async function check(name, fn) {
  const r = fn();
  if (r && typeof r.then === "function") await r;
  passed += 1;
  console.log(`  ok  ${name}`);
}

/**
 * `bearer` goes into the standard Authorization slot and IS the account
 * selector. There is no secret here — it picks whose quota the request spends.
 */
async function api(method, urlPath, body, opts = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const state = () => api("GET", "/api/state").then((r) => r.json);
const byKey = (s, k) => s.accounts.find((a) => a.key === k);

async function waitForPort(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not come up on ${PORT} within ${timeoutMs}ms`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-marker-"));
  const authFile = path.join(dir, "codebuddy-auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify(
      {
        version: 2,
        activeKey: ALICE,
        accounts: {
          [ALICE]: account("1001", "ent-a", "Alice", "fake-at-a"),
          [BOB]: account("1002", "ent-b", "Bob", "fake-at-b"),
        },
      },
      null,
      2
    )
  );

  // No --token: authentication is off by default.
  const server = spawn(
    process.execPath,
    [OUT, "serve", "--port", String(PORT), "--data-dir", dir],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const logs = [];
  server.stdout.on("data", (d) => logs.push(d.toString()));
  server.stderr.on("data", (d) => logs.push(d.toString()));

  try {
    await waitForPort();

    console.log("no authorization is required");
    const initial = await api("GET", "/api/state");
    await check("GET /api/state works with no Authorization header", () =>
      assert.strictEqual(initial.status, 200)
    );
    await check("the OpenAI-compatible surface is reachable too", async () => {
      const models = await api("GET", "/v1/models");
      assert.strictEqual(models.status, 200);
      assert.ok(Array.isArray(models.json.data) && models.json.data.length > 0);
    });

    console.log("GET /api/state — both accounts");
    const st = initial.json;
    await check("both accounts are listed", () => assert.strictEqual(st.accounts.length, 2));
    await check("each account exposes the key callers select it by", () =>
      assert.deepStrictEqual(st.accounts.map((a) => a.key).sort(), [ALICE, BOB])
    );
    await check("active account is the stored activeKey", () =>
      assert.strictEqual(st.activeKey, ALICE)
    );
    await check("accounts carry a pre-rendered label", () =>
      assert.deepStrictEqual(st.accounts.map((a) => a.label), ["Alice", "Bob"])
    );
    await check("active account is exactly one of them", () =>
      assert.strictEqual(st.accounts.filter((a) => a.active).length, 1)
    );
    await check("the catalog resolves even with unusable tokens", () => {
      // Documenting a real finding: /v3/config does not validate the session
      // and is not account-scoped, so this fetch succeeds with fake tokens.
      // (It IS scoped by the client identity — see RegionProfile.)
      // The catalog is therefore cached ONCE per region, not per account.
      assert.strictEqual(st.catalogError, undefined);
      assert.strictEqual(st.modelsSource, "auth");
      assert.ok(st.models.length > 0, "expected a non-empty catalog");
    });
    await check("no image-generation model is ever offered as a chat model", () => {
      const generation = st.models.filter((m) => m.tags?.includes("text-to-image"));
      assert.deepStrictEqual(generation, []);
    });
    console.log(`      (catalog size: ${st.models.length}; excluded: ${st.excludedModels.length})`);

    console.log("POST /api/accounts/switch");
    const switched = await api("POST", "/api/accounts/switch", { key: "ent-b:1002" });
    await check("switch returns the new state", () => assert.strictEqual(switched.status, 200));
    await check("activeKey moved to Bob", () =>
      assert.strictEqual(switched.json.activeKey, "ent-b:1002")
    );
    await check("Bob is the only active account", () =>
      assert.deepStrictEqual(
        switched.json.accounts.filter((a) => a.active).map((a) => a.key),
        ["ent-b:1002"]
      )
    );
    await check("switching did NOT sign anyone out", () =>
      assert.strictEqual(switched.json.accounts.length, 2)
    );
    await check("the switch is persisted to disk", () => {
      const raw = JSON.parse(fs.readFileSync(authFile, "utf-8"));
      assert.strictEqual(raw.activeKey, "ent-b:1002");
      assert.strictEqual(Object.keys(raw.accounts).length, 2);
    });

    await check("an unknown key is rejected, not silently ignored", async () => {
      const bad = await api("POST", "/api/accounts/switch", { key: "does-not-exist" });
      assert.strictEqual(bad.status, 400);
    });

    await check("an arbitrary API key is rejected, not treated as 'no marker'", async () => {
      // Clients habitually send "sk-..."; silently using the active account
      // would bill the wrong person.
      const r = await api("GET", "/api/state", undefined, { bearer: "sk-not-a-real-key" });
      assert.strictEqual(r.status, 400);
    });


    console.log("POST /api/checkin/all — the sweep must survive failures");
    const sweep = await api("POST", "/api/checkin/all");
    await check("the sweep does not 500 when every account fails", () =>
      assert.strictEqual(sweep.status, 200)
    );
    await check("it reports a result for EACH account", () =>
      assert.deepStrictEqual(Object.keys(sweep.json.results).sort(), [ALICE, BOB])
    );
    await check("failures are counted, not hidden", () => {
      assert.strictEqual(sweep.json.failed, 2);
      assert.strictEqual(sweep.json.claimed, 0);
    });

    console.log("POST /api/models/refresh");
    const refresh = await api("POST", "/api/models/refresh");
    await check("re-fetching the catalog keeps the accounts intact", () => {
      assert.strictEqual(refresh.status, 200);
      assert.ok(Array.isArray(refresh.json) && refresh.json.length > 0);
    });
    await check("state is unaffected by a catalog refresh", async () => {
      const after = await state();
      assert.strictEqual(after.accounts.length, 2);
      assert.strictEqual(after.activeKey, BOB);
    });

    console.log("an UNKNOWN account key is a 400, never a silent fallback");
    await check("sent as the bearer", async () => {
      const r = await api("GET", "/api/state", undefined, { bearer: "nope" });
      assert.strictEqual(r.status, 400);
      assert.match(r.json.error.message, /Unknown account marker/);
    });
    await check("on an /v1 route too", async () => {
      const r = await api("GET", "/v1/models", undefined, { bearer: "nope" });
      assert.strictEqual(r.status, 400);
    });
    await check("the error lists the accounts that DO exist", async () => {
      const r = await api("GET", "/api/state", undefined, { bearer: "nope" });
      assert.match(r.json.error.message, new RegExp(BOB));
    });

    console.log("the bearer is the ONLY channel that selects an account");
    await check("logout removes the BEARER's account, and ?account= is ignored", async () => {
      // logout deletes exactly ONE account, which makes it an unambiguous
      // signal of who the request was attributed to. The bearer is Bob; the
      // query string names Alice. Alice must SURVIVE — if `?account=` were
      // still honoured, Alice would be the one that disappeared.
      const r = await api(
        "POST",
        `/api/logout?account=${encodeURIComponent(ALICE)}`,
        {},
        { bearer: BOB }
      );
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(
        r.json.accounts.map((a) => a.key),
        [ALICE],
        "the bearer's account should be gone, and the queried one left alone"
      );
    });

    console.log("omitting the marker uses the current account");
    await check("logout with no marker removes the ACTIVE account", async () => {
      const r = await api("POST", "/api/logout", {});
      assert.strictEqual(r.json.accounts.length, 0);
    });
    await check("state degrades to signed-out, not to an error", async () => {
      const s = await state();
      assert.strictEqual(s.loggedIn, false);
      assert.strictEqual(s.activeKey, null);
      assert.strictEqual(s.modelsSource, "anonymous");
      assert.ok(s.models.length > 0, "the anonymous catalog must still work");
    });

    console.log(`\n${passed} checks passed`);
  } finally {
    server.kill("SIGTERM");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await testUsageSurface();
}

/**
 * Quota data must cover EVERY account, since the management page shows a bill
 * per account and the packages one expand away.
 */
async function testUsageSurface() {
  const PORT2 = 8918;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-usage-"));
  fs.writeFileSync(
    path.join(dir, "codebuddy-auth.json"),
    JSON.stringify(
      {
        version: 2,
        activeKey: ALICE,
        accounts: {
          [ALICE]: account("1001", "ent-a", "Alice", "x"),
          [BOB]: account("1002", "ent-b", "Bob", "y"),
        },
      },
      null,
      2
    )
  );

  const server = spawn(
    process.execPath,
    [OUT, "serve", "--port", String(PORT2), "--data-dir", dir],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const call = (path, method = "GET") =>
    fetch(`${BASE2}${path}`, { method }).then(async (r) => ({
      status: r.status,
      json: await r.json().catch(() => undefined),
    }));

  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        if ((await call("/api/state")).status < 500) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log("\n-- quota has to cover every account --");
    await check("the refresh reports even when every upstream call fails", async () => {
      const r = await call("/api/usage/refresh", "POST");
      assert.strictEqual(r.status, 200, "a broken upstream must not 500 the refresh");
    });
    await check("every account gets its OWN check-in status read", async () => {
      // The sweep is per account, not just the active one — otherwise a
      // multi-account page could only ever describe one of them.
      const r = await call("/api/state");
      assert.strictEqual(r.json.accounts.length, 2);
      for (const a of r.json.accounts) {
        assert.ok(a.checkin, `${a.key} has no check-in status after a refresh`);
        assert.strictEqual(a.checkin.state, "unknown", `${a.key}: status not recorded`);
      }
    });
    await check("a failed billing fetch reports NOTHING, never zero", async () => {
      // The important half of "fail visibly": with unusable tokens the gateway
      // refuses, and rendering `0 / 0 credits` would read as "you are out of
      // credits" rather than "we could not ask".
      const r = await call("/api/state");
      for (const a of r.json.accounts) {
        assert.strictEqual(
          a.usage,
          undefined,
          `${a.key} invented a usage figure after a failed fetch`
        );
      }
    });
    await check("the refresh is READ-ONLY: it must not CLAIM a bonus", async () => {
      // It may (and should) record the STATUS it observed — what it must never
      // do is turn a status check into a claim.
      const r = await call("/api/state");
      for (const a of r.json.accounts) {
        assert.notStrictEqual(
          a.checkin?.state,
          "claimed",
          `${a.key} was claimed by a read`
        );
        assert.notStrictEqual(
          a.checkin?.freshlyClaimed,
          true,
          `${a.key} reports a fresh claim from a read`
        );
      }
    });
  } finally {
    server.kill("SIGTERM");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} checks passed (including the usage surface)`);
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
