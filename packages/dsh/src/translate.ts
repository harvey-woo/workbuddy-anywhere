/**
 * Translate between DeepSeek Harness (dsh) stream/message vocabulary and the
 * host-neutral chat vocabulary of `@wbaw/core`.
 *
 * dsh drives adapters through `StreamChunk` (block-start / *-delta /
 * block-end / usage / finish) and `Message` (role + content blocks). wbaw's
 * `chat/engine` consumes `ChatMessage` (role + text/toolCalls/toolResults/
 * images) and emits `ChatEvent` (text / toolCall / usage). This module is the
 * only place that knows both shapes — mirroring how copilot's provider.ts is
 * the only VS Code-aware layer.
 */

import * as fs from "node:fs";
import type {
  ContentBlock,
  Message,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from "@deepseek-ai/dsh-llm";
import type {
  ChatImage,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  ChatToolDef,
  ChatEvent,
} from "@wbaw/core";

/** Minimal view of a dsh image attachment ref we can materialise locally. */
interface LocalImageAttachment {
  bytes?: Uint8Array;
  path?: string;
  mimeType?: string;
}

/**
 * dsh carries images as durable attachment refs; wbaw needs raw bytes. We can
 * read bytes directly when the ref exposes them (the common local case), and
 * degrade silently otherwise — matching copilot, which falls back to core's
 * built-in vision helper when the host cannot hand over an image.
 */
function resolveImage(attachment: unknown): ChatImage | undefined {
  const ref = attachment as LocalImageAttachment | undefined;
  if (!ref) return undefined;
  try {
    if (ref.bytes) {
      return { mimeType: ref.mimeType || "image/png", data: ref.bytes };
    }
    if (ref.path) {
      return { mimeType: ref.mimeType || "image/png", data: fs.readFileSync(ref.path) };
    }
  } catch {
    // Degrade: a single unreadable image must not break the whole request.
  }
  return undefined;
}

function safeParseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Map a dsh conversation (`Message[]`) into wbaw's `ChatMessage[]`. */
export function toWbawMessages(messages: readonly Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const msg: ChatMessage = { role: m.role as ChatMessage["role"] };
    let text = "";
    const toolCalls: ChatToolCall[] = [];
    const toolResults: Array<{ callId: string; text: string }> = [];
    const images: ChatImage[] = [];

    for (const block of m.content as readonly ContentBlock[]) {
      switch (block.type) {
        case "text":
          text += block.text;
          break;
        // Reasoning is server-side for wbaw (thinking_effort), so it is never
        // sent back to the gateway as request history.
        case "reasoning":
          break;
        case "tool-call":
          toolCalls.push({
            id: String(block.id),
            name: block.name,
            input: safeParseArguments(block.arguments),
          });
          break;
        case "tool-result": {
          const t = block.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("");
          toolResults.push({ callId: String(block.toolCallId), text: t });
          break;
        }
        case "image": {
          const img = resolveImage(block.attachment);
          if (img) images.push(img);
          break;
        }
        default:
          break;
      }
    }

    if (text) msg.text = text;
    if (toolCalls.length) msg.toolCalls = toolCalls;
    if (toolResults.length) msg.toolResults = toolResults;
    if (images.length) msg.images = images;
    out.push(msg);
  }
  return out;
}

/** Map a dsh `ToolSchema` into wbaw's `ChatToolDef`. */
export function toToolDef(t: ToolSchema): ChatToolDef {
  return { name: t.name, description: t.description, inputSchema: t.parameters };
}

/**
 * Translate wbaw `ChatEvent`s into dsh `StreamChunk`s.
 *
 * Protocol obligations honoured:
 *  - every content block is opened with `block-start`, fed deltas, closed with
 *    `block-end`, REUSING THE BLOCK INDEX for every delta of that block;
 *  - `usage` is buffered and emitted immediately BEFORE `finish`;
 *  - nothing is emitted after `finish`.
 *
 * The earlier version of this function incremented `index` per text event,
 * which broke chat rendering: each `core` text delta arrived as its own
 * 3-chunk trio (block-start + delta + block-end) with a fresh index, so a
 * long answer arrived as dozens of one-line blocks and the chat UI displayed
 * it as paragraphs of one word each. dsh's `AssistantStreamAttempt` correctly
 * folds same-index deltas into a single block, so the fix is to keep a
 * stable text-block index for the whole text phase and emit block-end only
 * once the stream (or a non-text event) closes that phase.
 */
export async function* toStreamChunks(
  events: AsyncIterable<ChatEvent>
): AsyncGenerator<StreamChunk> {
  let index = 0;
  let usage: TokenUsage | undefined;
  // True while we have an open text block whose deltas we are forwarding.
  // We open the block lazily on the first text event of a phase and close
  // it when the phase ends (a toolCall arrives, or the stream finishes).
  let textOpen = false;
  let textBuf = "";
  let textIndex = -1;

  const closeText = function* (): Generator<StreamChunk, void, void> {
    if (!textOpen) return;
    yield {
      type: "block-end",
      index: textIndex,
      block: { type: "text", text: textBuf },
    } as StreamChunk;
    textOpen = false;
    textBuf = "";
    textIndex = -1;
  };

  for await (const ev of events) {
    if (ev.type === "text") {
      if (!textOpen) {
        textIndex = index++;
        yield {
          type: "block-start",
          index: textIndex,
          blockType: "text",
        } as StreamChunk;
        textOpen = true;
        textBuf = "";
      }
      textBuf += ev.text;
      yield {
        type: "text-delta",
        index: textIndex,
        text: ev.text,
      } as StreamChunk;
    } else if (ev.type === "toolCall") {
      // A tool call cannot live inside the same block as a text delta —
      // close any open text block first so the assembler sees a clean
      // block-end / block-start boundary.
      yield* closeText();
      const i = index++;
      const args = JSON.stringify(ev.call.input ?? {});
      const id = ev.call.id as never;
      yield {
        type: "block-start",
        index: i,
        blockType: "tool-call",
      } as StreamChunk;
      yield {
        type: "tool-call-delta",
        index: i,
        id,
        name: ev.call.name,
        argumentsDelta: args,
      } as StreamChunk;
      yield {
        type: "block-end",
        index: i,
        block: { type: "tool-call", id, name: ev.call.name, arguments: args },
      } as StreamChunk;
    } else if (ev.type === "usage") {
      // Buffer; flushed once, right before finish.
      usage = {
        inputTokens: ev.usage.prompt_tokens ?? 0,
        outputTokens: ev.usage.completion_tokens ?? 0,
      };
    }
  }

  yield* closeText();
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: { kind: "stop" } };
}
