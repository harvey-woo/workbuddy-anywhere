/**
 * OpenAPI 3.1 description of the local API.
 *
 * Two surfaces in one document:
 *   /v1/*   OpenAI-compatible — point Cline / Continue / any OpenAI client at
 *           http://127.0.0.1:<port>/v1. Hand-written, because it mirrors a
 *           foreign spec rather than our own surface.
 *   /api/*  The bundled web UI's own API. Its paths, verbs and summaries are
 *           DERIVED from RPC_ROUTES (rpc.ts) — the same table the UI's http
 *           transport uses — so a route can never be documented at a path it
 *           is not served at.
 */

import { RPC_METHODS, RPC_ROUTES, type RpcMethod } from "../rpc";

export const DEFAULT_PORT = 8787;

/**
 * NOTE: there is deliberately NO `?account=` parameter. The account key goes in
 * the standard Authorization bearer slot, which every OpenAI-compatible client
 * already exposes as its "API key" field. A second way to say the same thing
 * would only add a precedence rule to get wrong.
 */

/** Response schema per /api method (a trailing [] means an array of it). */
const RESPONSE_SCHEMA: Partial<Record<RpcMethod, string>> = {
  getState: "ServiceState",
  startLogin: "LoginStart",
  pollLogin: "LoginPoll",
  getUsage: "UsageSnapshot",
  refreshAllUsage: "ServiceState",
  checkin: "CheckinResult",
  getModels: "ModelInfo[]",
  refreshModels: "ModelInfo[]",
  addCustomModel: "ModelInfo[]",
  removeCustomModel: "ModelInfo[]",
  getSettings: "Settings",
  updateSettings: "Settings",
  listVisionModels: "VisionModels",
};

/** Request body schema per /api method that takes one. */
const REQUEST_SCHEMA: Partial<Record<RpcMethod, string>> = {
  addCustomModel: "CustomModelInput",
  updateSettings: "Settings",
};

/**
 * RPC_ROUTES uses Express-style ":id"; the OpenAPI spec mandates "{id}".
 * Only the documentation form is rewritten — the served path keeps ":id".
 */
function toSpecPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

