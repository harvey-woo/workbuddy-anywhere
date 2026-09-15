#!/usr/bin/env node
/**
 * Load the built extension without VS Code and drive it.
 *
 * Why this exists: the extension is a host for core, and the interesting
 * failures are wiring failures — a stale import, a settings key that no longer
 * exists, an auth store pointed at the wrong directory, a provider that never
 * registers. None of those need a real editor window to catch, and all of them
 * are painful to find by launching an Extension Development Host.
 *
 * It is SAFE: the stub's `globalStorageUri` points at a throwaway directory, so
 * the developer's own VS Code session and credentials are never touched. The
 * account used is synthetic, and its tokens are deliberately invalid so nothing
 * can be refreshed or spent.
 *
 * Run: node scripts/smoke-extension.cjs
 */

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const BUNDLE = path.join(__dirname, "..", "out", "extension.js");

/**
 * The RPC channel between the management page and its host.
 *
 * Mirrors `RPC_CHANNEL` in core's `src/rpc.ts`. A wrong value is not silent:
 * the host handler returns early on an unknown channel, so no reply is posted
 * and the checks that use it fail with "no reply to …".
 */
const RPC_CHANNEL = "workbuddy-rpc";

// ── The throwaway workspace ─────────────────────────────────────────────

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ext-smoke-"));
/** Where VS Code would put THIS extension id's globalStorage. */
const storage = path.join(userData, "codebuddy-chat.workbuddy-anywhere-for-copilot");
/**
 * Where the PRE-RENAME id's globalStorage is, and where the user's session
 * really is. The checks below only pass if the extension reads through to it —
 * a rename must not look like being signed out.
 */
const legacyStorage = path.join(userData, "codebuddy-chat.codebuddy-chat");
fs.mkdirSync(legacyStorage, { recursive: true });

/** A pre-split (v1) auth file, so the migration path is exercised too. */
fs.writeFileSync(
  path.join(legacyStorage, "codebuddy-auth.json"),
  JSON.stringify(
    {
      accessToken: "fake-access-token",
      refreshToken: "fake-refresh-token",
      savedAt: Date.now(),
      // Far future: the 60s refresh tick must never fire.
      expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
      userAgent: "smoke",
      uid: "smoke-user",
      nickname: "Smoke Test",
    },
    null,
    2
  )
);

// ── A stub `vscode` ─────────────────────────────────────────────────────

const disposables = [];
const disposable = (fn) => {
  const d = { dispose: fn ?? (() => {}) };
  disposables.push(d);
  return d;
};

const registered = {
  // EVERY registration, by vendor. The extension registers two (CN + Global),
  // and keeping only the last one made the assertion below depend on source
  // order: it read "the last registered vendor is codebuddy" while the code
  // registers codebuddy FIRST and codebuddy-intl second, so it could never
  // pass. A Map keyed by vendor says what the test actually means.
  providers: new Map(),
  /** Pinned to the CN provider so downstream checks do not race source order. */
  provider: undefined,
  commands: new Map(),
};
const statusBar = { text: "", tooltip: undefined, shown: false, command: undefined };
const panels = [];
const settings = {
  thinkingEffort: "auto",
  visionFallbackModel: "",
  customModels: [],
  enabledByRegion: { cn: true, intl: true },
};

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return disposable(() => this.listeners.delete(listener));
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

class CancellationTokenSource {
  constructor() {
    this.token = { isCancellationRequested: false, onCancellationRequested: () => disposable() };
  }
  dispose() {}
}

