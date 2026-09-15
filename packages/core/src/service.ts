/**
 * WorkbuddyService — the single façade every host talks to.
 *
 * The VS Code extension, the Electron app and the HTTP server all drive this
 * class; the shared Vue UI reaches it through a transport (postMessage / IPC /
 * HTTP) that only forwards these method calls. That is what removes the
 * per-host request-building layer: nobody re-implements auth, model caching,
 * custom-model merging, check-in or the chat payload any more.
 *
 * MULTI-ACCOUNT. The store holds N accounts; one of them is ACTIVE and is what
 * chat/billing use. Two rules the user asked for explicitly:
 *
 *   1. Every account is kept alive by the same 60s tick, so switching accounts
 *      never needs a fresh QR scan. An idle account must NOT be allowed to
 *      expire just because it was not the active one.
 *   2. Daily check-in runs for every account, not just the active one.
 *
 * The model catalog is GLOBAL, not per account: within a region `/v3/config`
 * answers the same list for every account of that region (it is scoped by the
 * CLIENT IDENTITY — User-Agent + region — not by whose token asks; see
 * `RegionProfile.clientUserAgent`), so N accounts would just be N identical
 * requests. User preferences (settings) are global too — one config, N
 * accounts — while billing and check-in ARE per account.
 */

import {
  AccountIdentity,
  WorkbuddyAuth,
  LOGIN_TTL_MS,
  POLL_INTERVAL_MS,
  fetchAccount,
  pollLoginOnce,
  refreshTokens,
  startLogin,
} from "./auth";
import { BadRequestError, UnauthorizedError } from "./errors";
import { DEFAULT_REGION, REGIONS, type Region } from "./region";
import {
  BillingAccount,
  BillingResult,
  CheckinResult,
  billingPercent,
  ensureCheckin,
  fetchBilling,
  fetchCheckinStatus,
} from "./billing";
import {
  ExcludedModel,
  ModelConfig,
  applyModelOverrides,
  fetchModelConfig,
  fetchModelConfigAnonymous,
  pickAgent,
} from "./models";
import type { Settings, SettingsStore } from "./settings";
import { accountKey, accountLabel, type AuthStore } from "./storage";
import {
  AUTO_SELECT_IDLE_MS,
  BILLING_STALE_MS,
  isBillingStale,
  pickAutoAccount,
  type PinnedSession,
  type PoolCandidate,
} from "./pool";
import type { ChatEvent, ChatImage, ChatRequest } from "./chat/types";
import { streamChat } from "./chat/engine";
import { catalogVisionHelper, capDescription, listCatalogVisionModels } from "./vision";
import type { VisionHelper, VisionModelChoice } from "./vision";

/** Browser-ish UA the gateway expects on login/billing/chat. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/**
 * Refresh the access token this long before it actually expires.
 *
 * 5 minutes, not 1: the tick runs once a minute, so a 5-minute window gives
 * five chances to refresh before the token actually dies. With a 1-minute
 * window a single failed tick (network blip, gateway 5xx) means the account
 * is dead until the user signs in again — which is exactly the failure the
 * multi-account design is supposed to prevent.
 */
const REFRESH_SKEW_MS = 5 * 60_000;
/** How often the background token-refresh tick runs. */
const REFRESH_TICK_MS = 60_000;
/** Label for the built-in helper's models, shown by the shared UI. */
const BUILTIN_VISION_LABEL = "WorkBuddy models";

export type ModelSource = "auth" | "anonymous" | "none";

export interface ServiceOptions {
  auth: AuthStore;
  settings: SettingsStore;
  log?: (msg: string) => void;
  /**
   * Image descriptions — the host's OWN source, when it has one.
   *
   * Left unset by hosts with no model namespace of their own (the desktop app,
   * the HTTP server): core then uses its built-in helper over the account's
   * catalog, which is the only place the account's credential is in scope.
   * VS Code supplies a helper backed by `vscode.lm`, which can reach models
   * core cannot. The host helper is tried FIRST and the built-in second, so a
   * failing host degrades to catalog behaviour instead of a broken chat.
   */
  vision?: VisionHelper;
}

/** Quota for one account, including the per-package rows. */
export interface AccountUsage {
  percent: number;
  remain: number;
  size: number;
  /**
   * The gateway's own package rows, passed through verbatim.
   *
   * A single account can hold several packages (a monthly plan, a bonus pack,
   * an expiring trial), each with its own capacity and expiry — so a single
   * number is not enough when the user wants to know WHERE the credits are.
   */
  packages: BillingAccount[];
}

/** One row in the account switcher. */
export interface AccountSummary {
  /** Stable identity — every account mutation is keyed by this. */
  key: string;
  uid?: string;
  enterpriseId?: string;
  nickname?: string;
  /** Pre-rendered label so every host shows the same name. */
  label: string;
  /**
   * Which cluster this account lives on. Part of every request's routing, and
   * the reason a CN account and an INTL account can coexist in one list.
   */
  region: Region;
  expiresAt?: number;
  /** Access token is already past expiry and the refresh has not landed yet. */
  expired: boolean;
  active: boolean;
  usage?: AccountUsage;
  /** Result of this account's most recent check-in attempt, when known. */
  checkin?: CheckinResult;
  /**
   * True when AUTO-SELECT currently has this account pinned for its region
   * (only meaningful while `settings.autoSelectAccount` is on). This is the
   * account the next request would use — shown as an "auto" badge in the UI.
   */
  auto?: boolean;
  /** Last refresh failure for THIS account — surfaced, never swallowed. */
  refreshError?: string;
  /**
   * Why there is no quota figure for this account.
   *
   * Without it, a failed billing call renders as a bare "quota unavailable"
   * with no packages and no explanation — indistinguishable from "this account
   * genuinely has no packages".
   */
  usageError?: string;
}

export interface ServiceState {
  /** True when at least one account is stored and usable. */
  loggedIn: boolean;
  accounts: AccountSummary[];
  activeKey: string | null;
  /** The active account's identity, flattened for hosts that show one name. */
  nickname?: string;
  uid?: string;
  enterpriseId?: string;
  expiresAt?: number;
  settings: Settings;
  /** The shared catalog, plus the user's custom IDs. */
  models: ModelConfig[];
  /** "anonymous" = catalog fetched without a usable session. */
  modelsSource: ModelSource;
  /**
   * Catalog entries deliberately withheld from `models` (image-generation
   * models, internal `lite` helpers). Reported so a host can show them (greyed)
   * and switch them on.
   */
  excludedModels: ExcludedModel[];
  /**
   * Why the catalog is missing or stale. Recorded even when a fallback catalog
   * stands in — otherwise a broken fetch silently renders as "0 models".
   */
  catalogError?: string;
  /**
   * The ACTIVE account's quota, flattened for hosts that show one number.
   * The same data is on `accounts[].usage`, which is what multi-account views
   * should read.
   */
  usage?: AccountUsage;
  /**
   * Which region the catalog and models in this payload belong to — i.e. the
   * active account's region, or CN while signed out. A host that renders a
   * region switcher reads this instead of guessing.
   */
  region: Region;
}

