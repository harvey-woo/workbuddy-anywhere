# WorkBuddy Anywhere — dsh plugin

English | [中文](README.zh.md)

Routes model requests in [dsh](https://github.com/deepseek-ai/deepseek-harness)
to **WorkBuddy Anywhere**. It registers `workbuddy` and `workbuddy-intl` LLM
provider routes, publishes the account's live model catalog to dsh's model
picker, and embeds the account management page in dsh Settings.

By default the plugin keeps its login in `~/.workbuddy-anywhere/` — the same
directory `wbaw serve` uses, so the CLI and dsh share one set of accounts. Other
hosts do not; see [Where accounts live](#where-accounts-live).

## Install

Requires dsh 0.1.5-rc.1 or newer.

```bash
dsh plugin --profile <name> add ./wbaw-dsh-workbuddy-0.7.0.tgz
```

`<name>` is the profile to install into — an existing one such as `web`, or a
new name, which dsh creates on first use. `dsh plugin` is dsh's own plugin
command; it installs the dependency and adds the plugin to that profile's bundle
list for you, so there is no manifest to edit by hand. A relative path like the
`./` above is resolved from the directory you run the command in, not from the
profile.

To install straight from a checkout instead of a tarball:

```bash
dsh plugin --profile <name> add /path/to/repo/packages/dsh
```

Git specs are **not** supported. `lib/` is git-ignored build output and dsh's
installer only builds a package at publish time, so a git install would land a
package with no entry point. Use a tarball or a checkout path.

### Verify the install

```bash
dsh --profile <name> --dump-config
```

The plugin and both of its provider routes should appear:

```
# == @wbaw/dsh-workbuddy
- id: dsh-workbuddy
  name: '@wbaw/dsh-workbuddy'
  config:
    providers:
      - workbuddy
      - workbuddy-intl
```

Then start dsh and pick a WorkBuddy model in the model picker.

### Uninstall

```bash
dsh plugin --profile <name> remove @wbaw/dsh-workbuddy
```

### The peer-dependency warning is expected

`add` prints a warning like this:

```
 WARN  Issues with peer dependencies found
└─┬ @wbaw/dsh-workbuddy 0.7.0
  ├── ✕ missing peer @deepseek-ai/cordis@^4.0.2
  └── ✕ missing peer @deepseek-ai/dsh-llm@^0.1.5-rc.1
```

Nothing is broken, and it cannot be avoided. Those packages are provided by the
dsh installation that loads the plugin, not by the profile, so there is nothing
for the installer to satisfy them from — dsh resolves them from its own tree at
runtime. The declarations are there to record which host versions the plugin
needs, and they are deliberately kept out of the regular dependencies (see
[Dependencies](#dependencies)).

## What you get in dsh

**WorkBuddy models in the picker.** Both clusters are registered as provider
routes, so dsh's Models settings page lists the live catalog fetched from
`/v3/config` — including an anonymous catalog when you are signed out. Marking a
model's group disabled in dsh surfaces as a provider error.

**A Workbuddy section in Settings.** The account management page, embedded in
dsh's settings panel: sign in (browser or QR code), switch and check in accounts,
toggle which models are offered, and adjust per-account options. This is where
you sign in the first time.

**A credits chip in the composer.** The input's right-hand side shows the active
account's remaining credits for the selected model's region; clicking it lets you
switch accounts or hand the choice back to automatic selection.

The Settings panel and the composer chip follow dsh's theme and language, and
updates stream in live — a language or theme change applies without a reload.

### Notes

- Images are sent when dsh hands over raw bytes or a readable file path;
  otherwise the request degrades to text and the built-in vision helper describes
  the image on the account's behalf.
- Thinking effort is controlled from dsh's per-model configuration
  (`modelConfiguration.reasoningEffort`).

## Where accounts live

Only dsh and the CLI share a login. Each host keeps its own credential store:

| Host | Store |
| --- | --- |
| dsh plugin, `wbaw serve`, `wbaw` CLI | `~/.workbuddy-anywhere/` |
| Desktop app (macOS) | `~/Library/Application Support/workbuddy-desktop/data/` |
| VS Code extension | that extension's VS Code `globalStorage` directory |

Signing in to one does not sign you in to another, so accounts you added in the
desktop app or in VS Code will not appear here, and vice versa.

That is deliberate for the desktop app rather than an oversight. Two processes
refreshing the same token race each other, and while every write is atomic
(temp file + rename) there is no cross-process lock — so a concurrent refresh
can drop a rotated token and sign the account out. The desktop app therefore
keeps its own copy on purpose.

To put the plugin's store somewhere else — including the desktop app's
directory, if you would rather have the shared login and accept that race —
override its config by `id` in the profile's `cordis.patch.yml`. Use an
**absolute** path; `~` is not expanded:

```yaml
- id: dsh-workbuddy
  config:
    dataDir: /Users/you/Library/Application Support/workbuddy-desktop/data
    providers:
      - workbuddy
      - workbuddy-intl
```

The override replaces `config` as a whole rather than merging into it, so repeat
any keys you want to keep. `providers` is listed above only to be explicit —
omitting it falls back to the schema default, which is both routes anyway.
Confirm with `dsh --profile <name> --dump-config`, whose output will read
`patched by …/cordis.patch.yml` on the plugin's row.

## Development

Requires Node 20+.

```bash
yarn install
yarn workspace @wbaw/dsh-workbuddy build
```

This bundles `src/` into a single `lib/index.js` with esbuild, emits type
declarations, and copies the shared management UI into `ui-dist/` so the package
carries its own copy. `client.js` — the browser half — is loaded as-is and is not
built. `yarn typecheck` type-checks without emitting.

### Release

```bash
yarn release:dsh
```

Builds, packs, verifies, and drops a tarball in `release-<version>/`. The
verification step is the point of the script: it installs the packed tarball into
a throwaway tree and loads it, so a broken bundle fails on the developer's
machine rather than on a user's. Run it on its own with
`yarn workspace @wbaw/dsh-workbuddy verify:release`.

### Dependencies

`@wbaw/core` is private and unpublished, so esbuild **inlines** it into
`lib/index.js`. It sits in `devDependencies` to keep it out of the install; the
build fails if it ever reappears in `dependencies` or if the emitted bundle still
references it.

Everything under `@deepseek-ai/*` stays external and is declared as a peer
dependency, so the plugin uses the host's copies instead of bundling its own.
Cordis registration, schemastery schemas and `LlmAdapter` / `LlmError` are all
compared by identity, and a second copy would silently mismatch.
