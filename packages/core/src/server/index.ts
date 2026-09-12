/**
 * Local HTTP API server.
 *
 * Serves three things on one origin:
 *   /v1/*          three chat protocols — OpenAI Chat Completions,
 *                  Anthropic Messages, OpenAI Responses
 *   /api/*         the internal API the bundled Vue UI uses
 *   /, /assets/*   the built Vue UI itself
 *
 * ── Authentication ────────────────────────────────────────────────────
 * There is NONE, by design. This process HOSTS the accounts, so it has nothing
 * to authorize: a caller is not proving who they are, it is choosing whose
 * quota to spend.
 *
 * That choice is the ACCOUNT MARKER — a plain identifier, no secret and no
 * signature. It travels in the STANDARD slot, because every OpenAI-compatible
 * client already has an "API key" field:
 *
 *     Authorization: Bearer <account-key>
 *
 * Valid values come from `GET /api/state` -> `accounts[].key`. Omitting the
 * marker is normal and means "use the account that is currently selected",
 * which the service tracks and persists across restarts.
 *
 * An UNKNOWN marker is a 400: falling back to the active account would spend
 * somebody's quota that the caller did not ask for.
 *
 * There is exactly ONE way to name an account, on purpose — a second channel
 * would only add a precedence rule to get wrong.
 */

import * as http from "http";
import * as path from "path";
import type { WorkbuddyService } from "../service";
import { createRpcHandlers } from "../rpc-handlers";
import { RPC_METHODS, RPC_ROUTES } from "../rpc";
import { DEFAULT_PORT, openApiDocument } from "./openapi";
import { injectConfig, readStatic } from "./static";
import {
  errorStatus,
  openAIError,
  toChatRequest,
  type OpenAIChatRequestBody,
} from "./openai";
import {
  chatCompletionsProtocol,
  messagesProtocol,
  responsesProtocol,
  type ProtocolDefinition,
} from "./codecs";
import { toAnthropicChatRequest, type AnthropicMessageBody } from "./messages";
import { toResponsesChatRequest, type ResponsesBody } from "./responses";
import type { ChatRequest, ChatToolCall, ChatUsage } from "../chat/types";

/** Largest accepted request body — big enough for base64 images, not infinite. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Query parameter that picks an account when the bearer is unavailable. */

/** The value of `Authorization: Bearer <x>`, or undefined when absent/blank. */
function bearerValue(header: string | undefined): string | undefined {
  const match = header ? /^bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match ? match[1].trim() || undefined : undefined;
}

/**
 * Which account should this request spend?
 *
 * Two STANDARD slots, one rule: an OpenAI-compatible client already has an
 * "API key" field (bearer), while an Anthropic client sends `x-api-key`. Both
 * carry the same account marker — there is still exactly one way to NAME an
 * account, just two places a client may put it.
 *
 * Returns undefined when the request selects nothing, which means "use the
 * account that is currently selected".
 */
