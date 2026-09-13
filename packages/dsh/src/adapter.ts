/**
 * The WorkBuddy Anywhere LLM adapter for DeepSeek Harness.
 *
 * One instance per cluster (CN / INTL), each owning a single provider route —
 * mirroring the two `codebuddy` / `codebuddy-intl` vendors the VS Code Copilot
 * extension registers. The instance is thin: it builds a wbaw `ChatRequest`
 * from dsh's `GenerateOptions` and delegates the actual protocol work (auth,
 * model catalog, SSE, tool-call recovery) to `@wbaw/core`'s `WorkbuddyService`,
 * exactly as copilot delegates to the same core.
 */

import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmDiscoveredModel,
  LlmModelInfo,
  LlmModelContext,
  LlmModelReasoningInfo,
} from "@deepseek-ai/dsh-llm";
import { WorkbuddyService, type ModelConfig } from "@wbaw/core";
import type { ChatRequest } from "@wbaw/core";
import { toStreamChunks, toToolDef, toWbawMessages } from "./translate.js";

/** Resolved-model shape returned by `resolveModel()`. */
export type ResolvedWorkbuddyModel = LlmModelInfo & {
  context?: LlmModelContext;
  defaultMaxTokens?: number;
  reasoning?: LlmModelReasoningInfo;
  systemPromptUpdate?: "in-history";
};

/** Provider-neutral model metadata wbaw's catalog maps onto. */
function toModelInfo(provider: string, m: ModelConfig): LlmModelInfo {
  return {
    provider,
    id: externalModelId(provider, m.id),
    name: m.displayName,
    description: m.description,
    inputModalities: m.capabilities.imageInput ? ["text", "image"] : ["text"],
  };
}

/**
 * The two WorkBuddy clusters advertise OVERLAPPING model ids (both serve
 * `hy3`, `glm-5.3`, …), and dsh keys its catalog by id — a bare id appears
 * once and the second provider group collapses into the first. Prefixing
 * every id with its provider route keeps the two groups separate in every
 * dsh surface. `stripModelId` is the inverse: dsh hands the prefixed id
 * back on every call (prepareCall → resolveModel → stream), and the wire
 * request must carry the RAW cluster id.
 */
export function externalModelId(provider: string, id: string): string {
  return provider === "workbuddy-intl" ? `workbuddy-intl:${id}` : id;
}

/** Inverse of {@link externalModelId}: raw cluster id for the wire request. */
export function stripModelId(provider: string, id: string): string {
  const prefix = "workbuddy-intl:";
  return provider === "workbuddy-intl" && id.startsWith(prefix)
    ? id.slice(prefix.length)
    : id;
}

/**
 * Discovery-catalog shape (what `registerModelDiscovery` serves to dsh's Models
 * settings page). Note dsh's `LlmDiscoveredModel` carries only `id`/`name`/
 * `contextWindow`/`maxTokens` — the reasoning-effort ladder is surfaced
 * separately through `resolveModel` (see `toResolvedModel`), which the in-chat
 * model selector reads for its reasoning-level control.
 */
export function toDiscoveredModel(
  m: ModelConfig,
  provider: string
): LlmDiscoveredModel {
  return {
    id: externalModelId(provider, m.id),
    name: m.displayName,
    contextWindow: m.contextLength,
    maxTokens: m.maxOutputTokens,
  };
}

function toResolvedModel(provider: string, m: ModelConfig): ResolvedWorkbuddyModel {
  const info = toModelInfo(provider, m);
  const efforts = m.reasoningConfig?.supportedEfforts;
  // dsh's normalizeModelInfo requires defaultEffort to be a member of efforts,
  // so fall back to the first effort when the catalog omits/defaults it.
  const rawDefault = m.reasoningConfig?.defaultEffort;
  const defaultEffort =
    rawDefault && efforts?.includes(rawDefault) ? rawDefault : efforts?.[0];
  return {
    ...info,
    context: { contextWindow: m.contextLength },
    defaultMaxTokens: m.maxOutputTokens,
    systemPromptUpdate: "in-history",
    reasoning:
      efforts && efforts.length > 0
        ? ({
            efforts: efforts.map((e) => ({ id: e, name: e })),
            defaultEffort,
          } as unknown as LlmModelReasoningInfo)
        : undefined,
  };
}

export class WorkbuddyAdapter extends LlmAdapter {
  constructor(
    private readonly service: WorkbuddyService,
    private readonly provider: string,
    private readonly region: "cn" | "intl"
  ) {
    super();
  }

  /** Catalog the adapter serves — pulled live from wbaw so it needs no reconfig. */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const state = await this.service.getState(this.region);
    return state.models.map((m) => toModelInfo(this.provider, m));
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal
  ): Promise<ResolvedWorkbuddyModel> {
    // dsh hands back the discovery-catalog id, which carries the
    // `workbuddy-intl:` prefix; the wbaw catalog keys raw ids.
    const raw = stripModelId(provider, model);
    const state = await this.service.getState(this.region);
    const found = state.models.find((m) => m.id === raw);
    if (!found) {
      throw new LlmError(
        `workbuddy: model "${raw}" is not in the WorkBuddy Anywhere catalog for provider "${provider}"`,
        "MODEL_NOT_FOUND"
      );
    }
    return toResolvedModel(this.provider, found);
  }

  /**
   * Bind exact model metadata + a one-generation stream entry point. dsh's
   * runtime calls this before every dispatch; without it, chat dispatch throws
   * `registration.adapter.prepareCall is not a function`.
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal
  ): Promise<{ model: ResolvedWorkbuddyModel; stream: (options: GenerateOptions) => AsyncIterable<import("@deepseek-ai/dsh-llm").StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<import("@deepseek-ai/dsh-llm").StreamChunk> {
    // The wire request carries the RAW cluster id — the discovery prefix
    // (`workbuddy-intl:`) exists only inside dsh's catalog.
    const request: ChatRequest = {
      model: stripModelId(this.provider, options.model),
      messages: toWbawMessages(options.messages),
      region: this.region,
      tools: options.tools?.map(toToolDef),
      toolMode: options.tools && options.tools.length > 0 ? "auto" : undefined,
      modelConfiguration: options.reasoningEffort
        ? { reasoningEffort: String(options.reasoningEffort) }
        : undefined,
      sessionKey: options.sessionId ? String(options.sessionId) : undefined,
    };

    try {
      // `service.chat` selects the account (auto-select or the active one for
      // this region), refreshes quota, and streams. A disabled model group
      // throws — surfaced to dsh as a provider error via toLlmError.
      yield* toStreamChunks(this.service.chat(request, options.signal));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new LlmError(`workbuddy: ${message}`, "PROVIDER_ERROR");
    }
  }
}
