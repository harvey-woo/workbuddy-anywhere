/**
 * VS Code's `LanguageModelChatProvider` — a thin adapter over core.
 *
 * Everything protocol-shaped already lives in `@wbaw/core`: the
 * OpenAI-compatible payload (including its order-sensitive rules for merging
 * assistant text, keeping tool calls adjacent to their results, and mending
 * orphaned calls), reasoning-effort resolution, the SSE reader, the first-byte
 * timeout and retry, and the recovery of tool calls the gateway embeds in
 * ordinary message text.
 *
 * So what is left here is only what genuinely needs VS Code:
 *
 *   - translating VS Code's content parts into core's neutral messages, and
 *     core's stream events back into `LanguageModelResponsePart`s;
 *   - the model list, including the per-model gear menu;
 *   - refusing tool calls VS Code cannot execute — WITH feedback the model can
 *     act on next turn (VS Code would otherwise just fail them);
 *   - token counting.
 */

import * as vscode from "vscode";
import type {
  ChatImage,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  ModelConfig,
  WorkbuddyService,
} from "@wbaw/core";

let channel: vscode.OutputChannel | undefined;

/** Diagnostic log ("CodeBuddy" output channel). Never throws. */
function out(msg: string): void {
  try {
    channel ??= vscode.window.createOutputChannel("WorkBuddy Anywhere");
    channel.appendLine(`${new Date().toISOString()} ${msg}`);
  } catch {
    // Logging must never break a stream.
  }
}

export class CodeBuddyChatProvider implements vscode.LanguageModelChatProvider {
  /**
   * Which cluster this provider fronts. The two vendors registered in
   * package.json (`codebuddy` and `codebuddy-intl`) each get their own
   * provider, and the cluster is the only thing they differ on — same
   * service, same model loading path, same stream translator.
   */
  readonly region: "cn" | "intl";
  private readonly service: WorkbuddyService;

  /** Emitted whenever the model list changes so VS Code re-queries it. */
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  /**
   * Fired once at the start of every chat request that flows through this
   * provider. VS Code does not expose a stable "which chat model is the user
   * looking at right now" event (see the picker model notes in
   * extension.ts), so the only place a provider learns that "the user
   * actually picked me and pressed Send" is `provideLanguageModelChatResponse`.
   * The extension subscribes to both providers and forwards the latest one
   * to the management webview so the page can re-render in the picked
   * cluster's context — segment control + accounts + quota all follow.
   */
  private readonly _onDidChangeLastUsedRegion =
    new vscode.EventEmitter<"cn" | "intl">();
  readonly onDidChangeLastUsedRegion = this._onDidChangeLastUsedRegion.event;

  private models: ModelConfig[] = [];

  constructor(service: WorkbuddyService, region: "cn" | "intl") {
    this.service = service;
    this.region = region;
  }

  setModels(models: ModelConfig[]): void {
    // An EMPTY list is never an improvement: VS Code re-queries on this event,
    // and if the previously-selected model is momentarily missing the picker
    // DROPS the selection (it does not re-apply it once the model comes back).
    // Keep serving the stale list until a real one arrives.
    if (models.length === 0 && this.models.length > 0) return;
    // Only fire when the list actually changed — duplicate registrations make
    // VS Code rebuild its picker cache, which is both noise and a way to lose
    // transient UI state.
    const changed = this.signature(this.models) !== this.signature(models);
    this.models = models;
    if (changed) this._onDidChange.fire();
  }

  /** Stable identity of a model list (ids in order) — for change detection. */
  private signature(models: ModelConfig[]): string {
    return models.map((m) => m.id).join("\n");
  }

  /** Convenience for the activation log. */
  count(): number {
    return this.models.length;
  }

  /** Ask VS Code to re-query our model list. */
  notifyChanged(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._onDidChangeLastUsedRegion.dispose();
  }

  // ── models ────────────────────────────────────────────────────────────

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // VS Code asks TWICE whenever a model carries a `configurationSchema`:
    //   1. a groupless call            -> options.configuration is undefined
    //   2. one call per BYOK group the user added via "Manage Models"
    // Answering both registers the same models under two cache keys, which is
    // what made every CodeBuddy model appear twice. We serve the model list on
    // the groupless call only.
    if ((options as { configuration?: unknown }).configuration !== undefined) {
      return [];
    }

