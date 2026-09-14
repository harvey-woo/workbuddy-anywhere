/**
 * Session persistence — MULTI-ACCOUNT.
 *
 * Every host keeps the SAME file name (`codebuddy-auth.json`) inside its own
 * data directory:
 *   - VS Code extension : <globalStorageUri.fsPath>
 *   - Electron app      : app.getPath("userData")
 *   - standalone server : --data-dir (defaults to ~/.workbuddy-anywhere)
 *
 * Because the extension keeps writing to its globalStorage, a user who
 * already logged in before the split stays logged in — no re-scan needed.
 *
 * On-disk format (v2):
 *
 *   { "version": 2,
 *     "activeKey": "12345",
 *     "accounts": { "12345": { accessToken, refreshToken, ... } } }
 *
 * The pre-split format was a BARE WorkbuddyAuth object. `read()` detects it
 * (`accessToken` present, no `accounts` map), wraps it in a v2 envelope keyed
 * by its uid and writes the result back — so an existing user is migrated
 * transparently and keeps their session.
 *
 * The key is `enterpriseId:uid` when both are known (the same uid can exist in
 * two enterprises with different catalogs/quotas), else `uid`, else "default".
 */

import * as fs from "fs/promises";
import * as path from "path";
import { withFileLock } from "./file-lock";
import { DEFAULT_REGION, type Region } from "./region";
import { createHash } from "crypto";
import type { WorkbuddyAuth } from "./auth";

export const AUTH_FILE = "codebuddy-auth.json";

/**
 * Stable identity for an account. Never empty, and never the SAME for two
 * different sessions.
 *
 * The last fallback matters: when the identity lookup fails there is no uid to
 * key on, and returning a shared "default" would make the second login
 * overwrite the first. A digest of the refresh token is still stable across
 * restarts and unique per session.
 *
 * ONLY the international region is prefixed, and that asymmetry is deliberate.
 * CN keys are already on disk in every existing install — prefixing them would
 * make the next `upsert` write a SECOND entry for the same account instead of
 * replacing the first, i.e. a silent duplicate. Since CN is the historical
 * default, leaving it unprefixed keeps every existing key valid, while
 * `intl:` makes a cross-region collision impossible. (Only INTL keys carry a
 * prefix, so an unprefixed key can never be mistaken for an INTL account.)
 */
export function accountKey(
  auth: { uid?: string; enterpriseId?: string; refreshToken?: string; region?: Region }
): string {
  const uid = (auth.uid || "").trim();
  const ent = (auth.enterpriseId || "").trim();
  const prefix = auth.region === "intl" ? "intl:" : "";
  if (uid && ent) return `${prefix}${ent}:${uid}`;
  if (uid) return `${prefix}${uid}`;

  const rt = (auth.refreshToken || "").trim();
  if (rt) {
    const digest = createHash("sha256").update(rt).digest("hex").slice(0, 12);
    return `${prefix}unnamed-${digest}`;
  }
  return `${prefix}default`;
}

/** Human label for the UI when the nickname is missing. */
export function accountLabel(auth: {
  nickname?: string;
  uid?: string;
  enterpriseId?: string;
}): string {
  return auth.nickname?.trim() || auth.uid?.trim() || "未命名账号";
}

export interface StoredAccount {
  /** The key it is stored under. */
  key: string;
  auth: WorkbuddyAuth;
}

