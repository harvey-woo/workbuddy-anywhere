#!/usr/bin/env node
/**
 * Build and pack the dsh plugin for release.
 *
 * This is the "release dsh without publishing @wbaw/core" path. `@wbaw/core` is
 * `private: true`, so it can never go to a registry; the plugin gets it inlined
 * by `packages/dsh/esbuild.mjs` instead, and every `@deepseek-ai/*` package
 * stays a peer dependency resolved from the dsh installation that loads it.
 *
 * The result is one self-contained tarball that anyone can install with dsh's
 * own plugin command (which forwards to pnpm for them — the user never has to
 * know or care which package manager dsh uses internally):
 *
 *   dsh plugin --profile <name> add /path/to/<tarball>.tgz
 *
 * Steps, in order:
 *   1. build the shared UI  (core/ui-dist — the tarball bundles it)
 *   2. build the plugin     (esbuild inlines core, tsc emits .d.ts, UI staged)
 *   3. verify the tarball   (packs it and loads it with @wbaw/core blocked)
 *   4. publish the tarball  into release-<version>/
 *
 * Step 3 is the point of the script: it is the only step that runs the ACTUAL
 * published artifact, so a bundling mistake fails here rather than on someone
 * else's machine. It re-packs, so step 2 is really just for early feedback.
 *
 * Usage:
 *   node scripts/release-dsh.mjs             # build + verify + collect tarball
 *   node scripts/release-dsh.mjs --no-pack   # skip step 4 (just verify)
 */

import { execFileSync } from "node:child_process";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const version = JSON.parse(
  execFileSync("node", ["-p", "JSON.stringify(require('./package.json'))"], {
    cwd: root,
    encoding: "utf8",
  })
).version;

const PLUGIN = "@wbaw/dsh-workbuddy";
const pluginDir = path.join(root, "packages", "dsh");
const releaseDir = path.join(root, `release-${version}`);
const keepTarball = !process.argv.includes("--no-pack");

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", encoding: "utf8" });

console.log(`release:dsh ${version}`);

// 1. Shared UI — the tarball carries a copy of it.
console.log("\n[1/4] building management UI");
run("yarn", ["workspace", "@wbaw/core", "ui:build"], root);

// 2. Plugin (esbuild inlines @wbaw/core; prepack runs this again strictly,
//    so keep it a plain `build` here to surface errors with full output).
console.log("\n[2/4] building plugin");
run("yarn", ["workspace", PLUGIN, "build"], root);

// 3. The real gate: pack, install into a throwaway tree, load it.
console.log("\n[3/4] verifying the packed tarball");
run("yarn", ["workspace", PLUGIN, "verify:release"], root);

// 4. Collect the artifacts the verifier produced.
//    verify-tarball.mjs deletes its scratch tree on success, so pack again —
//    it is cheap and prepack has already run, so the bytes are identical.
if (keepTarball) {
  console.log(`\n[4/4] collecting tarball into release-${version}/`);
  const packDir = path.join(pluginDir, ".release-pack");
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packDir, { recursive: true });
  execFileSync(
    "npm",
    ["pack", "--pack-destination", packDir, "--silent"],
    { cwd: pluginDir, encoding: "utf8" }
  );

  await mkdir(releaseDir, { recursive: true });
  const produced = (await readdir(packDir)).filter((f) => f.endsWith(".tgz"));
  if (produced.length !== 1) {
    console.error(`expected exactly one tarball, got ${produced.length}`);
    process.exit(1);
  }
  const dest = path.join(releaseDir, produced[0]);
  await rename(path.join(packDir, produced[0]), dest);
  await rm(packDir, { recursive: true, force: true });

  console.log(`\ndone — ${path.relative(root, dest)}`);
  console.log("\nInstall it into a dsh profile with:");
  console.log(`  dsh plugin --profile <name> add ${dest}`);
} else {
  console.log("\ndone (tarball not collected)");
}
