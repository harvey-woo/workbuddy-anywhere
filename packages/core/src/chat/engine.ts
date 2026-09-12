/**
 * OpenAI-compatible chat engine for the WorkBuddy gateway.
 *
 * This is the request-assembly + stream-handling half of what used to live in
 * the VS Code extension's provider.ts. It contains no vscode (or electron)
 * imports so all three hosts share exactly one implementation:
 *
 *   - VS Code extension : maps LanguageModelChatRequestMessage -> ChatMessage
 *   - HTTP server       : maps OpenAI request JSON       -> ChatMessage
 *   - Electron          : reuses the server or the service directly
 *
 * Everything that is order-sensitive (message mapping, tool-call validation,
 * orphan mending, end-of-stream flush ordering) is a direct port — do not
 * "tidy" it without a raw-SSE probe to back the change.
 */

import { parseSSEStream } from "../sse";
import { ToolCallCapture, sniffToolCallFromContent } from "../capture";
import { sanitizeToolSchema } from "../schema";
import { clusterFor } from "../auth";
import type { WorkbuddyAuth } from "../auth";
import type { ModelConfig } from "../models";
import type { Settings } from "../settings";
import type {
  ChatContext,
  ChatEvent,
  ChatImage,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  ChatUsage,
} from "./types";

const CHAT_PATH = "/v2/chat/completions";

/**
 * Stream timeout:
 *   `FIRST_BYTE_TIMEOUT_MS` aborts if no data arrives before the first byte
 *   comes back (network/auth is dead). Mirrors the CLI's
 *   `firstPayloadTimeoutMs`. After the first byte, no further timeout fires —
 *   reasoning models legitimately pause between thinking tokens for tens of
 *   seconds; an idle timeout would murder them mid-thought.
 */
const FIRST_BYTE_TIMEOUT_MS = 60_000;