    // getState is region-aware, so this provider only ever returns models
    // from the cluster it was registered for. Two providers, two catalogs.
    //
    // The cache is checked FIRST and, when empty, backfilled from the service —
    // but a service that cannot produce models yet (init still fetching the
    // catalog, or a failed fetch) must NOT become an empty answer. Serving []
    // on the first query of a session makes VS Code clear the persisted model
    // selection before the real list ever lands, and it never comes back.
    if (this.models.length === 0) {
      try {
        const state = await this.service.getState(this.region);
        if (state.models.length > 0) this.models = state.models;
      } catch (err) {
        out(`model list fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const seen = new Set<string>();
    const infos: vscode.LanguageModelChatInformation[] = [];

    for (const m of this.models) {
      const key = m.id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const info: vscode.LanguageModelChatInformation = {
        id: m.id,
        name: m.displayName,
        family: m.family,
        version: "1.0.0",
        maxInputTokens: m.contextLength || 100_000,
        maxOutputTokens: m.maxOutputTokens,
        // VS Code has no structured "extra info" field on the chat picker,
        // so cost goes on the tooltip (hover) instead of the name. The raw
        // `credits` field has no enforced shape (`"0.29"`, `"×0.29 credits"`,
        // `"0.29×/req"` all observed) — normalise to a single `<n>×` form.
        tooltip: (() => {
          const base = `${m.displayName} (${m.contextLength.toLocaleString()} tokens)`;
          if (!m.credits) return base;
          const n = m.credits
            .trim()
            .replace(/^(?:x|×)\s*/i, "")
            .replace(/\s*(?:x|×|credits?|per[\s-]?req(?:uest)?|\/req(?:uest)?|请求|积分)\s*$/i, "")
            .trim();
          return /^[0-9]+(?:\.[0-9]+)?$/.test(n) ? `${base} · ${n}×/req` : base;
        })(),
        capabilities: {
          imageInput: m.capabilities.imageInput,
          toolCalling: m.capabilities.toolCalling,
        },
      };

      if (m.capabilities.reasoning && m.reasoningConfig) {
        (info as { configurationSchema?: unknown }).configurationSchema =
          buildReasoningSchema(m);
      }
      infos.push(info);
    }
    return infos;
  }

  // ── chat ──────────────────────────────────────────────────────────────

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const request = toChatRequest(model.id, messages, options);
    // The tools VS Code actually offered this turn — the only ones it can run.
    const knownTools = new Set((options.tools ?? []).map((t) => t.name));

    // VS Code cancels through its own token; core speaks AbortSignal.
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());

    // Tool calls are collected rather than forwarded straight through: they
    // need the full stream (the arguments arrive in pieces) before they can be
    // validated.
    const toolCalls: ChatToolCall[] = [];

    // Notify the management webview that the user just sent a request through
    // THIS vendor's picker selection. The event fires at the start of the
    // turn so the page can switch context BEFORE the first token arrives;
    // firing only at the end would lag the UI for several seconds on long
    // prompts. The webview ignores the message if it already shows this
    // region (idempotent — the provider's region is a per-instance value, not
    // a per-request one).
    this._onDidChangeLastUsedRegion.fire(this.region);

    try {
      // Stamp this provider's region onto the request so core's per-region
      // account selection picks an account in the right cluster — a chat
      // through the INTL vendor must NEVER spend a CN account's quota.
      (request as { region?: "cn" | "intl" }).region = this.region;
      for await (const event of this.service.chat(request, controller.signal)) {
        switch (event.type) {
          case "text":
            progress.report(new vscode.LanguageModelTextPart(event.text));
            break;
          case "toolCall":
            toolCalls.push(event.call);
            break;
          case "usage":
            out(`usage ${JSON.stringify(event.usage)}`);
            break;
        }
      }
    } catch (err) {
      // A cancelled request is the user's doing, not a failure to report.
      if (token.isCancellationRequested) return;
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      subscription.dispose();
    }

    reportToolCalls(toolCalls, progress, knownTools);
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    // Good enough for budgeting: VS Code only uses this to decide when to
    // compact history, and the gateway does the real accounting.
    const str =
      typeof text === "string"
        ? text
        : text.content
            .map((p) =>
              p instanceof vscode.LanguageModelTextPart
                ? p.value
                : p instanceof vscode.LanguageModelToolCallPart
                  ? p.name
                  : ""
            )
            .join("");
    return Math.ceil(str.length / 4);
  }
}

// ── VS Code ⇄ core translation ──────────────────────────────────────────

/** One VS Code turn → core's neutral request. */
function toChatRequest(
  modelId: string,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions
): ChatRequest {
  return {
    model: modelId,
    messages: messages.map(toChatMessage),
    tools: (options.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      // Sanitized inside core before it reaches the gateway.
      inputSchema: t.inputSchema,
    })),
    toolMode:
      options.toolMode === vscode.LanguageModelChatToolMode.Required
        ? "required"
        : "auto",
    // The per-model gear menu writes here. It is passed through untranslated:
    // core resolves it against the model's own reasoning config, which is
    // where the knowledge of what that model accepts lives.
    modelConfiguration: (options.modelOptions ?? {}) as Record<string, unknown>,
  };
}

/**
 * One VS Code message → core's neutral message.
 *
 * The buckets are kept separate (text / toolCalls / toolResults / images)
 * rather than flattened, because the OpenAI payload is ORDER SENSITIVE and a
 * lossy intermediate shape silently changes what the gateway sees.
 *
 * Note there is NO image handling here: which model describes an image for a
 * model that cannot see is core's decision, made through an injected hook
 * (see `vscode-adapters.ts`). The adapter's only job is to hand the image over.
 */
function toChatMessage(msg: vscode.LanguageModelChatRequestMessage): ChatMessage {
  const message: ChatMessage = {
    role:
      msg.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant",
  };

  const text: string[] = [];
  const images: ChatImage[] = [];

  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text.push(part.value);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      (message.toolCalls ??= []).push({
        id: part.callId,
        name: part.name,
        input: part.input,
      });
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      (message.toolResults ??= []).push({
        callId: part.callId,
        text: toolResultText(part),
      });
    } else if (part instanceof vscode.LanguageModelDataPart) {
      if (part.mimeType.startsWith("image/")) {
        images.push({ mimeType: part.mimeType, data: part.data });
      }
    }
  }

  // `text` is set even when empty for assistant messages, because core relies
  // on the presence of the field to distinguish "said nothing" from "this
  // bucket does not exist".
  if (text.length > 0 || message.role === "assistant") {
    message.text = text.join("");
  }
  if (images.length > 0) message.images = images;
  return message;
}

/**
 * Flatten a tool result to text.
 *
 * Unknown part kinds are serialized rather than dropped: silently losing a
 * tool result is far worse than sending an awkward-looking one.
 */
function toolResultText(part: vscode.LanguageModelToolResultPart): string {
  const pieces: string[] = [];
  for (const content of part.content) {
    if (content instanceof vscode.LanguageModelTextPart) {
      pieces.push(content.value);
    } else if (content instanceof vscode.LanguageModelDataPart) {
      pieces.push(`[${content.mimeType}, ${content.data.byteLength} bytes]`);
    } else {
      try {
        pieces.push(JSON.stringify(content));
      } catch {
        pieces.push(String(content));
      }
    }
  }
  return pieces.join("\n");
}

/**
 * Forward the tool calls core produced, minus the ones VS Code cannot run.
 *
 * A rejected call is NOT silently dropped — it is reported back as text so the
 * model can see why and correct itself next turn. Letting it through would make
 * VS Code fail it inside the tool host with nothing the model can learn from,
 * and the model tends to simply repeat the same call.
 *
 * (Recovering tool calls that the gateway embedded in message text is NOT
 * handled here: core's engine already does it, which is why this function only
 * has to validate.)
 */
function reportToolCalls(
  calls: readonly ChatToolCall[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  knownTools: Set<string>
): void {
  if (calls.length === 0) return;

  const notes: string[] = [];
  for (const [index, call] of calls.entries()) {
    if (!knownTools.has(call.name)) {
      out(`tool call REJECTED: unknown tool "${call.name}"`);
      notes.push(
        `[system] Tool call "${call.name}" was NOT executed: that tool does not exist. ` +
          `Available tools: ${[...knownTools].join(", ") || "(none)"}. ` +
          `Re-issue the call with a valid tool name.`
      );
      continue;
    }
    progress.report(
      new vscode.LanguageModelToolCallPart(
        call.id || `cb-tool-${Date.now()}-${index}`,
        call.name,
        (call.input ?? {}) as object
      )
    );
  }

  if (notes.length > 0) {
    out(`reported ${notes.length} rejected tool call(s) back to the model`);
    progress.report(new vscode.LanguageModelTextPart(notes.join("\n")));
  }
}

// ── Gear menu ───────────────────────────────────────────────────────────

/** One-line explanation per effort level, for the gear menu. */
function reasoningHint(effort: string): string {
  switch (effort) {
    case "low":
      return "Minimal thinking, faster responses";
    case "high":
      return "Deep thinking, slower but more thorough";
    case "max":
      return "Maximum reasoning depth";
    default:
      return "Balanced thinking";
  }
}

/**
 * The per-model "Thinking Effort" control.
 *
 * `off` is ALWAYS offered. The server's `onlyReasoning` flag looks like "this
 * model cannot stop thinking", but that reading is not verified, and the
 * pre-split code recorded the opposite: an explicit "off" IS honoured for hy3
 * (which itself carries the flag). Removing an option users have today, on a
 * guess about a field name, is not a trade worth making — so the flag becomes a
 * truthful hint on the option instead of a deleted capability.
 */
function buildReasoningSchema(m: ModelConfig): Record<string, unknown> {
  const rc = m.reasoningConfig!;
  const efforts =
    rc.supportedEfforts && rc.supportedEfforts.length > 0
      ? rc.supportedEfforts
      : ["low", "medium", "high"];
  const labels = efforts.map((e) => e.charAt(0).toUpperCase() + e.slice(1));
  const hints = efforts.map(reasoningHint);

  const offHint =
    m.capabilities.reasoningOnly === true
      ? "Ask for reasoning to be off — this model may keep thinking regardless"
      : "Disable reasoning";

  return {
    type: "object",
    properties: {
      reasoningEffort: {
        type: "string",
        title: "Thinking Effort",
        enum: ["off", ...efforts],
        enumItemLabels: ["Off", ...labels],
        enumDescriptions: [offHint, ...hints],
        default: rc.defaultEffort || efforts[0] || "medium",
        group: "navigation",
      },
    },
  };
}
