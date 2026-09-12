/**
 * The three wire formats this server speaks, behind ONE interface.
 *
 * `chat-completions`, `messages` and `responses` are exactly the `apiType`
 * values VS Code's BYOK custom endpoints accept, so a client configured for
 * any of them can point here unchanged.
 *
 * Why an interface instead of three handlers: the HTTP plumbing around them
 * (fail before committing to a stream, abort on client disconnect, emit tool
 * calls once the text stream ends, surface a mid-stream failure in-band) is
 * identical for all three and was already easy to get wrong once. Only the
 * FRAMES differ, and those are pure functions of the engine's events.
 */

import type { ChatToolCall, ChatUsage } from "../chat/types";
import type { ModelConfig } from "../models";
import {
  newCompletionId,
  openAIChunk,
  openAICompletion,
  openAIError,
  openAIModelList,
  toOpenAIToolCalls,
} from "./openai";
import {
  AnthropicMessageStream,
  anthropicError,
  anthropicMessage,
  anthropicModelList,
} from "./messages";
import { ResponsesStream, responsesCompletion } from "./responses";

export interface StreamingCodec {
  /** Frames before the first delta (Anthropic/Responses open an envelope). */
  start(): string[];
  text(delta: string): string[];
  /** Called ONCE, after the text stream ends — the engine never interleaves. */
  toolCalls(calls: ChatToolCall[]): string[];
  finish(usage?: ChatUsage): string[];
  /** Bytes written after `finish()`, e.g. OpenAI's `[DONE]` sentinel. */
  tail: string;
  /** In-band failure frames: headers are already out, so a status code is gone. */
  failure(message: string): string[];
  /** The non-streaming body for the same turn. */
  body(text: string, calls: ChatToolCall[], usage?: ChatUsage): unknown;
}

export interface ProtocolDefinition {
  create(model: string): StreamingCodec;
  /** `Content-Type` for the streaming response. */
  sseHeaders: Record<string, string>;
  error(message: string, type: string, code?: string): unknown;
  modelList(models: ModelConfig[]): unknown;
  /** Header whose presence identifies this protocol on a SHARED path. */
  detectsOn?: (headers: Record<string, string | string[] | undefined>) => boolean;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ── chat-completions ────────────────────────────────────────────────────

/**
 * Wraps the existing builders, so the bytes on the wire are unchanged — this
 * is a refactor of the plumbing, not of the protocol.
 */
export const chatCompletionsProtocol: ProtocolDefinition = {
  sseHeaders: SSE_HEADERS,
  error: openAIError,
  modelList: openAIModelList,

  create(model: string): StreamingCodec {
    const id = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    let hadCalls = false;

    return {
      start: () => [],
      text: (delta) => [sse(openAIChunk(id, model, created, { content: delta }, null))],
      toolCalls: (calls) => {
        if (calls.length === 0) return [];
        hadCalls = true;
        return [sse(openAIChunk(id, model, created, { tool_calls: toOpenAIToolCalls(calls) }, null))];
      },
      finish: (usage) => {
        const frames = [
          sse(openAIChunk(id, model, created, {}, hadCalls ? "tool_calls" : "stop")),
        ];
        if (usage) {
          // OpenAI's own shape: a final chunk with an EMPTY choices array.
          frames.push(
            sse({ id, object: "chat.completion.chunk", created, model, choices: [], usage })
          );
        }
        return frames;
      },
      tail: "data: [DONE]\n\n",
      failure: (message) => [
        sse(openAIError(message, "upstream_error")),
        sse(openAIChunk(id, model, created, {}, "stop")),
      ],
      body: (text, calls, usage) => openAICompletion(id, model, created, text, calls, usage),
    };
  },
};

// ── messages (Anthropic) ────────────────────────────────────────────────

export const messagesProtocol: ProtocolDefinition = {
  sseHeaders: SSE_HEADERS,
  error: anthropicError,
  modelList: anthropicModelList,
  // `/v1/models` is shared with OpenAI, and Anthropic clients always send this.
  detectsOn: (headers) => headers["anthropic-version"] !== undefined,

  create(model: string): StreamingCodec {
    const stream = new AnthropicMessageStream(model);
    return {
      start: () => stream.start(),
      text: (delta) => stream.textDelta(delta),
      // Anthropic opens a block per call; the class closes the text block first.
      toolCalls: (calls) => calls.flatMap((call) => stream.toolCall(call)),
      finish: (usage) => stream.finish(usage),
      tail: "",
      failure: (message) => [
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`,
      ],
      body: (text, calls, usage) => anthropicMessage(model, text, calls, usage),
    };
  },
};

// ── responses ───────────────────────────────────────────────────────────

export const responsesProtocol: ProtocolDefinition = {
  sseHeaders: SSE_HEADERS,
  error: openAIError,
  modelList: openAIModelList,

  create(model: string): StreamingCodec {
    const stream = new ResponsesStream(model);
    return {
      start: () => stream.created(),
      text: (delta) => stream.textDelta(delta),
      toolCalls: (calls) => calls.flatMap((call) => stream.functionCall(call)),
      finish: (usage) => stream.finish(usage),
      tail: "",
      failure: (message) => [
        sse({ type: "error", message, code: "upstream_error" }),
        sse({
          type: "response.failed",
          response: { status: "failed", error: { code: "upstream_error", message } },
        }),
      ],
      body: (text, calls, usage) => responsesCompletion(model, text, calls, usage),
    };
  },
};