interface OpenAIMessage {
  role: string;
  content?: string | unknown[];
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface ToolCallAccum {
  id: string;
  name: string;
  args: string;
}

// ── Thinking effort ─────────────────────────────────────────────────────

/**
 * Resolve the reasoning effort from per-model config or workspace setting.
 * Priority: modelConfiguration (gear menu) > settings > API default.
 */
export function resolveThinkingEffort(
  modelInfo: ModelConfig | undefined,
  modelConfiguration: Record<string, unknown> | undefined,
  workspaceSetting: string
): string {
  if (!modelInfo?.capabilities.reasoning) return "";
  const rc = modelInfo.reasoningConfig;

  // 1. Per-model override (highest priority)
  const modelEffort = modelConfiguration?.reasoningEffort as string | undefined;
  if (modelEffort === "off") return "";
  let effort = "";
  if (modelEffort) {
    effort = modelEffort;
  } else if (workspaceSetting === "off") {
    return "";
  } else if (workspaceSetting !== "auto") {
    effort = workspaceSetting;
  } else if (rc?.defaultEffort) {
    effort = rc.defaultEffort;
  } else if (rc?.effort) {
    effort = rc.effort;
  }
  // NOTE: no hardcoded fallback. The old `return "medium"` guess could send
  // an effort value the model doesn't support.

  // hy3-family: the gateway only honors "high" for deep thinking — every
  // other value (medium/low/max/xhigh) silently DISABLES reasoning
  // (workbuddy-cliproxy force-pins reasoning_effort=high for hy3* for
  // exactly this reason). An explicit "off" was already handled above.
  if (/^hy3/i.test(modelInfo.id)) return "high";

  // NOTE: `capabilities.reasoningOnly` (the server's `onlyReasoning` flag) is
  // deliberately NOT enforced here. The upstream comment above establishes
  // that an explicit "off" IS honored for hy3, and hy3 is itself
  // onlyReasoning — so second-guessing "off" from an unverified field would
  // regress known-good behaviour. The flag is surfaced on ModelConfig instead,
  // for the UI to hide the "off" option where the server says it cannot work.

  if (!effort) return "";

  // Validate against the model's supported efforts. An unsupported value is
  // silently ignored by the gateway (thinking off) — fall back to the model
  // default instead of sending a guess; drop the field if nothing is valid.
  const supported = rc?.supportedEfforts;
  if (supported && supported.length > 0 && !supported.includes(effort)) {
    const fallback = [rc?.defaultEffort, rc?.effort].find(
      (e): e is string => !!e && supported.includes(e)
    );
    return fallback ?? "";
  }
  return effort;
}

// ── Request assembly ────────────────────────────────────────────────────

export interface BuildMessagesOptions {
  model: ModelConfig | undefined;
  settings: Settings;
  log?: (msg: string) => void;
  /** Describes an image for a model that cannot see it; null = give up. */
  describeImage?: (image: ChatImage) => Promise<string | null>;
}

/**
 * Map the neutral transcript onto the OpenAI payload.
 *
 * Ordering rules that MUST be preserved (each one was a bug at some point):
 *   - assistant content is ALWAYS a string ("" when empty) — `undefined`
 *     breaks strict backends;
 *   - a text-only assistant message directly before an assistant(tool_calls)
 *     message is MERGED into it (consecutive assistant messages hide the
 *     call/result pairing → the model repeats itself);
 *   - tool results are emitted before any text riding on the same message
 *     (the CLI's tCc order) so call/result stay adjacent;
 *   - assistant(tool_calls) that never got results (Copilot's maxToolCalls
 *     truncation) are mended with synthetic "cancelled" results.
 */
export async function buildOpenAIMessages(
  messages: ChatMessage[],
  opts: BuildMessagesOptions
): Promise<OpenAIMessage[]> {
  const oaiMessages: OpenAIMessage[] = [];
  // callId -> index of the assistant message that issued it
  const pendingToolCallIdx = new Map<string, number>();

  for (const msg of messages) {
    const role = msg.role;
    const textParts: string[] = msg.text ? [msg.text] : [];
    const toolCallParts = msg.toolCalls ?? [];
    const toolResultParts = msg.toolResults ?? [];

    // Images: passed through when the chosen model can see. Otherwise the
    // injected resolver describes them and the text is inlined instead.
    //
    // WHO describes the image is deliberately not the engine's business: the
    // service composes a host override and core's own catalog model into one
    // resolver (see `service.visionResolver`).
    const imageBlocks: Array<{ type: string; image_url?: { url: string } }> = [];
    const needsVisionFallback = !!opts.model && !opts.model.capabilities.imageInput;
    for (const img of msg.images ?? []) {
      if (!img.mimeType.startsWith("image/")) continue;
      if (needsVisionFallback && opts.describeImage) {
        const desc = await opts.describeImage(img);
        if (desc) {
          textParts.push(`[图片描述] ${desc}`);
          opts.log?.(
            `vision-fallback mime=${img.mimeType} desc-chars=${desc.length}`
          );
          continue;
        }
        // Nothing could describe it — fall through to the inline path.
        // Upstream will reject the image, but the text around it still lands.
      }
      imageBlocks.push({
        type: "image_url",
        image_url: {
          url: `data:${img.mimeType};base64,${Buffer.from(img.data).toString("base64")}`,
        },
      });
    }

    if (role === "assistant" && toolCallParts.length > 0) {
      let content = textParts.join("");
      const prev = oaiMessages[oaiMessages.length - 1];
      if (
        !content &&
        prev &&
        prev.role === "assistant" &&
        !prev.tool_calls &&
        typeof prev.content === "string" &&
        prev.content
      ) {
        content = prev.content;
        oaiMessages.pop();
      }
      const idx = oaiMessages.length;
      oaiMessages.push({
        role: "assistant",
        content,
        tool_calls: toolCallParts.map((tc) => {
          pendingToolCallIdx.set(tc.id, idx);
          return {
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          };
        }),
      });
    } else if (toolResultParts.length > 0) {
      // One "tool" message per tool result.
      for (const tr of toolResultParts) {
        oaiMessages.push({
          role: "tool",
          content: tr.text || "(no output)",
          tool_call_id: tr.callId,
        });
        pendingToolCallIdx.delete(tr.callId);
      }
      // Text riding on a tool-result message goes AFTER the results so the
      // call/result pairing stays adjacent for the backend.
      const textContent = textParts.join("");
      if (textContent) {
        oaiMessages.push({ role: "user", content: textContent });
      }
    } else if (imageBlocks.length > 0) {
      // Multimodal message: text first, then images (OpenAI content array).
      const text = textParts.join("");
      const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      if (text) content.push({ type: "text", text });
      content.push(...imageBlocks);
      oaiMessages.push({ role, content: content as unknown as string });
    } else {
      oaiMessages.push({ role, content: textParts.join("") });
    }
  }

  // Mend orphaned tool_calls.
  for (const [callId, idx] of pendingToolCallIdx) {
    oaiMessages.splice(idx + 1, 0, {
      role: "tool",
      content: "cancelled",
      tool_call_id: callId,
    });
    for (const [cid, i] of pendingToolCallIdx) {
      if (i > idx) pendingToolCallIdx.set(cid, i + 1);
    }
    pendingToolCallIdx.delete(callId);
  }

  return oaiMessages;
}

export function buildChatHeaders(auth: WorkbuddyAuth): Record<string, string> {
  // Mirrors workbuddy-cliproxy (commonHeaders + backendHeaders) — the
  // reference working client for this gateway. It sends X-Refresh-Token,
  // X-Domain and X-No-Department-Info on every chat request, uses a
  // browser-ish Accept + X-Requested-With + Origin/Referer, and does NOT send
  // X-Client-Platform.
  //
  // Origin/Referer come from the account's region: the CN cluster wants
  // `www.codebuddy.cn`, the international one wants `www.workbuddy.ai`.
  const origin = clusterFor(auth).origin;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: origin + "/",
    Authorization: `Bearer ${auth.accessToken}`,
    "User-Agent": auth.userAgent || "CLI/2.63.2 CodeBuddy/2.63.2",
    "X-Product": "SaaS",
    "X-No-Department-Info": "1",
  };
  if (auth.uid) headers["X-User-Id"] = auth.uid;
  if (auth.enterpriseId) headers["X-Enterprise-Id"] = auth.enterpriseId;
  if (auth.refreshToken) headers["X-Refresh-Token"] = auth.refreshToken;
  if (auth.domain) headers["X-Domain"] = auth.domain;
  return headers;
}