export interface AuthStore {
  /** Every stored account, oldest first. */
  list(): Promise<WorkbuddyAuth[]>;
  /**
   * Same as `list()`, but WITHOUT dropping the storage key.
   *
   * Needed when an account's key has to change — repairing an identity after
   * the fact means the old key has to be named exactly, and re-deriving it is
   * not possible once the key algorithm has changed.
   */
  listEntries(): Promise<StoredAccount[]>;
  get(key: string): Promise<WorkbuddyAuth | undefined>;
  /** The account new chats use, or undefined when signed out. */
  /**
   * The active account for the CURRENT region (settings.region at the time
   * the call is made), or undefined when signed out. The two clusters have
   * independent active picks, so a Chinese user can keep the Chinese account
   * active while inspecting the international catalog.
   */
  getActive(region?: Region): Promise<WorkbuddyAuth | undefined>;
  /**
   * The active account key for one region. Returns the stored key even when
   * the account it points to has since been removed — the caller decides
   * whether the dangling reference is a problem (it usually is not, and
   * surfacing it keeps the caller honest).
   */
  getActiveKey(region?: Region): Promise<string | null>;
  /**
   * Make `key` the active account for one region. No-op when the key is
   * unknown (never leaves a dangling activeKey). Other regions are untouched:
   * the global call site can still ask for the "current" region and the
   * right thing happens on each side.
   */
  setActive(key: string | null, region?: Region): Promise<void>;
  /** Insert or replace by `accountKey`. Makes the account active. */
  upsert(auth: WorkbuddyAuth): Promise<WorkbuddyAuth>;
  /**
   * Replace an existing account IN PLACE without touching `activeKey`.
   *
   * The token-refresh tick uses this: a background refresh of account B must
   * not silently switch which account the user is chatting as.
   */
  save(auth: WorkbuddyAuth): Promise<void>;
  /**
   * Move an account to a different key — used when its identity turns out to be
   * known after all (a repaired uid/nickname). Follows `activeKey` if it
   * pointed at the old key, so a repair never changes which account is
   * selected.
   */
  rename(oldKey: string, auth: WorkbuddyAuth): Promise<void>;
  remove(key: string): Promise<void>;
  /** Forget every account (full sign-out). */
  clear(): Promise<void>;
}

interface AuthFileV2 {
  version: 2;
  /**
   * Active account key, PER region. A bare `activeKey: string | null` is
   * also accepted (the field is renamed to `activeKeys`; old files keep
   * the v1 single-active behaviour under the CN slot until the user
   * touches it).
   */
  activeKeys?: Partial<Record<Region, string | null>>;
  /** V1 single-active slot. New writes go to activeKeys.cn. */
  activeKey?: string | null;
  accounts: Record<string, WorkbuddyAuth>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EMPTY: AuthFileV2 = {
  version: 2,
  activeKeys: { [DEFAULT_REGION]: null, intl: null } as Partial<Record<Region, string | null>>,
  accounts: {},
};

export class FileAuthStore implements AuthStore {
  /**
   * Serializes read-modify-write cycles. Without this two concurrent
   * `upsert`s (e.g. the 60s refresh tick racing a login) can interleave and
   * drop one account — a silent data loss, not a crash.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private cache?: AuthFileV2;

  constructor(
    private readonly dir: string,
    private readonly fileName: string = AUTH_FILE
  ) {}

  private get file(): string {
    return path.join(this.dir, this.fileName);
  }

  /**
   * Run `fn` with exclusive access to the file.
   *
   * Two layers, because there are two kinds of concurrency:
   *   - `serialize` orders callers INSIDE this process (one store instance is
   *     shared by the whole service);
   *   - `withFileLock` orders callers ACROSS processes, which is the case this
   *     store has to survive because the dsh plugin and `wbaw serve` default to
   *     the same directory.
   *
   * The cache is dropped before `fn` runs so the read half of the
   * read-modify-write starts from what is on disk right now. Without that, a
   * writer would spread a snapshot taken before another process wrote and put
   * that stale copy back — silently deleting every account the other process
   * had added.
   */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    return this.serialize(() =>
      withFileLock(this.file, () => {
        this.cache = undefined;
        return fn();
      })
    );
  }

  /** Run `fn` with exclusive access to the file. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    // Keep the chain alive even when a caller's promise rejects.
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * Identity of the file as we last saw it (`inode:size:mtime`), used to notice
   * a rewrite by another process. Every write here goes through `write()`,
   * which renames a fresh temp file into place — so ANY write, ours or not,
   * changes the inode, and a stale cache is always detectable.
   */
  private stamp?: string;

  /** Current identity of the file on disk; `"missing"` when there is none. */
  private async currentStamp(): Promise<string> {
    try {
      const st = await fs.stat(this.file);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return "missing";
    }
  }

  private async read(): Promise<AuthFileV2> {
    // The cache is only trustworthy while the file is the one we last read. A
    // reader that kept handing back its first snapshot would also never SEE an
    // account another process added, on top of clobbering it on the next write.
    if (this.cache && this.stamp === (await this.currentStamp())) return this.cache;
    this.cache = await this.readFromDisk();
    return this.cache;
  }

