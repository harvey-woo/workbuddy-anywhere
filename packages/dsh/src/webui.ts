/**
 * Node-half web serving for the WorkBuddy management UI inside dsh.
 *
 * dsh's own `/api/*` is reserved for the harness, so we mount the WorkBuddy
 * management UI under the non-conflicting `/workbuddy/` prefix:
 *
 *   /workbuddy/            → core's built Vue SPA (relative asset paths)
 *   /workbuddy/api/*        → the same RPC handlers VS Code / desktop use
 *
 * The SPA is served with an injected `window.__WORKBUDDY__` config that points
 * its HTTP transport at `/workbuddy/api`, so the embedded page talks to the
 * proxy above instead of the bare `/api` dsh reserves.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import {
  RPC_ROUTES,
  RPC_METHODS,
  createRpcHandlers,
  type WorkbuddyService,
} from "@wbaw/core";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const UI_PREFIX = "/workbuddy";
// NOTE: call.path already includes the `/api` segment (e.g. `/api/{region}/state`),
// so baseUrl must be the mount prefix WITHOUT `/api`. The UI does
// `fetch(baseUrl + call.path)` → `/workbuddy/api/{region}/state`, which the
// proxy below handles. Using `/workbuddy/api` here would double the segment.
//
// dsh-specific: hide core's redundant sidebar brand (dsh's Settings nav
// already shows "WorkBuddy Anywhere") and apply dsh's dark palette via CSS
// variables. Each declaration is split into a dedicated `setProperty` call so
// arbitrary values (including those with `:` or `;`) can never break out of
// the surrounding string literal. The calls run BEFORE the Vue module boots,
// so the first paint already uses dsh colors — no flash of core's defaults.
//
// Values are measured from a live dsh Settings dialog (the "通用设置"
// section): dialog bg, nav button bg, theme cell bg, border, text, muted,
// plus size tokens (dsh body is 14px / 22px line-height, button radius 12px,
// cell radius 20px).
const DSH_CSS_VARS: Array<[string, string]> = [
  // Palette (dsh uses macOS-dark style, not GitHub-dark)
  ["--wb-bg", "#2c2c2e"],
  ["--wb-panel", "#353638"],
  ["--wb-panel-2", "#43454a"],
  // dsh's actual hairline divider is white at 12% opacity — measured from the
  // bottom-border on its settings rows. The previous `#adb2b8` was a solid
  // mid-gray that was visually too loud for a divider on a #2c2c2e panel.
  ["--wb-border", "rgba(255,255,255,0.12)"],
  ["--wb-text", "#f9fafb"],
  ["--wb-muted", "#adb2b8"],
  ["--wb-accent", "#0a84ff"],
  ["--wb-accent-soft", "rgba(10,132,255,0.18)"],
  ["--wb-ok", "#30d158"],
  ["--wb-danger", "#ff453a"],
  ["--wb-warn", "#ffd60a"],
  ["--wb-font", "-apple-system,system-ui,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"],
  // Size tokens (dsh is 14px, not core's default 13px)
  ["--wb-font-size-base", "14px"],
  ["--wb-font-size-sm", "13px"],
  ["--wb-font-size-xs", "12px"],
  ["--wb-line-height-base", "22px"],
  // Radii (dsh buttons 12px, theme cells 20px)
  ["--wb-radius", "14px"],
  ["--wb-radius-sm", "8px"],
  ["--wb-radius-lg", "20px"],
  // Padding (dsh nav buttons: 9px 16px; inputs slightly roomier)
  ["--wb-btn-pad-y", "8px"],
  ["--wb-btn-pad-x", "14px"],
  ["--wb-input-pad-y", "7px"],
  ["--wb-input-pad-x", "12px"],
];
/** Same declarations as a semicolon-joined string, for the `cssVars` field
 *  that core's App.vue reads on mount (belt + braces alongside setProperty). */
const DSH_CSS_VARS_STR = DSH_CSS_VARS.map(([k, v]) => `${k}:${v}`).join(";");
/**
 * Escape a JS string literal value so it is safe to embed inside a `<script>`
 * block: backslash-escape quotes and break any `</` sequence so the HTML
 * parser can never close the tag early from an attacker- or user-derived value.
 */
