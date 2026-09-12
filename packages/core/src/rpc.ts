/**
 * Transport-agnostic RPC contract.
 *
 * The shared Vue UI calls exactly these methods through one of three
 * transports, and every host implements exactly these methods:
 *
 *   transport "vscode" : webview -> postMessage -> extension -> service
 *   transport "ipc"    : renderer -> preload -> ipcRenderer -> main -> service
 *   transport "http"   : fetch -> local server -> service
 *
 * IMPORTANT: this module must stay browser-safe — it is imported by the UI
 * bundle at RUNTIME (for RPC_ROUTES). Only `import type` is allowed below, so
 * nothing from the Node-only modules is pulled in. Keeping the route table
 * here is what stops the UI's paths and the server's paths from drifting
 * apart.
 */

import type {
  CheckinAllResult,
  LoginPoll,
  LoginStart,
  ServiceState,
  UsageSnapshot,
  VisionModelsResult,
} from "./service";
import type { Settings } from "./settings";
import type { Region } from "./region";
import type { ModelConfig } from "./models";
import type { CheckinResult } from "./billing";

/** What each method returns, and what (single) argument it takes. */
export interface RpcMethods {
  getState(params?: { region?: Region }): ServiceState;
  /**
   * Begin a sign-in. `region` picks the cluster AND the protocol: CN uses the
   * scan-and-poll device flow, INTL uses OAuth (which returns `state: ""`,
   * because there is nothing to poll). For INTL, `broker` chooses the identity
   * provider (Google / GitHub / X); defaults to Google.
   */
  startLogin(params?: { region?: Region; broker?: "google" | "github" | "twitter" }): LoginStart;
  pollLogin(params?: { region?: Region }): LoginPoll;
  /** Sign out ONE account. Without a key, the active account. */
  logout(params: { key?: string }): ServiceState;
  /** Make an account active without re-authenticating. */
  switchAccount(params: { key: string }): ServiceState;
  /** Forget one account entirely. */
  removeAccount(params: { key: string }): ServiceState;
  getUsage(params: { key?: string }): UsageSnapshot;
  /**
   * Re-read quota + check-in status for EVERY account.
   *
   * Read-only: it never claims a bonus, so rendering a page cannot mutate
   * anything. Claiming is `checkinAll`.
   */
  refreshAllUsage(): ServiceState;
  checkin(params: { key?: string }): CheckinResult;
  /** Claim the daily bonus for EVERY account in one sweep. */
  checkinAll(): CheckinAllResult;
  getModels(): ModelConfig[];
  /**
   * Re-fetch the model catalog.
   *
   * No per-account parameter: within a region `/v3/config` is not
   * account-scoped. Across regions it IS different (29 models on CN, 35 on
   * INTL), so `region` selects which catalog to refresh — defaulting to the
   * active account's.
   */
  refreshModels(params?: { region?: Region }): ModelConfig[];
  addCustomModel(params: { id: string; displayName?: string }): ModelConfig[];
  removeCustomModel(params: { id: string }): ModelConfig[];
  getSettings(): Settings;
  updateSettings(params: Partial<Settings>): Settings;
  /**
   * Candidates for `settings.visionFallbackModel`.
   *
   * The ids come from whichever vision source is active on THIS host, which is
   * why the UI must ask instead of filtering the catalog itself.
   */
  listVisionModels(): VisionModelsResult;
  /** Open a URL in the user's browser (webview/IPC hosts must relay it). */
  openExternal(params: { url: string }): { ok: true };
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = Parameters<RpcMethods[M]>[0];
export type RpcResult<M extends RpcMethod> = Awaited<ReturnType<RpcMethods[M]>>;

export interface RpcRoute {
  /** HTTP method + path used by the http transport and the local server. */
  http: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string } | null;
  /** Name of the `:param` in `http.path` (its value is the method argument). */
  pathParam?: string;
  /**
   * `/{region}/...` segment in the path. Replaced with the caller's region
   * (`"cn"` or `"intl"`) when the URL is built, and stripped back to the
   * remaining path before matching in the server. The region itself lands in
   * `args.region` so handlers see it without re-parsing the URL.
   */
  region?: "both";
  /** True when the argument travels as the JSON request body. */
  body?: boolean;
  /**
   * The method takes an account key, so the caller's account marker (header or
   * `?account=`) can stand in for it. Declared HERE, next to the route, so the
   * server never has to keep a parallel list that can drift out of sync.
   */
  accountScoped?: boolean;
  summary: string;
}

/**
 * `http: null` = host-only method: the browser transport cannot serve it and
 * says so instead of silently doing nothing.
 */
