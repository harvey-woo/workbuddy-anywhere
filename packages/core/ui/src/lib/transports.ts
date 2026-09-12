/**
 * The three transports behind one method: `call(method, params)`.
 *
 * Every transport forwards the same method names to the same service methods
 * (see src/rpc.ts), so a view never knows which host it is running in.
 *
 * Timeouts exist because a dead host must produce an error the UI can show,
 * not a spinner that never stops.
 */

import {
  RPC_CHANNEL,
  httpCallFor,
  type RpcMethod,
  type RpcReply,
} from "@core/rpc";
import { runtimeConfig } from "./config";

/** Calls older than this are failed so the UI cannot hang forever. */
const CALL_TIMEOUT_MS = 60_000;

export interface Transport {
  call(method: RpcMethod, params?: unknown): Promise<unknown>;
}

export function createTransport(): Transport {
  switch (runtimeConfig().transport) {
    case "vscode":
      return createVsCodeTransport();
    case "ipc":
      return createIpcTransport();
    default:
      return createHttpTransport();
  }
}

// ── VS Code webview: postMessage with a reply envelope ──────────────────

function createVsCodeTransport(): Transport {
  const api = window.acquireVsCodeApi?.() as
    | { postMessage(msg: unknown): void }
    | undefined;
  if (!api) throw new Error("acquireVsCodeApi() unavailable in this webview");

  let seq = 0;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(err: Error): void; timer: number }
  >();

  window.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as { channel?: string } | undefined;
    if (!msg) return;
    // Host-pushed notification (no RPC id): "state changed" — the service
    // finished a chat and refreshed billing; the webview should re-fetch.
    // Dispatched as a custom event so transports.ts does not need to know
    // which view should react.
    if (msg.channel === "stateChanged") {
      window.dispatchEvent(new CustomEvent("workbuddy:stateChanged"));
      return;
    }
    if (msg.channel !== RPC_CHANNEL) return;
    const entry = pending.get((msg as RpcReply).id);
    if (!entry) return;
    pending.delete((msg as RpcReply).id);
    clearTimeout(entry.timer);
    if ((msg as RpcReply).error) entry.reject(new Error((msg as RpcReply).error!.message));
    else entry.resolve((msg as RpcReply).result);
  });

  return {
    call(method, params) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`VS Code did not answer "${method}" within 60s`));
          }
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        api.postMessage({ channel: RPC_CHANNEL, id, method, params });
      });
    },
  };
}

// ── Electron: preload-exposed bridge ────────────────────────────────────

function createIpcTransport(): Transport {
  const bridge = window.workbuddy;
  if (!bridge) throw new Error("Electron preload bridge unavailable");
  // The host pushes state-changed notifications (billing refresh after a
  // chat, settings update). The webview dispatches them as a CustomEvent so
  // App.vue can react the same way as the VS Code transport.
  bridge.onStateChanged?.(() => {
    window.dispatchEvent(new CustomEvent("workbuddy:stateChanged"));
  });
  return {
    call: (method, params) => bridge.invoke(method, params),
  };
}

// ── Local server: the RPC table doubles as the route table ──────────────

function createHttpTransport(): Transport {
  const { token, baseUrl } = runtimeConfig();
  return {
    async call(method, params) {
      // The route -> request mapping lives in core's rpc.ts so the browser and
      // the tests cannot disagree about it. (It used to be inlined here, where
      // `body`/`pathParam` were read off `ROUTES[method].http` — an object that
      // only holds `{method, path}` — so no browser call ever sent a body.)
      const call = httpCallFor(method, params);
      if (!call) {
        throw new Error(
          `"${method}" needs a desktop host (VS Code or the Electron app) — it is not available in a plain browser.`
        );
      }
      const res = await fetch(baseUrl + call.path, {
        method: call.method,
        headers: {
          ...call.headers,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: call.body,
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (!res.ok) {
        const detail = (json as { error?: { message?: string } } | undefined)?.error
          ?.message;
        throw new Error(detail ?? `HTTP ${res.status} ${res.statusText}`);
      }
      return json;
    },
  };
}
