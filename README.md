# WorkBuddy Anywhere

Sign in to your WorkBuddy accounts **once**, then use them everywhere: VS Code Chat, a
menu-bar desktop app, or any client that speaks a standard model API.

Every account is kept alive in the background (token refresh and daily check-in run for
*all* of them, not just the active one), and every host shares one management UI.

## Packages

| Package | Name | What it is |
| ------- | ---- | ---------- |
| `packages/core` | `@wbaw/core` | Accounts, quota, model catalog, chat engine, the multi-protocol HTTP API and the shared Vue management UI |
| `packages/copilot` | `workbuddy-anywhere-for-copilot` | VS Code extension — WorkBuddy models in VS Code Chat |
| `packages/desktop` | `@wbaw/desktop` | Electron menu-bar app — the tray is home, the window is a page you open |

Only the VS Code extension is unscoped: its package `name` **is** its extension id, and
VS Code extension ids cannot carry an npm scope.

## The API

`workbuddy-anywhere serve` speaks three chat protocols on one port — the same three
`apiType` values VS Code's BYOK custom endpoints accept, so a client configured for any
of them works unchanged:

| Protocol | Endpoint | Account marker |
| -------- | -------- | -------------- |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `Authorization: Bearer <key>` |
| Anthropic Messages | `POST /v1/messages` | `x-api-key: <key>` |
| OpenAI Responses | `POST /v1/responses` | `Authorization: Bearer <key>` |

Model listing is `GET /v1/models` (shared by OpenAI and Anthropic; the shape follows the
`anthropic-version` header). Interactive docs are at `/docs`.

The account key is a plain SELECTOR, not a secret: the server hosts the signed-in
accounts, so a caller is choosing whose quota to spend rather than proving an identity.
Omitting it uses the currently selected account; `GET /api/state` lists the keys.

## Setup

```bash
yarn install
```

**Electron**: `electron` ships without its runtime binary (the `postinstall` script was
removed upstream). If `node_modules/electron/path.txt` is missing:

```bash
cd node_modules/electron && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
```

## Common tasks

```bash
yarn build      # compile every package (also builds the management UI)
yarn test       # protocol mapping tests for core
yarn workspace workbuddy-anywhere-for-copilot package   # -> .vsix
yarn workspace @wbaw/desktop start                      # run the desktop app
yarn workspace @wbaw/desktop smoke                      # CDP checks against a running app
```

Icon assets are generated, not hand-edited:

```bash
yarn workspace @wbaw/desktop icons
```

## Versioning

All three packages ship in lock-step — the root `package.json` `version`
field is the single source of truth, and `yarn sync:version` keeps every
workspace pinned to it. Changes are recorded as changesets; CI fails the
build when any pending change lacks one:

```bash
yarn changeset              # add a .changeset/*.md describing the change
yarn changeset:status      # what's still un-bumped?
yarn version-packages      # consumes changesets, bumps root + workspaces
yarn sync:version          # force workspaces back to root (in case drift)
yarn ci:drift              # --check: exit 1 if any workspace != root
yarn release:tag           # git tag v<root-version> && git push --tags
```

PRs touching source should `yarn changeset` in the same commit; the
version bump itself happens on the release commit via
`yarn version-packages && yarn sync:version && yarn release:tag`.

## Conventions worth knowing

Some identifiers still say `codebuddy`, and deliberately so — they are **state**, not
descriptions:

| Identifier | Why it cannot change |
| ---------- | -------------------- |
| `codebuddy.*` settings keys | Existing `settings.json` / Settings Sync would stop applying |
| LM provider `vendor: "codebuddy"` | It is the model-cache key in VS Code |
| `codebuddy-auth.json` | The session file every install already has |
| `codebuddy-chat` publisher | Changing it changes the extension id, which moves globalStorage |
| `Origin` / `User-Agent` on gateway requests | The upstream API expects them verbatim |

Everything user-visible says **WorkBuddy Anywhere**.
