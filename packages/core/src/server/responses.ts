/**
 * OpenAI Responses protocol mapping (/v1/responses).
 *
 * The third shape VS Code's BYOK "custom endpoint" supports (`apiType:
 * "responses"`). It is NOT Chat Completions with a different URL: the request
 * carries `input` items instead of `messages`, tools are flat instead of nested
 * under `function`, and the stream is a sequence of NAMED events describing an
 * object being built, rather than deltas into a choices array.
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
import { parseDataUrl } from "./openai";

type ContentPart = { type?: string; text?: string; image_url?: string | { url?: string } };

/**
 * One `input` item.
 *
 * A single shape rather than a union of the three item types: `type` is
 * optional in what clients actually send, so a union would never narrow and
 * would only produce casts.
 */
interface InputItem {
  type?: string;
  /** `message` */
  role?: string;
  content?: string | ContentPart[];
  /** `function_call` */
  call_id?: string;
  name?: string;
  arguments?: string;
  /** `function_call_output` */
  output?: unknown;
}

export interface ResponsesBody {
  model?: string;
  input?: string | InputItem[];
  instructions?: string;
  tools?: Array<{
    type?: string;
    name?: string;
    description?: string;
    parameters?: unknown;
  }>;
  tool_choice?: unknown;
  stream?: boolean;
  [key: string]: unknown;
}

export interface ParsedResponsesRequest {
  request: ChatRequest;
  /** Knobs accepted for compatibility but deliberately not forwarded. */
  ignored: string[];
}

/** Same reasoning as the Chat Completions surface: see `openai.ts`. */
const IGNORED_KNOBS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "reasoning",
  "store",
  "previous_response_id",
  "include",
  "truncation",
  "metadata",
  "parallel_tool_calls",
  "stream_options",
];

export function toResponsesChatRequest(body: ResponsesBody): ParsedResponsesRequest {
  if (!body?.model) throw new BadRequestError("`model` is required");

  const messages: ChatMessage[] = [];
  if (body.instructions) messages.push({ role: "system", text: body.instructions });

  if (typeof body.input === "string") {
    if (body.input) messages.push({ role: "user", text: body.input });
  } else if (Array.isArray(body.input)) {
    messages.push(...toMessages(body.input));
  }

  if (messages.length === 0) {
    throw new BadRequestError("`input` must contain at least one message");
  }

  const tools: ChatToolDef[] = [];
  for (const tool of body.tools ?? []) {
    if (!tool?.name) continue;
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters ?? { type: "object", properties: {} },
    });
  }

  return {
    request: {
      model: body.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      toolMode: body.tool_choice === "required" ? "required" : "auto",
    },
    ignored: IGNORED_KNOBS.filter((key) => body[key] !== undefined),
  };
}

/**
 * Flatten `input` items onto the engine's message list.
 *
 * Consecutive `function_call` items are MERGED into one assistant message: the
 * engine's ordering rules assume a single assistant turn issuing all of its
 * calls, and splitting them into one message per call produces consecutive
 * assistant messages that hide the call/result pairing upstream.
 */
function toMessages(input: InputItem[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pendingCalls: ChatToolCall[] = [];

  const flushCalls = (): void => {
    if (pendingCalls.length === 0) return;
    out.push({ role: "assistant", text: "", toolCalls: pendingCalls });
    pendingCalls = [];
  };

  for (const item of input) {
    if (item.type === "function_call") {
      pendingCalls.push({
        id: item.call_id ?? randomId("call"),
        name: item.name ?? "",
        input: parseArguments(item.arguments),
      });
      continue;
    }
    flushCalls();

    if (item.type === "function_call_output") {
      out.push({
        role: "tool",
        toolResults: [{ callId: item.call_id ?? "", text: outputText(item.output) }],
      });
      continue;
    }

    // Anything else is a message item. `type` is optional in practice, so role
    // is the real discriminator.
    const role = item.role === "assistant" ? "assistant" : item.role === "developer" || item.role === "system" ? "system" : "user";
    const { text, images } = splitContent(item.content);
    const message: ChatMessage = { role };
    if (text) message.text = text;
    if (images.length > 0) message.images = images;
    if (message.text !== undefined || message.images) out.push(message);
  }

  flushCalls();
  return out;
}

function splitContent(content: string | ContentPart[] | undefined): {
  text: string;
  images: ChatImage[];
} {
  if (!content) return { text: "", images: [] };
  if (typeof content === "string") return { text: content, images: [] };

  let text = "";
  const images: ChatImage[] = [];
  for (const part of content) {
    if (typeof part?.text === "string" && (part.type === "input_text" || part.type === "output_text" || part.type === undefined)) {
      text += part.text;
    } else if (part?.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) images.push(parseDataUrl(url));
    }
  }
  return { text, images };
}