/** Rough token estimate used when the host asks for a token count. */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Tool-call validation / emission ─────────────────────────────────────

/**
 * Validate accumulated tool calls and yield them in the original order.
 *
 * Hard rejects (unknown tool name, unparseable args) become assistant-visible
 * notes instead of calls: executing them would fail inside the host with no
 * model-visible reason, so telling the model HERE lets it correct itself on
 * the next turn. Soft-warns calls recovered from a text template.
 */
function* validateToolCalls(
  accum: Map<number, ToolCallAccum>,
  opts: {
    knownTools: Set<string>;
    fromCapture: Set<number>;
    log?: (msg: string) => void;
  }
): Generator<ChatEvent> {
  const notes: string[] = [];
  for (const [idx, tc] of accum) {
    if (!tc.name) continue;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(tc.args || "{}");
    } catch {
      parsed = undefined;
    }

    if (!opts.knownTools.has(tc.name)) {
      opts.log?.(`validate: REJECTED unknown tool "${tc.name}"`);
      notes.push(
        `[system] Tool call "${tc.name}" was NOT executed: that tool does not exist. Available tools: ${[...opts.knownTools].join(", ")}. Re-issue the call with a valid tool name.`
      );
      continue;
    }

    if (parsed === undefined) {
      opts.log?.(
        `validate: REJECTED malformed args for "${tc.name}" (${tc.args.length} ch)`
      );
      notes.push(
        `[system] Tool call "${tc.name}" was NOT executed: its arguments were not valid JSON (likely truncated). Re-issue the call with complete arguments.`
      );
      continue;
    }

    if (opts.fromCapture.has(idx)) {
      notes.push(
        `[system] Note: the previous tool call was recovered from malformed output. Emit tool calls through the standard tool_calls channel instead of embedding them in message text.`
      );
    }

    yield {
      type: "toolCall",
      call: {
        id: tc.id || `cb-tool-${Date.now()}-${idx}`,
        name: tc.name,
        input: parsed,
      },
    };
  }
  // Feedback notes become assistant-visible text in the next turn's history.
  if (notes.length > 0) {
    yield { type: "text", text: notes.join("\n") };
  }
  accum.clear();
}

