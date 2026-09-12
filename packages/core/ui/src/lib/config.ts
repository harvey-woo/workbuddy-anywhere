/**
 * Runtime configuration, injected by the host that serves this bundle.
 *
 *   local server : <script>window.__WORKBUDDY__={"transport":"http","token":…}
 *   VS Code      : no injection — detected through acquireVsCodeApi
 *   Electron     : no injection — detected through the preload bridge
 *   dev (vite)   : VITE_WORKBUDDY_TOKEN, or a token pasted into localStorage
 */

export type TransportKind = "http" | "vscode" | "ipc";

export interface RuntimeConfig {
  transport: TransportKind;
  /** Bearer token for the http transport. */
  token: string;
  /** Base URL override for the http transport ("" = same origin). */
  baseUrl: string;
  version: string;
}

declare global {
  interface Window {
    __WORKBUDDY__?: Partial<RuntimeConfig>;
    acquireVsCodeApi?: () => unknown;
    workbuddy?: { invoke(method: string, params?: unknown): Promise<unknown> };
  }
}

export function runtimeConfig(): RuntimeConfig {
  const injected = window.__WORKBUDDY__;
  if (injected?.transport) {
    return {
      transport: injected.transport,
      token: injected.token ?? "",
      baseUrl: injected.baseUrl ?? "",
      version: injected.version ?? "",
    };
  }
  if (window.workbuddy?.invoke) {
    return { transport: "ipc", token: "", baseUrl: "", version: "" };
  }
  if (typeof window.acquireVsCodeApi === "function") {
    return { transport: "vscode", token: "", baseUrl: "", version: "" };
  }
  // Plain browser. In `vite dev` the API is proxied, so same-origin works; the
  // token has to come from somewhere, hence the localStorage fallback.
  return {
    transport: "http",
    token:
      (import.meta.env.VITE_WORKBUDDY_TOKEN as string | undefined) ??
      localStorage.getItem("workbuddy.token") ??
      "",
    baseUrl: (import.meta.env.VITE_WORKBUDDY_BASE as string | undefined) ?? "",
    version: "",
  };
}