function jsLit(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/<\//g, "<\\/").
    replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}
const CONFIG_SETPROPS = DSH_CSS_VARS.map(
  ([k, v]) => `s.setProperty("${jsLit(k)}","${jsLit(v)}");`
).join("");

/** dsh's home directory, where its own settings live. */
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
/** dsh's own settings file (its plugin namespaces live here). */
const DSH_SETTINGS_FILE = path.join(DSH_HOME, "settings.yaml");

/**
 * Read one `field` out of one `namespace` in dsh's `settings.yaml`.
 *
 * A minimal targeted scan, not a YAML parse: the file is a flat
 * `namespace:  <indented fields>` map that dsh itself writes, and we need one
 * two-level lookup. Pulling in a YAML dependency for that would be the tail
 * wagging the dog.
 *
 * Best-effort by design — the file may not exist, or the key may be absent
 * (dsh omits it while the value is still the default), which is exactly why
 * callers fall back to their own defaults.
 */
function readDshSetting(namespace: string, field: string): string | undefined {
  try {
    const raw = fs.readFileSync(DSH_SETTINGS_FILE, "utf8");
    const block =
      new RegExp(`^${namespace}:\\s*\\n((?:[ \\t]+.*\\n?)*)`, "m").exec(raw)?.[1] ??
      "";
    return new RegExp(
      `^[ \\t]+${field}:\\s*["']?([^"'\\n]+?)["']?\\s*$`,
      "m"
    ).exec(block)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * dsh's THEME preference: `light`, `dark`, or `system` (its default).
 *
 * dsh resolves `system` through `prefers-color-scheme` host-side. We forward
 * only an EXPLICIT choice and let `system` fall through: our page is an iframe
 * on the same machine, so its own `prefers-color-scheme` resolves against the
 * same OS dsh looked at. Forwarding `system` would mean inventing a resolution
 * here and being wrong whenever the OS flips while the page is open.
 */
function readDshThemePreference(): "light" | "dark" | "system" {
  const pref = readDshSetting("ui-theme", "preference");
  return pref === "light" || pref === "dark" ? pref : "system";
}

/**
 * dsh's LANGUAGE preference, when the user set one explicitly.
 *
 * Same reasoning as the theme: an iframe's `documentElement.lang` is OUR OWN
 * document's (`lang="en"` from index.html), never dsh's — so `navigator`
 * language and the inherited document language both report the OS, not the
 * choice the user made in dsh's Settings. Only an explicit non-`system`
 * preference is forwarded; otherwise core's own host detection already agrees
 * with dsh's default.
 */
function readDshLocalePreference(): string | undefined {
  const pref = readDshSetting("locale", "preference");
  if (!pref) return undefined;
  const tag = pref.trim().toLowerCase();
  // dsh's own `system` sentinel means "follow the OS" — let core do that.
  if (tag === "system" || tag === "auto") return undefined;
  return pref.trim();
}

/** This plugin's own version, shown next to the brand in core's footer. */
function pluginVersion(): string {
  try {
    return (
      (require("../package.json") as { version?: string }).version ?? ""
    );
  } catch {
    return "";
  }
}

/**
 * The dsh harness's version, for diagnostics ("which host am I inside").
 *
 * Best-effort: the harness is installed by whatever launched dsh (npx, a
 * global install, a profile), so it may not be resolvable from here at all.
 * An empty string means "could not determine", which the UI renders as nothing.
 */
function dshVersion(): string {
  try {
    const pkg = require.resolve("@deepseek-ai/dsh/package.json", {
      paths: [DSH_HOME, process.cwd()],
    });
    return (require(pkg) as { version?: string }).version ?? "";
  } catch {
    return "";
  }
}

/**
 * The `window.__WORKBUDDY__` injection for one HTML response.
 *
 * Built per request (not at module load) so a theme change in dsh's Settings is
 * picked up on the next reload instead of being frozen at server start.
 *
 * @param langTag - language the embedding frame reported, when it sent one.
 * Passed through verbatim: core owns the tag→bundle mapping.
 */
function configScript(langTag?: string): string {
  const preference = readDshThemePreference();
  // `system` is deliberately NOT forwarded: core resolves it with its own
  // `prefers-color-scheme`, which is the same OS dsh resolved against.
  const theme =
    preference === "light" || preference === "dark"
      ? `,theme:"${preference}"`
      : "";
  // The frame's tag wins over our file read: the frame asked dsh's locale
  // service, which resolves the DEFAULT ("follow the browser") too — and that
  // default is invisible in `settings.yaml`, which stays empty until someone
  // picks a language by hand.
  const locale = langTag ?? readDshLocalePreference();
  return (
    `<script>window.__WORKBUDDY__={transport:"http",baseUrl:"/workbuddy",token:""` +
    `,cssVars:"${jsLit(DSH_CSS_VARS_STR)}"` +
    theme +
    (locale ? `,locale:"${jsLit(locale)}"` : "") +
    `,version:"${jsLit(pluginVersion())}"` +
    `,hostVersion:"${jsLit(dshVersion())}"` +
    // The plugin withdraws its LLM routes when the group is switched off, so
    // the Models page's control is real here.
    `,canToggleModelGroup:true` +
    `,display:{title:false,subtitle:false}};` +
    `var s=document.documentElement.style;${CONFIG_SETPROPS}</script>`
  );
}

/**
 * Locate the built management UI (`ui-dist`).
 *
 * Order matters: the plugin's OWN copy is checked first, because
 * `scripts/stage-ui.mjs` copies it there during the build. That is what makes
 * the released package self-contained — an installed plugin carries its UI and
 * never has to know where the monorepo put anything.
 *
 * The relative fallback exists for a checkout where the build has not run yet.
 * There is deliberately NO `require.resolve("@wbaw/core/…")` fallback: core is
 * `private` and unpublished, `esbuild.mjs` inlines it into this file, so at
 * runtime there is no `@wbaw/core` to resolve. Asking for it would only leave a
 * dead reference to an installable-nothing package in the shipped bundle.
 */
function resolveUiDist(): string | null {
  // 1. Our own staged copy: <plugin>/lib/index.js → <plugin>/ui-dist.
  const own = path.resolve(here, "..", "ui-dist");
  if (fs.existsSync(own)) return own;
  // 2. Monorepo layout: <plugin>/lib/index.js → ../../core/ui-dist.
  const mono = path.resolve(here, "..", "..", "core", "ui-dist");
  if (fs.existsSync(mono)) return mono;
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/** Express-style `:param` / `{region}` matcher. Returns params or null. */
function matchRoute(
  pattern: string,
  pathname: string
): Record<string, string> | null {
  const p = pattern
    .replace("{region}", ":region")
    .split("/")
    .filter(Boolean);
  const u = pathname.split("/").filter(Boolean);
  if (p.length !== u.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) {
      params[p[i].slice(1)] = decodeURIComponent(u[i]);
    } else if (p[i] !== u[i]) {
      return null;
    }
  }
  return params;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/** Handle one `/workbuddy/api/*` request against the core RPC table. */
async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  apiPath: string,
  service: WorkbuddyService
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const handlers = createRpcHandlers(service);
  const regionMatch = /^\/(\w+)(?=\/|$)/.exec(apiPath);

  for (const key of RPC_METHODS) {
    const route = RPC_ROUTES[key];
    if (!route.http || route.http.method !== method) continue;
    // apiPath already has the `/api` prefix stripped; strip it from the
    // route pattern too before matching.
    const routePath = route.http.path.replace(/^\/api/, "") || "/";
    const params = matchRoute(routePath, apiPath);
    if (!params) continue;

    const body = route.body ? ((await readBody(req)) as Record<string, unknown>) : {};
    const args: Record<string, unknown> = { ...body, ...params };
    // Only inject the URL path's first segment as `args.region` when the
    // MATCHED ROUTE actually uses `{region}` in its path template. Earlier
    // versions of this code did `if (regionMatch) args.region = ...` which
    // looked harmless but was a silent data-destroyer for any route whose
    // first path segment happened to be a real English word — e.g. a
    // PATCH to `/api/settings` would set `args.region = "settings"`,
    // clobbering the request body's `{region: "intl"}` and writing
    // `region: "settings"` to disk. Sanitising on read hid it for a while,
    // but the underlying write was always wrong. The template check below
    // scopes this branch to the methods that actually need it (state,
    // login, models) and leaves settings PATCHes alone.
    if (regionMatch && route.http.path.includes("{region}")) args.region = regionMatch[1];

    try {
      const result = await (handlers as Record<string, (a: unknown) => unknown>)[
        key as string
      ](args);
      sendJson(res, 200, result ?? {});
    } catch (err) {
      sendJson(res, 500, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
    return;
  }

  sendJson(res, 404, { error: { message: `Unknown API route: ${method} ${apiPath}` } });
}

function serveStatic(
  res: ServerResponse,
  uiDir: string,
  staticPath: string,
  langTag?: string
): void {
  let rel = staticPath || "/";
  if (rel === "/") rel = "/index.html";
  const filePath = path.join(uiDir, rel);
  // Path-traversal guard: resolved path must stay inside uiDir.
  if (filePath !== uiDir && !filePath.startsWith(uiDir + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (!err) {
      const ext = path.extname(filePath).toLowerCase();
      // index.html gets the runtime config injected so the embedded app points
      // its HTTP transport at /workbuddy/api instead of dsh's own /api.
      if (filePath.endsWith("index.html")) {
        // No-store: the injected config (esp. baseUrl) changes with the mount,
        // and a cached HTML would freeze a stale baseUrl in the iframe.
        res.writeHead(200, {
          "Content-Type": CONTENT_TYPES[".html"],
          "Cache-Control": "no-store",
        });
        res.end(data.toString().replace("<!--WORKBUDDY_CONFIG-->", configScript(langTag)));
        return;
      }
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        // No-store so the embedded SPA always re-reads the injected config
        // (and never serves a stale bundle that cached baseUrl="").
        "Cache-Control": "no-store",
      });
      res.end(data);
      return;
    }
    // SPA fallback: any unknown extension-less path serves index.html (with the
    // injected config so the embedded app points at the right API base).
    fs.readFile(path.join(uiDir, "index.html"), (e2, idx) => {
      if (e2) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[".html"],
        "Cache-Control": "no-store",
      });
      res.end(idx.toString().replace("<!--WORKBUDDY_CONFIG-->", configScript(langTag)));
    });
  });
}