/** Result of "check in everywhere". */
export interface CheckinAllResult {
  /** account key -> that account's result */
  results: Record<string, CheckinResult>;
  /** How many accounts claimed a bonus on this run. */
  claimed: number;
  /** How many accounts failed (unknown state or error). */
  failed: number;
}

/**
 * What the UI needs to render the vision-fallback picker.
 *
 * `sources` names WHERE the ids resolve, so the user can tell an LM-namespace
 * model from a catalog one. There is only ever ONE source: a list mixing two
 * namespaces offers choices whose ids the describe half resolves differently.
 */
export interface VisionModelsResult {
  sources: string[];
  models: Array<VisionModelChoice & { source: string }>;
}

export interface LoginStart {
  /**
   * The polling token — EMPTY when the region's flow has nothing to poll (the
   * international cluster logs in through OAuth, so the UI must instead wait
   * for the browser round-trip to complete). Callers must not assume a state
   * exists just because a login started.
   */
  state: string;
  authUrl: string;
  expiresInMs: number;
  pollIntervalMs: number;
  region: Region;
}

export type LoginPoll =
  | { status: "pending" }
  | {
      status: "success";
      /** Account key of the account that was just added and made active. */
      key: string;
      nickname?: string;
      uid?: string;
      checkin?: CheckinResult;
    }
  | { status: "expired" };

export interface UsageSnapshot {
  billing: BillingResult;
  checkin: CheckinResult;
}

/** The fetched model catalog, plus how it was obtained. */
interface CatalogEntry {
  models: ModelConfig[];
  source: ModelSource;
  excluded: ExcludedModel[];
}

export class WorkbuddyService {
  private readonly log: (msg: string) => void;
  private readonly listeners = new Set<() => void>();
  /**
   * The model catalog — one cache per REGION, and deliberately not one per
   * account.
   *
   * Within a region, `/v3/config` is not ACCOUNT-scoped: it answers the same
   * list for any token of that region (verified 2026-09-11). What it DOES key
   * off is the client identity — User-Agent plus whether an id header is sent —
   * so the identity lives in `RegionProfile` and the cache is per region, never
   * per account. A per-account cache would cost N identical round-trips at
   * startup and give N ways to fail, in exchange for nothing.
   *
   * Across regions it IS different, and not subtly: CN serves 29 models and
   * INTL serves 35, with different ids in front (`default` vs `default-model`).
   * Sharing one cache would show a Chinese user the international catalog, or
   * the reverse — so the region is the cache key.
   */
  private readonly catalogs = new Map<Region, CatalogEntry>();
  private readonly catalogErrors = new Map<Region, string>();
  /** Billing and check-in ARE per account — those endpoints do need a session. */
  private readonly billings = new Map<string, BillingResult>();
  /** When each billing snapshot was fetched — auto-select freshness check. */
  private readonly billingsAt = new Map<string, number>();
  /** Billing refreshes already running — so one stale snapshot kicks off one fetch. */
  private readonly billingRefreshInFlight = new Set<string>();
  private readonly checkins = new Map<string, CheckinResult>();
  /**
   * Local day (`YYYY-MM-DD`, see `localDayKey`) each verdict above describes.
   *
   * The bonus resets at local midnight, and the gateway has NO read-only
   * endpoint that can re-confirm it (see `fetchCheckinStatus`), so the claim is
   * the record — and the day it was made on is part of it.
   */
  private readonly checkinDay = new Map<string, string>();
  private readonly refreshErrors = new Map<string, string>();
  /** Billing failures, keyed by account — the reason quota is blank. */
  private readonly billingErrors = new Map<string, string>();
  /**
   * Login attempts, one per region.
   *
   * Not a single slot: two sign-ins can be in flight at once when the user is
   * adding a CN account and an INTL account, and a shared slot would let one
   * overwrite the other's `state` — the second scan would then be polled with
   * the first one's token.
   */
  private readonly logins = new Map<Region, { state: string; startedAt: number }>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  /** Armed for the next local midnight; re-arms itself (cross-day check-in). */
  private checkinTimer?: ReturnType<typeof setTimeout>;
  /**
   * Auto-select session pins: region -> (session slot -> pinned account).
   * The slot id is the request's `sessionKey`, or the shared "default" slot
   * for hosts that cannot identify sessions (VS Code's LM provider). Each pin
   * expires after AUTO_SELECT_IDLE_MS without use.
   */
  private readonly autoPins = new Map<Region, Map<string, PinnedSession>>();
  /** When each account last served a request — the allocator's LRU tie-break. */
  private readonly lastUsedAt = new Map<string, number>();

  constructor(private readonly opts: ServiceOptions) {
    this.log = opts.log ?? (() => {});
  }

  // ── change notification ───────────────────────────────────────────────

