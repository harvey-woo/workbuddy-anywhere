/**
 * Dynamic model list fetcher.
 *
 * The list comes from `GET /v3/config`:
 *
 *   {
 *     code: 0,
 *     data: {
 *       agents: [
 *         { name: "cli", models: ["hy4-preview", "hy3", ...] }
 *       ],
 *       models: [
 *         { id: "hy4-preview", name: "Hy4 preview", maxInputTokens: 1000000,
 *           maxOutputTokens: 64000, supportsToolCall: true,
 *           supportsImages: true, supportsReasoning: true,
 *           reasoning: { defaultEffort: "high", ... } }
 *       ]
 *     }
 *   }
 *
 * Both regions serve that shape but NOT the same content: CN returns 29 models
 * and INTL returns 35 (verified 2026-09-11), so the region is part of every
 * catalog call rather than a global constant. Base URLs live in `region.ts`.
 */

import { REGION_PROFILES, DEFAULT_REGION, type Region } from "./region";
import type { Settings } from "./settings";

const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

export interface ModelConfig {
  id: string;
  displayName: string;
  /** Localized description; the server sends both zh and en, English wins. */
  description?: string;
  contextLength: number;
  maxOutputTokens: number;
  family: string;
  vendor?: string;
  capabilities: {
    toolCalling: boolean;
    /** EFFECTIVE image input: false when the server disabled multimodal. */
    imageInput: boolean;
    /**
     * The server explicitly turned multimodal off (`disabledMultimodal`).
     * Stronger than `!supportsImages` — this is a deliberate "text only"
     * switch, so the UI can say WHY there is no vision.
     */
    multimodalDisabled?: boolean;
    reasoning: boolean;
    /**
     * Reasoning is mandatory (`onlyReasoning`): sending "off" is silently
     * ignored upstream, so `resolveThinkingEffort` must not pretend to
     * disable it.
     */
    reasoningOnly?: boolean;
  };
  reasoningConfig?: {
    effort?: string;
    defaultEffort?: string;
    supportedEfforts?: string[];
    canDisableThinking?: boolean;
    summary?: string;
  };
  /** Upstream sampling defaults, forwarded verbatim when present. */
  sampling?: {
    temperature?: number;
    topP?: number;
  };
  /** Server-side tags, e.g. ["text-to-image"] for non-chat models. */
  tags?: string[];
  credits?: string;
  relatedModels?: Record<string, string>;
}

export interface AgentConfig {
  name: string;
  description?: string;
  modelOrder: string[];
}

interface ServerModel {
  id: string;
  name?: string;
  descriptionEn?: string;
  descriptionZh?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxAllowedSize?: number;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  disabledMultimodal?: boolean;
  supportsReasoning?: boolean;
  onlyReasoning?: boolean;
  reasoning?: { defaultEffort?: string; supportedEfforts?: string[]; canDisableThinking?: boolean; effort?: string; summary?: string };
  temperature?: number;
  top_p?: number;
  tags?: string[];
  credits?: string;
  relatedModels?: Record<string, string>;
  vendor?: string;
}

interface ServerAgent {
  name?: string;
  description?: string;
  models?: string[];
  modelTags?: string[];
}

interface ServerConfig {
  agents?: ServerAgent[];
  models?: ServerModel[];
}

/**
 * Tags that mark a catalog entry as NOT a user-facing chat model.
 *
 * `text-to-image` / `image-to-image` are image GENERATION (offering one in a
 * chat picker only produces confusing upstream errors). `lite` is the internal
 * helper model (context summary, prompt suggestion, terminal titles) — the app
 * hides those too.
 */
const NON_CHAT_TAGS = new Set(["text-to-image", "image-to-image", "text-to-video", "image-to-video", "lite"]);

/** Why a catalog entry is not in the effective model list. */
export type ExclusionReason =
  /** Image / video generation — not a chat model at all. */
  | "generation"
  /** Internal helper (`lite`): summarisation, titles, prompt suggestion. */
  | "helper"
  /** The user turned it off (blacklist). */
  | "blocked";

