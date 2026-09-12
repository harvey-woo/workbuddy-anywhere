/**
 * Automatic account selection ("auto mode") — the PURE half.
 *
 * Everything here is a pure function over plain data so the allocation rules
 * can be tested without a service, network, or clock beyond a `now` argument.
 * The stateful half (pin storage, billing freshness, background refresh)
 * lives in `service.ts`.
 *
 * Allocation rules, in the order the user asked for them:
 *
 *   1. SESSION AFFINITY FIRST. A pinned account is reused for as long as it
 *      is eligible and the session has not gone idle — even when another
 *      account has quota expiring sooner. Switching accounts mid-conversation
 *      is exactly what this feature must never do.
 *   2. Only when there is NO usable pin (first request, or the pinned account
 *      died / went idle) does the allocator pick a new account:
 *      "spend the credits that are about to expire" — the account holding the
 *      soonest-expiring package with credits left wins, because those credits
 *      are worthless once the cycle ends.
 *      Tie-breaks: more remaining credits, then least-recently-used, so idle
 *      capacity gets exercised instead of hammering one account.
 */

/** One account, as the allocator sees it. All fields are snapshots. */
export interface PoolCandidate {
  key: string;
  /**
   * Total credits still available, from the latest billing snapshot.
   * `undefined` = we never got a billing answer for this account — it stays
   * ELIGIBLE (an unmeasured account is not an empty one) but sorts last,
   * because we cannot reason about its expiry.
   */
  remain?: number;
  /**
   * Earliest `cycleEndTime` among the account's packages that still have
   * credits (ms epoch). `undefined` = unknown / no packages with credits.
   */
  soonestExpiry?: number;
  /** Last token-refresh failure — an account we cannot authenticate as. */
  refreshError?: string;
  /** When this account last served a request (ms epoch); never = undefined. */
  lastUsedAt?: number;
}

/** A session→account binding. */
export interface PinnedSession {
  key: string;
  /** Last time this pin was USED (a request picked it), for idle expiry. */
  lastUsedAt: number;
}

/** Requests idle longer than this release their pin (and a new one is picked). */
export const AUTO_SELECT_IDLE_MS = 30 * 60_000;

/** An account at or below this many credits is treated as exhausted. */
export const AUTO_SELECT_MIN_REMAIN = 1;

/** Billing snapshots older than this trigger a background refresh. */
export const BILLING_STALE_MS = 5 * 60_000;

/**
 * Can this account serve a request right now?
 *
 * Eligible does NOT mean "preferred": an account with unknown usage is
 * eligible (we simply do not know), while one that failed token refresh is
 * not — we cannot even authenticate as it.
 */
export function isEligible(c: PoolCandidate): boolean {
  if (c.refreshError) return false;
  if (c.remain !== undefined && c.remain <= AUTO_SELECT_MIN_REMAIN) return false;
  return true;
}

/**
 * Pick the account for one request.
 *
 * `pinned` is the CURRENT binding for this session (or undefined). When it is
 * fresh (not idle) and still eligible it wins outright — affinity first,
 * always. Otherwise the best eligible candidate is chosen expiry-first.
 *
 * Returns the account key, or null when nothing is eligible (the caller then
 * falls back to whatever the host did before auto-select existed).
 */
export function pickAutoAccount(
  candidates: PoolCandidate[],
  pinned: PinnedSession | undefined,
  now: number,
  idleMs: number = AUTO_SELECT_IDLE_MS
): string | null {
  if (pinned && now - pinned.lastUsedAt <= idleMs) {
    const pin = candidates.find((c) => c.key === pinned.key);
    if (pin && isEligible(pin)) return pinned.key;
  }

  const eligible = candidates.filter(isEligible);
  if (eligible.length === 0) return null;

  // soonestExpiry undefined → Infinity (unmeasured accounts sort last)
  const expiry = (c: PoolCandidate): number => c.soonestExpiry ?? Number.POSITIVE_INFINITY;
  // lastUsedAt undefined → 0 (never used = oldest = tried first)
  const lru = (c: PoolCandidate): number => c.lastUsedAt ?? 0;
  const remain = (c: PoolCandidate): number => c.remain ?? Number.NEGATIVE_INFINITY;

  eligible.sort((a, b) => {
    const byExpiry = expiry(a) - expiry(b);
    if (byExpiry !== 0) return byExpiry;
    const byRemain = remain(b) - remain(a);
    if (byRemain !== 0) return byRemain;
    return lru(a) - lru(b);
  });
  return eligible[0].key;
}

/**
 * True when a billing snapshot is too old to base a decision on (the caller
 * should kick off a background refresh and keep using the snapshot).
 */
export function isBillingStale(fetchedAt: number | undefined, now: number): boolean {
  return fetchedAt === undefined || now - fetchedAt > BILLING_STALE_MS;
}
