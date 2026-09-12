/**
 * Image description for models that cannot see.
 *
 * A model that cannot accept images still has to answer questions about them.
 * The answer is to make ONE extra chat call to a vision-capable model and
 * inline the returned text in place of the image.
 *
 * WHO that model is varies by host, so it is a seam — `VisionHelper` — with
 * two halves that must not drift apart: a list of candidate ids for the UI,
 * and the describe call that resolves those same ids.
 *
 *   - Built-in (this file): the account's own catalog. No host code needed,
 *     which is the only way the desktop app and the local HTTP server can see
 *     images at all — and the only place where the ACCOUNT's credential (whose
 *     quota pays for the description) is in scope.
 *   - VS Code: the `vscode.lm` namespace, which can reach models core cannot.
 *
 * The host helper is consulted FIRST, the built-in second, so a host that
 * cannot deliver still gets catalog behaviour instead of a broken chat.
 */

import type { WorkbuddyAuth } from "./auth";
import type { ModelConfig } from "./models";
import type { ChatImage } from "./chat/types";
import { streamChat } from "./chat/engine";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

const PROMPT =
  "请简洁描述这张图片的内容（用于转交给不支持视觉的模型）。不要解释、不要前缀，直接给描述。";

/** Cap the description so a chatty model cannot blow up the real prompt. */
const MAX_DESC_CHARS = 4_000;

/** Same ceiling for host-supplied descriptions — a host is not exempt. */
export function capDescription(text: string): string {
  return text.slice(0, MAX_DESC_CHARS);
}

/** One selectable model, in the namespace of whichever helper is active. */
export interface VisionModelChoice {
  /** The value persisted in `settings.visionFallbackModel`. */
  id: string;
  label: string;
}

/**
 * Where image descriptions come from on this host.
 *
 * The two methods are deliberate halves of one thing: a picker that offers ids
 * the describe half cannot resolve (or vice versa) is worse than no picker at
 * all, so they are never injected separately.
 */
export interface VisionHelper {
  /** Shown in the UI so the user knows where the ids come from. */
  readonly label: string;
  list(): Promise<VisionModelChoice[]>;
  /** `modelId` is one of `list()`'s ids; "" means "no preference". */
  describe(image: ChatImage, modelId: string): Promise<string | null>;
}

/** Catalog entries that can see — the built-in helper's candidate list. */
export function listCatalogVisionModels(
  catalog: ModelConfig[]
): VisionModelChoice[] {
  return catalog
    .filter((m) => m.capabilities.imageInput)
    .map((m) => ({ id: m.id, label: m.displayName }));
}

/**
 * The built-in helper: the account's own catalog.
 *
 * Always available, so no host has to implement vision to support images.
 */
export function catalogVisionHelper(
  auth: WorkbuddyAuth,
  catalog: ModelConfig[],
  log?: (msg: string) => void
): VisionHelper {
  return {
    label: "WorkBuddy models",
    list: async () => listCatalogVisionModels(catalog),
    describe: (image, modelId) =>
      describeImageUpstream(auth, catalog, image, { preferred: modelId, log }),
  };
}

export interface DescribeImageOptions {
  /**
   * Catalog model id to try FIRST. Ignored when it is absent from the catalog
   * or cannot see, so a stale setting degrades to plain catalog order instead
   * of breaking image handling.
   */
  preferred?: string;
  log?: (msg: string) => void;
}

/**
 * Describe `image` with the account's own vision models.
 *
 * Returns null when nothing worked (no vision model offered, all candidates
 * failed, or the stream produced no text). Callers must treat null as "leave
 * the image inline", never as a hard error — a chat that cannot describe an
 * image should still deliver the text around it.
 */
export async function describeImageUpstream(
  auth: WorkbuddyAuth,
  catalog: ModelConfig[],
  image: ChatImage,
  options: DescribeImageOptions = {}
): Promise<string | null> {
  const { preferred = "", log } = options;

  const visionModels = catalog.filter((m) => m.capabilities.imageInput);
  if (visionModels.length === 0) {
    log?.("image description: this account offers no vision-capable model");
    return null;
  }

  const preferredModel = preferred
    ? visionModels.find((m) => m.id === preferred)
    : undefined;
  if (preferred && !preferredModel) {
    log?.(
      `image description: "${preferred}" is not a vision-capable catalog model; using catalog order`
    );
  }
  const candidates = preferredModel
    ? [preferredModel, ...visionModels.filter((m) => m !== preferredModel)]
    : visionModels;

  // Reasoning is pointless (and billed) for a one-line description.
  const settings: Settings = { ...DEFAULT_SETTINGS, thinkingEffort: "off" };

  for (const model of candidates) {
    let text = "";
    try {
      for await (const ev of streamChat(
        {
          model: model.id,
          messages: [{ role: "user", text: PROMPT, images: [image] }],
        },
        // `catalog` keeps the capability lookup honest; `describeImage` is
        // deliberately absent so this call cannot recurse into itself.
        { auth, models: catalog, settings, log }
      )) {
        if (ev.type === "text") text += ev.text;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`image description: ${model.id} failed (${msg})`);
      continue;
    }

    const trimmed = text.trim();
    if (trimmed) {
      log?.(`image description: ${model.id} ok (${trimmed.length} chars)`);
      return capDescription(trimmed);
    }
  }

  log?.("image description: every vision-capable model failed");
  return null;
}