export function registerWorkbuddyWeb(
  ctx: Context,
  service: WorkbuddyService
): void {
  const uiDir = resolveUiDist();
  const web = (ctx as unknown as {
    webServer?: {
      register?: (route: {
        kind: "exact" | "prefix";
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
      }) => unknown;
    };
  }).webServer;

  if (!web?.register) {
    console.error("[workbuddy] webServer service unavailable; management UI skipped");
    return;
  }

  web.register({
    kind: "prefix",
    path: UI_PREFIX,
    handler: (req, res) => {
      console.error(`[workbuddy] REQ ${req.method} ${req.url}`);
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);
      if (!pathname.startsWith(UI_PREFIX)) {
        res.writeHead(404).end("Not found");
        return;
      }
      const sub = pathname.slice(UI_PREFIX.length) || "/";
      if (sub.startsWith("/api/")) {
        const apiPath = sub.slice("/api".length) || "/";
        return handleApi(req, res, apiPath, service);
      }
      if (!uiDir) {
        res.writeHead(500).end("WorkBuddy management UI not built (ui-dist missing)");
        return;
      }
      // `?lang=` is set by our own client half from dsh's locale service.
      return serveStatic(res, uiDir, sub, url.searchParams.get("lang") ?? undefined);
    },
  });

  console.error(
    `[workbuddy] management UI served at /workbuddy/ (ui-dist=${uiDir ?? "MISSING"})`
  );
}