/**
 * A model that is deliberately NOT in the effective list, with its full catalog
 * config so a host can still render it (greyed) and switch it back on.
 */
export interface ExcludedModel extends ModelConfig {
  reason: ExclusionReason;
}

export interface ModelFetchOptions {
  userAgent?: string;
  accessToken?: string;
  userId?: string;
  enterpriseId?: string;
  domain?: string;
  /** Which cluster to read the catalog from. Defaults to CN. */
  region?: Region;
}

/**
 * Fetch the catalog without a session.
 *
 * Used before the first login, and as the fallback when a session exists but
 * the fetch failed. Note that `/v3/config` is NOT a fixed public list — it is
 * scoped by the client identity that asks for it (User-Agent plus the
 * `X-User-Id` sent here), which is why the identity lives in `RegionProfile`.
 *
 * The anonymous form needs an id to answer at all; `fetchModelConfig` sends
 * `X-User-Id: "0"` for that, which returns the same catalog a signed-in user
 * sees on both clusters (verified 2026-09-11).
 */
export async function fetchModelConfigAnonymous(region: Region = DEFAULT_REGION): Promise<{
  models: ModelConfig[];
  excluded: ExcludedModel[];
}> {
  const result = await fetchModelConfig({
    // A generic id is enough — the endpoint does not check it beyond wanting one.
    userId: "0",
    region,
  });
  const picked = pickAgent(result, "cli");
  if (!picked || picked.models.length === 0) {
    throw new Error("/v3/config returned no usable models");
  }
  return { models: picked.models, excluded: picked.excluded };
}

export async function fetchModelConfig(
  options: ModelFetchOptions = {}
): Promise<{ agents: AgentConfig[]; models: ModelConfig[] }> {
  const region = options.region ?? DEFAULT_REGION;
  const profile = REGION_PROFILES[region];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Client-Platform": "web",
    "X-Product": "SaaS",
    // The identity of THIS cluster's own client. See RegionProfile — the
    // gateway keys the response off it and the two identities return
    // different catalogs.
    "User-Agent": options.userAgent || profile.clientUserAgent,
    Origin: profile.origin,
    Referer: profile.origin + "/",
  };
  if (profile.clientXhr) headers["X-Requested-With"] = "XMLHttpRequest";

  if (options.accessToken) {
    headers["Authorization"] = `Bearer ${options.accessToken}`;
  }

  // Identity headers for the catalog. The rules below are what the gateway
  // actually implements (measured 2026-09-11, both clusters, empty and signed
  // in):
  //   - signed in: send NO id header — that is what the desktop app does, and
  //     a literal `X-Enterprise-Id: "0"` narrows INTL from 21 models to 18
  //     (hy4 preview disappears) while on CN it answers with an empty list;
  //   - anonymous: `X-User-Id: "0"` is what unlocks the public catalog — with
  //     neither id the endpoint answers with an empty list, and with only
  //     `X-Enterprise-Id` it also answers with an empty list;
  //   - a REAL enterprise id is the one case where both go out together.
  const realEnterprise = !!options.enterpriseId && options.enterpriseId !== "0";
  if (!options.accessToken) headers["X-User-Id"] = options.userId || "0";
  if (realEnterprise) {
    headers["X-User-Id"] = options.userId || "0";
    headers["X-Enterprise-Id"] = options.enterpriseId as string;
  }
  if (options.domain) headers["X-Domain"] = options.domain;

  const resp = await fetch(`${profile.baseUrl}/v3/config`, {
    method: "GET",
    headers,
  });

  if (!resp.ok) {
    throw new Error(`/v3/config returned HTTP ${resp.status}`);
  }

  const json = (await resp.json()) as { code: number; data?: ServerConfig };
  if (json.code !== 0) {
    throw new Error(`/v3/config API error: ${json.code}`);
  }

  return parseModelCatalog(json.data);
}