  private async readFromDisk(): Promise<AuthFileV2> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf-8");
      this.stamp = await this.currentStamp();
    } catch {
      this.stamp = await this.currentStamp();
      return { ...EMPTY, accounts: {} };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt file: do NOT wipe it — a half-written file must not cost the
      // user every account. Treat it as empty and let the next write repair it.
      return { ...EMPTY, accounts: {} };
    }
    if (!isRecord(parsed)) return { ...EMPTY, accounts: {} };

    if (isRecord(parsed.accounts)) {
      const accounts: Record<string, WorkbuddyAuth> = {};
      for (const [key, value] of Object.entries(parsed.accounts)) {
        if (isRecord(value) && typeof value.accessToken === "string") {
          accounts[key] = value as unknown as WorkbuddyAuth;
        }
      }
      // V2 activeKeys takes precedence. A v1 file with a bare `activeKey`
      // migrates into activeKeys.cn so an existing CN user keeps their
      // selection, and a fresh INTL selection starts empty.
      const v2Keys = isRecord(parsed.activeKeys) ? parsed.activeKeys : null;
      const activeKeys: Partial<Record<Region, string | null>> = v2Keys
        ? (parsed.activeKeys as Partial<Record<Region, string | null>>)
        : (typeof parsed.activeKey === "string" ? { cn: parsed.activeKey } : {});
      return this.heal({ accounts }, activeKeys);
    }

    // Legacy v1: a bare WorkbuddyAuth. Migrate in place so the user stays
    // logged in without any action. The single account lands in the slot
    // that matches its region.
    if (typeof parsed.accessToken === "string") {
      const auth = parsed as unknown as WorkbuddyAuth;
      const key = accountKey(auth);
      const migrated: AuthFileV2 = {
        version: 2,
        activeKeys: { [auth.region ?? DEFAULT_REGION]: key } as Partial<Record<Region, string | null>>,
        accounts: { [key]: auth },
      };
      await this.write(migrated);
      return migrated;
    }

    return { ...EMPTY, accounts: {} };
  }

  /**
   * Keep every region's `activeKey` pointing at a real account, fall back
   * to that region's first account when the stored key is gone, and drop
   * any region that has no accounts in it.
   *
   * Region comparison must DEFAULT a missing `region` to CN: accounts logged
   * in before the region field existed carry none, and matching them with a
   * strict `a.region === r` makes firstOf("cn") miss them — heal would then
   * null the CN active key on EVERY read, and "Use this account" would lose
   * to it the moment it was written (this exact bug ate the selection for
   * every pre-region CN account).
   */
  private heal(
    file: { accounts: Record<string, WorkbuddyAuth> },
    activeKeys: Partial<Record<Region, string | null>>
  ): AuthFileV2 {
    const accounts = file.accounts;
    const regionOf = (a: WorkbuddyAuth): Region => a.region ?? DEFAULT_REGION;
    const firstOf = (r: Region): string | null => {
      const candidate = Object.keys(accounts).find((k) => regionOf(accounts[k]) === r);
      return candidate ?? null;
    };
    const cleaned: Partial<Record<Region, string | null>> = {};
    for (const r of [DEFAULT_REGION, "intl"] as Region[]) {
      if (firstOf(r) === null) {
        cleaned[r] = null;
        continue;
      }
      const stored = activeKeys[r];
      cleaned[r] = stored && accounts[stored] ? stored : firstOf(r);
    }
    return { version: 2, activeKeys: cleaned, accounts };
  }

  /**
   * Atomic write: temp file + rename, so a crash cannot truncate the real one.
   *
   * The object is healed first, so the cache always holds exactly what a
   * subsequent read would produce. Skipping that is what used to make
   * `remove()` look like it had thrown away the region the removal did not
   * touch: the file was fine, but the in-memory copy written here disagreed
   * with it.
   */
  private async write(file: AuthFileV2): Promise<void> {
    const healed = this.heal({ accounts: file.accounts }, file.activeKeys ?? {});
    this.cache = healed;
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(healed, null, 2), "utf-8");
    await fs.rename(tmp, this.file);
    this.stamp = await this.currentStamp();
  }

  async list(): Promise<WorkbuddyAuth[]> {
    return this.serialize(async () => Object.values((await this.read()).accounts));
  }

  async listEntries(): Promise<StoredAccount[]> {
    return this.serialize(async () =>
      Object.entries((await this.read()).accounts).map(([key, auth]) => ({ key, auth }))
    );
  }

  async get(key: string): Promise<WorkbuddyAuth | undefined> {
    return this.serialize(async () => (await this.read()).accounts[key]);
  }

  /**
   * Active key for the current or named region. Defaults to the CN region
   * so old call sites that never passed one still work.
   */
  async getActiveKey(region: Region = DEFAULT_REGION): Promise<string | null> {
    return this.serialize(async () => {
      const file = await this.read();
      return file.activeKeys?.[region] ?? null;
    });
  }

  async getActive(region: Region = DEFAULT_REGION): Promise<WorkbuddyAuth | undefined> {
    return this.serialize(async () => {
      const file = await this.read();
      const key = file.activeKeys?.[region];
      return key ? file.accounts[key] : undefined;
    });
  }

  /**
   * Make `key` the active account for one region. An unknown key is a
   * no-op (never leaves a dangling activeKey). Other regions are untouched
   * so the two clusters can hold independent selections.
   */
  async setActive(key: string | null, region: Region = DEFAULT_REGION): Promise<void> {
    await this.mutate(async () => {
      const file = await this.read();
      if (key !== null && !file.accounts[key]) return;
      const nextKeys: Partial<Record<Region, string | null>> = {
        ...(file.activeKeys ?? {}),
        [region]: key,
      };
      await this.write({ ...file, activeKeys: nextKeys });
    });
  }

  /**
   * Insert a freshly-signed-in account and make it active on its own
   * region. The other region's selection is preserved, so logging in on
   * CN does not change which Global account is active.
   */
  async upsert(auth: WorkbuddyAuth): Promise<WorkbuddyAuth> {
    return this.mutate(async () => {
      const file = await this.read();
      const key = accountKey(auth);
      const region = (auth.region ?? DEFAULT_REGION) as Region;
      const nextKeys: Partial<Record<Region, string | null>> = {
        ...(file.activeKeys ?? {}),
        [region]: key,
      };
      await this.write({
        version: 2,
        activeKeys: nextKeys,
        accounts: { ...file.accounts, [key]: auth },
      });
      return auth;
    });
  }

  /**
   * Replace an existing account IN PLACE without touching any region's
   * active pick. The token-refresh tick uses this so a background refresh
   * of account B never silently switches which account is chatting on
   * either side.
   */
  async save(auth: WorkbuddyAuth): Promise<void> {
    await this.mutate(async () => {
      const file = await this.read();
      const key = accountKey(auth);
      await this.write({
        ...file,
        accounts: { ...file.accounts, [key]: auth },
      });
    });
  }

  /**
   * Move an account to a different key — used when its identity turns out
   * to be known after all. If the old key was the active pick on the
   * account's region, the new key takes its place on that region; other
   * regions are untouched.
   */
  async rename(oldKey: string, auth: WorkbuddyAuth): Promise<void> {
    await this.mutate(async () => {
      const file = await this.read();
      const newKey = accountKey(auth);
      if (newKey === oldKey) {
        await this.write({ ...file, accounts: { ...file.accounts, [oldKey]: auth } });
        return;
      }
      const accounts = { ...file.accounts };
      delete accounts[oldKey];
      accounts[newKey] = auth;
      const region = (auth.region ?? DEFAULT_REGION) as Region;
      const prevActive = file.activeKeys ?? {};
      const nextKeys: Partial<Record<Region, string | null>> = {
        ...prevActive,
        [region]: prevActive[region] === oldKey ? newKey : prevActive[region],
      };
      await this.write({
        version: 2,
        activeKeys: nextKeys,
        accounts,
      });
    });
  }

  async remove(key: string): Promise<void> {
    await this.mutate(async () => {
      const file = await this.read();
      if (!file.accounts[key]) return;
      const accounts = { ...file.accounts };
      delete accounts[key];
      if (Object.keys(accounts).length === 0) {
        await this.drop();
        return;
      }
      // Clear the removed key only from the region that had it selected, and
      // let `write()`'s heal pick that region's replacement. Passing through
      // `activeKeys` is the point: the old code wrote the v1 `activeKey` field
      // instead, which dropped every region's selection on the floor. Removing
      // a CN account would silently re-pick the Global one too.
      const activeKeys = { ...(file.activeKeys ?? {}) };
      for (const r of [DEFAULT_REGION, "intl"] as Region[]) {
        if (activeKeys[r] === key) activeKeys[r] = null;
      }
      await this.write({ version: 2, activeKeys, accounts });
    });
  }

  async clear(): Promise<void> {
    await this.mutate(() => this.drop());
  }

  private async drop(): Promise<void> {
    this.cache = { version: 2, activeKey: null, accounts: {} };
    try {
      await fs.unlink(this.file);
    } catch {
      // already gone
    }
    this.stamp = await this.currentStamp();
  }
}
