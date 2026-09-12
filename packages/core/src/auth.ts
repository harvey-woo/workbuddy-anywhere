/**
 * Unified auth for WorkBuddy.
 *
 * Two regions are supported:
 *   - cn  : `copilot.tencent.com` (Origin: `www.codebuddy.cn`)
 *     Sign-in is the device-code-style scan-and-poll protocol on
 *     `/v2/plugin/auth/*`.
 *   - intl: `www.workbuddy.ai` (Origin: `www.workbuddy.ai`)
 *     Sign-in uses the SAME `/v2/plugin/auth/*` protocol as CN, verified live
 *     2026-09-11: `POST /v2/plugin/auth/state?platform=workbuddy-ai` returns
 *     `{state, authUrl}`, the poll answers `code 11217 (login ing...)` while
 *     pending, and `/v2/plugin/login/account` 401s until the login lands.
 *     Only the `platform` query value differs between the clusters.
 *
 * Auth flow (CN — the only one currently usable from this module):
 *   1. POST /v2/plugin/auth/state?platform=CLI → { state, authUrl }
 *   2. User scans QR / visits authUrl
 *   3. Caller polls pollLoginOnce(state) until a token is issued
 *   4. GET /v2/plugin/login/account (BEARER-authenticated) → { uid, nickname }
 *   5. Host persists the result through an AuthStore (see storage.ts)
 *
 * Token usage:
 *   - Bearer auth on /v2/chat/completions
 *   - Bearer + X-User-Id on /billing/meter/get-user-resource
 *   - Bearer + X-User-Id on /v3/config
 *
 * Refresh:
 *   POST /v2/plugin/auth/token/refresh with X-Refresh-Token header
 *
 * This module is host-agnostic (no vscode / electron imports): the VS Code
 * extension, the Electron app and the standalone HTTP server all share it.
 *
 * Region flow: every helper that talks to the cluster accepts the FULL
 * `WorkbuddyAuth`. `clusterFor(account)` returns the right `baseUrl` and
 * `origin` pair from the account's region, so a single call site handles both
 * regions correctly without an `if region === "cn"` branch on every request.
 */

import * as https from "https";
import * as http from "http";
import { REGION_PROFILES, type Region, DEFAULT_REGION } from "./region";

const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/** How often a caller should poll pollLoginOnce() while waiting for a scan. */
export const POLL_INTERVAL_MS = 2_000;
/** How long a login attempt stays valid before the UI should give up. */
export const LOGIN_TTL_MS = 5 * 60 * 1_000;

export interface WorkbuddyAuth {
  accessToken: string;
  refreshToken: string;
  savedAt: number;
  expiresAt: number;
  userAgent: string;
  uid?: string;
  enterpriseId?: string;
  nickname?: string;
  domain?: string;
  /** Which cluster this token belongs to. Defaults to CN for pre-split accounts. */
  region?: Region;
}

/** The base URL the upstream cluster lives at for the given region. */
export function baseUrlFor(region: Region | undefined): string {
  return REGION_PROFILES[region ?? DEFAULT_REGION].baseUrl;
}

/** The Origin / Referer pair the upstream requires for cross-site requests. */
export function originFor(region: Region | undefined): string {
  return REGION_PROFILES[region ?? DEFAULT_REGION].origin;
}

/**
 * Everything the cluster needs from one place: a `baseUrl`, the `origin` to
 * present, and the resolved `region`. Returning the region makes the caller's
 * decisions log (log) accurate without re-deriving it from the account.
 */
export function clusterFor(account: { region?: Region }): {
  baseUrl: string;
  origin: string;
  region: Region;
} {
  const region = account.region ?? DEFAULT_REGION;
  const profile = REGION_PROFILES[region];
  return { baseUrl: profile.baseUrl, origin: profile.origin, region };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function rawRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          "User-Agent": CLIENT_UA,
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function apiPost(
  baseUrl: string,
  origin: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<unknown> {
  const res = await rawRequest(
    "POST",
    `${baseUrl}${path}`,
    {
      "User-Agent": CLIENT_UA,
      Origin: origin,
      Referer: origin + "/",
      ...headers,
    },
    body ?? "{}"
  );
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.data.slice(0, 200)}`);
  const env = JSON.parse(res.data) as { code: number; msg: string; data: unknown };
  if (env.code !== 0) throw new Error(`API error ${env.code}: ${env.msg}`);
  return env.data;
}

async function apiGet(
  baseUrl: string,
  origin: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<unknown> {
  const res = await rawRequest(
    "GET",
    `${baseUrl}${path}`,
    {
      "User-Agent": CLIENT_UA,
      Origin: origin,
      Referer: origin + "/",
      "Content-Type": "application/json",
      ...headers,
    }
  );
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.data.slice(0, 200)}`);
  const env = JSON.parse(res.data) as { code: number; msg: string; data: unknown };
  if (env.code !== 0) throw new Error(`API error ${env.code}: ${env.msg}`);
  return env.data;
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

export interface LoginTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  domain?: string;
}