  /** Subscribe to session/model/settings changes. Returns an unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // A listener must never break the service.
      }
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /**
   * Load every stored account, warm the catalog and start the token-refresh
   * tick. Never throws: a broken network must not stop a host from starting.
   */
  async init(options: { autoCheckin?: boolean } = {}): Promise<ServiceState> {
    const accounts = await this.opts.auth.list();

    if (accounts.length === 0) {
      await this.loadCatalog(DEFAULT_REGION);
      this.emit();
      return this.getState();
    }

    // The tick refreshes ALL accounts, which is what makes switching accounts
    // instant instead of "scan the QR code again".
    this.startTokenRefresh();

    // ONE catalog fetch for everyone (see the `catalog` field).
    const active = await this.loadActiveAuth();
    await this.loadCatalog(this.regionOf(active), active);

    // Repair accounts stored before the identity lookup was fixed. Runs before
    // anything caches per-account state, so no key goes stale.
    await this.backfillIdentities();

    // Warm EVERY account's quota, not just the active one: the management page
    // shows a bill per account and must not need a manual refresh to do it.
    await this.refreshAllUsage();

    if (options.autoCheckin) {
      // One sweep over EVERY account — the user asked for "签到一起签".
      try {
        await this.checkinAll();
      } catch (err) {
        this.log(`auto check-in sweep failed: ${errText(err)}`);
      }
    }

    // Check-in is a DAILY thing, and the app may stay open across midnight.
    // Claim whatever is claimable on the new day (both clusters), then keep a
    // timer armed for the next midnight so a long-lived host never misses one.
    this.startCheckinRollover();

    this.emit();
    return this.getState();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.checkinTimer) {
      clearTimeout(this.checkinTimer);
      this.checkinTimer = undefined;
    }
    this.listeners.clear();
  }

  // ── state ─────────────────────────────────────────────────────────────

  async getState(preferredRegion?: Region): Promise<ServiceState> {
    const settings = await this.opts.settings.get();
    const accounts = await this.opts.auth.list();
    // Per-region active keys: the two clusters hold independent picks, so
    // which account is "the current one" depends on which region the UI is
    // looking at. `currentRegion` is the user's chosen region from settings.
    const currentRegion = preferredRegion ?? settings.region;
    const activeKeysByRegion = await this.collectActiveKeys(accounts);
    const activeKey = activeKeysByRegion[currentRegion] ?? null;
    const active = activeKey ? accounts.find((a) => accountKey(a) === activeKey) : undefined;
    const catalog = this.catalogEntry(currentRegion);
    // The list hosts receive: the catalog + the user's allow/deny.
    const effective = applyModelOverrides(catalog, settings);
    const billing = active ? this.billings.get(accountKey(active)) : undefined;
    const autoKeysByRegion = this.autoKeysByRegion(settings.autoSelectAccount);

    return {
      loggedIn: !!active && Date.now() < active.expiresAt,
      accounts: accounts.map((a) =>
        this.summarize(
          a,
          activeKeysByRegion[a.region ?? DEFAULT_REGION] ?? null,
          autoKeysByRegion[a.region ?? DEFAULT_REGION] ?? null
        )
      ),
      // The activeKey we surface is for the region the user is looking at,
      // so the UI can label a single "current" account without a region prefix.
      activeKey: activeKey ?? null,
      nickname: active?.nickname,
      uid: active?.uid,
      enterpriseId: active?.enterpriseId,
      expiresAt: active?.expiresAt,
      settings,
      models: effective.models,
      modelsSource: catalog.source,
      excludedModels: effective.excluded,
      catalogError: this.catalogErrors.get(currentRegion),
      region: currentRegion,
      usage: usageOf(billing),
    };
  }

  /**
   * Read every region's active key in one pass. Used by `getState` to attach
   * the right `active` flag to each account and to surface the right active
   * for the user's current region.
   */
  private async collectActiveKeys(
    accounts: WorkbuddyAuth[]
  ): Promise<Record<Region, string | null>> {
    const out: Record<Region, string | null> = { cn: null, intl: null };
    const regions = new Set(accounts.map((a) => a.region ?? DEFAULT_REGION));
    for (const r of regions) {
      out[r] = await this.opts.auth.getActiveKey(r);
    }
    return out;
  }

  private summarize(
    auth: WorkbuddyAuth,
    activeKey: string | null,
    autoKey: string | null = null
  ): AccountSummary {
    const key = accountKey(auth);
    const billing = this.billings.get(key);
    return {
      key,
      uid: auth.uid,
      enterpriseId: auth.enterpriseId,
      nickname: auth.nickname,
      label: accountLabel(auth),
      region: this.regionOf(auth),
      expiresAt: auth.expiresAt,
      expired: Date.now() >= auth.expiresAt,
      active: key === activeKey,
      auto: autoKey !== null && key === autoKey,
      usage: usageOf(billing),
      checkin: this.checkins.get(key),
      refreshError: this.refreshErrors.get(key),
      usageError: this.billingErrors.get(key),
    };
  }

  /** The catalog, or an empty placeholder before the first fetch lands. */
  private catalogEntry(region: Region): CatalogEntry {
    return this.catalogs.get(region) ?? { models: [], source: "none", excluded: [] };
  }

  /**
   * The effective list for a region: the catalog plus the user's allow/deny.
   * EVERY consumer goes through here, so a blacklisted model cannot be honoured
   * by one caller and ignored by another.
   */
  private effectiveModels(region: Region, settings: Settings): ModelConfig[] {
    return applyModelOverrides(this.catalogEntry(region), settings).models;
  }

  /**
   * Which region the UI is looking at: the active account's, defaulting to CN
   * while signed out (a signed-out user still gets a catalog to browse).
   */
  private regionOf(auth: WorkbuddyAuth | undefined): Region {
    return auth?.region ?? DEFAULT_REGION;
  }

  /** Record a verdict, remembering which day it describes. */
  private recordCheckin(key: string, result: CheckinResult): void {
    this.checkins.set(key, result);
    this.checkinDay.set(key, localDayKey());
  }

  /** Forget an account's verdict — its key changed, or it is gone. */
  private forgetCheckin(key: string): void {
    this.checkins.delete(key);
    this.checkinDay.delete(key);
  }

  /** Whether the stored verdict was obtained today, so still describes today. */
  private checkinRecordedToday(key: string): boolean {
    return this.checkinDay.get(key) === localDayKey();
  }

  /**
   * Whether the daily check-in should run for THIS account's cluster. The
   * INTL gateway has no check-in endpoint, so it ships disabled; both flags
   * live in settings (`checkinByRegion`) and are plain config — nothing in
   * core renders a toggle for them. A disabled region behaves as "no
   * check-in feature exists": every entry point skips silently.
   */
  private async checkinEnabledFor(auth: WorkbuddyAuth | undefined): Promise<boolean> {
    const settings = await this.opts.settings.get();
    const region = this.regionOf(auth);
    const flags = settings.checkinByRegion;
    return region === "intl" ? (flags?.intl ?? false) : (flags?.cn ?? true);
  }

  private async currentRegion(): Promise<Region> {
    const settings = await this.opts.settings.get();
    return settings.region;
  }

  /** Per-region active key (defaults to the user's current region). */
  private async activeKeyOrNull(): Promise<string | null> {
    const r = await this.currentRegion();
    return this.opts.auth.getActiveKey(r);
  }

  /** The effective model list for the user's current region. */
  async getModels(): Promise<ModelConfig[]> {
    const settings = await this.opts.settings.get();
    const active = await this.loadActiveAuth();
    return this.effectiveModels(this.regionOf(active), settings);
  }

  /**
   * Candidates for `settings.visionFallbackModel`.
   *
   * ONE namespace, never a merge: the setting names a model the ACTIVE source
   * resolves, so listing ids from anywhere else offers choices that go
   * somewhere the user did not ask for. In VS Code that means the LM namespace
   * only — and it is why this asks the host instead of reading `getModels()`,
   * which would have shown the account's catalog (the desktop app's list) in a
   * page running inside VS Code.
   *
   * The catalog still appears when the host has nothing to offer, so the
   * control is never empty: on the desktop and the server there is no host
   * namespace, and core's built-in helper IS the source there.
   *
   * Note that configuring nothing is normal even in VS Code — core falls back
   * to its own catalog model by itself, so the built-in never needs selecting.
   */
  async listVisionModels(): Promise<VisionModelsResult> {
    const host = this.opts.vision;
    if (host) {
      try {
        const hostModels = await host.list();
        if (hostModels.length > 0) {
          return {
            sources: [host.label],
            models: hostModels.map((m) => ({ ...m, source: host.label })),
          };
        }
        this.log(`vision: ${host.label} offered no models; falling back to the catalog`);
      } catch (err) {
        this.log(`host vision model list failed: ${errText(err)}`);
      }
    }

    const builtin = listCatalogVisionModels(
      this.effectiveModels(this.regionOf(await this.loadActiveAuth()), await this.opts.settings.get())
    );
    return {
      sources: [BUILTIN_VISION_LABEL],
      models: builtin.map((m) => ({ ...m, source: BUILTIN_VISION_LABEL })),
    };
  }

  async getSettings(): Promise<Settings> {
    return this.opts.settings.get();
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = await this.opts.settings.update(patch);
    this.emit();
    return next;
  }

  async addCustomModel(id: string, displayName?: string): Promise<ModelConfig[]> {
    const settings = await this.opts.settings.get();
    if (!settings.customModels.some((m) => m.id === id)) {
      await this.opts.settings.update({
        customModels: [...settings.customModels, { id, displayName: displayName || id }],
      });
      this.emit();
    }
    return this.getModels();
  }

  async removeCustomModel(id: string): Promise<ModelConfig[]> {
    const settings = await this.opts.settings.get();
    const next = settings.customModels.filter((m) => m.id !== id);
    if (next.length !== settings.customModels.length) {
      await this.opts.settings.update({ customModels: next });
      this.emit();
    }
    return this.getModels();
  }

  // ── accounts ──────────────────────────────────────────────────────────

  /**
   * Resolve a caller-supplied ACCOUNT MARKER to a concrete account key.
   *
   * The marker is a plain identifier, NOT a credential. This service hosts the
   * accounts, so there is nothing to authorize — the marker exists only so a
   * caller can choose WHICH hosted account a request spends. Callers discover
   * the valid values from `GET /api/state` (`accounts[].key`).
   *
   *   undefined / ""  → the active account, i.e. whoever was last switched to.
   *   a stored key    → that account.
   *   anything else   → BadRequestError. Falling back silently would spend a
   *                     different account's quota than the caller asked for,
   *                     which is worse than a loud error.
   */
  async resolveAccountKey(marker?: string): Promise<string | undefined> {
    const wanted = marker?.trim();
    if (!wanted) {
      const r = await this.currentRegion();
      return (await this.opts.auth.getActiveKey(r)) ?? undefined;
    }

    const account = await this.opts.auth.get(wanted);
    if (account) return wanted;

    const known = (await this.opts.auth.list()).map((a) => accountKey(a));
    throw new BadRequestError(
      `Unknown account marker "${wanted}". ` +
        (known.length
          ? `Known accounts: ${known.join(", ")}.`
          : "No accounts are registered yet.") +
        " Query GET /api/state for the current list."
    );
  }

  async listAccounts(): Promise<AccountSummary[]> {
    const accounts = await this.opts.auth.list();
    const activeKeysByRegion = await this.collectActiveKeys(accounts);
    const settings = await this.opts.settings.get();
    const autoKeysByRegion = this.autoKeysByRegion(settings.autoSelectAccount);
    return accounts.map((a) =>
      this.summarize(
        a,
        activeKeysByRegion[a.region ?? DEFAULT_REGION] ?? null,
        autoKeysByRegion[a.region ?? DEFAULT_REGION] ?? null
      )
    );
  }

  /**
   * Switch which account chat/billing use.
   *
   * The catalog is shared, so nothing has to be re-fetched here — and because
   * the 60s tick keeps every account's token fresh, switching never asks the
   * user to scan a QR code again.
   */
  async switchAccount(key: string): Promise<ServiceState> {
    const auth = await this.opts.auth.get(key);
    if (!auth) throw new BadRequestError(`Unknown account: ${key}`);
    // Each region has its own active slot — making an account active writes
    // to the slot of the account's region, leaving the other cluster's
    // selection alone.
    const region = (auth.region ?? DEFAULT_REGION) as Region;
    await this.opts.auth.setActive(key, region);
    const valid = (await this.loadValidAuth(key)) ?? auth;
    await this.refreshBillingFor(valid);
    this.emit();
    return this.getState();
  }

  /** Remove ONE account. Removing the last one falls back to a signed-out state. */
  async removeAccount(key: string): Promise<ServiceState> {
    await this.opts.auth.remove(key);
    this.billings.delete(key);
    this.forgetCheckin(key);
    this.refreshErrors.delete(key);
    this.billingErrors.delete(key);
    if ((await this.opts.auth.list()).length === 0) await this.loadCatalog(DEFAULT_REGION);
    this.emit();
    return this.getState();
  }

  /** Sign out one account (default: the active one of the current region). */
  async logout(key?: string): Promise<ServiceState> {
    let target = key;
    if (!target) {
      const r = await this.currentRegion();
      target = (await this.opts.auth.getActiveKey(r)) ?? undefined;
    }
    if (target) return this.removeAccount(target);
    await this.opts.auth.clear();
    await this.loadCatalog(DEFAULT_REGION);
    this.emit();
    return this.getState();
  }

  // ── auth ──────────────────────────────────────────────────────────────

  /** The ACTIVE account of the current region with a usable token. */
  private async loadActiveAuth(): Promise<WorkbuddyAuth | undefined> {
    const r = await this.currentRegion();
    const key = await this.opts.auth.getActiveKey(r);
    return key ? this.loadValidAuth(key) : undefined;
  }

  /**
   * Return a usable session for one account (default: active), or undefined.
   *
   * Refreshes within REFRESH_SKEW_MS of expiry so an in-flight request never
   * dies on an expired Bearer. Failures are recorded per account instead of
   * being swallowed — a silently un-refreshable account looks "logged in" in
   * the UI while every request 401s.
   */
  private async loadValidAuth(key?: string): Promise<WorkbuddyAuth | undefined> {
    const account = key
      ? await this.opts.auth.get(key)
      : await this.opts.auth.getActive(await this.currentRegion());
    if (!account) return undefined;
    const accountId = key ?? accountKey(account);

    if (Date.now() < account.expiresAt - REFRESH_SKEW_MS) {
      this.refreshErrors.delete(accountId);
      return account;
    }
    if (!account.refreshToken) {
      this.refreshErrors.set(accountId, "no refresh token — sign in again");
      return undefined;
    }
    try {
      const refreshed = await refreshTokens(
        account.refreshToken,
        this.regionOf(account)
      );
      const next: WorkbuddyAuth = {
        ...account,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
      // `save`, NOT `upsert`: refreshing account B in the background must not
      // silently switch which account the user is chatting as.
      await this.opts.auth.save(next);
      this.refreshErrors.delete(accountId);
      return next;
    } catch (err) {
      const msg = errText(err);
      this.refreshErrors.set(accountId, msg);
      this.log(`token refresh failed for ${accountLabel(account)}: ${msg}`);
      return undefined;
    }
  }

  /**
   * Pick a usable session in a specific region.
   *
   * Used by chat when the URL prefixes the request with `/intl/v1/...`: the
   * call must hit the international gateway, so the chosen account has to
   * live there too. Falls back to the active account if the named region has
   * no session — exactly the same fallback the host sees when it forgets the
   * account marker, so behaviour is consistent across transports.
   */
  async ensureAuthInRegion(region: Region): Promise<WorkbuddyAuth> {
    const accounts = await this.opts.auth.list();
    const matching = accounts.find((a) => this.regionOf(a) === region);
    if (matching) {
      const auth = await this.loadValidAuth(accountKey(matching));
      if (auth) return auth;
    }
    return this.ensureAuth();
  }

  /**
   * Return a usable session or throw. Chat, billing and check-in all go
   * through here, so a stale token can never reach the gateway.
   */
  async ensureAuth(key?: string): Promise<WorkbuddyAuth> {
    const auth = key ? await this.loadValidAuth(key) : await this.loadActiveAuth();
    if (auth) return auth;
    const signedOut = (await this.opts.auth.list()).length === 0;
    throw new UnauthorizedError(
      signedOut
        ? "Not signed in. Please sign in to WorkBuddy first."
        : "This account's session expired and could not be refreshed. Please sign in again."
    );
  }

  async startLogin(
    region: Region = DEFAULT_REGION,
    // Kept for RPC compatibility; both clusters now use the same state/poll
    // protocol and the login page itself offers the identity-provider choice,
    // so there is no broker parameter to forward anymore.
    _broker?: "google" | "github" | "twitter"
  ): Promise<LoginStart> {
    const data = await startLogin(region);
    this.logins.set(region, { state: data.state, startedAt: Date.now() });
    return {
      state: data.state,
      authUrl: data.authUrl,
      expiresInMs: LOGIN_TTL_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      region,
    };
  }

  /**
   * ONE poll attempt. The caller (UI) drives the loop and therefore owns the
   * countdown; nothing here blocks for minutes at a time.
   */
  async pollLogin(region: Region = DEFAULT_REGION): Promise<LoginPoll> {
    const pending = this.logins.get(region);
    if (!pending) return { status: "expired" };
    if (Date.now() - pending.startedAt > LOGIN_TTL_MS) {
      this.logins.delete(region);
      return { status: "expired" };
    }
    const state = pending.state;
    const result = await pollLoginOnce(state, region);
    if (result.status !== "success") return { status: "pending" };
    this.logins.delete(region);

    const identity = await this.identifyAccount(result.tokens.accessToken, region);
    const auth: WorkbuddyAuth = {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      savedAt: Date.now(),
      expiresAt: Date.now() + result.tokens.expiresIn * 1000,
      userAgent: USER_AGENT,
      uid: identity.uid,
      enterpriseId: identity.enterpriseId,
      nickname: identity.nickname,
      domain: result.tokens.domain,
      region,
    };
    // A fresh sign-in becomes the ACTIVE account (that is what the user just
    // asked for) but must not disturb the other stored accounts.
    await this.opts.auth.upsert(auth);
    const key = accountKey(auth);
    this.refreshErrors.delete(key);
    this.startTokenRefresh();
    await this.loadCatalog(region, auth);

    let checkin: CheckinResult | undefined;
    if (await this.checkinEnabledFor(auth)) {
      try {
        checkin = await ensureCheckin(auth);
        this.recordCheckin(key, checkin);
      } catch (err) {
        this.log(`check-in after login failed: ${errText(err)}`);
      }
    }
    await this.refreshBillingFor(auth);

    this.log(`login success: ${accountLabel(auth)} (${key})`);
    this.emit();
    return {
      status: "success",
      key,
      nickname: identity.nickname,
      uid: identity.uid,
      checkin,
    };
  }

  /**
   * Look up who a session belongs to.
   *
   * A failure is REPORTED, not hidden. Without an identity the account falls
   * back to a token-derived key: safe (it cannot collide with another account)
   * but unhelpful to look at — and silently shipping one is how the original
   * always-failing lookup went unnoticed.
   */
  private async identifyAccount(
    accessToken: string,
    region: Region = DEFAULT_REGION
  ): Promise<AccountIdentity> {
    try {
      return await fetchAccount(accessToken, region);
    } catch (err) {
      this.log(
        `could not look up this session's identity: ${errText(err)} — falling back to a token-derived account key`
      );
      return { uid: "", enterpriseId: "", nickname: "" };
    }
  }

  /**
   * Fill in uid/nickname for accounts that have none.
   *
   * Sessions created by older builds never got them (the lookup was sent to an
   * endpoint that authenticates by bearer, but was called with a login state
   * instead). Re-scanning a QR code just to stop seeing "Unnamed account" would
   * be a poor trade, so repair them in place instead — one call per broken
   * account, usually zero.
   */
  private async backfillIdentities(): Promise<void> {
    for (const { key, auth: account } of await this.opts.auth.listEntries()) {
      if (account.uid && account.nickname) continue;
      try {
        // The ACCOUNT's region, not the active one: a CN session looked up
        // against the INTL cluster (or the reverse) fails every time, which
        // would leave the account permanently "unnamed".
        const identity = await fetchAccount(account.accessToken, this.regionOf(account));
        if (!identity.uid && !identity.nickname) continue;
        await this.opts.auth.rename(key, { ...account, ...identity });
        this.billings.delete(key);
        this.forgetCheckin(key);
        this.refreshErrors.delete(key);
        this.billingErrors.delete(key);
        this.log(`identified ${key} as ${identity.nickname || identity.uid}`);
      } catch (err) {
        this.log(`could not identify ${key}: ${errText(err)}`);
      }
    }
  }

  // ── usage ─────────────────────────────────────────────────────────────

  /** Fetch quota + check-in for one account (default: the active one). */
  async getUsage(key?: string): Promise<UsageSnapshot> {
    const auth = await this.ensureAuth(key);
    const accountId = key ?? accountKey(auth);
    let checkin: CheckinResult;
    if (await this.checkinEnabledFor(auth)) {
      try {
        checkin = await ensureCheckin(auth);
      } catch (err) {
        checkin = { state: "unknown", error: errText(err) };
      }
      this.recordCheckin(accountId, checkin);
    } else {
      // Check-in disabled for this region: "unknown" is the schema's
      // not-applicable state; consumers hide the row via checkinEnabled in
      // the state payload rather than parsing this.
      checkin = { state: "unknown" };
    }
    const billing = await this.fetchBillingForAccount(auth, accountId);
    this.emit();
    return { billing, checkin };
  }

  /**
   * Re-read quota and check-in STATUS for EVERY account.
   *
   * Deliberately READ-ONLY: it never claims a bonus. Opening a page must not
   * mutate anything, and claiming is `checkinAll`'s job. Sequential, because a
   * burst of parallel calls to the billing endpoint is a good way to get
   * rate-limited and lose them all at once.
   */
  async refreshAllUsage(): Promise<ServiceState> {
    for (const account of await this.opts.auth.list()) {
      const key = accountKey(account);
      const auth = (await this.loadValidAuth(key)) ?? account;
      await this.refreshBillingFor(auth);
      // Region gate: skip the status read entirely for check-in-less
      // clusters instead of leaving a stale/erred status in the map.
      if (!(await this.checkinEnabledFor(auth))) continue;
      try {
        const status = await fetchCheckinStatus(auth);
        // An INCONCLUSIVE read (no check-in activity is running — see
        // `fetchCheckinStatus`) says nothing about today's bonus, so it must not
        // overwrite a verdict a CLAIM established today. That overwrite is what
        // made the UI fall back to "not claimed yet" on every refresh —
        // startup warm-up, the Refresh usage button, the tray, the region-follow
        // refresh after a chat, and the midnight rollover — for accounts whose
        // bonus was in fact already claimed.
        if (status.state === "unknown" && this.checkinRecordedToday(key)) continue;
        this.recordCheckin(key, status);
      } catch (err) {
        // Keep whatever status we already had rather than blanking the UI.
        this.log(`check-in status failed for ${accountLabel(account)}: ${errText(err)}`);
      }
    }
    this.emit();
    return this.getState();
  }

  /** Claim the daily bonus for one account (default: the active one). */
  async checkin(key?: string): Promise<CheckinResult> {
    return this.checkinAccount(key);
  }

  /**
   * Claim the daily bonus for EVERY account — the user asked for check-in to
   * be a single sweep so no account silently misses a day.
   *
   * Sequential on purpose: the gateway rate-limits, and firing N claims at
   * once is a good way to lose them all together.
   */
  async checkinAll(): Promise<CheckinAllResult> {
    const accounts = await this.opts.auth.list();
    const results: Record<string, CheckinResult> = {};
    let claimed = 0;
    let failed = 0;

    for (const account of accounts) {
      const key = accountKey(account);
      const result = await this.checkinAccount(key);
      results[key] = result;
      if (result.state === "claimed" && result.freshlyClaimed) claimed += 1;
      if (result.state === "unknown") failed += 1;
    }

    this.emit();
    return { results, claimed, failed };
  }

  private async checkinAccount(key?: string): Promise<CheckinResult> {
    const accountId = key ?? (await this.activeKeyOrNull()) ?? "default";
    const auth = await this.ensureAuth(key);
    // Region gate: a cluster without check-in simply reports "unknown" and
    // does not touch the gateway — checkinAll then counts nothing for it.
    if (!(await this.checkinEnabledFor(auth))) {
      const skipped: CheckinResult = { state: "unknown" };
      this.recordCheckin(accountId, skipped);
      this.emit();
      return skipped;
    }
    let result: CheckinResult;
    try {
      result = await ensureCheckin(auth);
      if (result.state === "claimed" && result.freshlyClaimed) {
        await this.refreshBillingFor(auth);
      }
    } catch (err) {
      result = { state: "unknown", error: errText(err) };
    }
    this.recordCheckin(accountId, result);
    this.emit();
    return result;
  }

  /**
   * Fetch billing and record the outcome either way.
   *
   * Throws on failure (this is the explicit-request path, where the caller
   * wants the error), but still remembers why so the next `getState()` can
   * explain the gap.
   */
  private async fetchBillingForAccount(
    auth: WorkbuddyAuth,
    key: string
  ): Promise<BillingResult> {
    try {
      const billing = await fetchBilling(auth);
      this.billings.set(key, billing);
      this.billingsAt.set(key, Date.now());
      this.billingErrors.delete(key);
      return billing;
    } catch (err) {
      this.billingErrors.set(key, errText(err));
      throw err;
    }
  }

  private refreshBillingFor(auth: WorkbuddyAuth): Promise<void> {
    const key = accountKey(auth);
    return this.refreshBillingByKey(auth, key);
  }

  /** One billing fetch: cache result + timestamp, record failure, never throw. */
  private async refreshBillingByKey(auth: WorkbuddyAuth, key: string): Promise<void> {
    try {
      const billing = await fetchBilling(auth);
      this.billings.set(key, billing);
      this.billingsAt.set(key, Date.now());
      this.billingErrors.delete(key);
    } catch (err) {
      // Non-fatal — most likely offline. Keep the previous numbers rather than
      // blanking the UI, but RECORD why, so the UI can say more than
      // "unavailable".
      const msg = errText(err);
      this.billingErrors.set(key, msg);
      this.log(`billing fetch failed for ${accountLabel(auth)}: ${msg}`);
    }
  }

  // ── auto-select ───────────────────────────────────────────────────────

  /**
   * Per-region map of "the account auto-select would currently use", for the
   * `auto` badge on account cards. Empty when the toggle is off.
   */
  private autoKeysByRegion(enabled: boolean): Partial<Record<Region, string | null>> {
    if (!enabled) return {};
    const out: Partial<Record<Region, string | null>> = {};
    for (const [region, slots] of this.autoPins) {
      if (slots.size === 0) continue;
      out[region] = slots.values().next().value?.key ?? null;
    }
    return out;
  }

  /**
   * Choose the account for ONE request under auto-select.
   *
   * Affinity FIRST: a pinned account that is still eligible and has not gone
   * idle is reused untouched — quota/expiry ranking only ever applies when a
   * NEW pin has to be made. Returns undefined when the toggle is off or
   * nothing is eligible; the caller then falls back to the historical paths.
   *
   * Billing snapshots past their freshness window trigger a BACKGROUND
   * refresh (never awaited — account choice must not block the request) and
   * the stale numbers are still used for this decision.
   */
  private async pickAccount(region: Region, sessionKey?: string): Promise<string | undefined> {
    const settings = await this.opts.settings.get();
    if (!settings.autoSelectAccount) return undefined;

    const now = Date.now();
    const accounts = (await this.opts.auth.list()).filter(
      (a) => this.regionOf(a) === region
    );
    if (accounts.length === 0) return undefined;

    for (const a of accounts) {
      const key = accountKey(a);
      if (isBillingStale(this.billingsAt.get(key), now) && !this.billingRefreshInFlight.has(key)) {
        this.billingRefreshInFlight.add(key);
        void this.loadValidAuth(key)
          .then((valid) => (valid ? this.refreshBillingByKey(valid, key) : undefined))
          .finally(() => this.billingRefreshInFlight.delete(key));
      }
    }

    const slotId = sessionKey?.trim() || "default";
    let slots = this.autoPins.get(region);
    if (!slots) {
      slots = new Map();
      this.autoPins.set(region, slots);
    }
    const pinned = slots.get(slotId);
    if (pinned && now - pinned.lastUsedAt > AUTO_SELECT_IDLE_MS) {
      slots.delete(slotId);
    }
    const current = slots.get(slotId);

    const candidates: PoolCandidate[] = accounts.map((a) => {
      const key = accountKey(a);
      const billing = this.billings.get(key);
      const alive = (billing?.accounts ?? []).filter(
        (p) => (p.cycleCapacityRemain ?? p.capacityRemain ?? 0) > 0
      );
      return {
        key,
        refreshError: this.refreshErrors.get(key),
        remain: billing?.totalRemain,
        soonestExpiry: alive.length
          ? Math.min(...alive.map((p) => Date.parse(p.cycleEndTime) || Number.POSITIVE_INFINITY))
          : undefined,
        lastUsedAt: this.lastUsedAt.get(key),
      };
    });

    const picked = pickAutoAccount(candidates, current, now);
    if (!picked) return undefined;

    slots.set(slotId, { key: picked, lastUsedAt: now });
    this.lastUsedAt.set(picked, now);
    return picked;
  }

  /**
   * Resolve the session for a chat request WITHOUT an explicit account marker:
   * auto-select when it can produce an account, otherwise the historical
   * region/active paths.
   */
  private async ensureChatAuth(request: ChatRequest): Promise<WorkbuddyAuth> {
    const region = request.region ?? (await this.currentRegion());
    const picked = await this.pickAccount(region, request.sessionKey);
    if (picked) {
      try {
        return await this.ensureAuth(picked);
      } catch (err) {
        // The picker chose an account whose token cannot be refreshed (the
        // eligibility check runs on cached data). Drop the pin so the next
        // request re-picks, then fall through to the historical behaviour.
        this.log(`auto-select fell back: ${errText(err)}`);
        this.autoPins.get(region)?.delete(request.sessionKey?.trim() || "default");
      }
    }
    return request.region ? this.ensureAuthInRegion(request.region) : this.ensureAuth();
  }

  /**
   * Pre-flight check for the HTTP server: fail the request with a real status
   * code BEFORE a 200/SSE stream is committed. Auto-select aware — with the
   * toggle on, a dead ACTIVE account must not fail requests that another
   * account could serve.
   */
  async ensureChatReady(accountKey?: string, region?: Region): Promise<void> {
    if (accountKey) {
      await this.ensureAuth(accountKey);
      return;
    }
    const r = region ?? (await this.currentRegion());
    const picked = await this.pickAccount(r);
    if (picked) {
      try {
        await this.ensureAuth(picked);
        return;
      } catch (err) {
        this.autoPins.get(r)?.delete("default");
        // Fall through: report whatever the historical path reports.
      }
    }
    await this.ensureAuth();
  }

  // ── models ────────────────────────────────────────────────────────────

  /**
   * Re-fetch the shared catalog. Used by the UI's refresh button and by a
   * session that started before a login completed.
   */
  /**
   * Re-fetch the model catalog.
   *
   * `region` selects which cluster to read; omitted means the active account's
   * (the catalog differs between them: 29 models on CN, 35 on INTL).
   */
  async refreshModels(region?: Region): Promise<ModelConfig[]> {
    const auth = await this.loadActiveAuth();
    await this.loadCatalog(region ?? this.regionOf(auth), auth);
    this.emit();
    return this.getModels();
  }

  /**
   * Make sure ONE region's catalog is cached, using that region's own
   * account when there is one (the clusters do not share sessions, so a CN
   * catalog request must carry a CN Bearer). No-op when the catalog is
   * already cached. Hosts that expose BOTH regions at once — the dsh
   * adapter registers `workbuddy` and `workbuddy-intl` as separate model
   * groups — call this at startup for each region, because `init()` only
   * warms the ACTIVE account's region and the other group would silently
   * resolve to an empty list.
   */
  async ensureCatalog(region: Region): Promise<void> {
    if (this.catalogs.has(region)) return;
    try {
      const auth = await this.ensureAuthInRegion(region);
      await this.loadCatalog(region, this.regionOf(auth) === region ? auth : undefined);
    } catch (err) {
      // Anonymous fallback lives inside loadCatalog. Log the reason anyway —
      // a silent empty picker is indistinguishable from "this region has no
      // models", which is how the CN/INTL cross-talk bug above stayed
      // invisible for so long.
      this.log(`ensureCatalog(${region}) failed: ${errText(err)}`);
    }
  }

  /**
   * Warm the catalog for EVERY region at once.
   *
   * `init()` only warms the active account's region (one round-trip on the
   * hot path), but hosts that expose both regions as separate LM providers
   * — workbuddy-anywhere-for-copilot registers `codebuddy` (CN) AND
   * `codebuddy-intl` (INTL) — would show an empty picker on the unused
   * region until the user actually signs in there or calls
   * `refreshModels(region)` from the management page. That is the bug fixed
   * by this helper: a single call at startup populates both caches in
   * parallel (independent clusters, no contention).
   *
   * Errors per region are swallowed inside `ensureCatalog`; partial success
   * is the goal here, not all-or-nothing.
   */
  async warmAllCatalogs(): Promise<void> {
    // STRICTLY SEQUENTIAL. Running the two regions in parallel looked
    // harmless — separate hosts, separate caches — but both paths funnel
    // through `ensureAuthInRegion` → `loadValidAuth`, which can trigger a
    // token refresh and a read-modify-write of the credential store. Two
    // concurrent saves race, and the loser's catalog request goes out with
    // the wrong account (or none), silently collapsing one region to an
    // empty list. Verified 2026-09-14: parallel produced "29 CN / 0 Global",
    // sequential produces both. Two round-trips at startup is a price worth
    // paying for determinism.
    for (const region of REGIONS) {
      await this.ensureCatalog(region);
    }
  }

  /**
   * Fetch the model catalog once per region and cache it.
   *
   * Pass the active account when there is one so the request carries a real
   * session; without it the public headers are used. The CONTENT is the same
   * either way (see the `catalogs` field) — only `source` differs, which the UI
   * uses to explain itself.
   */
  private async loadCatalog(region: Region, auth?: WorkbuddyAuth): Promise<void> {
    try {
      if (auth) {
        const result = await fetchModelConfig({
          accessToken: auth.accessToken,
          userId: auth.uid,
          enterpriseId: auth.enterpriseId,
          domain: auth.domain,
          region,
        });
        const picked = pickAgent(result, "cli");
        if (!picked || picked.models.length === 0) {
          throw new Error("/v3/config returned no usable models");
        }
        this.catalogs.set(region, {
          models: picked.models,
          source: "auth",
          excluded: picked.excluded,
        });
      } else {
        const anon = await fetchModelConfigAnonymous(region);
        this.catalogs.set(region, {
          models: anon.models,
          source: "anonymous",
          excluded: anon.excluded,
        });
      }
      this.catalogErrors.delete(region);
    } catch (err) {
      // Record the reason and KEEP the previous catalog: a transient fetch
      // failure must not blank a picker that was working a minute ago, and it
      // must not be invisible either.
      const message = errText(err);
      this.catalogErrors.set(region, message);
      this.log(`model fetch failed (${region}): ${message}`);
    }
  }

  // ── chat ──────────────────────────────────────────────────────────────

  /**
   * Stream one completion.
   *
   * `accountKey` selects which hosted account pays for the request — it is the
   * resolved account marker, not a credential. Omitted means "the active
   * account", which is what hosts with an explicit switcher (VS Code,
   * Electron) rely on.
   *
   * Images destined for a model that cannot see are resolved from ONE source —
   * the host's own helper when it has one (VS Code's LM namespace), otherwise
   * core's built-in helper over the account's catalog. `visionFallbackModel`
   * names the model inside whichever namespace is active.
   */
  async *chat(
    request: ChatRequest,
    signal?: AbortSignal,
    accountKey?: string
  ): AsyncGenerator<ChatEvent> {
    // An explicit account marker always wins — auto-select never overrides it.
    // Next: auto-select (when enabled) picks quota-/expiry-aware with session
    // affinity. Without a pick, the historical paths apply: a region-prefixed
    // URL forces that cluster, otherwise the active account pays.
    const auth = accountKey
      ? await this.ensureAuth(accountKey)
      : await this.ensureChatAuth(request);
    const settings = await this.opts.settings.get();
    // NOTE: `settings.enabledByRegion` is deliberately NOT consulted here. It
    // decides whether a group is registered with a host's model picker (the VS
    // Code extension and the dsh plugin add/remove their providers), so a
    // request that reaches this method has already passed that gate by
    // existing. The HTTP surface is a client and is not gated by it.
    const catalog = this.catalogEntry(this.regionOf(auth));
    const effective = applyModelOverrides(catalog, settings);

    try {
      yield* streamChat(request, {
        auth,
        models: effective.models,
        settings,
        log: this.log,
        describeImage: this.visionResolver(auth, effective.models, settings),
        signal,
      });
    } finally {
      // EAGER QUOTA REFRESH: the gateway debits credits on every request,
      // and the cached `billings` snapshot is the only source the status bar,
      // tray, and management page read from. Without this, every UI shows a
      // stale number until the next 60s tick or manual refresh — the user
      // thought the toggle was broken when it was just a stale count.
      // Fire-and-forget: the chat stream already finished, we cannot delay
      // its return on a network call, and the host has the emit listener.
      void this.refreshBillingFor(auth).finally(() => this.emit());
    }
  }

  /**
   * Compose the image-description resolver for one account.
   *
   * The account's `auth` only exists in HERE, which is exactly why the catalog
   * half cannot be delegated to a host callback: no host holds the credential
   * of the account whose quota should pay for the description.
   */
  private visionResolver(
    auth: WorkbuddyAuth,
    catalog: ModelConfig[],
    settings: Settings
  ): (image: ChatImage) => Promise<string | null> {
    const host = this.opts.vision;
    const builtin = catalogVisionHelper(auth, catalog, this.log);
    const modelId = settings.visionFallbackModel.trim();
    return async (image) => {
      if (host) {
        try {
          const desc = await host.describe(image, modelId);
          if (desc) return capDescription(desc);
        } catch (err) {
          this.log(`host image description failed: ${errText(err)}`);
        }
      }
      return builtin.describe(image, modelId);
    };
  }

  // ── token refresh tick ────────────────────────────────────────────────

  private startTokenRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => void this.tickRefresh(), REFRESH_TICK_MS);
    // Never hold a host process open just to refresh a token.
    (this.refreshTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Claim the daily bonus when the DAY rolls over, for as long as the host is
   * open.
   *
   * `init` already sweeps on startup, which covers the common case. What it
   * cannot cover is an app/extension that stays open past midnight — the next
   * day's bonus would silently go unclaimed until the host happened to be
   * restarted. This timer closes that gap: it fires just after local midnight,
   * claims for every account on every cluster, refreshes the displayed status,
   * and then re-arms itself for the following midnight.
   */
  private startCheckinRollover(): void {
    if (this.checkinTimer) return;
    const arm = (): void => {
      const delay = msUntilNextLocalMidnight();
      this.checkinTimer = setTimeout(() => void this.tickCheckinRollover(), delay);
      // A long idle timer must not keep the host process alive on its own.
      (this.checkinTimer as { unref?: () => void }).unref?.();
    };
    arm();
  }

  private async tickCheckinRollover(): Promise<void> {
    // Re-arm FIRST: whatever happens below must not stop tomorrow's sweep.
    this.checkinTimer = undefined;
    this.startCheckinRollover();
    try {
      const result = await this.checkinAll();
      this.log(
        `[checkin] day rollover: ${result.claimed} claimed, ${result.failed} failed`
      );
    } catch (err) {
      this.log(`[checkin] day rollover sweep failed: ${errText(err)}`);
    }
    // And refresh the displayed status (statuses for the new day).
    try {
      await this.refreshAllUsage();
    } catch (err) {
      this.log(`[checkin] day rollover status refresh failed: ${errText(err)}`);
    }
  }

  /**
   * Keep EVERY account alive.
   *
   * This is the whole reason switching accounts does not require a new QR
   * scan: a background account must be refreshed even though nothing is using
   * it at this moment.
   *
   * Sequential on purpose — firing N refreshes at once is a good way to get
   * rate-limited and lose them all together.
   */
  private async tickRefresh(): Promise<void> {
    let accounts: WorkbuddyAuth[];
    try {
      accounts = await this.opts.auth.list();
    } catch (err) {
      this.log(`token tick could not read accounts: ${errText(err)}`);
      return;
    }
    let changed = false;
    for (const account of accounts) {
      const key = accountKey(account);
      const before = account.accessToken;
      const valid = await this.loadValidAuth(key);
      // A failure is already recorded per account by loadValidAuth.
      if (valid && valid.accessToken !== before) changed = true;
    }
    if (changed) this.emit();
  }
}

/**
 * Flatten a billing result into the per-account summary shape.
 *
 * The package rows are carried through untouched: an account can hold several
 * packages and the UI has to be able to show which one the credits came from.
 */
function usageOf(billing: BillingResult | undefined): AccountUsage | undefined {
  if (!billing) return undefined;
  return {
    percent: billingPercent(billing),
    remain: billing.totalRemain,
    size: billing.totalSize,
    packages: billing.accounts,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Milliseconds until the next local midnight (with a small slack so the claim
 * lands just INSIDE the new day rather than racing the server's own rollover).
 */
function msUntilNextLocalMidnight(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(next.getTime() - now.getTime(), 60_000) + 30_000;
}

/**
 * The local calendar day as `YYYY-MM-DD`.
 *
 * The daily bonus resets at local midnight, so a check-in verdict only
 * describes the day it was obtained on — see `refreshAllUsage`.
 */
function localDayKey(now = new Date()): string {
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
