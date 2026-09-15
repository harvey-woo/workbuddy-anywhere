/**
 * Host-agnostic settings.
 *
 * `SettingsStore` is an interface, not a file format, because the hosts store
 * these values in different places on purpose:
 *   - VS Code  : VS Code's own user settings (workspace.getConfiguration
 *                ("codebuddy")) so nothing changes for existing users and the
 *                VS Code settings UI keeps working.
 *   - Electron / server : workbuddy-settings.json in the data directory.
 *
 * The shared Vue UI only talks to the interface, so it never needs to know
 * which of the two it is talking to.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { withFileLock } from "./file-lock";
import { DEFAULT_REGION, type Region } from "./region";

export type ThinkingEffort = "auto" | "low" | "medium" | "high" | "off";

export interface CustomModel {
  id: string;
  displayName: string;
}

export interface Settings {
  /** Thinking/reasoning depth for models that support it. */
  thinkingEffort: ThinkingEffort;
  /**
   * OPTIONAL model id used to describe images for chat models that cannot
   * accept them. Empty = the first candidate the active source offers.
   *
   * The id is interpreted in the namespace of whichever vision source the
   * CURRENT host provides (see `VisionHelper`), so the only way to build the
   * picker is to ask the host: `listVisionModels()`.
   *
   *   - desktop app / HTTP server → an id from the account's catalog
   *     (e.g. "glm-4.6v"), because core describes images itself there.
   *   - VS Code → an LM-namespace id (e.g. "copilot/gpt-4o"), because the
   *     extension can reach models core cannot.
   *
   * Switching hosts may therefore leave a value that no longer resolves; that
   * degrades to "first candidate", never to a broken chat.
   */
  visionFallbackModel: string;
  /** Model IDs offered on top of the server-provided catalog. */
  customModels: CustomModel[];
  /**
   * Model ids force-ADDED to the effective list even though the list-building
   * rules leave them out (whitelist). The Models page writes here when a greyed
   * row is switched on.
   */
  modelAllowlist: string[];
  /**
   * Model ids force-REMOVED from the effective list (blacklist). Applied LAST,
   * so it also wins over `customModels` and `modelAllowlist`.
   */
  modelBlocklist: string[];
  /**
   * Whether each region's model group is REGISTERED with a host's model
   * picker, per region.
   *
   * Per region because the two clusters are two INDEPENDENT groups in every
   * picker (`CodeBuddy` and `CodeBuddy Global` are separate vendors in VS Code,
   * separate routes in dsh). A single global flag could not express the thing
   * users actually ask for — offer the CN models without a second cluster
   * cluttering the picker, or the reverse — and it made the Models page's
   * switch look stale, because flipping it in one region also flipped the
   * other.
   *
   * Hosts that own a picker act on this literally: the VS Code extension
   * unregisters that vendor's `LanguageModelChatProvider` and the dsh plugin
   * empties that route, so the group disappears from the picker instead of
   * being merely hidden by a flag (see `packages/copilot` / `packages/dsh`).
   *
   * It deliberately does NOT gate core's own chat path. The HTTP surface is a
   * client, not a host with a picker, and a settings flag that silently 409s
   * somebody's curl script while no UI exposes it is a trap — that is what an
   * earlier version of this field did, together with an `autoSelectAccount`
   * exemption that made it look inert in half the configurations.
   *
   * Supersedes a single global `enabled: boolean`, which hosts and settings
   * files may still carry; see the migration in `FileSettingsStore.get`.
   */
  enabledByRegion: { cn: boolean; intl: boolean };
  /**
   * Allocate accounts automatically per request (quota- and expiry-aware,
   * sticky per session). Off = requests follow the manually selected account,
   * exactly the historical behaviour.
   */
  autoSelectAccount: boolean;
  /**
   * Whether the daily check-in feature is enabled PER REGION. The INTL
   * cluster has no check-in endpoint, so it defaults to off; a host may
   * still flip either flag from its own settings surface. This is a plain
   * config field — core only reads it, no UI toggle ships here.
   */
  checkinByRegion: { cn: boolean; intl: boolean };
  /**
   * The cluster the user is currently looking at.
   *
   * Lives in settings so it survives restarts and is shared with every
   * page: the management UI, the login page, and the model picker all
   * agree on which region is "current" without each holding a ref. The
   * per-account region (on `WorkbuddyAuth.region`) is the authoritative
   * source for catalog + chat; this one is a UI-level switch that decides
   * which cluster's account list, login form, and catalog to show.
   */
  region: Region;
  /** Visual theme: "dark" (default) or "light". In VS Code webview, the host controls this. */
  theme: "dark" | "light";
  /** UI language: "en" (default) or "zh". In VS Code webview, the host locale is used. */
  locale: "en" | "zh";
  /**
   * Port for the local API server (desktop app only). Persisted so the user
   * does not have to reconfigure after restarts. `0` = not yet configured
   * (the desktop app picks an available port on first launch).
   */
  serverPort: number;
}

