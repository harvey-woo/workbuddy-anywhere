# WorkBuddy Anywhere — DeepSeek Harness (dsh) plugin

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
routes model requests to **WorkBuddy Anywhere**, mirroring the VS Code
**Copilot** extension (`workbuddy-anywhere-for-copilot`). It is the same idea in
a different host: register WorkBuddy models with the harness's LLM seam, list
them in the harness's model picker, and give a status interaction — all by
reusing `@wbaw/core` in-process.

## What it does (vs. the Copilot extension)

| Copilot extension | dsh plugin (`@wbaw/dsh-workbuddy`) |
| --- | --- |
| Registers `codebuddy` / `codebuddy-intl` `LanguageModelChatProvider`s | Registers `workbuddy` / `workbuddy-intl` `LlmAdapter` routes on `ctx.llm` |
| Lists server catalog as VS Code LM models | Serves catalog via `listModels` / `resolveModel` (written into dsh config) |
| Streams via `@wbaw/core` `WorkbuddyService` | Streams via the same `WorkbuddyService` |
| Status-bar item → management webview | `workbuddy.status` / `workbuddy.manage` commands |
| Reads VS Code settings for accounts/models | Reads `~/.workbuddy-anywhere` files (shared with desktop app & `wbaw serve`) |

## Design — reuse, don't reimplement

The plugin is a thin Cordis plugin (`name` / `inject` / `Config` / `apply`). The
only host-specific code is the translation between dsh's `StreamChunk` /
`Message` vocabulary and wbaw's `ChatEvent` / `ChatMessage` (see
`src/translate.ts`). Everything protocol-shaped — auth, multi-account, model
catalog, SSE, tool-call recovery, thinking-effort, quota refresh — is delegated
to `@wbaw/core`, exactly as copilot does.

The plugin and the desktop app / HTTP server share the **same on-disk login**
(`~/.workbuddy-anywhere/codebuddy-auth.json` + `workbuddy-settings.json`) through
core's `FileAuthStore` / `FileSettingsStore`, so you log in once and every host
sees the same accounts.

## Build

Requires Node.js 22+ (dsh's engine floor) and the dsh packages on npm.

```bash
cd dsh-plugin
npm install        # installs @deepseek-ai/* + @wbaw/core (via file:)
npm run build      # tsc -> lib/
```

`@wbaw/core` is pulled from the sibling `../packages/core` (built with
`yarn workspace @wbaw/core build`). Its `out/` types back this plugin.

## Load into dsh

Build first, then mount as an out-of-tree plugin. Easiest: add the `plugins`
block from `cordis.patch.yml` to `$DSH_HOME/cordis.patch.yml`, pointing `path`
at the absolute path of `dsh-plugin/lib/index.js`. Alternatively, once
published, `dsh plugin add llm-workbuddy`.

Verify the routes mounted:

```bash
dsh --profile web --dump-config
# -> look for `workbuddy` and `workbuddy-intl` under the llm provider routes.
```

Then any dsh agent loop can pick a `workbuddy` model and chat through
WorkBuddy Anywhere. The Models settings page lists the live catalog (fetched
from `/v3/config`, including the anonymous catalog when signed out), which is
the dsh equivalent of "writing models into config".

## Status interaction

```bash
dsh --profile web -- run "..."   # or the web command palette
# then invoke:
workbuddy.status   # prints active account / cluster / quota % / model count
workbuddy.manage   # opens the shared management surface (desktop app / wbaw serve)
```

## Notes / limitations

- Images are sent when dsh hands over raw bytes or a readable file path;
  otherwise the request degrades to text (core's built-in vision helper still
  describes images on the account's behalf, as in copilot).
- Reasoning is controlled via `modelConfiguration.reasoningEffort`, passed through
  to wbaw's thinking-effort resolver.
- A disabled model group (`workbuddy-settings.json` `enabled:false`, no
  auto-select) surfaces as a provider error, matching copilot's disabled state.
