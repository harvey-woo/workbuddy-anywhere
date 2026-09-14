/**
 * Bundle the plugin into a single `lib/index.js`.
 *
 * Why a bundler instead of plain `tsc`: this package depends on the workspace
 * package `@wbaw/core`, which is `private: true` and is NEVER published. tsc
 * would emit a bare `import … from "@wbaw/core"`, which resolves fine in this
 * monorepo (yarn links the workspace) but not for anyone who installs the
 * published tarball — `@wbaw/core` simply does not exist on the registry.
 * Bundling inlines it, so the plugin ships self-contained and the release is
 * buildable and installable without publishing core.
 *
 * What stays EXTERNAL is everything this package declares in `dependencies`
 * AND `peerDependencies` — most importantly every `@deepseek-ai/*` package.
 * Those must be the HOST's copies, not ours: cordis plugin registration,
 * `schemastery` schema identity (our `Config` is validated by dsh), and
 * `LlmAdapter` / `LlmError` (which dsh compares by identity when it drives our
 * adapter) would all silently fail to match against a second bundled copy.
 * Reading the list from the manifest keeps this correct as deps come and go.
 *
 * `client.js` is NOT built here: it is the browser half, served verbatim and
 * resolved by dsh's module loader, so it is already free of bundler concerns.
 */
import { build, context } from "esbuild";
import { readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));

/** Declared runtime deps are installed by the consumer → keep them as imports. */
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

// Fail loudly rather than shipping a tarball that cannot resolve its own
// imports: `@wbaw/core` is unpublished, so it must be inlined, never external.
if (external.includes("@wbaw/core")) {
  console.error(
    `[esbuild] @wbaw/core is listed in "dependencies".\n` +
      `          It is private and never published, so the released plugin would fail to\n` +
      `          install. Move it to "devDependencies" so it gets bundled instead.`
  );
  process.exit(1);
}

const outfile = path.join(here, "lib", "index.js");
/** `ui-dist` is produced by stage-ui.mjs; lib/ is ours alone. */
const libDir = path.join(here, "lib");

// CLEARED first: `tsc` used to emit one file per source module here, and those
// stale sibling files still `import "@wbaw/core"`. Leaving them behind would
// ship dead files that fail to resolve in an installed plugin — exactly the
// class of bug this bundling change exists to remove.
await rm(libDir, { recursive: true, force: true });

const options = {
  entryPoints: [path.join(here, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  // The package is `"type": "module"` and dsh loads it as ESM.
  format: "esm",
  target: "node20",
  external,
  sourcemap: true,
  logLevel: "info",
  banner: {
    // `@wbaw/core` is CommonJS (`require("https")`, `require("crypto")`), and
    // bundling CJS into an ESM output leaves esbuild no way to express those
    // calls: its generated `__require` helper defers to a `require` binding if
    // one exists and otherwise throws "Dynamic require is not supported". In an
    // ESM module there is no `require`, so without this banner the published
    // plugin dies on import.
    //
    // This is esbuild's documented remedy and it is semantically correct here:
    // the plugin really is loaded from a file URL, so the host's own
    // resolution rules are what node builtins should be resolved against.
    js: 'import{createRequire as __wbawCreateRequire}from"node:module";const require=__wbawCreateRequire(import.meta.url);',
  },
};

/**
 * Verify the artefact, not the build: assert the emitted file does not mention
 * the unpublished package. A build that "succeeds" while leaving a bare
 * `@wbaw/core` import would only fail later, on someone else's machine.
 */
async function verify() {
  const emitted = await readFile(outfile, "utf8");
  // Check for actual import/require of @wbaw/core, not string literals in
  // error messages (e.g. "run: yarn workspace @wbaw/core ui:build").
  const hasImport = /(?:import|require)\s*(?:\(|\S.*from\s*)["']@wbaw\/core["']/.test(emitted);
  if (hasImport) {
    console.error(
      `[esbuild] ${path.relative(here, outfile)} has unresolved import of "@wbaw/core".\n` +
        `          The release would not install. Check for a non-literal import\n` +
        `          that esbuild could not inline.`
    );
    process.exit(1);
  }
  console.log(
    `[esbuild] ${path.relative(here, outfile)} — @wbaw/core inlined, ` +
      `${external.length} runtime dep(s) external`
  );
}

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[esbuild] watching for changes…");
} else {
  await build(options);
  await verify();
}
