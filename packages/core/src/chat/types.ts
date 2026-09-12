/**
 * Host-agnostic chat types.
 *
 * `ChatMessage` deliberately mirrors VS Code's content-part buckets
 * one-to-one (text / toolCalls / toolResults / images) instead of using a
 * flatter shape: the mapping to the OpenAI payload is ORDER SENSITIVE
 * (assistant text merging, tool-result ordering, orphaned-call mending) and
 * a lossy intermediate format silently changes what the gateway sees.
 */

import type { WorkbuddyAuth } from "../auth";
import type { ModelConfig } from "../models";
import type { Settings } from "../settings";

export interface ChatToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool input; sanitized before it reaches the API. */
  inputSchema: unknown;
}

export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatImage {
  mimeType: string;
  data: Uint8Array;
}

export interface ChatMessage {
  /**
   * "system" is passed through untouched — the OpenAI-compatible surface needs
   * it, while VS Code folds its system prompt into the first user message.
   */
  role: "system" | "user" | "assistant" | "tool";
  text?: string;
  toolCalls?: ChatToolCall[];
  toolResults?: Array<{ callId: string; text: string }>;
  images?: ChatImage[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  /** "required" maps to OpenAI's tool_choice:"required". */
  toolMode?: "auto" | "required";
  /** Per-model settings coming from the host's model configuration UI. */
  modelConfiguration?: Record<string, unknown>;
  /**
   * Which cluster the request must hit. Set by the server from the URL:
   * `/v1/...` -> `"cn"`, `/intl/v1/...` -> `"intl"`. Omitted means "follow
   * the active account's region" — the historical behaviour.
   */
  region?: "cn" | "intl";
  /**
   * Identifies the conversation for account stickiness under auto-select
   * (session affinity). Hosts that know their session pass it (HTTP server:
   * session headers / the OpenAI `user` field); hosts that cannot (VS Code's
   * LM provider has no session id) omit it and share a per-region idle window
   * — consecutive requests within the window stay on one account.
   */
  sessionKey?: string;
}

/** Token accounting as reported by the gateway's final usage frame. */
export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Everything the engine can emit. Text arrives in stream order. */
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "toolCall"; call: ChatToolCall }
  | { type: "usage"; usage: ChatUsage };

export interface ChatContext {
  auth: WorkbuddyAuth;
  /** Known model catalog — used for capability + reasoning-effort resolution. */
  models: ModelConfig[];
  settings: Settings;
  log?: (msg: string) => void;
  /**
   * Image-description resolver, injected by the service.
   *
   * Called only for models with `capabilities.imageInput === false`, and only
   * because the service always has somewhere to send the image: core's own
   * catalog model. A host may contribute an override on top. Returning null
   * means "nobody could describe this" and the image stays inline.
   */
  describeImage?: (image: ChatImage) => Promise<string | null>;
  signal?: AbortSignal;
}
