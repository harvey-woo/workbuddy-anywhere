#!/usr/bin/env node
/**
 * Regression test for the `/v3/config` REQUEST IDENTITY (`src/models.ts`).
 *
 * The whole "models the app shows but the picker does not" bug was a header
 * bug: the gateway scopes the catalog by the client identity, so asking with
 * the wrong User-Agent (or with a literal `X-Enterprise-Id: "0"`) silently
 * returns a DIFFERENT product's model list. Measured 2026-09-11:
 *
 *   CN    CLI/2.63.2 CodeBuddy/2.63.2 -> 29 models incl. hy4-preview
 *         WorkBuddy/1.0               -> 37 models, no hy4
 *   INTL  WorkBuddy/1.0               -> 21 models incl. hy4-preview-f
 *         CLI/2.63.2 CodeBuddy/2.63.2 -> 35 models, no hy4
 *
 * No single identity returns hy4 on both clusters, so the UA is per region and
 * MUST stay that way. These assertions are pure (no network): they stub fetch.
 *
 * Run: node scripts/test-model-request.cjs
 */

const assert = require("assert");

const { fetchModelConfig, fetchModelConfigAnonymous } = require("../out/models.js");
const { REGION_PROFILES } = require("../out/region.js");

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** Run `fetchModelConfig` with fetch stubbed and return the headers it sent. */
async function captureHeaders(options) {
  const realFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, headers: init.headers };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: {
          agents: [{ name: "cli", models: ["hy3"] }],
          models: [{ id: "hy3", name: "Hy3" }],
        },
      }),
    };
  };
  try {
    await fetchModelConfig(options);
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

(async () => {
  console.log("identity — the UA decides WHICH catalog comes back, so it is per region");
  check("CN presents the CLI identity", () => {
    assert.strictEqual(REGION_PROFILES.cn.clientUserAgent, "CLI/2.63.2 CodeBuddy/2.63.2");
  });
  check("INTL presents the desktop-app identity", () => {
    assert.strictEqual(REGION_PROFILES.intl.clientUserAgent, "WorkBuddy/1.0");
  });
  check("the two regions do NOT share one UA (neither works for both)", () => {
    assert.notStrictEqual(REGION_PROFILES.cn.clientUserAgent, REGION_PROFILES.intl.clientUserAgent);
  });

  console.log("\nheaders — signed in");
  const authed = await captureHeaders({
    accessToken: "tok",
    userId: "u-1",
    // This is the value that used to be sent and silently broke everything.
    enterpriseId: "0",
    region: "intl",
  });
  check("sends the region's User-Agent", () => {
    assert.strictEqual(authed.headers["User-Agent"], "WorkBuddy/1.0");
  });
  check("sends the bearer token", () => {
    assert.strictEqual(authed.headers["Authorization"], "Bearer tok");
  });
  check("does NOT send a literal X-Enterprise-Id (it narrows INTL 21 -> 18)", () => {
    assert.strictEqual(authed.headers["X-Enterprise-Id"], undefined);
  });
  check("does NOT send X-User-Id when a token is present", () => {
    assert.strictEqual(authed.headers["X-User-Id"], undefined);
  });
  check("asks the cluster's own /v3/config", () => {
    assert.strictEqual(authed.url, "https://www.codebuddy.ai/v3/config");
  });
  check("INTL asks with X-Requested-With, like the desktop app", () => {
    assert.strictEqual(authed.headers["X-Requested-With"], "XMLHttpRequest");
  });

  console.log("\nheaders — anonymous");
  const anon = await captureHeaders({ userId: "0", region: "cn" });
  check("sends X-User-Id 0, which is what unlocks the public catalog", () => {
    assert.strictEqual(anon.headers["X-User-Id"], "0");
  });
  check("still sends no X-Enterprise-Id", () => {
    assert.strictEqual(anon.headers["X-Enterprise-Id"], undefined);
  });
  check("CN does not send X-Requested-With", () => {
    assert.strictEqual(anon.headers["X-Requested-With"], undefined);
  });

  console.log("\nheaders — a REAL enterprise id is the one exception");
  const ent = await captureHeaders({
    accessToken: "tok",
    userId: "u-1",
    enterpriseId: "ent-abc",
    region: "cn",
  });
  check("both ids go out together for a real enterprise", () => {
    assert.strictEqual(ent.headers["X-Enterprise-Id"], "ent-abc");
    assert.strictEqual(ent.headers["X-User-Id"], "u-1");
  });

  console.log("\nanonymous helper (the logged-out picker path)");
  {
    const realFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url, headers: init.headers };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            agents: [{ name: "cli", models: ["hy3"] }],
            models: [{ id: "hy3", name: "Hy3" }],
          },
        }),
      };
    };
    try {
      await fetchModelConfigAnonymous("intl");
    } finally {
      globalThis.fetch = realFetch;
    }
    check("it really does call /v3/config", () => {
      assert.strictEqual(captured.url, "https://www.codebuddy.ai/v3/config");
    });
    check("sends an id (without one the endpoint answers with an empty list)", () => {
      assert.strictEqual(captured.headers["X-User-Id"], "0");
    });
    check("and still no X-Enterprise-Id", () => {
      assert.strictEqual(captured.headers["X-Enterprise-Id"], undefined);
    });
  }

  console.log(`\n${passed} checks passed`);
})();