export const DEFAULT_SETTINGS: Settings = {
  thinkingEffort: "auto",
  visionFallbackModel: "",
  customModels: [],
  modelAllowlist: [],
  modelBlocklist: [],
  enabledByRegion: { cn: true, intl: true },
  autoSelectAccount: false,
  checkinByRegion: { cn: true, intl: false },
  region: DEFAULT_REGION,
  theme: "dark",
  locale: "en",
  serverPort: 0,
};

export interface SettingsStore {
  get(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
}

export const SETTINGS_FILE = "workbuddy-settings.json";

export class FileSettingsStore implements SettingsStore {
  constructor(private readonly dir: string) {}

  private get file(): string {
    return path.join(this.dir, SETTINGS_FILE);
  }

  async get(): Promise<Settings> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf-8")) as Partial<Settings> & {
        /**
         * The pre-`enabledByRegion` global flag. Read, never written; kept in
         * the type so the migration below can see it without a cast, and left
         * in the file on write so an older build sharing this directory still
         * finds the value it understands.
         */
        enabled?: boolean;
      };
      // Self-heal: if a previous run persisted an invalid region (e.g. a
      // label string slipped into the patch, or a human edited the file
      // by hand), `...DEFAULT_SETTINGS, ...raw` would let the bad value
      // overwrite the default and strand the UI with no region selected.
      // Validate before merging.
      const rawRegion = raw.region;
      // checkinByRegion is a nested object: a hand-edited or older file may
      // miss one side, so merge it over the defaults per key instead of
      // letting a partial object wipe a flag.
      const rawCheckin = raw.checkinByRegion;
      // `enabledByRegion` replaced one global `enabled`. A file written before
      // the split carries only the global one, and honouring it as the seed for
      // BOTH regions is the difference between "the user's choice survives the
      // upgrade" and "a group they deliberately hid comes back on". Once
      // `enabledByRegion` exists its keys win, so the seed is applied once.
      const rawEnabled = raw.enabledByRegion;
      const legacyEnabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
      const enabledByRegion = {
        cn: rawEnabled?.cn ?? legacyEnabled ?? DEFAULT_SETTINGS.enabledByRegion.cn,
        intl: rawEnabled?.intl ?? legacyEnabled ?? DEFAULT_SETTINGS.enabledByRegion.intl,
      };
      const sanitized: Partial<Settings> = {
        ...raw,
        region: rawRegion === "cn" || rawRegion === "intl" ? rawRegion : DEFAULT_REGION,
        enabledByRegion,
        ...(rawCheckin
          ? {
              checkinByRegion: {
                cn: rawCheckin.cn ?? DEFAULT_SETTINGS.checkinByRegion.cn,
                intl: rawCheckin.intl ?? DEFAULT_SETTINGS.checkinByRegion.intl,
              },
            }
          : {}),
      };
      return { ...DEFAULT_SETTINGS, ...sanitized };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    // Read-modify-write on a file that other processes (dsh, `wbaw serve`, the
    // desktop app) also write. `get()` re-reads every time so it never serves a
    // stale snapshot, but without the lock two processes can still both read,
    // both merge, and the second write drops the first's keys.
    return withFileLock(this.file, async () => {
      const before = await this.get();
      const next: Settings = { ...before, ...patch };
      // The two per-region settings are nested maps. A shallow spread would let
      // a patch carrying ONE region silently wipe the other — `{cn: false}`
      // would drop `intl` entirely, and the read-side sanitizer would then
      // restore it to its DEFAULT rather than to its previous value, which is
      // data loss that reports as success. Merge these key by key. Everything
      // else is a scalar or a list, where last-writer-wins is the intent.
      for (const key of ["checkinByRegion", "enabledByRegion"] as const) {
        const patched = patch[key];
        if (patched) next[key] = { ...before[key], ...patched };
      }
      await fs.mkdir(this.dir, { recursive: true });
      // Atomic: a crash (or a concurrent reader) must never see a truncated
      // file. `writeFile` in place can leave half a document behind.
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
      await fs.rename(tmp, this.file);
      return next;
    });
  }
}