/**
 * Pure transformation of a `/v3/config` payload into the host-facing catalog.
 *
 * Split out of `fetchModelConfig` so the parts that are easy to get subtly
 * wrong (capability flags, display names) can be tested without a network
 * call — the previous "it compiles and the request returned 200" level of
 * verification is exactly how `disabledMultimodal` went unnoticed.
 */
export function parseModelCatalog(data: ServerConfig | undefined): {
  agents: AgentConfig[];
  models: ModelConfig[];
} {
  const serverModels = data?.models ?? [];
  const serverAgents = data?.agents ?? [];

  const models: ModelConfig[] = serverModels.map((m) => ({
    id: m.id,
    displayName: m.name || m.id,
    description: m.descriptionEn || m.descriptionZh,
    contextLength: m.maxInputTokens ?? m.maxAllowedSize ?? 200_000,
    maxOutputTokens: m.maxOutputTokens ?? 8_192,
    family: m.id.split("-")[0],
    vendor: m.vendor,
    capabilities: {
      toolCalling: m.supportsToolCall ?? true,
      // `disabledMultimodal` wins: the server sometimes leaves supportsImages
      // unset on a model it has deliberately switched to text-only.
      imageInput: m.disabledMultimodal ? false : m.supportsImages ?? false,
      multimodalDisabled: m.disabledMultimodal,
      reasoning: m.supportsReasoning ?? false,
      reasoningOnly: m.onlyReasoning,
    },
    reasoningConfig: m.reasoning ? {
      effort: m.reasoning.effort,
      defaultEffort: m.reasoning.defaultEffort,
      supportedEfforts: m.reasoning.supportedEfforts,
      canDisableThinking: m.reasoning.canDisableThinking,
      summary: m.reasoning.summary,
    } : undefined,
    sampling: (m.temperature !== undefined || m.top_p !== undefined) ? {
      temperature: m.temperature,
      topP: m.top_p,
    } : undefined,
    tags: m.tags && m.tags.length > 0 ? m.tags : undefined,
    credits: m.credits,
    relatedModels: m.relatedModels,
  }));

  // Rename hy\d-(preview-)?x variants to unique display names
  // e.g. hy3-x -> "Hy 3 X", hy4-preview-x -> "Hy 4 Preview X"
  for (const m of models) {
    if (/^hy\d+-(?:preview-)?x$/i.test(m.id)) {
      // Transform: hy3-x -> Hy 3 X, hy4-preview-x -> Hy 4 Preview X
      m.displayName = m.id
        .replace(/^hy(\d+)-(preview)?-?x$/i, (_, num, preview) => {
          let name = `Hy ${num}`;
          if (preview) name += " Preview";
          name += " X";
          return name;
        });
    }
  }

  const agents: AgentConfig[] = serverAgents.map((a) => ({
    name: a.name || "default",
    description: a.description,
    modelOrder: a.models ?? [],
  }));

  return { agents, models };
}