/** `arguments` is a JSON string; a malformed one must not kill the request. */
function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** `output` may be a string or an array of content parts. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .map((part: ContentPart) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

// ── Responses ───────────────────────────────────────────────────────────

function frame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}\n\n`;
}

function usageOf(usage: ChatUsage | undefined): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return { input_tokens: input, output_tokens: output, total_tokens: usage?.total_tokens ?? input + output };
}

/**
 * Builds the streamed response.
 *
 * The protocol describes an OBJECT BEING BUILT, so every frame carries a
 * `sequence_number` and the item/part it belongs to. Output items are closed
 * before the next one opens — a client that tracks `output_index` would
 * otherwise attach deltas to the wrong item.
 */
export class ResponsesStream {
  private readonly id = randomId("resp");
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private sequence = 0;
  private outputIndex = -1;
  private open: {
    index: number;
    id: string;
    kind: "message" | "function_call";
    callId?: string;
    name?: string;
    args?: string;
  } | null = null;
  private text = "";
  private readonly output: unknown[] = [];

  constructor(private readonly model: string) {}

  created(): string[] {
    return [
      frame("response.created", {
        sequence_number: this.sequence++,
        response: this.envelope("in_progress"),
      }),
      frame("response.in_progress", {
        sequence_number: this.sequence++,
        response: this.envelope("in_progress"),
      }),
    ];
  }

  textDelta(text: string): string[] {
    const frames: string[] = [];
    if (this.open?.kind !== "message") {
      frames.push(...this.closeOpen());
      const index = ++this.outputIndex;
      const id = randomId("msg");
      this.open = { index, id, kind: "message" };
      frames.push(
        frame("response.output_item.added", {
          sequence_number: this.sequence++,
          output_index: index,
          item: { id, type: "message", status: "in_progress", role: "assistant", content: [] },
        }),
        frame("response.content_part.added", {
          sequence_number: this.sequence++,
          item_id: id,
          output_index: index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        })
      );
    }
    this.text += text;
    frames.push(
      frame("response.output_text.delta", {
        sequence_number: this.sequence++,
        item_id: this.open.id,
        output_index: this.open.index,
        content_index: 0,
        delta: text,
      })
    );
    return frames;
  }

  /**
   * Whole calls arrive at once (the engine emits them after the text stream),
   * so the arguments delta carries the complete JSON — `delta` is a fragment
   * slot, not a requirement to be partial.
   */
  functionCall(call: ChatToolCall): string[] {
    const frames = this.closeOpen();
    const index = ++this.outputIndex;
    const id = randomId("fc");
    const args = JSON.stringify(call.input ?? {});
    this.open = { index, id, kind: "function_call", callId: call.id, name: call.name, args };

    frames.push(
      frame("response.output_item.added", {
        sequence_number: this.sequence++,
        output_index: index,
        item: {
          id,
          type: "function_call",
          status: "in_progress",
          call_id: call.id,
          name: call.name,
          arguments: "",
        },
      }),
      frame("response.function_call_arguments.delta", {
        sequence_number: this.sequence++,
        item_id: id,
        output_index: index,
        delta: args,
      }),
      frame("response.function_call_arguments.done", {
        sequence_number: this.sequence++,
        item_id: id,
        output_index: index,
        arguments: args,
      })
    );
    return frames;
  }

  finish(usage: ChatUsage | undefined): string[] {
    const frames = this.closeOpen();
    frames.push(
      frame("response.completed", {
        sequence_number: this.sequence++,
        response: { ...this.envelope("completed"), usage: usageOf(usage) },
      })
    );
    return frames;
  }

  /** Close the open item, publishing it into `output` for the final envelope. */
  private closeOpen(): string[] {
    const open = this.open;
    if (!open) return [];
    this.open = null;

    const frames: string[] = [];
    let item: Record<string, unknown>;

    if (open.kind === "message") {
      item = {
        id: open.id,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: this.text, annotations: [] }],
      };
      frames.push(
        frame("response.output_text.done", {
          sequence_number: this.sequence++,
          item_id: open.id,
          output_index: open.index,
          content_index: 0,
          text: this.text,
        }),
        frame("response.content_part.done", {
          sequence_number: this.sequence++,
          item_id: open.id,
          output_index: open.index,
          content_index: 0,
          part: { type: "output_text", text: this.text, annotations: [] },
        })
      );
      this.text = "";
    } else {
      item = {
        id: open.id,
        type: "function_call",
        status: "completed",
        call_id: open.callId,
        name: open.name,
        arguments: open.args ?? "{}",
      };
    }

    this.output[open.index] = item;
    frames.push(
      frame("response.output_item.done", {
        sequence_number: this.sequence++,
        output_index: open.index,
        item,
      })
    );
    return frames;
  }

  /** The response object every envelope and the final event share. */
  private envelope(status: "in_progress" | "completed"): Record<string, unknown> {
    return {
      id: this.id,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model,
      output: status === "completed" ? this.output : [],
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      temperature: null,
      top_p: null,
      max_output_tokens: null,
      previous_response_id: null,
      usage: null,
    };
  }
}

/** Non-streaming equivalent: one response object with every item already in it. */
export function responsesCompletion(
  model: string,
  text: string,
  toolCalls: ChatToolCall[],
  usage: ChatUsage | undefined
): unknown {
  const output: unknown[] = [];
  if (text) {
    output.push({
      id: randomId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const call of toolCalls) {
    output.push({
      id: randomId("fc"),
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input ?? {}),
    });
  }

  return {
    id: randomId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    previous_response_id: null,
    usage: usageOf(usage),
  };
}
