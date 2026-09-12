/**
 * Bundle the extension into a single `out/extension.js`.
 *
 * Why a bundler instead of plain `tsc`: the extension now depends on the
 * workspace package `@wbaw/core`, and tsc would emit a bare
 * `require("@wbaw/core")`. That resolves fine in development (yarn
 * links the workspace into node_modules) but NOT inside a packaged .vsix, where
 * only the extension's own files ship. Bundling removes that whole class of
 * "works here, broken when installed" bugs.
 *
 * `vscode` is the one true external — the host injects it.
 */
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreUiDist = path.resolve(here, "..", "core", "ui-dist");
const uiDest = path.join(here, "media", "ui-dist");

const options = {
  entryPoints: [path.join(here, "src", "extension.ts")],
  outfile: path.join(here, "out", "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

/**
 * The management UI is DATA, not code: it is copied next to the bundle and
 * served into a webview. Copying (rather than importing) keeps it out of the
 * bundle and lets the same built assets serve the web UI, the desktop app and
 * the browser.
 *
 * CLEARED first: index.html references a content-hashed bundle, so leaving the
 * previous ones behind accumulates dead assets (six had built up in the VSIX)
 * and makes it impossible to tell which build is actually installed.
 */
async function copyUi() {
  try {
    await rm(uiDest, { recursive: true, force: true });
    await mkdir(path.dirname(uiDest), { recursive: true });
    await cp(coreUiDist, uiDest, { recursive: true });
    console.log(`[esbuild] management UI -> ${path.relative(here, uiDest)}`);
  } catch (err) {
    console.warn(
      `[esbuild] no UI bundle at ${coreUiDist} — the management page will be unavailable.\n` +
        `           Build it with: yarn workspace @wbaw/core ui:build\n` +
        `           (${err.message})`
    );
  }
}

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  await copyUi();
  console.log("[esbuild] watching for changes…");
} else {
  await build(options);
  await copyUi();
}