export function pickAgent(
  result: { agents: AgentConfig[]; models: ModelConfig[] },
  preferredName: string = "cli"
): { agent: AgentConfig; models: ModelConfig[]; excluded: ExcludedModel[] } | undefined {
  const agent =
    result.agents.find((a) => a.name === preferredName) ??
    result.agents.find((a) => a.name === "default") ??
    result.agents[0];
  if (!agent) return undefined;

  const excluded: ExcludedModel[] = [];
  const chatModels = result.models.filter((m) => {
    const hit = m.tags?.find((t) => NON_CHAT_TAGS.has(t));
    if (!hit) return true;
    excluded.push({ ...m, reason: hit === "lite" ? "helper" : "generation" });
    return false;
  });

  // The agent's list is used for ORDER, not for filtering.
  //
  // The app offers (almost) the whole catalog: the `cli` agent curates 15 of
  // CN's 28 chat models, and restricting the picker to those 15 silently hid
  // models the app — and the gateway — both serve (hy4-preview-x,
  // deepseek-v4-flash, glm-4.6, kimi-k2.5, …). So: the server's own ranking
  // first, then everything else in catalog order. Rows the user does not want
  // are switched off in the management page, not hidden from it.
  const rank = new Map(agent.modelOrder.map((id, i) => [id, i]));
  const models = [...chatModels].sort(
    (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  );

  return { agent, models, excluded };
}

/**
 * A model the catalog never mentioned — a custom id, or an allowlisted id the
 * catalog has since dropped.
 *
 * Conservative on purpose: an id we know nothing about is assumed to support
 * tool calls (a chat model without them is useless in every host here) and
 * nothing else. Guessing "vision" would send images to a model that cannot read
 * them.
 */
export function syntheticModel(id: string, displayName?: string): ModelConfig {
  return {
    id,
    displayName: displayName || id,
    contextLength: 200_000,
    maxOutputTokens: 8_192,
    family: id.split("-")[0],
    capabilities: {
      toolCalling: true,
      imageInput: false,
      reasoning: id.startsWith("hy"),
    },
  };
}

/** The catalog plus the user's custom model ids. */
export function mergeCustomModels(base: ModelConfig[], settings: Settings): ModelConfig[] {
  const models = [...base];
  for (const cm of settings.customModels) {
    if (models.some((m) => m.id === cm.id)) continue;
    models.push(syntheticModel(cm.id, cm.displayName));
  }
  return models;
}

/**
 * The EFFECTIVE model list — what hosts actually receive (the VS Code model
 * picker, `/v1/models`, and the chat engine's own model lookup).
 *
 * Authority, weakest first:
 *   1. the catalog's chat models — the default. The app offers the whole list
 *      (CN: 28 of the 29 the catalog holds);
 *   2. `settings.modelAllowlist`  — force an excluded id back IN (whitelist);
 *   3. `settings.customModels`    — ids the catalog never mentions;
 *   4. `settings.modelBlocklist`  — force an id OUT (blacklist). Applied last,
 *      so it beats everything above, custom and allowlisted ids included.
 *
 * Also returns what ended up out, each carrying its FULL config, so a host can
 * render it greyed and switch it back on without a second lookup.
 */
export function applyModelOverrides(
  curation: { models: ModelConfig[]; excluded: ExcludedModel[] },
  settings: Settings
): { models: ModelConfig[]; excluded: ExcludedModel[] } {
  const allow = new Set(settings.modelAllowlist ?? []);
  const deny = new Set(settings.modelBlocklist ?? []);

  const keep: ModelConfig[] = [];
  const excluded: ExcludedModel[] = [];

  // (1) the curation as served, and (2) anything it withheld that the user has
  // allowed back in — which keeps the real capabilities the catalog gave it.
  for (const m of curation.models) keep.push(m);
  for (const e of curation.excluded) {
    if (!allow.has(e.id)) {
      excluded.push(e);
      continue;
    }
    const { reason: _reason, ...config } = e;
    keep.push(config);
  }

  // An allowlisted id the catalog never mentioned still has to resolve.
  const known = new Set<string>([
    ...curation.models.map((m) => m.id),
    ...curation.excluded.map((e) => e.id),
  ]);
  for (const id of allow) {
    if (!known.has(id)) keep.push(syntheticModel(id));
  }

  // (3) custom ids, then (4) the blacklist, which has the last word.
  const models: ModelConfig[] = [];
  for (const m of mergeCustomModels(keep, settings)) {
    if (deny.has(m.id)) excluded.push({ ...m, reason: "blocked" });
    else models.push(m);
  }
  return { models, excluded };
}

/**
 * The CN base URL. Kept for callers that only need "some" host (the docs page
 * and the OpenAPI description); real traffic goes through `region.ts`.
 */
export function getBaseUrl(): string {
  return REGION_PROFILES[DEFAULT_REGION].baseUrl;
}
