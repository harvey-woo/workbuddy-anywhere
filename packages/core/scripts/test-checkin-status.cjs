#!/usr/bin/env node
/**
 * Regression test for the daily check-in VERDICT (`src/billing.ts` +
 * `src/service.ts`).
 *
 * The bug this pins down: `/billing/meter/checkin-status` reports a seasonal
 * check-in ACTIVITY, not the daily bonus. With no activity running it returns
 * the whole block zeroed — `active:false` and `today_checked_in:false` — so
 * reading that flag as "today's bonus is unclaimed" reported a false
 * "not claimed yet" for accounts that had already claimed. Because
 * `refreshAllUsage()` re-read it on every refresh (startup warm-up, the Refresh
 * usage button, the tray, the region-follow refresh after a chat, the midnight
 * rollover), the correct verdict the claim had just established was erased
 * again and again. Verified live 2026-09-15: `daily-checkin` answered 10001
 * "今天已签到，请明天再来" for three accounts `checkin-status` called
 * `today_checked_in:false`.
 *
 * Nothing here touches the network: `globalThis.fetch` is stubbed with the
 * REAL payload shapes captured from the gateway.
 *
 * Run: node scripts/test-checkin-status.cjs
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { WorkbuddyService } = require("../out/service.js");
const { FileAuthStore } = require("../out/storage.js");
const { DEFAULT_SETTINGS } = require("../out/settings.js");
const { fetchCheckinStatus, ensureCheckin } = require("../out/billing.js");

// ── the real response shapes ────────────────────────────────────────────

/** Captured live: no check-in activity is running, so everything is zeroed. */
const ACTIVITY_OFF = {
  active: false,
  today_checked_in: false,
  streak_days: 0,
  daily_credit: 0,
  today_credit: 0,
  is_streak_day: false,
  next_streak_day: 0,
  streak_bonus_days: 0,
  streak_bonus_credit: 0,
  checkin_dates: null,
  week_checkin_days: 0,
  week_progress: [false, false, false, false, false, false, false],
  total_credits: 0,
  start_time: "",
  end_time: "",
  theme_name: "",
  season: 0,
  activity_name: "",
  claim_button_text: "",
  action_button: { show: false, text: "", action: "" },
};

/** An activity IS running and the user already claimed it today. */
const ACTIVITY_ON_CLAIMED = { ...ACTIVITY_OFF, active: true, today_checked_in: true };
/** An activity IS running and the user has not claimed it today. */
const ACTIVITY_ON_PENDING = { ...ACTIVITY_OFF, active: true };

const ALREADY_CLAIMED_TODAY = { code: 10001, msg: "今天已签到，请明天再来" };
const FRESH_CLAIM = { code: 0, msg: "OK", data: { credit: 300 } };

const BILLING_OK = {
  code: 0,
  data: {
    Response: {
      Data: {
        Accounts: [
          {
            AccountId: 1,
            PackageName: "Pro",
            PackageCode: "p_tcaca",
            CapacityRemain: 100,
            CapacitySize: 200,
            CycleCapacityRemain: 100,
            CycleCapacitySize: 200,
            CycleEndTime: "2026-10-01T00:00:00Z",
            Status: 0,
          },
        ],
      },
    },
  },
};

/** Minimal Response stand-in: `fetchBilling` uses json(), the rest use text(). */
function reply(status, body) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// ── harness ─────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const RealDate = globalThis.Date;
const calls = { status: 0, claim: 0 };

/** What the status endpoint answers for the next read. */
let statusPayload = ACTIVITY_OFF;
/** What the claim endpoint answers for the next claim. */
let claimPayload = ALREADY_CLAIMED_TODAY;

function stubFetch() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/billing/meter/checkin-status")) {
      calls.status += 1;
      return reply(200, { code: 0, msg: "OK", data: statusPayload });
    }
    if (u.endsWith("/billing/meter/daily-checkin")) {
      calls.claim += 1;
      // The real gateway answers HTTP 400 for "already claimed".
      return reply(claimPayload.code === 0 ? 200 : 400, claimPayload);
    }
    if (u.endsWith("/billing/meter/get-user-resource")) return reply(200, BILLING_OK);
    throw new Error(`unexpected fetch: ${u}`);
  };
}

/**
 * `Date` shifted by whole days, with `Date.now()` left REAL.
 *
 * `localDayKey` reads `new Date()`, so shifting it simulates "the next day"
 * without touching the clock the rest of the service uses for token expiry.
 */
function dateShiftedByDays(days) {
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + days * 86_400_000);
      else super(...args);
    }
    static now() {
      return RealDate.now();
    }
  }
  return ShiftedDate;
}

const ACCOUNT = {
  accessToken: "at",
  refreshToken: "rt",
  savedAt: Date.now(),
  expiresAt: Date.now() + 3600_000,
  userAgent: "test",
  uid: "1001",
  enterpriseId: "ent-a",
  nickname: "Alice",
  region: "cn",
};

