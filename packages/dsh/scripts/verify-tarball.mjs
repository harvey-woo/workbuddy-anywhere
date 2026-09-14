/**
 * Verify the RELEASED tarball actually installs and loads.
 *
 * Why this exists: `@wbaw/core` is `private: true` and must never be
 * published, so the plugin has to ship it inlined. A `tsc` build, a green
 * typecheck and even a "successful" esbuild run all pass while the published
 * artefact is broken — bundling CommonJS into an ESM file compiles fine and
 * then throws `Dynamic require of "https" is not supported` on the very first
 * `import`. Nothing else in the repo exercises that path, because in here
 * `@wbaw/core` IS resolvable and the bundle is never the thing under test.
 *
 * So this script packs the package, unpacks it into a throwaway tree, links
 * only the host-provided `@deepseek-ai/*` packages, and then loads it with a
 * resolve hook that makes `@wbaw/core` throw on sight.
 *
 * Why a hook rather than a sandbox from which core has simply been deleted: the
 * host packages have to stay reachable, they live in the monorepo's
 * `node_modules`, and Node resolves symlinks to their real path — so the module
 * graph escapes back into the workspace and core becomes reachable again no
 * matter where the sandbox sits. Blocking the specifier at the resolver asserts
 * the thing that actually matters, that nothing ASKS for `@wbaw/core`, and it
 * does so while the bundle's real dependencies still resolve normally.
 *
 * Asserts:
 *   1. the published entry point imports without throwing;
 *   2. `@wbaw/core` was never resolved while doing so;
 *   3. the Cordis plugin surface (`name`, `inject`, `Config`, `apply`) is intact;
 *   4. `Config` is parsed by the HOST's schemastery with the right defaults;
 *   5. `ui-dist/` — the management page — actually shipped.
 *
 * Usage: node scripts/verify-tarball.mjs
 */

import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const pkg = JSON.parse(await readFile(path.join(pkgRoot, "package.json"), "utf8"));
const shortName = pkg.name.split("/")[1];

const stage = path.join(pkgRoot, ".verify-release");
const packDir = path.join(stage, "pack");
const sandbox = path.join(stage, "sandbox");

let failures = 0;
const ok = (msg) => console.log(`  ok  ${msg}`);
const bad = (msg) => {
  failures++;
  console.error(`  BAD ${msg}`);
};

console.log(`verify-tarball: ${pkg.name}@${pkg.version}`);

await rm(stage, { recursive: true, force: true });
await mkdir(packDir, { recursive: true });
await mkdir(path.join(sandbox, "node_modules", "@wbaw"), { recursive: true });

// ── Pack ────────────────────────────────────────────────────────────────────
// `prepack` rebuilds (strictly), so the tarball under test matches the source.
const tarballName = execFileSync(
  "npm",
  ["pack", "--pack-destination", packDir, "--silent"],
  { cwd: pkgRoot, encoding: "utf8" }
)
  .trim()
  .split("\n")
  .pop();
console.log(`  ..  packed ${tarballName}`);

// ── Install into a throwaway tree ───────────────────────────────────────────
const installed = path.join(sandbox, "node_modules", "@wbaw", shortName);
await mkdir(installed, { recursive: true });
execFileSync("tar", [
  "-xzf",
  path.join(packDir, tarballName),
  "-C",
  installed,
  "--strip-components=1",
]);

// Host-provided packages only. Anything the plugin fails to find here, it is
// expected to have inlined into itself.
const hostScope = path.join(pkgRoot, "node_modules", "@deepseek-ai");
try {
  await access(hostScope);
} catch {
  bad("host @deepseek-ai/* is not installed — run `yarn install` first");
}
await symlink(hostScope, path.join(sandbox, "node_modules", "@deepseek-ai"), "dir");

// ── Probe, run INSIDE the sandbox ───────────────────────────────────────────
const probe = path.join(sandbox, "probe.mjs");
await writeFile(
  probe,
  `
import { registerHooks } from "node:module";

// Installed BEFORE the plugin is imported: any attempt to reach the private
// workspace package throws instead of silently resolving through the monorepo.
let coreRequests = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@wbaw/core" || specifier.startsWith("@wbaw/core/")) {
      coreRequests++;
      throw new Error("@wbaw/core must not be required by a released plugin");
    }
    return nextResolve(specifier, context);
  },
});

const fail = (m) => { console.error("BAD " + m); process.exit(1); };

let mod;
try {
  mod = await import(${JSON.stringify(pkg.name)});
} catch (err) {
  fail("import failed: " + (err && err.message));
}
console.log("ok  entry point imports");

if (coreRequests !== 0)
  fail("@wbaw/core was resolved " + coreRequests + " time(s) during import");
console.log("ok  @wbaw/core never resolved");

if (mod.name !== ${JSON.stringify(pkg.name)}) fail("bad name: " + mod.name);
console.log("ok  name = " + mod.name);

if (!Array.isArray(mod.inject) || !mod.inject.includes("llm"))
  fail("bad inject: " + JSON.stringify(mod.inject));
console.log("ok  inject = " + JSON.stringify(mod.inject));

if (typeof mod.apply !== "function") fail("apply is not a function");
console.log("ok  apply is a function");

// Parsed by the HOST schemastery: proves schema identity was not duplicated.
const cfg = mod.Config({});
if (cfg.providers.join(",") !== "workbuddy,workbuddy-intl")
  fail("bad default providers: " + JSON.stringify(cfg.providers));
console.log("ok  Config parsed by host schemastery; providers = " + cfg.providers.join(","));

if (!cfg.dataDir) fail("dataDir default missing");
console.log("ok  dataDir = " + cfg.dataDir);

const { access } = await import("node:fs/promises");
const root = new URL("./node_modules/@wbaw/" + ${JSON.stringify(shortName)} + "/", import.meta.url);
try {
  await access(new URL("ui-dist/index.html", root));
} catch {
  fail("ui-dist/index.html missing from the tarball");
}
console.log("ok  ui-dist/index.html shipped");
`
);

let stdout = "";
try {
  stdout = execFileSync(process.execPath, [probe], { cwd: sandbox, encoding: "utf8" });
} catch (err) {
  stdout = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
}

for (const line of stdout.trim().split("\n")) {
  if (line.startsWith("ok ")) ok(line.slice(3));
  else if (line.startsWith("BAD ")) bad(line.slice(4));
}
if (!stdout.includes("ok ") && !stdout.includes("BAD ")) {
  bad(`sandbox probe produced no result:\n${stdout}`);
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures === 0) {
  await rm(stage, { recursive: true, force: true });
  console.log(
    `\nverify-tarball: OK — ${tarballName} installs and loads without @wbaw/core.`
  );
} else {
  console.error(
    `\nverify-tarball: ${failures} check(s) FAILED. Artifacts left in ` +
      `${path.relative(process.cwd(), stage)} for inspection.`
  );
  process.exit(1);
}
