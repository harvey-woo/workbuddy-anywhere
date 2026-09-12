/**
 * OpenAI-compatible protocol mapping (/v1/*).
 *
 * Kept separate from the HTTP plumbing so the transcription rules are
 * testable and reviewable on their own: `toChatRequest` converts an incoming
 * OpenAI body into the neutral ChatRequest the engine understands, and the
 * builders turn engine events back into OpenAI JSON / SSE chunks.
 */

import type {
  ChatImage,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  ChatToolDef,
  ChatUsage,
} from "../chat/types";
import type { ModelConfig } from "../models";
import { BadRequestError, UnauthorizedError } from "../errors";

export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url?: string };
}

export interface OpenAIMessageIn {
  role?: string;
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAIChatRequestBody {
  model?: string;
  messages?: OpenAIMessageIn[];
  stream?: boolean;
  tools?: Array<{
    type?: string;
    function?: { name?: string; description?: string; parameters?: unknown };
  }>;
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface ParsedChatRequest {
  request: ChatRequest;
  /** Request knobs we deliberately do not forward to the gateway. */
  ignored: string[];
}

/**
 * Knobs accepted for client compatibility but NOT forwarded. `max_tokens` is
 * the important one: the gateway counts reasoning tokens against it and
 * TRUNCATES the stream mid-thought when a thinking model exceeds the cap —
 * verified with raw SSE probes (max_tokens=1024 → truncated; absent →
 * complete tool calls). See the engine for the full note.
 */
const IGNORED_KNOBS = [
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "n",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "seed",
  "response_format",
  "parallel_tool_calls",
];

export function toChatRequest(body: OpenAIChatRequestBody): ParsedChatRequest {
  if (!body?.model) throw new Error("`model` is required");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("`messages` must be a non-empty array");
  }

  const messages: ChatMessage[] = body.messages.map(toChatMessage);

  const tools: ChatToolDef[] = [];
  for (const t of body.tools ?? []) {
    if (!t?.function?.name) continue;
    tools.push({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters ?? { type: "object", properties: {} },
    });
  }

  const ignored = IGNORED_KNOBS.filter((k) => body[k] !== undefined);

  return {
    request: {
      model: body.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      toolMode: body.tool_choice === "required" ? "required" : "auto",
    },
    ignored,
  };
}

function toChatMessage(m: OpenAIMessageIn): ChatMessage {
  const role =
    m.role === "system"
      ? "system"
      : m.role === "assistant"
        ? "assistant"
        : m.role === "tool"
          ? "tool"
          : "user";

  if (role === "tool") {
    return {
      role,
      toolResults: [
        { callId: m.tool_call_id ?? "", text: contentToText(m.content) },
      ],
    };
  }

  const { text, images } = splitContent(m.content);
  const msg: ChatMessage = { role };
  if (text) msg.text = text;
  if (images.length > 0) msg.images = images;
  if (role === "assistant" && m.tool_calls?.length) {
    msg.toolCalls = m.tool_calls
      .filter((tc) => !!tc.function?.name)
      .map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
        name: tc.function!.name as string,
        input: parseArguments(tc.function?.arguments),
      }));
  }
  return msg;
}

function splitContent(
  content: string | OpenAIContentPart[] | null | undefined
): { text: string; images: ChatImage[] } {
  if (!content) return { text: "", images: [] };
  if (typeof content === "string") return { text: content, images: [] };

  let text = "";
  const images: ChatImage[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      text += part.text;
    } else if (part?.type === "image_url" && part.image_url?.url) {
      images.push(parseDataUrl(part.image_url.url));
    }
  }
  return { text, images };
}

/**
 * Only inline `data:` URLs are accepted. Fetching a remote URL would mean the
 * server makes an outbound request the user never asked for, so an http(s)
 * image is rejected loudly instead of being dropped silently.
 *
 * Exported because every protocol embeds images the same way, and this rule
 * should not be re-derived per surface.
 */
export function parseDataUrl(url: string): ChatImage {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!m) {
    throw new Error(
      "image_url must be an inline data: URL (data:<mime>;base64,<data>). Remote image URLs are not fetched by this server."
    );
  }
  return { mimeType: m[1], data: new Uint8Array(Buffer.from(m[2], "base64")) };
}

function contentToText(
  content: string | OpenAIContentPart[] | null | undefined
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ── Response builders ───────────────────────────────────────────────────

export function openAIModelList(models: ModelConfig[]): unknown {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created,
      owned_by: "workbuddy",
      // Non-standard extras are allowed; clients ignore unknown fields.
      display_name: m.displayName,
      context_length: m.contextLength,
      max_output_tokens: m.maxOutputTokens,
      capabilities: m.capabilities,
    })),
  };
}

export function toOpenAIToolCalls(calls: ChatToolCall[]): unknown[] {
  return calls.map((c, i) => ({
    index: i,
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
  }));
}

export function openAICompletion(
  id: string,
  model: string,
  created: number,
  text: string,
  toolCalls: ChatToolCall[],
  usage: ChatUsage | undefined
): unknown {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: {
                    name: c.name,
                    arguments: JSON.stringify(c.input ?? {}),
                  },
                })),
              }
            : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function openAIChunk(
  id: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: string | null
): unknown {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function openAIError(message: string, type: string, code?: string): unknown {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

export function newCompletionId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Map an internal failure onto an HTTP status.
 *
 * Typed errors win: they express INTENT, whereas a message regex only guesses.
 * The regexes are kept as the fallback for errors thrown elsewhere (including
 * by host hooks), not as the primary mechanism.
 *
 *   400 — the request itself is unusable;
 *   401 — the client must (re-)authenticate;
 *   409 — a deliberate local block (model group disabled);
 *   502 — anything else, i.e. the upstream gateway.
 */
export function errorStatus(err: unknown): number {
  if (err instanceof BadRequestError) return 400;
  if (err instanceof UnauthorizedError) return 401;
  const msg = err instanceof Error ? err.message : String(err);
  if (/not signed in|session expired|unauthorized/i.test(msg)) return 401;
  if (/is required|must be|not supported|unknown model/i.test(msg)) return 400;
  if (/disabled/i.test(msg)) return 409;
  return 502;
}
