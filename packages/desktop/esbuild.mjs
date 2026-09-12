/**
 * Bundles the Electron main process and preload, then stages the shared
 * management UI and the tray icon next to them.
 *
 * The UI is the SAME built bundle the VS Code webview and the local HTTP
 * server serve — copied rather than rebuilt, so a screen cannot exist on one
 * host and be missing on another.
 */
import esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");
const coreDir = path.resolve(here, "..", "core");
const uiOut = path.join(outDir, "ui");
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  // Provided by the Electron runtime; bundling it would break the require.
  external: ["electron"],
  logLevel: "info",
};

const entries = [
  { entryPoints: [path.join(here, "src", "main.ts")], outfile: path.join(outDir, "main.js") },
  { entryPoints: [path.join(here, "src", "preload.ts")], outfile: path.join(outDir, "preload.js") },
];

async function stageUi() {
  const src = path.join(coreDir, "ui-dist");
  try {
    await rm(uiOut, { recursive: true, force: true });
    await mkdir(uiOut, { recursive: true });
    await cp(src, uiOut, { recursive: true });
  } catch (err) {
    console.error(`[esbuild] could not stage the management UI from ${src}`);
    console.error("[esbuild] build it first: yarn workspace @wbaw/core ui:build");
    throw err;
  }
  console.log(`[esbuild] management UI -> ${path.relative(here, uiOut)}`);
}

/**
 * The tray icon: a black-with-alpha template image at 18pt plus its @2x twin,
 * generated from the extension's brand mark by scripts/make-tray-icons.sh.
 * Both are committed, so `compile` needs no image tooling installed.
 */
async function stageTrayIcons() {
  for (const name of ["trayTemplate.png", "trayTemplate@2x.png", "icon.png"]) {
    await cp(path.join(here, "assets", name), path.join(outDir, name));
  }
  console.log("[esbuild] icons -> out/trayTemplate.png(+@2x), out/icon.png");
}

if (watch) {
  for (const entry of entries) {
    const ctx = await esbuild.context({ ...shared, ...entry });
    await ctx.watch();
  }
  await stageUi();
  await stageTrayIcons();
  console.log("[esbuild] watching (UI is staged once; re-run after ui:build)");
} else {
  await Promise.all(entries.map((entry) => esbuild.build({ ...shared, ...entry })));
  await stageUi();
  await stageTrayIcons();
}
