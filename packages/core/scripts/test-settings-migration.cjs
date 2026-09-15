#!/usr/bin/env node
/**
 * Regression test for the `enabled` → `enabledByRegion` split in
 * `src/settings.ts`.
 *
 * The global flag became a per-region map because the two clusters are two
 * independent groups in every host's model picker. Two things about that
 * change are easy to get wrong later and invisible when wrong, so they are
 * pinned here:
 *
 *   1. UPGRADE. A settings file written before the split carries only the
 *      global `enabled`. If the migration ignores it, a user who deliberately
 *      hid a group gets it back — silently, and with no UI state that explains
 *      why.
 *   2. PARTIAL WRITE. Both per-region settings are nested maps. A shallow
 *      `{...current, ...patch}` lets a patch carrying ONE region wipe the
 *      other, and the read-side sanitizer then restores the wiped key to its
 *      DEFAULT rather than to its previous value: data loss that reports as
 *      success.
 *
 * Run: node scripts/test-settings-migration.cjs
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { FileSettingsStore, DEFAULT_SETTINGS, SETTINGS_FILE } = require("../out/settings.js");

let passed = 0;
async function check(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") await result;
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** A store over a fresh temp dir holding exactly `contents` (or nothing). */
function storeWith(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-settings-"));
  if (contents !== undefined) {
    fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(contents, null, 2));
  }
  return new FileSettingsStore(dir);
}

async function main() {
  console.log("the split from a global `enabled` to per-region flags");

  await check("a pre-split file with enabled:false hides BOTH regions", async () => {
    // The case that matters: `false` is the value a user had to go out of their
    // way to choose, so losing it is the one upgrade failure they would notice
    // and could not explain.
    const store = storeWith({ enabled: false, region: "cn" });
    const settings = await store.get();
    assert.deepStrictEqual(
      settings.enabledByRegion,
      { cn: false, intl: false },
      "the legacy global false must seed both regions"
    );
  });

  await check("a pre-split file with enabled:true shows both regions", async () => {
    const store = storeWith({ enabled: true });
    const settings = await store.get();
    assert.deepStrictEqual(settings.enabledByRegion, { cn: true, intl: true });
  });

  await check("a file with neither key falls back to the defaults", async () => {
    const store = storeWith({ region: "intl" });
    const settings = await store.get();
    assert.deepStrictEqual(settings.enabledByRegion, DEFAULT_SETTINGS.enabledByRegion);
  });

  await check("missing file falls back to the defaults", async () => {
    const store = storeWith(undefined);
    const settings = await store.get();
    assert.deepStrictEqual(settings.enabledByRegion, DEFAULT_SETTINGS.enabledByRegion);
  });

  await check("once enabledByRegion exists, its keys win over the legacy flag", async () => {
    // Otherwise the post-split choice could never override the pre-split one,
    // and a user who re-enabled Global would watch it revert on next start.
    const store = storeWith({
      enabled: false,
      enabledByRegion: { cn: true, intl: false },
    });
    const settings = await store.get();
    assert.deepStrictEqual(
      settings.enabledByRegion,
      { cn: true, intl: false },
      "explicit per-region keys must beat the legacy global value"
    );
  });

  await check("a half-written map takes the legacy value for the missing key only", async () => {
    // "Explicit key wins, else the legacy seed, else the default" — one rule,
    // applied per key, so a hand-edited or partially-written file degrades
    // predictably instead of inventing a third behaviour.
    const store = storeWith({ enabled: false, enabledByRegion: { cn: true } });
    const settings = await store.get();
    assert.deepStrictEqual(settings.enabledByRegion, { cn: true, intl: false });
  });

  await check("a bogus enabled value is ignored, not coerced", async () => {
    // `enabled: "no"` is truthy, so a truthiness check would silently turn the
    // group ON. Only a real boolean may act as the seed.
    const store = storeWith({ enabled: "no" });
    const settings = await store.get();
    assert.deepStrictEqual(settings.enabledByRegion, DEFAULT_SETTINGS.enabledByRegion);
  });

  console.log("a partial patch must not wipe the other region");

  await check("update({cn}) leaves intl alone", async () => {
    const store = storeWith({ enabledByRegion: { cn: true, intl: false } });
    await store.update({ enabledByRegion: { cn: false } });
    const settings = await store.get();
    assert.deepStrictEqual(
      settings.enabledByRegion,
      { cn: false, intl: false },
      "intl was reset to its default by a patch that only mentioned cn"
    );
  });

  await check("update({intl}) leaves cn alone", async () => {
    const store = storeWith({ enabledByRegion: { cn: false, intl: true } });
    await store.update({ enabledByRegion: { intl: false } });
    const settings = await store.get();
    assert.deepStrictEqual(settings.enabledByRegion, { cn: false, intl: false });
  });

  await check("the same holds for checkinByRegion", async () => {
    // Same hazard, same guard: the two maps are merged in one loop, so a
    // regression that drops one of them should fail here too.
    const store = storeWith({ checkinByRegion: { cn: true, intl: true } });
    await store.update({ checkinByRegion: { intl: false } });
    const settings = await store.get();
    assert.deepStrictEqual(settings.checkinByRegion, { cn: true, intl: false });
  });

  await check("an unrelated patch does not disturb either map", async () => {
    const store = storeWith({ enabledByRegion: { cn: false, intl: true } });
    await store.update({ region: "intl" });
    const settings = await store.get();
    assert.deepStrictEqual(settings.enabledByRegion, { cn: false, intl: true });
    assert.strictEqual(settings.region, "intl");
  });

  await check("a legacy global false survives a write that only sets region", async () => {
    // The seed must reach DISK, not just the reader: a later write rebuilds the
    // file from `get()`, so if the migration only lived in the reader the
    // value would be lost on the very next unrelated update.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-settings-"));
    fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ enabled: false }));
    const store = new FileSettingsStore(dir);
    await store.update({ region: "intl" });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), "utf-8"));
    assert.deepStrictEqual(
      raw.enabledByRegion,
      { cn: false, intl: false },
      "the migrated value was not persisted"
    );
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
