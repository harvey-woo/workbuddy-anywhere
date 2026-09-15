/**
 * The ONLY things core needs from a VS Code host.
 *
 * Everything else the extension used to own — auth, billing, the model
 * catalog, the OpenAI payload, SSE parsing, tool-call recovery — now lives in
 * `@wbaw/core` and is shared with the desktop app and the local
 * HTTP server. This file is the seam: two adapters plus the two host hooks core
 * cannot implement by itself.
 *
 * Zero-migration guarantees, both verified against the pre-split extension:
 *
 *   - CREDENTIALS: `FileAuthStore(globalStorageUri.fsPath)` reads the SAME
 *     `codebuddy-auth.json` in the SAME directory the extension has always
 *     used, so an existing user is already signed in (and the file is upgraded
 *     to the multi-account format on first read).
 *   - SETTINGS: the same `codebuddy.*` keys, read through VS Code's own
 *     configuration, so `settings.json` and Settings Sync keep working.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  AUTH_FILE,
  DEFAULT_REGION,
  DEFAULT_SETTINGS,
  FileAuthStore,
  WorkbuddyService,
  type ChatImage,
  type Region,
  type Settings,
  type SettingsStore,
  type VisionHelper,
  type VisionModelChoice,
} from "@wbaw/core";

/** VS Code's configuration section — unchanged from the pre-split extension. */
const SECTION = "codebuddy";

/**
 * Core's user preferences, stored in VS Code's own settings.
 *
 * Deliberately NOT a JSON file: the Settings UI keeps editing these, Settings
 * Sync keeps carrying them, and nothing has to be migrated.
 */
export class VsCodeSettingsStore implements SettingsStore {
  private get cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
  }

  async get(): Promise<Settings> {
    // The region is a "global" preference — independent of the active VS Code
    // workspace — so the management page and the status bars all read the
    // same value. Default CN because that is what existing installs use.
    const region = this.cfg.get<Region>("region", DEFAULT_REGION);
    // `enabledByRegion` is an object setting with NO schema default, so an
    // unset value comes back as undefined — that absence is the only signal
    // that this install predates the per-region split, and therefore the cue to
    // seed from the legacy global `enabled`. Once the new key has been written
    // its keys win and the old one is ignored, exactly as in the file store.
    const perRegionEnabled = this.cfg.get<Partial<Settings["enabledByRegion"]>>(
      "enabledByRegion"
    );
    const legacyEnabled = this.cfg.get<boolean>("enabled", true);
    // Spread DEFAULT_SETTINGS FIRST: this used to be a hand-maintained mirror
    // of the interface, which silently ignored every field added later (the
    // Models page's allow/deny lists would have been written and then read back
    // as undefined). Anything not overridden below now falls back on its own.
    return {
      ...DEFAULT_SETTINGS,
      thinkingEffort: this.cfg.get<Settings["thinkingEffort"]>(
        "thinkingEffort",
        DEFAULT_SETTINGS.thinkingEffort
      ),
      visionFallbackModel: this.cfg.get<string>(
        "visionFallbackModel",
        DEFAULT_SETTINGS.visionFallbackModel
      ),
      customModels: this.cfg.get<Settings["customModels"]>(
        "customModels",
        DEFAULT_SETTINGS.customModels
      ),
      modelAllowlist: this.cfg.get<string[]>("modelAllowlist", DEFAULT_SETTINGS.modelAllowlist),
      modelBlocklist: this.cfg.get<string[]>("modelBlocklist", DEFAULT_SETTINGS.modelBlocklist),
      enabledByRegion: {
        cn: perRegionEnabled?.cn ?? legacyEnabled,
        intl: perRegionEnabled?.intl ?? legacyEnabled,
      },
      autoSelectAccount: this.cfg.get<boolean>(
        "autoSelectAccount",
        DEFAULT_SETTINGS.autoSelectAccount
      ),
      region: region === "intl" ? "intl" : "cn",
    };
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    // The two per-region settings are nested maps, and `cfg.update` replaces an
    // object setting wholesale — so a patch carrying ONE region would drop the
    // other, and the read-side fallback would restore it to its default rather
    // than to its previous value. Merge them per key first. The file store has
    // the same hazard and guards it the same way.
    const current = await this.get();
    const mergePerRegion = (key: "checkinByRegion" | "enabledByRegion") => {
      const patched = patch[key];
      return patched ? { ...current[key], ...patched } : undefined;
    };
    const merged: Partial<Settings> = {
      ...patch,
      checkinByRegion: mergePerRegion("checkinByRegion"),
      enabledByRegion: mergePerRegion("enabledByRegion"),
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) continue;
      await this.cfg.update(key, value, vscode.ConfigurationTarget.Global);
    }
    return this.get();
  }
}