let passed = 0;
async function check(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") await result;
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function main() {
  stubFetch();

  console.log("fetchCheckinStatus() must not invent a daily verdict");
  await check("no activity running -> unknown, NOT unclaimed", async () => {
    statusPayload = ACTIVITY_OFF;
    assert.deepStrictEqual(await fetchCheckinStatus(ACCOUNT), { state: "unknown" });
  });
  await check("activity running + claimed -> claimed", async () => {
    statusPayload = ACTIVITY_ON_CLAIMED;
    assert.deepStrictEqual(await fetchCheckinStatus(ACCOUNT), { state: "claimed" });
  });
  await check("activity running + not claimed -> unclaimed", async () => {
    statusPayload = ACTIVITY_ON_PENDING;
    assert.deepStrictEqual(await fetchCheckinStatus(ACCOUNT), { state: "unclaimed" });
  });

  console.log("ensureCheckin() must still CLAIM when the read is inconclusive");
  await check("an inconclusive read falls through to the claim endpoint", async () => {
    statusPayload = ACTIVITY_OFF;
    claimPayload = FRESH_CLAIM;
    const before = calls.claim;
    const result = await ensureCheckin(ACCOUNT);
    assert.strictEqual(calls.claim, before + 1, "the claim endpoint must be asked");
    assert.strictEqual(result.state, "claimed");
    assert.strictEqual(result.freshlyClaimed, true);
    assert.strictEqual(result.credit, 300);
  });
  await check("a confirmed claim skips the claim endpoint", async () => {
    statusPayload = ACTIVITY_ON_CLAIMED;
    const before = calls.claim;
    const result = await ensureCheckin(ACCOUNT);
    assert.strictEqual(calls.claim, before, "no need to claim what the gateway confirms");
    assert.strictEqual(result.state, "claimed");
  });
  await check("'already claimed today' is reported as claimed", async () => {
    statusPayload = ACTIVITY_OFF;
    claimPayload = ALREADY_CLAIMED_TODAY;
    const result = await ensureCheckin(ACCOUNT);
    assert.strictEqual(result.state, "claimed");
    assert.strictEqual(result.freshlyClaimed, undefined, "nothing was claimed just now");
  });

  // ── service level ─────────────────────────────────────────────────────

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-checkin-test-"));
  const store = new FileAuthStore(dir);
  await store.upsert(ACCOUNT);
  const settings = {
    get: async () => ({ ...DEFAULT_SETTINGS }),
    update: async () => ({ ...DEFAULT_SETTINGS }),
  };
  const service = new WorkbuddyService({ auth: store, settings, log: () => {} });
  const verdict = async () => (await service.getState()).accounts[0].checkin?.state;

  console.log("a refresh must not erase a verdict the claim established");
  await check("a read with no activity leaves the account unknown, not unclaimed", async () => {
    statusPayload = ACTIVITY_OFF;
    await service.refreshAllUsage();
    assert.strictEqual(await verdict(), "unknown");
  });
  await check("the sweep claims, and the account reads as claimed", async () => {
    statusPayload = ACTIVITY_OFF;
    claimPayload = ALREADY_CLAIMED_TODAY;
    await service.checkinAll();
    assert.strictEqual(await verdict(), "claimed");
  });
  await check("REGRESSION: a later refresh keeps it claimed", async () => {
    // The reported bug: every refresh (startup warm-up, Refresh usage, the
    // tray, the region-follow refresh after a chat, the rollover) re-read the
    // activity endpoint, believed its zeroed flag, and put the UI back to
    // "not claimed yet".
    statusPayload = ACTIVITY_OFF;
    await service.refreshAllUsage();
    assert.strictEqual(await verdict(), "claimed");
  });
  await check("a stale verdict from a previous day does NOT survive", async () => {
    // The other direction: a claim made yesterday says nothing about today, so
    // tomorrow's refresh must stop reporting it (and re-offer the button).
    statusPayload = ACTIVITY_OFF;
    globalThis.Date = dateShiftedByDays(1);
    try {
      await service.refreshAllUsage();
    } finally {
      globalThis.Date = RealDate;
    }
    assert.strictEqual(await verdict(), "unknown");
  });
  await check("a conclusive read still wins over the remembered verdict", async () => {
    // The activity endpoint IS the source of truth when an activity runs, so a
    // same-day "unclaimed" must be able to replace a same-day "claimed".
    statusPayload = ACTIVITY_ON_PENDING;
    claimPayload = ALREADY_CLAIMED_TODAY;
    await service.checkinAll();
    assert.strictEqual(await verdict(), "claimed");
    await service.refreshAllUsage();
    assert.strictEqual(await verdict(), "unclaimed");
  });

  service.dispose();
  globalThis.fetch = realFetch;
  globalThis.Date = RealDate;

  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  globalThis.fetch = realFetch;
  globalThis.Date = RealDate;
  console.error(`\nFAILED: ${err && err.message}`);
  process.exit(1);
});