class MarkdownString {
  constructor() {
    this.value = "";
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
}

const partClass = (name) => {
  const cls = class {
    constructor(...args) {
      this[name] = args;
      Object.assign(this, Object.fromEntries(args.map((a, i) => [`arg${i}`, a])));
    }
  };
  Object.defineProperty(cls, "name", { value: name });
  return cls;
};

const vscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  // Values match the real enum: the status bar compares by value, so the mock
  // must not invent a different ordering or the palette picks the wrong theme.
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ViewColumn: { Active: -1, One: 1 },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  EventEmitter,
  CancellationTokenSource,
  MarkdownString,
  LanguageModelTextPart: partClass("LanguageModelTextPart"),
  LanguageModelToolCallPart: partClass("LanguageModelToolCallPart"),
  LanguageModelToolResultPart: partClass("LanguageModelToolResultPart"),
  LanguageModelDataPart: partClass("LanguageModelDataPart"),
  LanguageModelChatMessage: {
    User: (...args) => ({ role: 1, content: args.length === 1 ? args[0] : args }),
    Assistant: (...args) => ({ role: 2, content: args.length === 1 ? args[0] : args }),
  },
  Uri: {
    parse: (value) => ({ toString: () => value }),
    joinPath: (base, ...parts) => ({
      toString: () => `${base.toString()}/${parts.join("/")}`,
      fsPath: `${base.fsPath}/${parts.join("/")}`,
    }),
  },
  env: { openExternal: async () => true },
  commands: {
    registerCommand(id, handler) {
      registered.commands.set(id, handler);
      return disposable();
    },
    executeCommand: async () => undefined,
  },
  lm: {
    registerLanguageModelChatProvider(vendor, provider) {
      registered.providers.set(vendor, provider);
      // Deleting on dispose matters now: the extension applies
      // `settings.enabledByRegion` by adding and removing these registrations,
      // so the Map has to reflect what is LIVE rather than what has ever been
      // registered. The real host behaves the same way — the docs for this
      // call say the disposable "unregisters the provider when disposed".
      return disposable(() => registered.providers.delete(vendor));
    },
    selectChatModels: async () => [],
  },
  window: {
    activeColorTheme: { kind: 2 /* Dark */ },
    onDidChangeActiveColorTheme: () => disposable(),
    createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
    createWebviewPanel(viewType, title, _column, _options) {
      const panel = {
        viewType,
        title,
        /**
         * The webview half of the RPC bridge.
         *
         * `onDidReceiveMessage` stores the host handler here instead of
         * discarding it, and `webview.postMessage` records replies — together
         * they let a test drive the SAME path the management page uses
         * (post a `workbuddy-rpc` envelope, get a reply), which is the only way
         * to prove that path works independently of the command palette.
         */
        onMessage: undefined,
        replies: [],
        async send(message) {
          assert.ok(panel.onMessage, "the panel never subscribed to messages");
          await panel.onMessage(message);
        },
        webview: {
          html: "",
          asWebviewUri: (uri) => ({ toString: () => uri.toString(), fsPath: uri.fsPath }),
          onDidReceiveMessage: (cb) => {
            panel.onMessage = cb;
            return disposable();
          },
          postMessage: async (m) => {
            panel.replies.push(m);
            return true;
          },
        },
        /**
         * Counted, because "opened the page" has two honest outcomes: the first
         * call creates the panel, later ones reveal the one that already exists.
         * A test that only watched `panels.length` would read a reveal as a
         * no-op and call the command broken.
         */
        reveals: 0,
        reveal() {
          this.reveals += 1;
        },
        onDidDispose: () => disposable(),
        dispose() {},
      };
      panels.push(panel);
      return panel;
    },
    createStatusBarItem: () => ({
      show() {
        statusBar.shown = true;
      },
      dispose() {},
      get text() {
        return statusBar.text;
      },
      set text(value) {
        statusBar.text = value;
      },
      get tooltip() {
        return statusBar.tooltip;
      },
      set tooltip(value) {
        statusBar.tooltip = value;
      },
      get command() {
        return statusBar.command;
      },
      set command(value) {
        statusBar.command = value;
      },
    }),
    showQuickPick: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key in settings ? settings[key] : fallback),
      update: async (key, value) => {
        settings[key] = value;
      },
    }),
    fs: {
      readFile: async (uri) => fs.promises.readFile(uri.fsPath),
    },
  },
};

// Intercept the `vscode` module BEFORE loading the bundle.
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return vscode;
  return originalLoad.call(this, request, ...rest);
};

// Stub the BILLING endpoints only, so the quota path is exercised with a known
// payload. Everything else (notably /v3/config) still goes to the real gateway:
// the point is to test OUR wiring, and the catalog is already covered by core's
// own tests.
const BILLING_ACCOUNTS = [
  {
    AccountId: 1,
    PackageName: "专业版月付",
    PackageCode: "p_pro_monthly",
    CapacityRemain: 900,
    CapacitySize: 1000,
    CycleCapacityRemain: 900,
    CycleCapacitySize: 1000,
    CycleEndTime: "2026-10-01T00:00:00Z",
    Status: 0,
  },
  {
    AccountId: 2,
    PackageName: "加油包",
    PackageCode: "p_boost",
    CapacityRemain: 350,
    CapacitySize: 1000,
    CycleCapacityRemain: 350,
    CycleCapacitySize: 1000,
    CycleEndTime: "2026-09-20T00:00:00Z",
    Status: 0,
  },
];

const realFetch = globalThis.fetch;
/**
 * Every quota read, so tests can assert that a refresh ACTUALLY happened
 * rather than that a number merely looks right — a stale cached figure and a
 * freshly fetched one are indistinguishable from the rendered value alone.
 */