export interface VsCodeServiceOptions {
  context: vscode.ExtensionContext;
  log?: (msg: string) => void;
}

/**
 * Where the session file is read from (and written back to).
 *
 * VS Code derives globalStorage from the extension ID, and this extension was
 * renamed (`codebuddy-chat` → `workbuddy-anywhere-for-copilot`). The new
 * directory therefore starts out EMPTY while the user's `codebuddy-auth.json`
 * still sits in the old one — reading the old location until the new one has a
 * file is the difference between "already signed in" and looking signed out.
 *
 * Read and write resolve through the same function, so a running install never
 * splits its accounts across the two directories.
 */
function credentialsDir(context: vscode.ExtensionContext): string {
  const current = context.globalStorageUri.fsPath;
  if (fs.existsSync(path.join(current, AUTH_FILE))) return current;

  const legacy = path.join(path.dirname(current), "codebuddy-chat.codebuddy-chat");
  if (fs.existsSync(path.join(legacy, AUTH_FILE))) return legacy;

  return current;
}

/** Build the core service for this host. */
export function createVsCodeService(options: VsCodeServiceOptions): WorkbuddyService {
  const { context, log } = options;
  return new WorkbuddyService({
    auth: new FileAuthStore(credentialsDir(context)),
    settings: new VsCodeSettingsStore(),
    log,
    // VS Code owns a whole LM namespace, so it can describe images with models
    // core cannot reach. The helper is ALSO the picker's source, so the ids the
    // management page offers are exactly the ids this half can resolve.
    //
    // Core's own catalog helper still runs as a fallback: a host that cannot
    // deliver (no model registered, a non-vision model chosen) degrades to
    // catalog behaviour rather than to a broken chat.
    vision: createVsCodeVisionHelper(),
  });
}

// ── Vision helper (VS Code's LM namespace) ──────────────────────────────

/**
 * The two halves live together on purpose: a list that offers ids the describe
 * half cannot resolve (or the reverse) is worse than having no picker.
 */
function createVsCodeVisionHelper(): VisionHelper {
  return {
    label: "VS Code models",
    list: listVsCodeVisionModels,
    describe: describeImageWithHostModel,
  };
}

/** Every chat model registered in this window, de-duplicated by id. */
async function listVsCodeVisionModels(): Promise<VisionModelChoice[]> {
  let available: vscode.LanguageModelChat[];
  try {
    available = await vscode.lm.selectChatModels({});
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const models: VisionModelChoice[] = [];
  for (const model of available) {
    const id = `${model.vendor}/${model.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: model.name });
  }
  return models;
}

/**
 * Turn a stored `visionFallbackModel` value into a
 * `vscode.lm.selectChatModels` selector.
 *
 * Cross-provider on purpose — the chosen model may live in any VS Code LM
 * registration (this extension, another extension, Copilot, …).
 *
 *   "vendor/model" → exact id + vendor
 *   "model"        → exact id, empty vendor
 *   ""             → no selector (core does the work from its own catalog)
 */
function parseVisionFallbackSelector(raw: string): vscode.LanguageModelChatSelector {
  if (!raw) return {};
  const slash = raw.indexOf("/");
  if (slash < 0) return { id: raw, vendor: "" };
  return { id: raw.slice(slash + 1), vendor: raw.slice(0, slash) };
}

/**
 * Describe an image with the model the user picked from `list()`.
 *
 * Returns null when there is no choice, the model is gone, or it cannot accept
 * the data part — core then falls back to its own catalog.
 */
async function describeImageWithHostModel(
  image: ChatImage,
  modelId: string
): Promise<string | null> {
  if (!modelId) return null; // no override configured: let core do it

  let candidates: vscode.LanguageModelChat[];
  try {
    candidates = await vscode.lm.selectChatModels(parseVisionFallbackSelector(modelId));
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;

  // The runtime handle does not expose `capabilities`, so candidates cannot be
  // pre-filtered by vision. Try them in order; a non-vision model throws on the
  // data part and we fall through to the next.
  const cts = new vscode.CancellationTokenSource();
  try {
    for (const model of candidates) {
      let text = "";
      try {
        const response = await model.sendRequest(
          [
            vscode.LanguageModelChatMessage.User([
              new vscode.LanguageModelDataPart(image.data, image.mimeType),
              new vscode.LanguageModelTextPart(
                "请简洁描述这张图片的内容（用于转交给不支持视觉的模型）。不要解释、不要前缀，直接给描述。"
              ),
            ]),
          ],
          {
            justification:
              "Describe this image so it can be forwarded to a non-vision chat model.",
          },
          cts.token
        );
        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) text += chunk.value;
        }
      } catch {
        continue;
      }
      const trimmed = text.trim();
      if (trimmed) return trimmed;
    }
  } finally {
    cts.dispose();
  }
  return null;
}