export const RPC_ROUTES: Record<RpcMethod, RpcRoute> = {
  getState: {
    region: "both",
    http: { method: "GET", path: "/api/{region}/state" },
    summary: "Session, settings, models (region selects which catalog)",
  },
  startLogin: {
    region: "both",
    http: { method: "POST", path: "/api/{region}/login/start" },
    body: true,
    summary: "Begin a sign-in (region selects CN device-flow or INTL OAuth)",
  },
  pollLogin: {
    region: "both",
    http: { method: "POST", path: "/api/{region}/login/poll" },
    body: true,
    summary: "One login poll",
  },
  logout: {
    http: { method: "POST", path: "/api/logout" },
    body: true,
    accountScoped: true,
    summary: "Sign out one account",
  },
  switchAccount: {
    http: { method: "POST", path: "/api/accounts/switch" },
    body: true,
    accountScoped: true,
    summary: "Make an account active",
  },
  removeAccount: {
    http: { method: "DELETE", path: "/api/accounts/:key" },
    pathParam: "key",
    accountScoped: true,
    summary: "Forget one account",
  },
  getUsage: { http: { method: "GET", path: "/api/usage" }, accountScoped: true, summary: "Quota + check-in" },
  refreshAllUsage: {
    http: { method: "POST", path: "/api/usage/refresh" },
    summary: "Re-read every account's quota and check-in status",
  },
  checkin: {
    http: { method: "POST", path: "/api/checkin" },
    body: true,
    accountScoped: true,
    summary: "Claim daily bonus",
  },
  checkinAll: {
    http: { method: "POST", path: "/api/checkin/all" },
    summary: "Claim the daily bonus for every account",
  },
  getModels: {
    region: "both",
    http: { method: "GET", path: "/api/{region}/models" },
    summary: "Model catalog (region-scoped)",
  },
  refreshModels: {
    region: "both",
    http: { method: "POST", path: "/api/{region}/models/refresh" },
    summary: "Re-fetch the model catalog",
  },
  addCustomModel: {
    http: { method: "POST", path: "/api/models/custom" },
    body: true,
    summary: "Add a custom model id",
  },
  removeCustomModel: {
    http: { method: "DELETE", path: "/api/models/custom/:id" },
    pathParam: "id",
    summary: "Remove a custom model id",
  },
  getSettings: { http: { method: "GET", path: "/api/settings" }, summary: "Read settings" },
  updateSettings: {
    http: { method: "PATCH", path: "/api/settings" },
    body: true,
    summary: "Update settings",
  },
  listVisionModels: {
    http: { method: "GET", path: "/api/settings/vision/models" },
    summary: "Image-description candidates for this host",
  },
  openExternal: { http: null, summary: "Open a URL in the browser" },
};

export const RPC_METHODS = Object.keys(RPC_ROUTES) as RpcMethod[];

/** A concrete HTTP request for one RPC call. */
export interface HttpCall {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  /** Serialized JSON body; undefined when the route takes none. */
  body?: string;
  headers: Record<string, string>;
}

/**
 * Turn an RPC call into the HTTP request the local server expects.
 *
 * Lives HERE, next to the route table, for the same reason the table does: the
 * browser transport and any test have to agree on how a route becomes a
 * request.
 *
 * It used to live only in the UI, where `body` and `pathParam` were read off
 * `RPC_ROUTES[method].http` instead of the route itself. That object only has
 * `{ method, path }`, so `route.body` was ALWAYS undefined:
 *
 *   - no browser call ever sent a request body, silently breaking
 *     switchAccount / addCustomModel / updateSettings;
 *   - `:pathParam` was never substituted, breaking removeAccount too.
 *
 * Nothing caught it, because the server tests call the endpoints directly and
 * never exercise the UI transport. Hence this function, and its test.
 *
 * Returns undefined for host-only methods (`http: null`).
 */
export function httpCallFor(
  method: RpcMethod,
  params?: unknown
): HttpCall | undefined {
  const route = RPC_ROUTES[method];
  const http = route.http;
  if (!http) return undefined;

  let path = http.path;
  if (route.pathParam) {
    const raw = (params as Record<string, unknown> | undefined)?.[route.pathParam];
    path = path.replace(`:${route.pathParam}`, encodeURIComponent(String(raw ?? "")));
  }
  if (route.region) {
    // A region-scoped path picks cn or intl from the params, with a global
    // hint as fallback. With NEITHER, fall back to CN rather than throw —
    // the path cannot otherwise be assembled, but throwing breaks older
    // callers that were happy with a default (notably the regression smoke
    // that exercises every method with empty params).
    const r = pickRegionForCall(method, params) ?? "cn";
    path = path.replace("{region}", r);
  }

  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (route.body) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(params ?? {});
  }

  return { method: http.method, path, body, headers };
}

/**
 * Resolve the region a region-scoped call should hit.
 *
 *   1. `params.region` if the caller already named one.
 *   2. A module-level hint set by the host or the UI when it knows which
 *      region the user is looking at — set via `setRegionForCalls(region)`.
 *   3. `undefined` — `httpCallFor` then throws a helpful error.
 */
let lastRegionForCalls: Region | null = null;
export function setRegionForCalls(r: Region | null): void {
  lastRegionForCalls = r;
}
function pickRegionForCall(method: RpcMethod, params: unknown): Region | undefined {
  const p = params as { region?: Region } | undefined;
  if (p?.region === "cn" || p?.region === "intl") return p.region;
  if (lastRegionForCalls) return lastRegionForCalls;
  // Safety net: a region-scoped call without a region is almost always a
  // client bug — log the method so the failure is debuggable.
  // eslint-disable-next-line no-console
  console.warn(`[rpc] ${method} has no region in params and no region hint set`);
  return undefined;
}

/** The envelope every postMessage / IPC message uses. */
export interface RpcEnvelope {
  /** Message kind so hosts can share a channel with other traffic. */
  channel: "workbuddy-rpc";
  id: number;
  method: RpcMethod;
  params?: unknown;
}

export interface RpcReply {
  channel: "workbuddy-rpc";
  id: number;
  result?: unknown;
  error?: { message: string };
}

export const RPC_CHANNEL = "workbuddy-rpc";