// ── Streaming ───────────────────────────────────────────────────────────

/**
 * POST the chat request with fetch-failure handling.
 *
 * `TypeError: fetch failed` is undici's generic wrapper — the REAL reason
 * (ECONNRESET on a stale keep-alive socket, ECONNREFUSED, DNS, ENOTFOUND,
 * our own first-byte abort…) lives on `error.cause`. This wrapper:
 *   1. unwraps and logs the cause chain,
 *   2. retries ONCE on transient connect-phase failures (no bytes of the
 *      response have been streamed yet, so a retry cannot duplicate content),
 *   3. turns our first-byte abort into an explicit, actionable error.
 */
async function chatFetch(
  baseUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
  isCancelled: () => boolean,
  log: (msg: string) => void
): Promise<Response> {
  const payload = JSON.stringify(body);
  const url = `${baseUrl}${CHAT_PATH}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (isCancelled()) throw new Error("Request cancelled");
    try {
      return await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal,
      });
      // fetch resolves once RESPONSE HEADERS arrive; a resolve here means the
      // connection itself succeeded — no retry needed.
    } catch (err) {
      lastErr = err;
      const e = err as Error & { cause?: Error & { code?: string } };
      const cause = e?.cause;
      const code = cause?.code ?? "";
      const causeMsg = cause
        ? `${cause.name}: ${cause.message}${code ? ` (${code})` : ""}`
        : "(no cause)";

      // A caller-driven cancel and our own first-byte timeout both surface as
      // an abort; check the caller first so a user cancel is not reported as
      // a network timeout.
      if (isCancelled()) {
        log("fetch aborted by caller cancellation");
        throw new Error("Request cancelled");
      }
      if (code === "ABORT_ERR" || e.name === "AbortError") {
        log(
          `fetch ABORTED (first-byte timeout ${FIRST_BYTE_TIMEOUT_MS}ms) — no response headers from gateway`
        );
        throw new Error(
          `WorkBuddy: no response from gateway within ${FIRST_BYTE_TIMEOUT_MS / 1000}s (first-byte timeout). Check your network or try again.`
        );
      }

      const transient = [
        "ECONNRESET",
        "ECONNREFUSED",
        "EPIPE",
        "EAI_AGAIN",
        "ENOTFOUND",
        "UND_ERR_SOCKET",
      ].includes(code);
      log(
        `fetch FAILED (attempt ${attempt}/2): ${e.message} cause=${causeMsg}${transient ? " → retrying" : " → NOT retryable"}`
      );
      if (!transient || attempt === 2) break;
      // Brief pause before retry so a gateway restart blip can pass.
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const e = lastErr as Error & { cause?: Error & { code?: string } };
  const cause = e?.cause;
  const detail = cause
    ? `${cause.message}${cause.code ? ` (${cause.code})` : ""}`
    : e?.message ?? "unknown network error";
  throw new Error(`WorkBuddy network error: ${detail}`);
}

/**
 * Run one chat completion against the gateway, yielding neutral events.
 *
 * Throws on unrecoverable failures (auth, HTTP error, truncated stream) so
 * each host can surface them its own way.
 */
export async function* streamChat(
  request: ChatRequest,
  ctx: ChatContext
): AsyncGenerator<ChatEvent> {
  const log = ctx.log ?? (() => {});
  const modelInfo = ctx.models.find((m) => m.id === request.model);

  const oaiMessages = await buildOpenAIMessages(request.messages, {
    model: modelInfo,
    settings: ctx.settings,
    log,
    describeImage: ctx.describeImage,
  });

  const body: Record<string, unknown> = {
    model: request.model,
    messages: oaiMessages,
    stream: true,
    stream_options: { include_usage: true },
  };

  const effort = resolveThinkingEffort(
    modelInfo,
    request.modelConfiguration,
    ctx.settings.thinkingEffort
  );
  if (effort) {
    body.reasoning_effort = effort;
  }

  // NOTE: do NOT send max_tokens. The gateway counts reasoning
  // tokens against it; when a thinking model's reasoning exceeds the cap the
  // gateway TRUNCATES the stream mid-thought and closes with
  // finish_reason:"tool_calls" but an EMPTY tool_calls array — the tool call
  // vanishes ("says what it will do, then nothing"). Verified by raw SSE
  // probes: max_tokens=1024 → truncated; no max_tokens → complete tool_calls.
  // The server enforces its own sane output limit.

  const tools = request.tools ?? [];
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: sanitizeToolSchema(t.inputSchema),
      },
    }));
    if (request.toolMode === "required") {
      body.tool_choice = "required";
    }
  }

  const headers = buildChatHeaders(ctx.auth);

  const controller = new AbortController();
  const isCancelled = (): boolean => ctx.signal?.aborted === true;
  const onAbort = (): void => controller.abort();
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      throw new Error("Request cancelled");
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  }

  // First-byte timer: abort only if the FIRST byte never arrives. Once data
  // starts streaming we leave the stream alone — reasoning models regularly go
  // tens of seconds between thinking tokens.
  let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
  const onFirstByte = (): void => {
    if (firstByteTimer) {
      clearTimeout(firstByteTimer);
      firstByteTimer = undefined;
    }
  };

  try {
    firstByteTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS);
    const streamStartedAt = Date.now();
    const response = await chatFetch(
      clusterFor(ctx.auth).baseUrl,
      headers,
      body,
      controller.signal,
      isCancelled,
      log
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Upstream error ${response.status}: ${errText.slice(0, 300)}`);
    }

    // ── Tool-call accumulator ───────────────────────────────────────
    const toolCallAccum = new Map<number, ToolCallAccum>();
    /** Indices recovered from content templates / sniffing (non-standard). */
    const fromCapture = new Set<number>();
    /** Whitelist of tool names the caller offered this turn. */
    const knownTools = new Set(tools.map((t) => t.name));
    let finishReason = "";

    // Text-channel capture (custom <tool_calls:TAG> templates, Claude/antml
    // <invoke> blocks, bare JSON — plus per-chunk hold-back and end-of-stream
    // recovery) lives in capture.ts as a vscode-free state machine.
    const capture = new ToolCallCapture(log);

    const processText = (delta: string, kind: "content" | "reasoning"): string => {
      const shown = capture.processText(delta, kind);
      for (const call of capture.takeCalls()) {
        const idx = toolCallAccum.size;
        toolCallAccum.set(idx, call);
        fromCapture.add(idx);
      }
      return shown;
    };

    for await (const chunk of parseSSEStream(response)) {
      if (isCancelled()) break;
      // First byte received → cancel the first-byte timer.
      onFirstByte();

      // Usage frame (we send stream_options.include_usage): the last chunk
      // carries `usage` alongside an EMPTY choices array. Surfaced as an event
      // so the OpenAI-compatible endpoint can report real token counts.
      if (chunk.data.usage) {
        yield { type: "usage", usage: chunk.data.usage as ChatUsage };
      }

      const choices = chunk.data.choices as
        | Array<{
            finish_reason?: string | null;
            delta?: {
              content?: string;
              reasoning_content?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>
        | undefined;
      if (!choices) {
        // No choices array — either a harmless keep-alive/usage frame or an
        // ERROR frame. Error frames were previously swallowed here, so a
        // gateway rejection looked like "the stream just ended".
        const d = chunk.data as Record<string, unknown>;
        const err = d.error ?? d.err;
        if (err) {
          const msg = typeof err === "object" ? JSON.stringify(err) : String(err);
          log(`stream ERROR frame: ${msg.slice(0, 300)}`);
          throw new Error(`WorkBuddy stream error: ${msg.slice(0, 300)}`);
        }
        log(`stream non-choice frame: ${JSON.stringify(chunk.data).slice(0, 200)}`);
        continue;
      }

      for (const choice of choices) {
        if (choice.finish_reason != null && choice.finish_reason !== "") {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta;
        if (!delta) continue;

        // ── STANDARD tool_calls channel ──────────────────────────────
        // OpenAI-style streaming: the first fragment carries
        // {index, id, function:{name}}, later fragments carry only
        // {index, function:{arguments:"<chunk>"}}. Accumulate by index.
        // NOTE: this handler was LOST in an earlier refactor — every tool
        // call sent through the standard channel was silently dropped,
        // leaving finish_reason:"tool_calls" with an EMPTY accumulator.
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? toolCallAccum.size;
            const existing = toolCallAccum.get(idx);
            if (existing) {
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
              log(
                `stream toolcall[${idx}] args+=${tc.function?.arguments?.length ?? 0}ch (total ${existing.args.length})`
              );
            } else {
              toolCallAccum.set(idx, {
                id: tc.id || "",
                name: tc.function?.name || "",
                args: tc.function?.arguments || "",
              });
              log(
                `stream toolcall[${idx}] NEW id=${tc.id || "(none)"} name=${tc.function?.name || "(none)"}`
              );
            }
          }
        }

        // Reasoning content: shown as text, BUT it goes through the SAME
        // template state machine as content — thinking models often
        // "rehearse" the tool-call template inside reasoning_content, and a
        // tag opened in reasoning can close in content (or never close there
        // at all). Without this the call inside reasoning is lost.
        if (delta.reasoning_content) {
          const shown = processText(delta.reasoning_content, "reasoning");
          if (shown) yield { type: "text", text: shown };
        }

        // Text content — also sniff for tool-call JSON that some gateways
        // dump into `content` instead of `tool_calls`, AND capture
        // <tool_calls:TAG> templates that span many chunks.
        if (delta.content) {
          const shown = processText(delta.content, "content");
          if (shown) {
            const sniffed = sniffToolCallFromContent(shown);
            if (sniffed) {
              const idx = toolCallAccum.size;
              toolCallAccum.set(idx, sniffed);
              fromCapture.add(idx);
            } else {
              yield { type: "text", text: shown };
            }
          }
        }
      }

      // NOTE: no mid-loop flush here. Some gateways send
      // finish_reason:"tool_calls" in a chunk BEFORE the last tool_calls
      // deltas arrive; flushing (and clearing) mid-loop on that signal
      // swallowed the trailing deltas. The end-of-stream flush below is the
      // single emit point — it always runs after the stream closes.
    }

    // ── Stream-end diagnostics ────────────────────────────────────────
    // A complete OpenAI-compatible stream ALWAYS delivers a finish_reason
    // before [DONE]. Ending without one means the gateway (or something
    // between us and it) closed the connection mid-generation. Fail LOUDLY
    // instead of silently ending the turn with half an answer. (No auto-retry
    // with an injected user message: that corrupts the transcript.)
    const elapsedMs = Date.now() - streamStartedAt;
    log(
      `stream END: finishReason=${finishReason || "(none)"} deltas=${capture.deltas} captureBusy=${capture.isBusy} ${elapsedMs}ms`
    );
    if (isCancelled()) {
      log("stream END: cancelled by caller");
      return;
    }
    const hadToolCalls = toolCallAccum.size > 0;
    if (!finishReason && !hadToolCalls) {
      throw new Error(
        `WorkBuddy: the gateway closed the stream before completion (no finish_reason after ${capture.deltas} deltas / ${Math.round(elapsedMs / 1000)}s). The response was cut off — please retry.`
      );
    }

    // ── End-of-stream flush: recover calls from UNCLOSED blocks ──────
    // Streams truncated by max_tokens or an abrupt finish can end while still
    // inside a capture block; without this the buffered call would vanish.
    // Unrecoverable leftovers are surfaced as text (never a silent drop).
    const leftover = capture.endFlush();
    for (const call of capture.takeCalls()) {
      const idx = toolCallAccum.size;
      toolCallAccum.set(idx, call);
      fromCapture.add(idx);
    }
    if (toolCallAccum.size > 0) {
      yield* validateToolCalls(toolCallAccum, { knownTools, fromCapture, log });
    }
    if (leftover) {
      yield { type: "text", text: leftover };
    }
  } finally {
    if (firstByteTimer) clearTimeout(firstByteTimer);
    ctx.signal?.removeEventListener("abort", onAbort);
  }
}
