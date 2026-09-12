/**
 * Regression test for auto account selection (`src/pool.ts`).
 *
 * Covers the rules the feature was specced around:
 *   - session affinity FIRST: a fresh, eligible pin always wins, even when
 *     another account's credits expire sooner;
 *   - a pin whose account died (refresh error / quota gone) is dropped;
 *   - an idle pin (past the window) is dropped;
 *   - fresh picks are expiry-first: spend credits that die soonest;
 *   - tie-breaks: more remaining credits, then least-recently-used;
 *   - unmeasured accounts (no billing snapshot) stay eligible but sort last;
 *   - an account at/below the exhaustion threshold is not eligible.
 *
 * Run: node scripts/test-auto-select.cjs
 */
const assert = require("node:assert/strict");
const {
  pickAutoAccount,
  isEligible,
  isBillingStale,
  AUTO_SELECT_IDLE_MS,
} = require("../out/pool.js");

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    throw err;
  }
};

const NOW = 1_000_000_000_000;
const c = (over) => ({ key: "a", ...over });

(async () => {
  console.log("isEligible()");
  await check("unknown usage stays eligible", () =>
    assert.ok(isEligible(c({ key: "a" })))
  );
  await check("refresh error disqualifies", () =>
    assert.ok(!isEligible(c({ refreshError: "boom" })))
  );
  await check("exhausted account disqualifies", () =>
    assert.ok(!isEligible(c({ remain: 1 })))
  );
  await check("healthy account eligible", () =>
    assert.ok(isEligible(c({ remain: 500 })))
  );

  console.log("pickAutoAccount() — affinity first");
  await check("fresh pin wins over a soon-to-expire account", () => {
    const picked = pickAutoAccount(
      [
        c({ key: "pinned", remain: 900, soonestExpiry: NOW + 30 * 864e5 }),
        c({ key: "dying", remain: 10, soonestExpiry: NOW + 3600e3 }),
      ],
      { key: "pinned", lastUsedAt: NOW - 1000 },
      NOW
    );
    assert.strictEqual(picked, "pinned");
  });
  await check("pin is dropped when its account hits a refresh error", () => {
    const picked = pickAutoAccount(
      [
        c({ key: "pinned", refreshError: "401" }),
        c({ key: "other", remain: 5, soonestExpiry: NOW + 864e5 }),
      ],
      { key: "pinned", lastUsedAt: NOW - 1000 },
      NOW
    );
    assert.strictEqual(picked, "other");
  });
  await check("pin is dropped when its quota is gone", () => {
    const picked = pickAutoAccount(
      [
        c({ key: "pinned", remain: 1 }),
        c({ key: "other", remain: 50, soonestExpiry: NOW + 864e5 }),
      ],
      { key: "pinned", lastUsedAt: NOW - 1000 },
      NOW
    );
    assert.strictEqual(picked, "other");
  });
  await check("idle pin (past window) is dropped", () => {
    const picked = pickAutoAccount(
      [
        c({ key: "pinned", remain: 900 }),
        c({ key: "dying", remain: 10, soonestExpiry: NOW + 3600e3 }),
      ],
      { key: "pinned", lastUsedAt: NOW - AUTO_SELECT_IDLE_MS - 1 },
      NOW
    );
    assert.strictEqual(picked, "dying");
  });

  console.log("pickAutoAccount() — fresh allocation");
  await check("soonest-expiring credits win", () => {
    const picked = pickAutoAccount(
      [
        c({ key: "big", remain: 5000, soonestExpiry: NOW + 30 * 864e5 }),
        c({ key: "dying", remain: 10, soonestExpiry: NOW + 3600e3 }),
      ],
      undefined,
      NOW
    );
    assert.strictEqual(picked, "dying");
  });
  await check("same expiry: more credits win", () => {
    const at = NOW + 864e5;
    const picked = pickAutoAccount(
      [
        c({ key: "small", remain: 10, soonestExpiry: at }),
        c({ key: "large", remain: 400, soonestExpiry: at }),
      ],
      undefined,
      NOW
    );
    assert.strictEqual(picked, "large");
  });
  await check("same expiry+credits: least recently used wins", () => {
    const at = NOW + 864e5;
    const picked = pickAutoAccount(
      [
        c({ key: "recent", remain: 100, soonestExpiry: at, lastUsedAt: NOW - 1000 }),
        c({ key: "idle", remain: 100, soonestExpiry: at, lastUsedAt: NOW - 60_000 }),
      ],
      undefined,
      NOW
    );
    assert.strictEqual(picked, "idle");
  });
  await check("never-used account beats a used one on the LRU tie-break", () => {
    const picked = pickAutoAccount(
      [
        c({ key: "used", remain: 100, soonestExpiry: NOW + 864e5, lastUsedAt: NOW - 1000 }),
        c({ key: "fresh", remain: 100, soonestExpiry: NOW + 864e5 }),
      ],
      undefined,
      NOW
    );
    assert.strictEqual(picked, "fresh");
  });
  await check("unmeasured account sorts last but stays eligible", () => {
    const picked = pickAutoAccount(
      [
        c({ key: "unknown" }),
        c({ key: "measured", remain: 10, soonestExpiry: NOW + 3600e3 }),
      ],
      undefined,
      NOW
    );
    assert.strictEqual(picked, "measured");
    const only = pickAutoAccount([c({ key: "unknown" })], undefined, NOW);
    assert.strictEqual(only, "unknown");
  });
  await check("all ineligible -> null (caller falls back)", () => {
    const picked = pickAutoAccount([c({ remain: 0 }), c({ refreshError: "x" })], undefined, NOW);
    assert.strictEqual(picked, null);
  });

  console.log("isBillingStale()");
  await check("no snapshot is stale", () => assert.ok(isBillingStale(undefined, NOW)));
  await check("fresh snapshot is not stale", () =>
    assert.ok(!isBillingStale(NOW - 1000, NOW))
  );

  console.log(`\n${passed} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
