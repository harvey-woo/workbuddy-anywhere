/**
 * Billing / quota API for the WorkBuddy backend.
 *
 * Endpoint: POST <baseUrl>/billing/meter/get-user-resource
 * Auth:     Bearer + X-User-Id + X-Enterprise-Id
 *
 * The base URL and Origin pair come from the account's region — see
 * `clusterFor()` in auth.ts. The CN cluster accepts the request; the INTL
 * cluster's billing endpoint is currently unconfirmed (same shape is
 * assumed — verified by `parseModelCatalog` returning identical structure
 * from both hosts; the billing endpoint returns 401 with a CN token, so the
 * shape is plausibly the same but is NOT proven end-to-end with an INTL token).
 *
 * Note: The billing API requires a browser-like User-Agent (not the CLI UA).
 * The workbuddy-usage extension confirms this.
 */

import { WorkbuddyAuth, clusterFor } from "./auth";
import { UnauthorizedError } from "./errors";

// Browser UA for billing API (different from chat API which uses CLI UA)
const BILLING_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

export interface BillingAccount {
  accountId: number;
  packageName: string;
  packageCode: string;
  capacityRemain: number;
  capacitySize: number;
  cycleCapacityRemain: number;
  cycleCapacitySize: number;
  cycleEndTime: string;
  status: number;
}

export interface BillingResult {
  totalRemain: number;
  totalSize: number;
  accounts: BillingAccount[];
}

/** Percentage of the quota still available (0 when the total is unknown). */
export function billingPercent(billing: BillingResult): number {
  return billing.totalSize > 0
    ? (billing.totalRemain / billing.totalSize) * 100
    : 0;
}

function headersFor(auth: WorkbuddyAuth, origin: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Client-Platform": "web",
    "X-Product": "SaaS",
    "User-Agent": BILLING_UA,
    Origin: origin,
    Referer: origin + "/",
    Authorization: `Bearer ${auth.accessToken}`,
  };
  if (auth.uid) h["X-User-Id"] = auth.uid;
  if (auth.enterpriseId) h["X-Enterprise-Id"] = auth.enterpriseId;
  if (auth.refreshToken) h["X-Refresh-Token"] = auth.refreshToken;
  return h;
}

export async function fetchBilling(auth: WorkbuddyAuth): Promise<BillingResult> {
  const { baseUrl, origin } = clusterFor(auth);
  const resp = await fetch(`${baseUrl}/billing/meter/get-user-resource`, {
    method: "POST",
    headers: headersFor(auth, origin),
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 200,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      OnlyValidPeriod: true,
    }),
  });

  if (resp.status === 401 || resp.status === 403) {
    // Typed so the HTTP layer answers 401 instead of blaming the upstream
    // with a 502: the caller CAN act on this, by signing in again.
    throw new UnauthorizedError("AUTH_EXPIRED");
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const json = (await resp.json()) as {
    code: number;
    data?: {
      Response?: {
        Data?: {
          Accounts?: Array<{
            AccountId: number;
            PackageName: string;
            PackageCode: string;
            CapacityRemain: number;
            CapacitySize: number;
            CycleCapacityRemain: number;
            CycleCapacitySize: number;
            CycleEndTime: string;
            Status: number;
          }>;
        };
      };
    };
  };

  if (json.code !== 0) {
    throw new Error(`API error ${json.code}`);
  }

  const accounts = json.data?.Response?.Data?.Accounts ?? [];
  let totalRemain = 0;
  let totalSize = 0;

  for (const a of accounts) {
    const remain = a.CycleCapacityRemain ?? a.CapacityRemain ?? 0;
    const size = a.CycleCapacitySize ?? a.CapacitySize ?? 0;
    totalRemain += remain;
    totalSize += size;
  }

  return {
    totalRemain,
    totalSize,
    accounts: accounts.map((a) => ({
      accountId: a.AccountId,
      packageName: a.PackageName,
      packageCode: a.PackageCode,
      capacityRemain: a.CapacityRemain,
      capacitySize: a.CapacitySize,
      cycleCapacityRemain: a.CycleCapacityRemain,
      cycleCapacitySize: a.CycleCapacitySize,
      cycleEndTime: a.CycleEndTime,
      status: a.Status,
    })),
  };
}

// ---------------------------------------------------------------------------
// Check-in API (daily sign-in for bonus credits)
// Uses the region's /billing/meter endpoints with Bearer auth.
// Falls back gracefully if the endpoint is unavailable or returns non-JSON.
// ---------------------------------------------------------------------------