export function openApiDocument(version: string): Record<string, unknown> {
  const ref = (name: string): Record<string, unknown> =>
    name.endsWith("[]")
      ? {
          type: "array",
          items: { $ref: `#/components/schemas/${name.slice(0, -2)}` },
        }
      : { $ref: `#/components/schemas/${name}` };

  const json = (name: string) => ({
    "application/json": { schema: ref(name) },
  });

  // /api/* — generated from the RPC table so the documented path is always the
  // served path.
  const apiPaths: Record<string, Record<string, unknown>> = {};
  for (const key of RPC_METHODS) {
    const route = RPC_ROUTES[key];
    if (!route.http) continue;
    const operation: Record<string, unknown> = {
      tags: ["UI"],
      operationId: key,
      summary: route.summary,
    };
    if (route.pathParam) {
      operation.parameters = [
        {
          name: route.pathParam,
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ];
    }
    const requestName = REQUEST_SCHEMA[key];
    if (route.body && requestName) {
      operation.requestBody = { required: true, content: json(requestName) };
    }
    const responseName = RESPONSE_SCHEMA[key];
    operation.responses = {
      200: {
        description: "OK",
        ...(responseName ? { content: json(responseName) } : {}),
      },
      401: { description: "No usable session for the selected account", content: json("Error") },
    };
    const entry = (apiPaths[toSpecPath(route.http.path)] ??= {});
    entry[route.http.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "WorkBuddy Anywhere API",
      version,
      description: [
        "Local API in front of the WorkBuddy gateway (two regions: China and global).",
        "",
        "**Three chat protocols are served** — the same three `apiType` values VS Code's",
        "BYOK custom endpoints accept, so any of those clients works unchanged:",
        "",
        "| Protocol | Endpoint | Account marker |",
        "| --- | --- | --- |",
        "| OpenAI Chat Completions | `POST /v1/chat/completions` (CN) / `POST /intl/v1/chat/completions` (INTL) | `Authorization: Bearer` |",
        "| Anthropic Messages | `POST /v1/messages` (CN) / `POST /intl/v1/messages` (INTL) | `x-api-key` |",
        "| OpenAI Responses | `POST /v1/responses` (CN) / `POST /intl/v1/responses` (INTL) | `Authorization: Bearer` |",
        "",
        `Point the client at \`http://127.0.0.1:${DEFAULT_PORT}\`; no API key secret is needed.`,
        "",
        "**The bare `/v1/...` paths land on CN, the `/intl/v1/...` paths land on the international**",
        "cluster. The same bearer token is sent on either path; the service picks an account",
        "in the matching region (or falls back to the active account if that region has no",
        "session). Picking a region is therefore purely a client-side decision: switch the base",
        "URL prefix and the rest of the call stays the same.",
        "",
        "**`/api/*` is the bundled web UI's own API** and mirrors the shared service façade.",
        "Region-scoped endpoints live at `/api/cn/...` and `/api/intl/...`; non-region endpoints",
        "(`/api/accounts/...`, `/api/usage/...`, `/api/settings/...`, etc.) stay unprefixed and",
        "operate on the account marker, not on a region.",
        "",
        "### Selecting an account",
        "This server HOSTS the signed-in accounts, so there is no authorization:",
        "a caller is not proving an identity, it is choosing whose quota to spend.",
        "",
        "Send the account `key` (from `GET /api/state` → `accounts[].key`) as the",
        "**bearer token** — that is the standard slot, so a client's ordinary",
        "\"API key\" field is all it takes. Omitting it uses the currently selected",
        "account. An unknown key returns 400.",
        "",
        "Request knobs accepted but NOT forwarded upstream: " +
          "`max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `n`, `stop`, " +
          "`presence_penalty`, `frequency_penalty`, `logit_bias`, `seed`, `response_format`, " +
          "`parallel_tool_calls`. The gateway counts reasoning tokens against `max_tokens` and " +
          "truncates the stream mid-thought when a thinking model exceeds it, so the value is " +
          "dropped and reported in the server log rather than silently changing behaviour.",
      ].join("\n"),
    },
    servers: [
      {
        url: `http://127.0.0.1:${DEFAULT_PORT}`,
        description: "Local server (default bind: 127.0.0.1)",
      },
    ],
    // Optional on purpose: an empty requirement means "no auth is needed".
    // `bearerAuth` only applies when the server was started with `--token`.
    security: [{}, { bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Send an ACCOUNT KEY here. It is a selector, not a secret — and this is the only " +
            "credential most OpenAI-compatible clients ask for. Valid values come from " +
            "`GET /api/state` → `accounts[].key`.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                message: { type: "string" },
                type: { type: "string" },
                code: { type: "string" },
              },
              required: ["message", "type"],
            },
          },
          required: ["error"],
        },
        ModelCapabilities: {
          type: "object",
          properties: {
            toolCalling: { type: "boolean" },
            imageInput: { type: "boolean" },
            reasoning: { type: "boolean" },
          },
        },
        ModelInfo: {
          type: "object",
          properties: {
            id: { type: "string" },
            displayName: { type: "string" },
            contextLength: { type: "integer" },
            maxOutputTokens: { type: "integer" },
            family: { type: "string" },
            capabilities: { $ref: "#/components/schemas/ModelCapabilities" },
            credits: { type: "string" },
          },
          required: ["id", "displayName", "contextLength", "capabilities"],
        },
        Settings: {
          type: "object",
          properties: {
            thinkingEffort: {
              type: "string",
              enum: ["auto", "low", "medium", "high", "off"],
            },
            visionFallbackModel: {
              type: "string",
              description:
                "Model id used to describe images for chat models that cannot accept " +
                "them. It names a model reported by `GET /api/settings/vision/models`; " +
                "empty = the first candidate.",
            },
            customModels: {
              type: "array",
              items: { $ref: "#/components/schemas/CustomModelInput" },
            },
            enabled: { type: "boolean" },
            autoSelectAccount: {
              type: "boolean",
              description:
                "Allocate accounts automatically per request (quota- and " +
                "expiry-aware, sticky per session for ~30 minutes of activity). " +
                "An explicit account marker still wins; off = the manually " +
                "selected account serves everything.",
            },
          },
        },
        CustomModelInput: {
          type: "object",
          properties: {
            id: { type: "string" },
            displayName: { type: "string" },
          },
          required: ["id"],
        },
        VisionModels: {
          type: "object",
          properties: {
            sources: {
              type: "array",
              items: { type: "string" },
              description:
                "Human labels for the sources represented below, in resolution order.",
            },
            models: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  source: { type: "string" },
                },
                required: ["id", "label", "source"],
              },
            },
          },
          required: ["sources", "models"],
        },
        ServiceState: {
          type: "object",
          properties: {
            loggedIn: { type: "boolean" },
            nickname: { type: "string" },
            uid: { type: "string" },
            enterpriseId: { type: "string" },
            expiresAt: { type: "integer", description: "epoch ms" },
            settings: { $ref: "#/components/schemas/Settings" },
            models: {
              type: "array",
              items: { $ref: "#/components/schemas/ModelInfo" },
            },
            modelsSource: {
              type: "string",
              enum: ["auth", "anonymous", "none"],
              description: "anonymous = public catalog served before sign-in",
            },
            usage: {
              type: "object",
              properties: {
                percent: { type: "number" },
                remain: { type: "number" },
                size: { type: "number" },
              },
            },
          },
          required: ["loggedIn", "settings", "models"],
        },
        LoginStart: {
          type: "object",
          properties: {
            state: { type: "string" },
            authUrl: { type: "string" },
            expiresInMs: { type: "integer" },
            pollIntervalMs: { type: "integer" },
          },
          required: ["state", "authUrl", "expiresInMs", "pollIntervalMs"],
        },
        LoginPoll: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["pending", "success", "expired"] },
            nickname: { type: "string" },
            uid: { type: "string" },
            checkin: { $ref: "#/components/schemas/CheckinResult" },
          },
          required: ["status"],
        },
        BillingAccount: {
          type: "object",
          properties: {
            accountId: { type: "integer" },
            packageName: { type: "string" },
            packageCode: { type: "string" },
            capacityRemain: { type: "number" },
            capacitySize: { type: "number" },
            cycleCapacityRemain: { type: "number" },
            cycleCapacitySize: { type: "number" },
            cycleEndTime: { type: "string" },
            status: { type: "integer" },
          },
        },
        BillingResult: {
          type: "object",
          properties: {
            totalRemain: { type: "number" },
            totalSize: { type: "number" },
            accounts: {
              type: "array",
              items: { $ref: "#/components/schemas/BillingAccount" },
            },
          },
          required: ["totalRemain", "totalSize", "accounts"],
        },
        CheckinResult: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["claimed", "unclaimed", "unknown"] },
            credit: { type: "number" },
            freshlyClaimed: { type: "boolean" },
            error: { type: "string" },
          },
          required: ["state"],
        },
        UsageSnapshot: {
          type: "object",
          properties: {
            billing: { $ref: "#/components/schemas/BillingResult" },
            checkin: { $ref: "#/components/schemas/CheckinResult" },
          },
          required: ["billing", "checkin"],
        },
      },
    },
    paths: {
      ...apiPaths,
      "/v1/models": {
        get: {
          tags: ["OpenAI"],
          summary: "List available models (OpenAI-compatible)",
          responses: {
            200: {
              description: "Model list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      object: { type: "string" },
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            object: { type: "string" },
                            created: { type: "integer" },
                            owned_by: { type: "string" },
                            context_length: { type: "integer" },
                            capabilities: {
                              $ref: "#/components/schemas/ModelCapabilities",
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            401: { description: "No usable session for the selected account", content: json("Error") },
          },
        },
      },
      "/v1/chat/completions": {
        post: {
          tags: ["OpenAI"],
          summary: "Chat completion — streaming and non-streaming, tool calls",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    messages: {
                      type: "array",
                      items: { type: "object", additionalProperties: true },
                      description:
                        "OpenAI chat messages. Image parts must use inline data: URLs.",
                    },
                    stream: { type: "boolean", default: false },
                    tools: { type: "array", items: { type: "object" } },
                    tool_choice: {
                      description: '"required" is forwarded as tool_choice=required',
                    },
                  },
                  required: ["model", "messages"],
                },
              },
            },
          },
          responses: {
            200: {
              description:
                "chat.completion, or a text/event-stream of chat.completion.chunk when stream=true",
              content: {
                "application/json": { schema: { type: "object" } },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            400: { description: "Malformed request", content: json("Error") },
            401: {
              description: "Not signed in to WorkBuddy",
              content: json("Error"),
            },
            409: {
              description: "Model group disabled locally",
              content: json("Error"),
            },
            502: { description: "Upstream gateway error", content: json("Error") },
          },
        },
      },
      "/intl/v1/chat/completions": {
        post: {
          tags: ["OpenAI"],
          summary: "Chat completion — international cluster",
          description:
            "Same contract as `/v1/chat/completions` but routed to the international gateway. " +
            "An account key from the INTL region is required; CN accounts are not available here.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    messages: { type: "array", items: { type: "object", additionalProperties: true } },
                    stream: { type: "boolean", default: false },
                    tools: { type: "array", items: { type: "object" } },
                  },
                  required: ["model", "messages"],
                },
              },
            },
          },
          responses: {
            200: { description: "Same as /v1/chat/completions" },
            400: { description: "Malformed request", content: json("Error") },
            401: { description: "No INTL account", content: json("Error") },
            502: { description: "Upstream gateway error", content: json("Error") },
          },
        },
      },
      "/v1/messages": {
        post: {
          tags: ["Anthropic"],
          summary: "Anthropic Messages — streaming and non-streaming",
          description:
            "Anthropic-compatible endpoint. Send the account key as `x-api-key` " +
            "(or `Authorization: Bearer`). The `anthropic-version` header is accepted " +
            "but ignored — the gateway handles version negotiation.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    messages: { type: "array", items: { type: "object", additionalProperties: true } },
                    max_tokens: { type: "integer", description: "Required by Anthropic. Capped by the gateway if the model's limit is lower." },
                    stream: { type: "boolean", default: false },
                    tools: { type: "array", items: { type: "object" } },
                  },
                  required: ["model", "messages", "max_tokens"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "Anthropic message, or text/event-stream when stream=true",
              content: {
                "application/json": { schema: { type: "object" } },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            400: { description: "Malformed request", content: json("Error") },
            401: { description: "Not signed in to WorkBuddy", content: json("Error") },
            502: { description: "Upstream gateway error", content: json("Error") },
          },
        },
      },
      "/intl/v1/messages": {
        post: {
          tags: ["Anthropic"],
          summary: "Anthropic Messages — international cluster",
          description: "Same contract as `/v1/messages` but routed to the international gateway.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    messages: { type: "array", items: { type: "object", additionalProperties: true } },
                    max_tokens: { type: "integer" },
                    stream: { type: "boolean", default: false },
                  },
                  required: ["model", "messages", "max_tokens"],
                },
              },
            },
          },
          responses: {
            200: { description: "Same as /v1/messages" },
            400: { description: "Malformed request", content: json("Error") },
            502: { description: "Upstream gateway error", content: json("Error") },
          },
        },
      },
      "/v1/responses": {
        post: {
          tags: ["OpenAI"],
          summary: "OpenAI Responses — streaming and non-streaming",
          description:
            "OpenAI Responses API endpoint (the newer API surface). " +
            "Compatible with clients that target the Responses API instead of Chat Completions.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    input: {
                      description:
                        "String or array of input items (same shape as OpenAI Responses API).",
                    },
                    stream: { type: "boolean", default: false },
                    tools: { type: "array", items: { type: "object" } },
                  },
                  required: ["model", "input"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "Response object, or text/event-stream when stream=true",
              content: {
                "application/json": { schema: { type: "object" } },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            400: { description: "Malformed request", content: json("Error") },
            401: { description: "Not signed in to WorkBuddy", content: json("Error") },
            502: { description: "Upstream gateway error", content: json("Error") },
          },
        },
      },
      "/intl/v1/responses": {
        post: {
          tags: ["OpenAI"],
          summary: "OpenAI Responses — international cluster",
          description: "Same contract as `/v1/responses` but routed to the international gateway.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    input: { description: "String or array of input items." },
                    stream: { type: "boolean", default: false },
                    tools: { type: "array", items: { type: "object" } },
                  },
                  required: ["model", "input"],
                },
              },
            },
          },
          responses: {
            200: { description: "Same as /v1/responses" },
            400: { description: "Malformed request", content: json("Error") },
            502: { description: "Upstream gateway error", content: json("Error") },
          },
        },
      },
    },
  };
}
