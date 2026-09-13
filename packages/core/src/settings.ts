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
  /** Whether the WorkBuddy model group is offered to the host's model picker. */
  enabled: boolean;
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
}

export const DEFAULT_SETTINGS: Settings = {
  thinkingEffort: "auto",
  visionFallbackModel: "",
  customModels: [],
  modelAllowlist: [],
  modelBlocklist: [],
  enabled: true,
  autoSelectAccount: false,
  checkinByRegion: { cn: true, intl: false },
  region: DEFAULT_REGION,
  theme: "dark",
  locale: "en",
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
      const raw = JSON.parse(
        await fs.readFile(this.file, "utf-8")
      ) as Partial<Settings>;
      // Self-heal: if a previous run persisted an invalid region (e.g. a
      // label string slipped into the patch, or a human edited the file
      // by hand), `...DEFAULT_SETTINGS, ...raw` would let the bad value
      // overwrite the default and strand the UI with no region selected.
      // Validate before merging.
      const rawRegion = (raw as Partial<Settings>).region;
      // checkinByRegion is a nested object: a hand-edited or older file may
      // miss one side, so merge it over the defaults per key instead of
      // letting a partial object wipe a flag.
      const rawCheckin = (raw as Partial<Settings>).checkinByRegion;
      const sanitized: Partial<Settings> = {
        ...raw,
        region: rawRegion === "cn" || rawRegion === "intl" ? rawRegion : DEFAULT_REGION,
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
    const next: Settings = { ...(await this.get()), ...patch };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(next, null, 2), "utf-8");
    return next;
  }
}