function readAccountMarker(req: http.IncomingMessage): string | undefined {
  const bearer = bearerValue(req.headers.authorization);
  if (bearer) return bearer;

  const apiKey = req.headers["x-api-key"];
  const value = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Common session/correlation header names from AI coding agents — the same
 * list llm-proxy-gateway probes. First present header wins; the OpenAI
 * `user` body field is the fallback, and no signal at all means the request
 * shares the per-region "default" affinity slot.
 */
const SESSION_HEADERS = [
  "x-claude-code-session-id", // Claude Code
  "x-conversation-id", // generic convention
  "x-session-id", // generic
  "x-request-id", // OpenAI SDK, Azure
  "openai-conversation-id", // OpenAI
  "x-correlation-id", // general API convention
] as const;

/** Extract a conversation identity for auto-select session affinity. */
function readSessionKey(req: http.IncomingMessage, body: Record<string, unknown>): string | undefined {
  for (const name of SESSION_HEADERS) {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const user = body?.user;
  if (typeof user === "string" && user.trim()) return `user:${user.trim()}`;
  return undefined;
}

/** A route that runs one chat turn in a specific wire format. */
interface ChatRoute {
  path: string;
  /** Which cluster this path lands on: cn for the bare /v1/*, intl for /intl/v1/*. */
  region: "cn" | "intl";
  protocol: ProtocolDefinition;
  parse(body: Record<string, unknown>): {
    request: ChatRequest;
    ignored: string[];
    stream: boolean;
  };
}

/**
 * Every chat surface. These three paths are the `apiType` values VS Code's BYOK
 * custom endpoints accept, so a client configured for any of them works here
 * unchanged — adding another protocol means adding ONE entry.
 */
// One entry per (region, protocol) pair. The bare `/v1/...` paths land on
// CN (the historical route, kept so existing clients keep working); the
// `/intl/v1/...` paths land on the international cluster. The two share the
// same parse/protocol code — only the cluster they hit differs, and that is
// stamped onto the request as `region` for the service to read.
const CHAT_ROUTES: ChatRoute[] = [
  {
    region: "cn",
    path: "/v1/chat/completions",
    protocol: chatCompletionsProtocol,
    parse: (body) => {
      const typed = body as OpenAIChatRequestBody;
      return { ...toChatRequest(typed), stream: typed.stream === true };
    },
  },
  {
    region: "intl",
    path: "/intl/v1/chat/completions",
    protocol: chatCompletionsProtocol,
    parse: (body) => {
      const typed = body as OpenAIChatRequestBody;
      return { ...toChatRequest(typed), stream: typed.stream === true };
    },
  },
  {
    region: "cn",
    path: "/v1/messages",
    protocol: messagesProtocol,
    parse: (body) => {
      const typed = body as AnthropicMessageBody;
      return { ...toAnthropicChatRequest(typed), stream: typed.stream === true };
    },
  },
  {
    region: "intl",
    path: "/intl/v1/messages",
    protocol: messagesProtocol,
    parse: (body) => {
      const typed = body as AnthropicMessageBody;
      return { ...toAnthropicChatRequest(typed), stream: typed.stream === true };
    },
  },
  {
    region: "cn",
    path: "/v1/responses",
    protocol: responsesProtocol,
    parse: (body) => {
      const typed = body as ResponsesBody;
      return { ...toResponsesChatRequest(typed), stream: typed.stream === true };
    },
  },
  {
    region: "intl",
    path: "/intl/v1/responses",
    protocol: responsesProtocol,
    parse: (body) => {
      const typed = body as ResponsesBody;
      return { ...toResponsesChatRequest(typed), stream: typed.stream === true };
    },
  },
];

/**
 * Protocols sharing `/v1/models` with OpenAI, told apart by a header each of
 * them always sends. Guessing from the path alone is impossible, and answering
 * with the wrong list shape is worse than not answering.
 */
const SHARED_PATH_PROTOCOLS: ProtocolDefinition[] = [messagesProtocol];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ApiServerOptions {
  service: WorkbuddyService;
  host?: string;
  port?: number;
  /** Directory holding the built UI (index.html + assets); defaults to ui-dist. */
  uiDir?: string;
  version?: string;
  log?: (msg: string) => void;
}

export interface ApiServerHandle {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

export async function startApiServer(opts: ApiServerOptions): Promise<ApiServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? DEFAULT_PORT;
  const version = opts.version ?? "0.0.0";
  const log = opts.log ?? ((): void => {});
  const uiDir = opts.uiDir ?? path.resolve(__dirname, "..", "..", "ui-dist");
  const service = opts.service;
  // No openExternal hook: the browser the UI runs in can open the URL itself.
  const handlers = createRpcHandlers(service);

  async function serveIndex(res: http.ServerResponse): Promise<void> {
    const index = await readStatic(uiDir, "/index.html");
    if (!index) {
      sendJson(
        res,
        500,
        openAIError(
          `UI bundle not found in ${uiDir}. Build it with: yarn workspace @wbaw/core ui:build`,
          "internal_error"
        )
      );
      return;
    }
    const html = injectConfig(index.body.toString("utf-8"), {
      transport: "http",
      version,
    });
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
  }

  /**
   * One chat turn, in whichever protocol the route named.
   *
   * The protocol contributes only FRAMES (`codec`). Everything around them —
   * failing before a 200 stream is committed, aborting on client disconnect,
   * emitting tool calls after the text stream ends, surfacing a mid-stream
   * failure in-band — is shared, because it was easy to get wrong once and
   * would be just as easy to get wrong three times.
   */
  async function handleChat(
    route: ChatRoute,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    accountKey?: string
  ): Promise<void> {
    const protocol = route.protocol;

    let request: ChatRequest;
    let stream: boolean;
    try {
      const raw = await readJson<Record<string, unknown>>(req);
      const parsed = route.parse(raw);
      request = parsed.request;
      // Stamp the cluster the URL asked for onto the request. The service
      // uses it to pick an account in the matching region, so a client
      // pointed at /intl/v1/... never accidentally spends a CN account.
      (request as { region?: "cn" | "intl" }).region = route.region;
      // Conversation identity for auto-select session affinity: session
      // headers first, then the OpenAI `user` field, else the shared slot.
      request.sessionKey = readSessionKey(req, raw);
      stream = parsed.stream;
      if (parsed.ignored.length > 0) {
        log(`request knobs accepted but NOT forwarded upstream: ${parsed.ignored.join(", ")}`);
      }
    } catch (err) {
      // A malformed body must come back in THIS protocol's error envelope: a
      // client handed the wrong shape reports "unparseable response" instead
      // of the actual message.
      sendJson(res, errorStatus(err), protocol.error(messageOf(err), "invalid_request_error"));
      return;
    }

    // Fail before committing to a 200 stream: once SSE headers are out we can
    // no longer answer with a real status code, and the two most common
    // failures (not signed in, group disabled) are exactly the ones a client
    // should be able to act on. Auto-select aware: with the toggle on, a dead
    // ACTIVE account must not fail requests another account could serve.
    await service.ensureChatReady(accountKey, route.region);
    const settings = await service.getSettings();
    // Auto-select outranks the group toggle: with auto on, the toggle only
    // hides the group from pickers, it does not block API requests.
    if (!settings.enabled && !settings.autoSelectAccount) {
      sendJson(
        res,
        409,
        protocol.error(
          "The WorkBuddy model group is disabled in the management page.",
          "invalid_request_error",
          "group_disabled"
        )
      );
      return;
    }

    const codec = protocol.create(request.model);
    const controller = new AbortController();
    res.on("close", () => controller.abort());

    if (!stream) {
      let text = "";
      const toolCalls: ChatToolCall[] = [];
      let usage: ChatUsage | undefined;
      for await (const ev of service.chat(request, controller.signal, accountKey)) {
        if (ev.type === "text") text += ev.text;
        else if (ev.type === "toolCall") toolCalls.push(ev.call);
        else usage = ev.usage;
      }
      sendJson(res, 200, codec.body(text, toolCalls, usage));
      return;
    }

    res.writeHead(200, protocol.sseHeaders);
    const write = (frames: string[]): void => {
      for (const frame of frames) res.write(frame);
    };
    write(codec.start());

    const toolCalls: ChatToolCall[] = [];
    let usage: ChatUsage | undefined;
    try {
      for await (const ev of service.chat(request, controller.signal, accountKey)) {
        if (ev.type === "text") write(codec.text(ev.text));
        // The engine emits tool calls once, after the text stream ends.
        else if (ev.type === "toolCall") toolCalls.push(ev.call);
        else usage = ev.usage;
      }
    } catch (err) {
      const msg = messageOf(err);
      log(`stream failed: ${msg}`);
      write(codec.failure(msg));
      res.write(codec.tail);
      res.end();
      return;
    }

    write(codec.toolCalls(toolCalls));
    write(codec.finish(usage));
    res.write(codec.tail);
    res.end();
  }

  /**
   * /api/* — the UI's own API. Handlers come from core's createRpcHandlers
   * (shared with the VS Code extension) and routing is DERIVED from
   * RPC_ROUTES, so neither the behaviour nor the paths can drift.
   */
  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    method: string,
    accountKey?: string
  ): Promise<void> {
    // Region-scoped routes arrive as `/api/cn/...` or `/api/intl/...`.
    // Detect the segment here; carry it forward as `args.region`. The
    // patterns in RPC_ROUTES use a `{region}` placeholder, substituted for
    // the literal the client sent, so the URL `/api/cn/state` matches the
    // pattern `/api/cn/state` exactly — and `/api/intl/state` does NOT
    // (which is the point: the request hit the wrong cluster).
    const regionMatch = /^\/api\/(cn|intl)(?=\/|$)/.exec(pathname);
    for (const key of RPC_METHODS) {
      const route = RPC_ROUTES[key];
      if (!route.http || route.http.method !== method) continue;
      const pattern = route.region
        ? route.http.path.replace("{region}", regionMatch ? regionMatch[1] : "(_)")
        : route.http.path;
      const pathParams = matchPath(pattern, pathname);
      if (!pathParams) continue;
      const body = route.body
        ? await readJson<Record<string, unknown>>(req)
        : {};
      const args: Record<string, unknown> = { ...body, ...pathParams };
      if (regionMatch) {
        args.region = regionMatch[1];
      }
      // The account marker stands in for the `key` argument on account-scoped
      // methods. An explicit key in the body/path still wins — switchAccount
      // and removeAccount are always ABOUT a named account.
      if (accountKey && route.accountScoped && args.key === undefined) {
        args.key = accountKey;
      }
      sendJson(res, 200, await handlers[key](args));
      return;
    }
    sendJson(res, 404, openAIError(`Unknown API route: ${method} ${pathname}`, "not_found"));
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // Local clients (Cline, Continue) may call from a web context.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "authorization, content-type, x-api-key, anthropic-version"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/health") {
      sendJson(res, 200, { ok: true, version });
      return;
    }
    if (pathname === "/openapi.json") {
      sendJson(res, 200, openApiDocument(version));
      return;
    }
    if (pathname === "/docs") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(docsHtml(version));
      return;
    }

    const isApi = pathname === "/v1" || pathname.startsWith("/v1/") || pathname.startsWith("/api/");

    // Resolve the account marker ONCE, here, so every endpoint agrees on what
    // an unknown marker means (400) instead of each inventing its own rule.
    // Absent is the normal case and means "the currently selected account".
    let accountKey: string | undefined;
    if (isApi) {
      const marker = readAccountMarker(req);
      if (marker) accountKey = await service.resolveAccountKey(marker);
    }

    // /v1/models for CN, /intl/v1/models for the international cluster.
    // The two clusters serve different catalogs (verified 2026-09-11:
    // CN 15 models, INTL 17, with disjoint ids), so a bare /v1/models must
    // NOT return the INTL list and confuse a Chinese client.
    const modelRegionMatch = /^\/intl\/v1\/models$/.exec(pathname);
    const isModelsGet =
      method === "GET" &&
      (pathname === "/v1/models" || !!modelRegionMatch);
    if (isModelsGet) {
      const region = modelRegionMatch ? "intl" : "cn";
      const protocol =
        SHARED_PATH_PROTOCOLS.find((p) => p.detectsOn?.(req.headers)) ??
        chatCompletionsProtocol;
      const state = await service.getState(region);
      sendJson(res, 200, protocol.modelList(state.models));
      return;
    }
    const chatRoute = method === "POST" ? CHAT_ROUTES.find((r) => r.path === pathname) : undefined;
    if (chatRoute) {
      await handleChat(chatRoute, req, res, accountKey);
      return;
    }
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, method, accountKey);
      return;
    }

    // ── Static UI ────────────────────────────────────────────────────
    if (method === "GET" || method === "HEAD") {
      if (pathname === "/" || pathname === "/index.html") {
        await serveIndex(res);
        return;
      }
      const asset = await readStatic(uiDir, pathname);
      if (asset) {
        res.writeHead(200, {
          "Content-Type": asset.contentType,
          "Content-Length": asset.body.length,
          "Cache-Control": "public, max-age=300",
        });
        res.end(asset.body);
        return;
      }
      // Extension-less path → client-side route, hand back the SPA shell.
      if (!path.extname(pathname)) {
        await serveIndex(res);
        return;
      }
    }

    sendJson(res, 404, openAIError(`Not found: ${method} ${pathname}`, "not_found"));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const status = errorStatus(err);
      log(`${req.method} ${req.url} failed (${status}): ${msg}`);
      if (!res.headersSent) {
        // 4xx are the caller's problem; only 5xx are "upstream".
        const type = status >= 400 && status < 500 ? "invalid_request_error" : "upstream_error";
        sendJson(res, status, openAIError(msg, type));
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  return {
    url: `http://${host}:${port}`,
    host,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Match a route pattern like "/api/models/custom/:id" against a real pathname.
 * Returns the decoded path parameters, or undefined when the shape differs.
 * Segment counts must match exactly, so "/api/state/extra" never matches
 * "/api/state".
 */
function matchPath(
  pattern: string,
  pathname: string
): Record<string, string> | undefined {
  const want = pattern.split("/");
  const got = pathname.split("/");
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) {
      params[want[i].slice(1)] = decodeURIComponent(got[i]);
      continue;
    }
    if (want[i] !== got[i]) return undefined;
  }
  return params;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readJson<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err instanceof Error ? err.message : err}`));
      }
    });
  });
}

/**
 * Minimal docs page: renders the OpenAPI document it fetches from
 * /openapi.json. No CDN dependency, so it works on a machine with no internet
 * route other than the gateway itself.
 */
function docsHtml(version: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkBuddy Anywhere API ${version}</title>
<style>
 body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px 24px;background:#111;color:#ddd}
 h1{font-size:20px;margin:0 0 4px} .sub{color:#999;margin-bottom:24px}
 h2{font-size:15px;margin:28px 0 8px;color:#7cc4ff;text-transform:uppercase;letter-spacing:.06em}
 .ep{display:flex;gap:12px;align-items:baseline;padding:7px 10px;border-radius:6px;background:#1a1a1a;margin-bottom:5px}
 .m{font:600 11px/1.6 monospace;padding:1px 7px;border-radius:4px;min-width:52px;text-align:center}
 .get{background:#1d3a2a;color:#6ee7a8}.post{background:#1d2f4a;color:#7cc4ff}.patch{background:#3a321d;color:#e7d36e}.delete{background:#3a1d1d;color:#e78a8a}
 code{color:#eee} .sum{color:#999;margin-left:auto;text-align:right}
 .note{background:#1a1a1a;border-left:3px solid #7cc4ff;padding:10px 14px;border-radius:0 6px 6px 0;color:#bbb;margin:16px 0}
 a{color:#7cc4ff}
</style></head><body>
<h1>WorkBuddy Anywhere API</h1>
<div class="sub">v${version} &middot; <a href="/openapi.json">openapi.json</a> &middot; <a href="/">management UI</a></div>
<div class="note">No authorization is required &mdash; this server hosts the accounts, so there is no
identity to prove.<br><br>
Which account a request spends is chosen with
<code>Authorization: Bearer &lt;account-key&gt;</code> (or <code>x-api-key</code> for Anthropic
clients) &mdash; standard slots, so a client's ordinary "API key" field is all it takes. Keys are
listed by <code>GET /api/state</code> &rarr; <code>accounts[].key</code>. Omit the marker to use the
account that is currently selected. An unknown key is a <code>400</code> &mdash; it never falls back
to someone else's quota.<br><br>
Three chat protocols are served, matching VS Code's BYOK <code>apiType</code> values:
<code>/v1/chat/completions</code>, <code>/v1/messages</code>, <code>/v1/responses</code>.</div>
<div id="out">loading…</div>
<script>
fetch('/openapi.json').then(function(r){return r.json()}).then(function(doc){
  var order=['OpenAI','UI'], out=document.getElementById('out'), html='';
  order.forEach(function(tag){
    var rows=[];
    Object.keys(doc.paths).forEach(function(p){
      Object.keys(doc.paths[p]).forEach(function(m){
        var op=doc.paths[p][m];
        if((op.tags||[])[0]!==tag) return;
        rows.push('<div class="ep"><span class="m '+m+'">'+m.toUpperCase()+'</span><code>'+p+'</code><span class="sum">'+(op.summary||'')+'</span></div>');
      });
    });
    if(rows.length) html+='<h2>'+tag+'</h2>'+rows.join('');
  });
  out.innerHTML=html;
}).catch(function(e){document.getElementById('out').textContent='Failed to load spec: '+e});
</script>
</body></html>`;
}
