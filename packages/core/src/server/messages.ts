/**
 * Anthropic Messages protocol mapping (/v1/messages).
 *
 * The second of the three shapes VS Code's BYOK "custom endpoint" supports
 * (`apiType: "messages"` alongside `chat-completions` and `responses`), so any
 * Claude-API client can point at this server unchanged.
 *
 * Shape differences from OpenAI that this file exists to absorb:
 *   - the system prompt is a TOP-LEVEL field, not a message;
 *   - tool RESULTS come back inside a user message as `tool_result` blocks,
 *     while the engine wants them as their own `tool` message;
 *   - every SSE frame carries an `event:` line, and the stream is bracketed by
 *     `message_start` / `message_stop` rather than terminated by `[DONE]`.
 */

import type {
  ChatImage,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  ChatToolDef,
  ChatUsage,
} from "../chat/types";
import { BadRequestError } from "../errors";
import { randomId } from "./ids";

/**
 * One content block.
 *
 * A single shape rather than a discriminated union on purpose: `type` is
 * optional in what clients actually send, so a union would not narrow and would
 * only produce casts.
 */
interface AnthropicBlock {
  type?: string;
  text?: string;
  source?: { type?: string; media_type?: string; data?: string };
  /** `tool_use` */
  id?: string;
  name?: string;
  input?: unknown;
  /** `tool_result` */
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface AnthropicMessageBody {
  model?: string;
  system?: string | AnthropicBlock[];
  messages?: Array<{ role?: string; content?: string | AnthropicBlock[] }>;
  tools?: Array<{ name?: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type?: string; name?: string };
  stream?: boolean;
  [key: string]: unknown;
}

export interface ParsedAnthropicRequest {
  request: ChatRequest;
  /** Anthropic knobs we take for compatibility but cannot forward. */
  ignored: string[];
}

/**
 * Accepted for client compatibility but NOT forwarded.
 *
 * `max_tokens` is the important one and it is REQUIRED by Anthropic clients:
 * the gateway counts reasoning tokens against it and truncates the stream
 * mid-thought, so forwarding it would actively break thinking models.
 */
const IGNORED_KNOBS = [
  "max_tokens",
  "temperature",
  "top_p",
  "stop_sequences",
  "metadata",
  "thinking",
  "service_tier",
];

export function toAnthropicChatRequest(body: AnthropicMessageBody): ParsedAnthropicRequest {
  if (!body?.model) throw new BadRequestError("`model` is required");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BadRequestError("`messages` must be a non-empty array");
  }

  const messages: ChatMessage[] = [];

  const system = systemText(body.system);
  if (system) messages.push({ role: "system", text: system });

  for (const message of body.messages) {
    messages.push(...toMessages(message));
  }

  const tools: ChatToolDef[] = [];
  for (const tool of body.tools ?? []) {
    if (!tool?.name) continue;
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema ?? { type: "object", properties: {} },
    });
  }

  return {
    request: {
      model: body.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      // "any" and a named tool both mean "you must call one".
      toolMode: body.tool_choice?.type === "auto" ? "auto" : tools.length > 0 ? "required" : "auto",
    },
    ignored: IGNORED_KNOBS.filter((key) => body[key] !== undefined),
  };
}

