#!/usr/bin/env node
// Sync the root package.json `version` into every workspace's
// package.json so the three products ship in lock-step.
//
// Why a custom script on top of changesets:
//   Changesets' `fixed` group correctly bumps workspace packages together
//   based on per-PR changesets, but the SOURCE of truth for "what version
//   are we shipping right now" is the root. After every changesets bump we
//   overwrite the workspace versions with the root version, so:
//     - the user-visible version in every product's package.json matches
//     - `git diff` of a release commit never shows drift between root and
//       any workspace
//   Changesets keeps tracking changes via its .changeset/*.md files; this
//   script only runs AFTER `yarn version-packages` to align the numbers.
//
// Usage:
//   node scripts/sync-version.mjs           # copy root -> workspaces
//   node scripts/sync-version.mjs --check   # exit 1 if any drift
//
// Wired into root package.json scripts:
//   yarn sync:version     - apply
//   yarn version-packages - apply then this
//   yarn ci:drift         - --check (CI guard)

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const rootVersion = rootPkg.version;
if (!rootVersion) {
  console.error("root package.json has no version");
  process.exit(1);
}

const packagesDir = join(root, "packages");
const targets = readdirSync(packagesDir)
  .filter((name) => statSync(join(packagesDir, name)).isDirectory())
  .map((name) => join(packagesDir, name, "package.json"));

let drift = [];
let changed = [];
for (const file of targets) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.version === rootVersion) continue;
  drift.push(`${file.replace(`${root}/`, "")}: ${pkg.version} -> ${rootVersion}`);
  if (!process.argv.includes("--check")) {
    pkg.version = rootVersion;
    writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    changed.push(file);
  }
}

if (process.argv.includes("--check")) {
  if (drift.length) {
    console.error("Workspace version drift from root:");
    drift.forEach((d) => console.error("  " + d));
    console.error(`\nRun: yarn sync:version`);
    process.exit(1);
  }
  console.log(`OK — root and ${targets.length} workspaces at ${rootVersion}`);
  process.exit(0);
}

if (changed.length === 0) {
  console.log(`Already in sync at ${rootVersion} (${targets.length} workspaces).`);
} else {
  console.log(`Aligned to root ${rootVersion}:`);
  changed.forEach((c) => console.log("  " + c.replace(`${root}/`, "")));
}
