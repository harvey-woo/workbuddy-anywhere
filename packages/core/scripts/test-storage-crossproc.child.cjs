#!/usr/bin/env node
/**
 * Child half of `test-storage-crossproc.cjs`.
 *
 * A separate file on purpose: the point is a REAL second process. Two
 * `FileAuthStore` instances inside one process share a JS event loop and are
 * ordered by the in-process queue alone, which would prove nothing about the
 * cross-process lock. Spawning this file makes `withFileLock` do actual work.
 *
 * Usage:
 *   node test-storage-crossproc.child.cjs auth     <dir> <index> <count>
 *   node test-storage-crossproc.child.cjs settings <dir> <index>
 */

const { FileAuthStore } = require("../out/storage.js");
const { FileSettingsStore } = require("../out/settings.js");

const [mode, dir, index, count] = process.argv.slice(2);

(async () => {
  if (mode === "auth") {
    const store = new FileAuthStore(dir);
    for (let i = 0; i < Number(count); i += 1) {
      const uid = `p${index}-${i}`;
      await store.upsert({
        accessToken: `at-${uid}`,
        refreshToken: `rt-${uid}`,
        savedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        userAgent: "child",
        uid,
        region: "cn",
      });
    }
  } else if (mode === "settings") {
    // Each child owns a key nobody else writes, so a correct (serialised)
    // update must leave every key in place. A lost update shows up as a
    // missing key rather than as a value that "wins".
    const store = new FileSettingsStore(dir);
    await store.update({ [`probe${index}`]: Number(index) });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  process.exit(0);
})().catch((err) => {
  console.error(`child ${mode}/${index} failed: ${err.message}`);
  process.exit(1);
});