/** `system` may be a string or a list of text blocks. */
function systemText(system: AnthropicMessageBody["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

/**
 * One Anthropic message can become SEVERAL engine messages: a user turn
 * carrying `tool_result` blocks is really the tool channel, and the engine
 * wants results before any text riding on the same turn (that ordering is what
 * keeps a call next to its result upstream).
 */
function toMessages(message: { role?: string; content?: string | AnthropicBlock[] }): ChatMessage[] {
  const role = message.role === "assistant" ? "assistant" : "user";
  const content = message.content;

  if (typeof content === "string") {
    return content ? [{ role, text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const textParts: string[] = [];
  const images: ChatImage[] = [];
  const toolCalls: ChatToolCall[] = [];
  const toolResults: Array<{ callId: string; text: string }> = [];

  for (const block of content) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") textParts.push(block.text);
        break;
      case "image": {
        const image = toImage(block);
        if (image) images.push(image);
        break;
      }
      case "tool_use":
        if (block.id && block.name) {
          toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
        }
        break;
      case "tool_result":
        if (block.tool_use_id) {
          toolResults.push({ callId: block.tool_use_id, text: toolResultText(block.content) });
        }
        break;
      default:
        break;
    }
  }

  const out: ChatMessage[] = [];
  if (toolResults.length > 0) out.push({ role: "tool", toolResults });

  const turn: ChatMessage = { role };
  if (textParts.length > 0) turn.text = textParts.join("");
  if (toolCalls.length > 0) turn.toolCalls = toolCalls;
  if (images.length > 0) turn.images = images;

  // A turn made purely of tool results has nothing left to add.
  if (turn.text !== undefined || turn.toolCalls || turn.images) out.push(turn);
  return out;
}

/** Only inline base64 is accepted; a remote URL would be a fetch we never asked for. */
function toImage(block: AnthropicBlock): ChatImage | undefined {
  if (block.source?.type !== "base64" || !block.source.data) return undefined;
  const mimeType = block.source.media_type ?? "image/png";
  return { mimeType, data: new Uint8Array(Buffer.from(block.source.data, "base64")) };
}

/** `tool_result.content` is a string or a list of blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: AnthropicBlock) => (typeof block?.text === "string" ? block.text : ""))
    .join("");
}

// ── Responses ───────────────────────────────────────────────────────────

/** Every Anthropic frame carries an `event:` line; `data:` alone is not enough. */
function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function usageOf(usage: ChatUsage | undefined): { input_tokens: number; output_tokens: number } {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
  };
}

/**
 * Builds the streaming response, one frame at a time.
 *
 * Content blocks are opened lazily and closed before the next one starts:
 * Anthropic addresses every delta by block INDEX, so emitting text after a tool
 * block had opened would attach it to the wrong block.
 */
export class AnthropicMessageStream {
  private readonly id = randomId("msg");
  private blockIndex = -1;
  /** Which kind of block is currently open, if any. */
  private open: "text" | "tool_use" | null = null;
  private text = "";
  /** Tool ids must round-trip: the client sends them back as `tool_use_id`. */
  private readonly toolIds: string[] = [];

  constructor(private readonly model: string) {}

  /** `message_start` opens the envelope the rest of the frames hang off. */
  start(): string[] {
    return [
      frame("message_start", {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ];
  }

  textDelta(text: string): string[] {
    const frames: string[] = [];
    if (this.open !== "text") {
      frames.push(...this.closeOpen());
      this.blockIndex += 1;
      this.open = "text";
      frames.push(
        frame("content_block_start", {
          type: "content_block_start",
          index: this.blockIndex,
          content_block: { type: "text", text: "" },
        })
      );
    }
    this.text += text;
    frames.push(
      frame("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "text_delta", text },
      })
    );
    return frames;
  }

  /**
   * A whole tool call arrives at once — the engine emits it after the text
   * stream ends — so the `input_json_delta` carries the complete JSON. That is
   * valid: `partial_json` is a fragment, not a required-to-be-partial one.
   */
  toolCall(call: ChatToolCall): string[] {
    const frames = this.closeOpen();
    this.blockIndex += 1;
    this.toolIds.push(call.id);
    const index = this.blockIndex;
    this.open = "tool_use";

    frames.push(
      frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input ?? {}) },
      })
    );
    return frames;
  }

  finish(usage: ChatUsage | undefined): string[] {
    const frames = this.closeOpen();
    frames.push(
      frame("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: this.toolIds.length > 0 ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: usageOf(usage),
      }),
      frame("message_stop", { type: "message_stop" })
    );
    return frames;
  }

  private closeOpen(): string[] {
    if (this.open === null) return [];
    const frames = [
      frame("content_block_stop", { type: "content_block_stop", index: this.blockIndex }),
    ];
    this.open = null;
    return frames;
  }
}

/** Non-streaming equivalent of the frames above. */
export function anthropicMessage(
  model: string,
  text: string,
  toolCalls: ChatToolCall[],
  usage: ChatUsage | undefined
): unknown {
  const content: unknown[] = [];
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} });
  }

  return {
    id: randomId("msg"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: usageOf(usage),
  };
}

/**
 * Anthropic errors are `{"type":"error","error":{...}}` — NOT the OpenAI
 * envelope, and a client that gets the wrong one reports "unparseable
 * response" instead of the real message.
 */
export function anthropicError(message: string, type = "api_error"): unknown {
  return { type: "error", error: { type, message } };
}

/**
 * `/v1/models` is shared with the OpenAI surface, so the shape is chosen by
 * the request: an Anthropic client always sends `anthropic-version`.
 */
export function anthropicModelList(models: Array<{ id: string; displayName: string }>): unknown {
  const data = models.map((model) => ({
    type: "model",
    id: model.id,
    display_name: model.displayName,
    created_at: new Date(0).toISOString(),
  }));
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}