export interface CheckinResult {
  state: "claimed" | "unclaimed" | "unknown";
  credit?: number;
  freshlyClaimed?: boolean;
  error?: string;
}

/** Safely parse JSON from response, returning null if non-JSON */
async function safeJson(resp: Response): Promise<unknown | null> {
  try {
    const text = await resp.text();
    // Skip HTML error pages (401/403 from openresty gateway)
    if (text.trimStart().startsWith("<")) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Get today's check-in status.
 *
 * READ-ONLY on purpose: it never claims the bonus. Exported so a host can
 * refresh what it displays without mutating anything as a side effect of
 * rendering a page — claiming is `ensureCheckin`'s job.
 */
export async function fetchCheckinStatus(auth: WorkbuddyAuth): Promise<CheckinResult> {
  const { baseUrl, origin } = clusterFor(auth);
  try {
    const resp = await fetch(`${baseUrl}/billing/meter/checkin-status`, {
      method: "POST",
      headers: headersFor(auth, origin),
      body: "{}",
    });
    // 401/403 = auth issue, skip gracefully
    if (resp.status === 401 || resp.status === 403) {
      return { state: "unknown", error: "AUTH_REQUIRED" };
    }
    const json = await safeJson(resp);
    if (!json || typeof json !== "object") {
      return { state: "unknown", error: "NON_JSON_RESPONSE" };
    }
    const obj = json as Record<string, unknown>;
    // Gateway returns HTTP 400 + code=10001 for "already claimed" (idempotent)
    if (obj.code === 10001) return { state: "claimed" };
    if (obj.code !== 0) return { state: "unknown", error: `code=${obj.code}` };
    const data = obj.data as Record<string, unknown> | undefined;
    // `today_checked_in` describes the seasonal check-in ACTIVITY, not the
    // daily bonus: with no activity running the gateway returns the whole block
    // zeroed (`active:false`, `activity_name:""`, `start_time`/`end_time`:""`)
    // — this flag included. Reading it as the daily verdict therefore reported
    // "unclaimed" for accounts that had already claimed. Verified 2026-09-15:
    // `daily-checkin` answered 10001 "今天已签到，请明天再来" for three accounts
    // this endpoint called `today_checked_in:false`.
    //
    // There is NO read-only source for the daily bonus — no other endpoint
    // exists, and the billing payload carries no check-in field. So when no
    // activity is running the honest answer is "cannot tell", and the only way
    // to learn the truth is `doCheckin` (idempotent, see `ensureCheckin`).
    if (data?.active !== true) return { state: "unknown" };
    if (data.today_checked_in === true) return { state: "claimed" };
    return { state: "unclaimed" };
  } catch (e: unknown) {
    return { state: "unknown", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Perform the check-in (claim daily bonus) */
async function doCheckin(auth: WorkbuddyAuth): Promise<CheckinResult> {
  const { baseUrl, origin } = clusterFor(auth);
  try {
    const resp = await fetch(`${baseUrl}/billing/meter/daily-checkin`, {
      method: "POST",
      headers: headersFor(auth, origin),
      body: "{}",
    });
    if (resp.status === 401 || resp.status === 403) {
      return { state: "unknown", error: "AUTH_REQUIRED" };
    }
    const json = await safeJson(resp);
    if (!json || typeof json !== "object") {
      return { state: "unknown", error: "NON_JSON_RESPONSE" };
    }
    const obj = json as Record<string, unknown>;
    if (obj.code === 10001) return { state: "claimed" };
    if (obj.code === 0) {
      const data = obj.data as Record<string, unknown> | undefined;
      return { state: "claimed", credit: data?.credit as number | undefined, freshlyClaimed: true };
    }
    return { state: "unknown", error: `code=${obj.code}` };
  } catch (e: unknown) {
    return { state: "unknown", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Ensure daily check-in: claim unless the gateway CONFIRMS it is already done.
 * Returns the check-in result (useful for tooltip display).
 *
 * Anything short of "claimed" falls through to the claim endpoint, including an
 * inconclusive status read — which is the normal case (see
 * `fetchCheckinStatus`). Claiming is idempotent, and its 10001 answer
 * ("今天已签到，请明天再来") is the only authoritative statement that today's
 * bonus is already claimed. Treating "unknown" as "nothing to do" would mean
 * never claiming at all.
 */
export async function ensureCheckin(auth: WorkbuddyAuth): Promise<CheckinResult> {
  try {
    const status = await fetchCheckinStatus(auth);
    if (status.state === "claimed") return status;
    return await doCheckin(auth);
  } catch {
    return { state: "unknown" };
  }
}