const billingCalls = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const json = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  if (url.includes("/billing/meter/get-user-resource")) {
    billingCalls.push(url);
    return json({ code: 0, data: { Response: { Data: { Accounts: BILLING_ACCOUNTS } } } });
  }
  if (url.includes("/billing/meter/checkin-status")) {
    return json({ code: 0, data: { today_checked_in: true, credit: 50 } });
  }
  if (url.includes("/billing/meter/daily-checkin")) {
    return json({ code: 10001 });
  }
  return realFetch(input, init);
};

// ── Drive it ────────────────────────────────────────────────────────────

let passed = 0;
async function check(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") await result;
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function main() {
  console.log("activation");
  const extension = require(BUNDLE);

  await check("activate() does not throw", () => {
    extension.activate({
      subscriptions: disposables,
      extensionUri: { fsPath: path.join(__dirname, ".."), toString: () => "" },
      globalStorageUri: { fsPath: storage, toString: () => storage },
    });
  });

  await check("BOTH model groups are registered (codebuddy + codebuddy-intl)", async () => {
    // Two vendors, not one: the picker lists them separately so a model from
    // one cluster never appears under the other, and so the user can tell
    // which quota a request will spend.
    //
    // Registration is applied from `settings.enabledByRegion`, which is read
    // asynchronously on activation — so wait for it rather than assuming the
    // synchronous registration an earlier version did.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && registered.providers.size < 2) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepStrictEqual(
      [...registered.providers.keys()].sort(),
      ["codebuddy", "codebuddy-intl"],
      "both vendors must be registered"
    );
  });

  await check("the manifest and the runtime agree about which commands exist", () => {
    // The manifest is what VS Code offers in the palette; the runtime is what
    // can actually answer. Either direction of mismatch is a defect — a
    // palette entry that throws, or a command nobody can reach.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
    );
    const declared = (manifest.contributes?.commands ?? []).map((c) => c.command);
    const runtime = [...registered.commands.keys()].sort();

    assert.deepStrictEqual(
      declared,
      ["codebuddy.openPanel", "codebuddy.manageProvider"],
      "both panel entry points must be declared: the palette command and the gears' hook"
    );

    // Declared is not the same as visible. The gears' hook has to be declared so
    // the manifest's `managementCommand` resolves, but it must be hidden from the
    // palette or the page gets a second entry that silently switches clusters.
    // This asserts the VISIBLE set, which is what the user actually sees.
    const hidden = (manifest.contributes?.menus?.commandPalette ?? [])
      .filter((m) => m.when === "false")
      .map((m) => m.command);
    assert.deepStrictEqual(
      hidden,
      ["codebuddy.manageProvider"],
      "the gears' hook must be the only palette-hidden command"
    );
    assert.deepStrictEqual(
      declared.filter((id) => !hidden.includes(id)),
      ["codebuddy.openPanel"],
      "the palette should expose exactly one entry — everything else moved into the page"
    );

    // Wired to the hover card's footer links. Deliberately NOT declared: they
    // are the card's buttons, and a palette entry would offer a second,
    // context-free way to do the same thing.
    const hoverOnly = ["codebuddy.checkinAll", "codebuddy.refreshUsage"];
    assert.deepStrictEqual(
      runtime.filter((id) => !declared.includes(id)),
      hoverOnly,
      "unexpected runtime-only command(s)"
    );

    // Both vendors' picker gears must resolve, or the gear renders and does
    // nothing. VS Code ignores `managementCommand` unless the manifest also
    // leaves the provider-level `configuration` out (see chatModelsWidget).
    for (const p of manifest.contributes?.languageModelChatProviders ?? []) {
      assert.ok(
        declared.includes(p.managementCommand),
        `${p.vendor}: managementCommand "${p.managementCommand}" is not a declared command`
      );
      assert.strictEqual(
        p.configuration,
        undefined,
        `${p.vendor}: a provider-level configuration makes VS Code IGNORE managementCommand`
      );
    }
  });

  await check("the status bar is shown", () => {
    assert.ok(statusBar.shown, "status bar item was never shown");
  });

  await check("the status bar opens the MANAGEMENT PAGE, not a native menu", async () => {
    // The whole point of the interaction change: one complete page instead of a
    // QuickPick that can only show a subset of it.
    const handler = registered.commands.get(statusBar.command);
    assert.ok(handler, `status bar is wired to an unknown command: ${statusBar.command}`);
    assert.strictEqual(
      statusBar.command,
      "codebuddy.openPanel",
      "the status bar must use the user-facing entry, not the gears' hook — a click carries no vendor"
    );

    const before = panels.length;
    await handler();
    assert.strictEqual(panels.length, before + 1, "no management panel was opened");
    assert.match(panels[panels.length - 1].title, /WorkBuddy Anywhere/);
  });

  await check("the palette entry opens the page and leaves the region alone", async () => {
    // A user typing "open panel" makes no claim about which cluster they are
    // working with, so this path must NOT carry the gears' vendor semantics. And
    // a second invocation must reveal the page rather than stack another one.
    const open = registered.commands.get("codebuddy.openPanel");
    assert.ok(open, "the palette command is not registered");

    const original = settings.region;
    settings.region = "intl";
    const before = panels.length;
    await open();

    assert.strictEqual(panels.length, before, "a second panel was opened");
    assert.strictEqual(
      panels[panels.length - 1].reveals,
      1,
      "the existing page was not revealed"
    );
    assert.strictEqual(settings.region, "intl", "opening the page must not move the region");
    settings.region = original;
  });

  await check("that page talks to the HOST, not over http", async () => {
    // If the injected transport were wrong the page would silently try to fetch
    // a local server that does not exist in VS Code.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !panels[panels.length - 1].webview.html) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const html = panels[panels.length - 1].webview.html;
    assert.ok(html.includes('"transport":"vscode"'), "webview transport is not vscode");
  });

  console.log("the model catalog reaches VS Code");
  const token = new CancellationTokenSource().token;
  let models = [];
  // The catalog comes from the REAL gateway (see the fetch stub above), and
  // the synthetic account only carries a session for one cluster — the other
  // answers anonymously or not at all. So the provider under test is whichever
  // one actually reports models. The previous version read
  // `registered.provider` (i.e. "the last one registered") and therefore
  // silently depended on source order rather than on the check it claimed.
  //
  // Polling is cheap: `provideLanguageModelChatInformation` reads the
  // provider's cache; the network call happened once during activation.
  // init() runs in the background, so wait for the catalog to land. Everything
  // that depends on activation having finished is checked after this point.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && models.length === 0) {
    for (const provider of registered.providers.values()) {
      const candidate = await provider.provideLanguageModelChatInformation(
        { silent: true },
        token
      );
      if (candidate.length > 0) {
        registered.provider = provider;
        models = candidate;
        break;
      }
    }
    if (models.length === 0) await new Promise((r) => setTimeout(r, 250));
  }

  console.log("credentials (zero migration, including the rename)");
  await check("the v1 auth file was found through the PRE-RENAME directory and migrated", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(legacyStorage, "codebuddy-auth.json"), "utf-8"));
    assert.strictEqual(raw.version, 2, "the file should have been upgraded in place");
    assert.deepStrictEqual(Object.keys(raw.accounts), ["smoke-user"]);
    assert.ok(
      !fs.existsSync(path.join(storage, "codebuddy-auth.json")),
      "the session must not be duplicated into the new id's directory"
    );
  });

  await check("models are offered (core's catalog is wired in)", () => {
    assert.ok(registered.provider, "neither vendor returned a catalog after 20s");
    assert.ok(models.length > 0, "no models after 20s — is the catalog reachable?");
  });
  console.log(`      ${models.length} models, e.g. ${models.slice(0, 3).map((m) => m.id).join(", ")}`);

  await check("the duplicate-registration guard still holds", async () => {
    const perGroup = await registered.provider.provideLanguageModelChatInformation(
      { silent: true, configuration: { apiKey: "x" } },
      token
    );
    assert.deepStrictEqual(perGroup, [], "per-group calls must return nothing");
  });

  await check("each model carries the fields VS Code needs", () => {
    for (const m of models) {
      assert.strictEqual(typeof m.id, "string");
      assert.strictEqual(typeof m.name, "string");
      assert.ok(m.maxInputTokens > 0, `${m.id}: no input budget`);
      assert.ok(m.maxOutputTokens > 0, `${m.id}: no output budget`);
      assert.strictEqual(typeof m.capabilities.toolCalling, "boolean");
    }
  });

  await check("EVERY reasoning model still offers 'off'", () => {
    // Deliberate: the server's `onlyReasoning` flag may mean "cannot stop
    // thinking", but that reading is unverified and the pre-split code recorded
    // the opposite for hy3. Hiding the option would remove a capability users
    // have today, so the flag only softens the LABEL instead.
    const withSchema = models.filter((m) => m.configurationSchema);
    assert.ok(withSchema.length > 0, "expected at least one reasoning model");
    for (const m of withSchema) {
      const effort = m.configurationSchema.properties.reasoningEffort;
      assert.ok(effort, `${m.id}: schema has no reasoningEffort`);
      assert.ok(
        Array.isArray(effort.enum) && effort.enum.includes("off"),
        `${m.id}: lost the ability to turn thinking off`
      );
      assert.strictEqual(effort.enumDescriptions.length, effort.enum.length);
    }
  });

  await check("token counting returns a number", async () => {
    const count = await registered.provider.provideTokenCount(models[0], "hello world", token);
    assert.ok(Number.isFinite(count) && count > 0);
  });

  console.log("the status bar reflects the CURRENT account");
  await check("a tooltip was set at all", () => {
    assert.ok(statusBar.tooltip, "no tooltip was set");
  });

  await check("it uses the ORIGINAL icon id", () => {
    // `$(codebuddy)` is not a registered icon and renders as literal text; the
    // declared one is `codebuddy-icon` (package.json -> contributes.icons).
    assert.ok(
      statusBar.text.startsWith("$(codebuddy-icon)"),
      `status bar text is: ${statusBar.text}`
    );
  });

  await check("the bar is icon + the chosen region's balance", () => {
    // The slot is ~90px wide, so the number is compacted: the stubbed billing
    // payload sums to 1250 remaining of 2000, i.e. 1.3k. It is CREDITS, not a
    // percentage — a percentage alone cannot tell you whether 30% is a week
    // or an afternoon of work.
    assert.strictEqual(
      statusBar.text,
      "$(codebuddy-icon) 1.3k",
      `expected "$(codebuddy-icon) 1.3k", got: ${statusBar.text}`
    );
  });

  await check("the hover is an SVG card with ONE ROW PER REGION", () => {
    const md = String(statusBar.tooltip.value ?? statusBar.tooltip);
    assert.match(md, /data:image\/svg\+xml/, "tooltip is not an SVG card");

    const encoded = md.match(/data:image\/svg\+xml;utf8,([^)]+)/);
    assert.ok(encoded, "the SVG data URI is malformed");
    const svg = decodeURIComponent(encoded[1]);

    assert.match(svg, /CodeBuddy/, "missing the card title");

    // Both regions must be present even when one has no account: a missing
    // row reads as "this cluster does not exist", which is a different claim
    // from "you have not signed in there".
    assert.match(svg, /中国大陆/, "missing the CN row");
    assert.match(svg, /Global/, "missing the Global row");

    // The per-package table was removed on purpose: the hover is a glance at
    // "how much is left", and the management page already answers "which
    // pack are these credits coming from" in full.
    assert.doesNotMatch(svg, /套餐/, "the package table came back");

    // The stubbed check-in reports today as already claimed, so the CN row
    // must carry that state — a card that silently drops it would leave the
    // user claiming again every day.
    assert.match(svg, /今日已签到/, "the CN check-in state is missing");

    // Emoji were removed in favour of type and colour: they render at
    // inconsistent widths across platforms, which is what made the old card
    // look ragged. Nothing in the card should be outside the Basic
    // Multilingual Plane's symbol blocks.
    assert.doesNotMatch(svg, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "emoji came back");

    // The card is a baked image, so its palette cannot come from CSS vars.
    // A dark-theme render must therefore use the dark foreground — a
    // hard-coded light grey is what made it unreadable on a light theme.
    assert.match(svg, /fill="#d4d4d4"/, "the dark palette was not applied");
  });

  await check("the hover actions are buttons, on one row with the refresh time", () => {
    const md = String(statusBar.tooltip.value ?? statusBar.tooltip);
    // A tooltip is inert without command links; `isTrusted` is what makes
    // them clickable rather than stripped.
    assert.ok(statusBar.tooltip.isTrusted, "the tooltip is not trusted — links would be stripped");
    assert.match(md, /command:codebuddy\.refreshUsage/, "missing the refresh link");

    // Every button, in row order. Each is an `<img>` holding an SVG, wrapped in
    // the anchor so the whole control is the click target. A `<span>` capsule
    // was tried first and cannot work: an inline box's background is sized by
    // font metrics (~16px) and `padding` is stripped by the sanitizer, so it can
    // never be anything but a label. `width`/`height` exist only on a replaced
    // element.
    const imgs = [...md.matchAll(/<a href="command:([\w.]+)" title="[^"]*"><img src="data:image\/svg\+xml;utf8,([^"]+)" width="(\d+)" height="(\d+)" alt="([^"]+)"><\/a>/g)];
    assert.ok(imgs.length >= 1, "no buttons found");

    const buttons = imgs.map((m) => ({
      command: m[1],
      svg: decodeURIComponent(m[2]),
      width: Number(m[3]),
      height: Number(m[4]),
      alt: m[5],
    }));
    const refresh = buttons.find((b) => b.command === "codebuddy.refreshUsage");
    assert.ok(refresh, "the refresh button is absent");

    // Sized like a control, not like text. This is the assertion that catches a
    // regression back to a label-sized chip.
    for (const b of buttons) {
      assert.strictEqual(b.height, 26, `${b.alt}: height is ${b.height}, expected 26`);
      assert.ok(b.width >= 40, `${b.alt}: width is ${b.width}px — too narrow to read as a control`);
      assert.match(b.svg, /<text[^>]*font-size="12"[^>]*text-anchor="middle"/, `${b.alt}: label is not centred at 12px`);
    }

    // ⚠ THE ALIGNMENT INVARIANT. The FIRST button in the row must carry a
    // transparent left gutter equal to the card's own `PAD_X`, because that is
    // the only way its capsule can line up with the card's left inset: the
    // cell offset is the host's (it ships no `td` padding for hovers, so the
    // browser default applies) and is not readable or settable from here.
    //
    // This must hold whichever button leads — with check-in available the
    // leading button is 签到, without it the leading button is 刷新. That is
    // exactly the case that regressed once, so it is asserted per-position
    // rather than on a hard-coded button.
    const leadingBox = buttons[0].svg.match(/<rect x="(\d+)" width="(\d+)" height="26" rx="4"/);
    assert.ok(leadingBox, `${buttons[0].alt}: no rounded surface`);
    assert.strictEqual(
      leadingBox[1],
      "10",
      `${buttons[0].alt} (leading button) has no 10px gutter — it cannot align with the card`
    );
    // Non-leading buttons must NOT repeat the gutter, or the gap between two
    // buttons doubles.
    for (const b of buttons.slice(1)) {
      const box = b.svg.match(/<rect x="(\d+)"/);
      assert.strictEqual(box[1], "0", `${b.alt} should not repeat the leading gutter`);
    }

    // A primary action and a secondary one must not share a surface colour, or
    // there is no hierarchy between "claim" and "refresh".
    if (buttons.length > 1) {
      const fill = (b) => b.svg.match(/<rect[^>]*fill="(#[0-9a-f]{6})"/)[1];
      assert.notStrictEqual(
        fill(buttons[0]),
        fill(refresh),
        "the check-in and refresh buttons have the same surface colour"
      );
    }

    // De-emphasised relative to 13px body text, and clearly labelled as a time.
    assert.match(md, /<small>更新 \d{2}:\d{2}<\/small>/, "the refresh time is missing or unlabelled");

    // One table, two rows: the card, then the actions. Both rows take the same
    // cell offset, which is what makes the first button line up with the card's
    // own left inset without knowing what that offset is.
    //
    // `width` must be the CARD width in PIXELS: `100%` resolves against the
    // hover's available width, which is wider than the card, and the tooltip
    // stretches to it — pushing the timestamp far right of the card's edge.
    assert.match(
      md,
      /<table width="420"><tbody><tr><td colspan="2"><img src="data:image\/svg\+xml;utf8,[^"]+" width="420" alt="CodeBuddy usage"><\/td><\/tr><tr><td>.*<\/td><td align="right"><small>更新 \d{2}:\d{2}<\/small><\/td><\/tr><\/tbody><\/table>/,
      "the card and the actions are not two rows of one fixed-width table"
    );

    // The card must NOT also be emitted as a standalone markdown image: that
    // would put it back on the paragraph grid and reintroduce the offset the
    // table exists to cancel.
    assert.doesNotMatch(
      md,
      /!\[CodeBuddy usage\]/,
      "the card is still a standalone markdown image outside the table"
    );
  });

  // ── the tracked region follows the vendor actually used ──────────────
  //
  // The user-visible requirement: send a message through a vendor and the
  // displayed quota must belong to THAT cluster. An earlier attempt only
  // messaged the (usually closed) management webview, so nothing on screen
  // changed — these checks are what that regression failed.
  console.log("the tracked region follows the vendor");

  /** Wait for the fire-and-forget settings write the provider triggers. */
  async function awaitRegion(region, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && settings.region !== region) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return settings.region;
  }

  /**
   * Drive one turn through a vendor and report the region that got written.
   *
   * The provider fires its event BEFORE it touches the network, so the region
   * must flip even though this turn cannot succeed — the fixture's credentials
   * are deliberately fake. The rejection is expected and swallowed; letting it
   * escape would fail the test for the wrong reason.
   */
  async function sendThrough(vendor, modelId) {
    const provider = registered.providers.get(vendor);
    assert.ok(provider, `no provider for ${vendor}`);
    const attempt = provider
      .provideLanguageModelChatResponse(
        { id: modelId },
        [],
        {},
        { report() {} },
        token
      )
      .then(
        () => "completed",
        () => "failed (expected — fake credentials)"
      );
    // Do not let a slow or hanging network call hold the test suite open.
    await Promise.race([attempt, new Promise((r) => setTimeout(r, 3_000))]);
    return attempt;
  }

  await check("a turn through the INTL vendor switches the tracked region", async () => {
    settings.region = "cn"; // start from the opposite of what we expect
    await sendThrough("codebuddy-intl", "default-model");
    const region = await awaitRegion("intl");
    assert.strictEqual(
      region,
      "intl",
      `the region did not follow the vendor (still ${region})`
    );
  });

  await check("and back again — it is not a one-way latch", async () => {
    await sendThrough("codebuddy", "default");
    const region = await awaitRegion("cn");
    assert.strictEqual(region, "cn", `the region did not follow back (still ${region})`);
  });

  await check("a region switch also re-reads quota", async () => {
    // The figures on screen belong to the region just left, so the switch must
    // refetch them. Counted, not assumed: the billing stub is the observable.
    settings.region = "cn";
    billingCalls.length = 0;
    await sendThrough("codebuddy-intl", "default-model");
    await awaitRegion("intl");
    // Give the background refresh a moment to land after the settings write.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && billingCalls.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(
      billingCalls.length > 0,
      "switching region did not re-read any quota — the card would show the old cluster's numbers"
    );
  });

  // ── the model group really is controlled by the setting ───────────────
  //
  // The switch lives on the Models tab and writes `settings.enabledByRegion`
  // over RPC; `service.onChange` fans that out to `syncModelGroup`, which adds
  // or removes that vendor's providers. That is the WHOLE path — the palette
  // has a single entry and it only opens the page — so these checks cover the
  // control end to end.
  //
  // Before this worked, the setting only made core refuse chat, and only while
  // auto-select was off, so the switch looked inert in half the configurations.
  console.log("the model-group switch controls the group");

  /** Poll until `predicate` holds, or give up. */
  async function waitFor(predicate, what, ms = 5_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !predicate()) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(predicate(), `timed out waiting for ${what}`);
  }

  /** Post one RPC envelope at the panel, exactly as the page does. */
  async function rpc(method, params, id) {
    const panel = panels[panels.length - 1];
    const before = panel.replies.length;
    await panel.send({ channel: RPC_CHANNEL, id, method, params });
    const reply = panel.replies.slice(before).find((m) => m.id === id);
    assert.ok(reply, `no reply to ${method} — wrong channel, or the handler bailed`);
    assert.ok(!reply.error, `${method} failed: ${reply.error?.message}`);
    return reply.result;
  }

  /** Provider instances as they were before the toggle, for an identity check. */
  const providersBefore = new Map(registered.providers);

  await check("switching a region OFF withdraws ONLY that region's provider", async () => {
    assert.strictEqual(providersBefore.size, 2, "expected two providers to start with");
    // The Models page writes the whole map (it owns both keys), so send the
    // same shape it does: CN off, Global left alone.
    await rpc("updateSettings", { enabledByRegion: { cn: false, intl: true } }, 9001);

    // The write fans out asynchronously, so the assertion has to wait rather
    // than read the Map immediately.
    await waitFor(
      () => !registered.providers.has("codebuddy"),
      "the CN provider to be unregistered"
    );
    // The heart of the change: the two clusters are independent groups, so
    // switching one off must not touch the other. A shared flag would fail
    // here, and the user would see the Models page's switch "stick" when they
    // changed region.
    assert.strictEqual(
      registered.providers.get("codebuddy-intl"),
      providersBefore.get("codebuddy-intl"),
      "the Global provider was withdrawn too — the two regions are not independent"
    );
    assert.deepStrictEqual(
      settings.enabledByRegion,
      { cn: false, intl: true },
      "the setting itself must have been written, not just the registration"
    );
  });

  await check("switching it back ON re-registers the SAME provider instance", async () => {
    await rpc("updateSettings", { enabledByRegion: { cn: true, intl: true } }, 9002);
    await waitFor(() => registered.providers.size === 2, "the providers to come back");
    assert.deepStrictEqual(
      [...registered.providers.keys()].sort(),
      ["codebuddy", "codebuddy-intl"],
      "the same two vendors must return"
    );
    // Identity, not equality: disposing a REGISTRATION must not dispose the
    // provider, or its cached catalog and emitters are gone and the picker
    // comes back empty until the next refresh. Global was never withdrawn, so
    // it must be the very same object it was before anything was switched.
    for (const [vendor, provider] of providersBefore) {
      assert.strictEqual(
        registered.providers.get(vendor),
        provider,
        `${vendor}: re-registration created a new provider — the cached catalog was dropped`
      );
    }
  });

  await check("each region's group follows its OWN flag", async () => {
    // Front-to-back: Global off, CN on — and assert the host really is in that
    // state rather than trusting the two calls above.
    await rpc("updateSettings", { enabledByRegion: { cn: true, intl: false } }, 9003);
    await waitFor(
      () => !registered.providers.has("codebuddy-intl"),
      "only the Global provider to be withdrawn"
    );
    assert.ok(
      registered.providers.has("codebuddy"),
      "the CN provider was withdrawn — the switch is not keyed by region"
    );

    // Restore, so later checks see the baseline the fixture declared.
    await rpc("updateSettings", { enabledByRegion: { cn: true, intl: true } }, 9004);
    await waitFor(() => registered.providers.size === 2, "both providers to return");
  });

  await check("an install from before the split keeps its choice", async () => {
    // The path that actually ships: VS Code keeps these under `codebuddy.*`, so
    // an install that predates the per-region split has `enabled` and no
    // `enabledByRegion`. Reading it as the seed is what stops a group the user
    // deliberately hid from reappearing on upgrade — and the read goes through
    // the REAL adapter, so this fails if only the file store migrates.
    const fixture = settings.enabledByRegion;
    delete settings.enabledByRegion;
    settings.enabled = false;

    const migrated = await rpc("getState", {}, 9005);
    assert.deepStrictEqual(
      migrated.settings.enabledByRegion,
      { cn: false, intl: false },
      "the legacy global `enabled` was not used as the seed"
    );

    // And it must stop mattering the moment a real per-region choice exists,
    // or the user could never turn one back on.
    settings.enabledByRegion = { cn: true, intl: true };
    const explicit = await rpc("getState", {}, 9006);
    assert.deepStrictEqual(
      explicit.settings.enabledByRegion,
      { cn: true, intl: true },
      "the legacy flag overrode an explicit per-region choice"
    );

    delete settings.enabled;
    settings.enabledByRegion = fixture;
  });

  await check("the picker's gear for a vendor targets THAT cluster", async () => {
    // VS Code invokes a provider's `managementCommand` as
    // `executeCommand(cmd, vendor.vendor)` — the argument is the only thing that
    // distinguishes the two gears, because both vendors point at the same
    // command. Ignoring it (as an earlier version did) meant clicking the gear
    // beside the Global group opened a page that could be showing CN.
    const open = registered.commands.get("codebuddy.manageProvider");
    assert.ok(open, "the management command is not registered");

    settings.region = "cn";
    await open("codebuddy-intl");
    assert.strictEqual(
      await awaitRegion("intl"),
      "intl",
      "the Global gear must switch the tracked region to intl"
    );

    await open("codebuddy");
    assert.strictEqual(
      await awaitRegion("cn"),
      "cn",
      "the CN gear must switch it back"
    );
  });

  console.log(`\n${passed} checks passed`);

  // Visual review hook: geometry bugs (overlapping text, dead space, a bar
  // that reads as a slab) pass every textual assertion and are only visible
  // in a rendered image. Dumping the SVG lets a reviewer open it in a browser
  // without starting an Extension Development Host.
  //
  //   WBAW_DUMP_SVG=/tmp/card.svg node scripts/smoke-extension.cjs
  if (process.env.WBAW_DUMP_SVG) {
    const md = String(statusBar.tooltip?.value ?? statusBar.tooltip ?? "");
    // The card is the FIRST data URI: it is the first cell of the tooltip
    // table. Buttons follow.
    const encoded = md.match(/src="data:image\/svg\+xml;utf8,([^"]+)"/);
    if (encoded) {
      const out = process.env.WBAW_DUMP_SVG;
      fs.writeFileSync(out, decodeURIComponent(encoded[1]));
      console.log(`card written to ${out}`);
    }
  }
  // The markdown side (image + action table) needs its own dump: the SVG is
  // only half the tooltip, and the half that is hardest to get right is the
  // half that depends on the host's stylesheet.
  if (process.env.WBAW_DUMP_MD) {
    const md = String(statusBar.tooltip?.value ?? statusBar.tooltip ?? "");
    fs.writeFileSync(process.env.WBAW_DUMP_MD, md);
    console.log(`tooltip markdown written to ${process.env.WBAW_DUMP_MD}`);
  }

  fs.rmSync(userData, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("\nFAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});
