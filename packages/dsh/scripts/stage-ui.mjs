/**
 * Stage the built management UI into this package.
 *
 * The UI is DATA, not code: it is the same static Vue SPA that serves the VS
 * Code webview, the desktop app and the standalone HTTP server. Copying it here
 * is what makes the plugin self-contained — `src/webui.ts` looks for
 * `<plugin>/ui-dist` FIRST, so an installed plugin never has to guess where the
 * monorepo put `@wbaw/core`.
 *
 * Run by `npm run build` after `tsc`. The destination is CLEARED first:
 * index.html references content-hashed asset filenames, so leaving a previous
 * build behind would let both generations pile up in a published tarball.
 */

import { cp, rm, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
/** Produced by `yarn workspace @wbaw/core ui:build`. */
const source = path.resolve(pkgRoot, "..", "core", "ui-dist");
const dest = path.join(pkgRoot, "ui-dist");

try {
  await access(source, constants.R_OK);
} catch {
  console.warn(
    `[stage-ui] no UI bundle at ${source} — the management page will be unavailable.\n` +
      `           Build it with: yarn workspace @wbaw/core ui:build`
  );
  process.exit(0);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(source, dest, { recursive: true });
console.log(`[stage-ui] ${path.relative(pkgRoot, source)} → ui-dist`);