export type LoginPollResult =
  | { status: "pending" }
  | { status: "success"; tokens: LoginTokens };

/** The `platform` query value each cluster's auth/state endpoint expects. */
function platformFor(region: Region): string {
  return region === "intl" ? "workbuddy-ai" : "CLI";
}

export async function startLogin(
  region: Region = DEFAULT_REGION
): Promise<{ state: string; authUrl: string }> {
  const { baseUrl, origin } = clusterFor({ region });
  const data = (await apiPost(
    baseUrl,
    origin,
    `/v2/plugin/auth/state?platform=${platformFor(region)}`
  )) as {
    state: string;
    authUrl: string;
  };
  if (!data.state || !data.authUrl) throw new Error("Invalid auth state");
  // The gateway echoes the authUrl host from the request's Host header, so a
  // call to the intl API host (`www.codebuddy.ai`) returns an authUrl on that
  // host — which 301s to the real login page. Rewrite it to the cluster's
  // origin up front (what the real desktop app opens) so the user lands
  // directly on the page that binds the state.
  if (region === "intl") {
    data.authUrl = data.authUrl.replace(/^https?:\/\/[^/]+/, origin);
  }
  return data;
}

/**
 * ONE poll attempt — never blocks waiting for the scan.
 *
 * The CALLER owns the polling loop (sleeping POLL_INTERVAL_MS between
 * attempts, giving up after LOGIN_TTL_MS). Keeping a single attempt per call
 * means the webview UI, the Electron renderer and the HTTP API can all drive
 * the flow without holding a request open for up to five minutes, and the UI
 * can show a live countdown.
 */
export async function pollLoginOnce(
  state: string,
  region: Region = DEFAULT_REGION
): Promise<LoginPollResult> {
  const { baseUrl, origin } = clusterFor({ region });
  try {
    const data = (await apiGet(
      baseUrl,
      origin,
      `/v2/plugin/auth/token?state=${state}`
    )) as {
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      domain?: string;
    };
    if (data.accessToken) {
      return {
        status: "success",
        tokens: {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken || "",
          expiresIn: data.expiresIn ?? 3600,
          domain: data.domain,
        },
      };
    }
  } catch {
    // 11217 = still pending; other errors are transient here too.
  }
  return { status: "pending" };
}

export interface AccountIdentity {
  uid: string;
  enterpriseId: string;
  nickname: string;
}

/**
 * Fetch the signed-in account's identity.
 *
 * Authenticates with the ACCESS TOKEN — NOT the login `state`.
 *
 * This endpoint does not read `state` at all: with no Authorization header it
 * answers 401 no matter what state you pass, and with a valid bearer it answers
 * 200 with no state at all (verified against the live gateway). The original
 * implementation only sent a state, so the call ALWAYS failed — and because the
 * failure was swallowed, every account was stored with an empty uid and
 * nickname, and got the fallback account key "default".
 *
 * Throws on failure on purpose: an unidentified account is not something to
 * paper over, because two of them would collide on that same fallback key and
 * the second login would OVERWRITE the first.
 */
export async function fetchAccount(
  accessToken: string,
  region: Region = DEFAULT_REGION
): Promise<AccountIdentity> {
  const { baseUrl, origin } = clusterFor({ region });
  const a = (await apiGet(
    baseUrl,
    origin,
    "/v2/plugin/login/account",
    { Authorization: `Bearer ${accessToken}` }
  )) as {
    uid?: string;
    nickname?: string;
    enterpriseId?: string;
    enterprise?: { id?: string };
  };
  return {
    uid: a.uid || "",
    enterpriseId: a.enterpriseId || a.enterprise?.id || "",
    nickname: a.nickname || "",
  };
}

export async function refreshTokens(
  refreshToken: string,
  region: Region = DEFAULT_REGION
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const { baseUrl, origin } = clusterFor({ region });
  const data = (await apiPost(
    baseUrl,
    origin,
    "/v2/plugin/auth/token/refresh",
    { "X-Refresh-Token": refreshToken }
  )) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
  if (!data.accessToken) throw new Error("Refresh failed: no access token");
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || refreshToken,
    expiresAt: Date.now() + (data.expiresIn ?? 3600) * 1000,
  };
}

