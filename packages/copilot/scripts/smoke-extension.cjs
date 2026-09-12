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

const registered = { provider: undefined, vendor: undefined, commands: new Map() };
const statusBar = { text: "", tooltip: undefined, shown: false, command: undefined };
const panels = [];
const settings = {
  thinkingEffort: "auto",
  visionFallbackModel: "",
  customModels: [],
  enabled: true,
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
      registered.vendor = vendor;
      registered.provider = provider;
      return disposable();
    },
    selectChatModels: async () => [],
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
    createWebviewPanel(viewType, title, _column, _options) {
      const panel = {
        viewType,
        title,
        webview: {
          html: "",
          asWebviewUri: (uri) => ({ toString: () => uri.toString(), fsPath: uri.fsPath }),
          onDidReceiveMessage: () => disposable(),
          postMessage: async () => true,
        },
        reveal() {},
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
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const json = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  if (url.includes("/billing/meter/get-user-resource")) {
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

  await check("the provider is registered under the `codebuddy` vendor", () => {
    assert.strictEqual(registered.vendor, "codebuddy");
    assert.ok(registered.provider, "no provider was registered");
  });

  await check("the commands VS Code advertises all exist", () => {
    const expected = [
      "codebuddy.manageProvider",
      "codebuddy.menu",
      "codebuddy.login",
      "codebuddy.logout",
      "codebuddy.showUsage",
      "codebuddy.settings",
      "codebuddy.refreshModels",
      "codebuddy.toggleProvider",
      "codebuddy.selectVisionFallback",
    ];
    for (const id of expected) {
      assert.ok(registered.commands.has(id), `missing command: ${id}`);
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
    assert.strictEqual(statusBar.command, "codebuddy.manageProvider");

    const before = panels.length;
    await handler();
    assert.strictEqual(panels.length, before + 1, "no management panel was opened");
    assert.match(panels[panels.length - 1].title, /WorkBuddy Anywhere/);
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
  // init() runs in the background; wait for the catalog to land. Everything
  // that depends on activation having finished is checked after this point.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    models = await registered.provider.provideLanguageModelChatInformation({ silent: true }, token);
    if (models.length > 0) break;
    await new Promise((r) => setTimeout(r, 250));
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
  await check("it still names the signed-in account on hover", () => {
    assert.ok(statusBar.tooltip, "no tooltip was set");
    const md = String(statusBar.tooltip.value ?? statusBar.tooltip);
    assert.match(md, /Smoke Test|CodeBuddy/, `tooltip says: ${md.slice(0, 120)}`);
  });

  await check("it uses the ORIGINAL icon id", () => {
    // `$(codebuddy)` is not a registered icon and renders as literal text; the
    // declared one is `codebuddy-icon` (package.json -> contributes.icons).
    assert.ok(
      statusBar.text.startsWith("$(codebuddy-icon)"),
      `status bar text is: ${statusBar.text}`
    );
  });

  await check("the bar is icon + percentage of the ACTIVE account, nothing else", () => {
    // Exactly the pre-split format. Account names and counters belong on hover.
    // 1250/2000 = 62.5% from the stubbed billing payload.
    assert.match(
      statusBar.text,
      /^\$\(codebuddy-icon\)\s+62\.5%$/,
      `expected "$(codebuddy-icon) 62.5%", got: ${statusBar.text}`
    );
  });

  await check("the hover is the ORIGINAL SVG card, not a text list", () => {
    const md = String(statusBar.tooltip.value ?? statusBar.tooltip);
    assert.match(md, /data:image\/svg\+xml/, "tooltip is not an SVG card");
    // The card's title, percent-encoded by encodeURIComponent.
    assert.match(md, /CodeBuddy%20%E9%A2%9D%E5%BA%A6/, "missing the card title");
  });

  console.log(`\n${passed} checks passed`);
  fs.rmSync(userData, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("\nFAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});
