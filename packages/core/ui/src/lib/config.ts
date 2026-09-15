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
  /**
   * The EXTENSION / PLUGIN version (what the sidebar header shows next to the
   * brand). Not the host application's version — see `hostVersion`.
   */
  version: string;
  /**
   * The HOST APPLICATION's version: VS Code's `version`, dsh's package
   * version. Displayed as diagnostics — "which host am I running inside".
   * Empty when the host does not disclose one.
   */
  hostVersion?: string;
  /**
   * Host-declared theme. Optional: VS Code and the OS already expose the theme
   * through the DOM / media queries, so a host only sets this when it knows
   * something those signals cannot express (e.g. dsh, which paints our iframe
   * with its own palette).
   */
  theme?: "dark" | "light";
  /**
   * Host-declared UI language. Optional for the same reason as `theme`; used
   * when the host's locale cannot be read from `documentElement.lang` (the
   * case inside an iframe, whose `lang` is our own document's, not dsh's).
   */
  locale?: "en" | "zh";
  /**
   * Optional host-provided CSS variable overrides (semicolon-separated
   * declarations like `--wb-bg:#000;--wb-text:#fff`). Applied to
   * `document.documentElement` on mount so the embedded core UI picks up the
   * host's palette. Empty / undefined = use core's built-in defaults.
   */
  cssVars?: string;
  /**
   * Per-surface visibility switches so a host that already shows a title
   * (e.g. dsh's Settings nav) can hide core's redundant chrome.
   */
  display?: { title?: boolean; subtitle?: boolean };
  /**
   * Set by a host that can take the model group in and out of its OWN model
   * picker — the VS Code extension unregisters its
   * `LanguageModelChatProvider`s, the dsh plugin withdraws its LLM routes.
   *
   * Absent means the control is not offered at all, rather than offered and
   * inert. This page also runs in hosts where flipping the flag changes nothing
   * observable (the desktop app, the standalone server), and a switch that does
   * nothing is worse than no switch — that was the state this flag replaced.
   */
  canToggleModelGroup?: boolean;
}

declare global {
  interface Window {
    __WORKBUDDY__?: Partial<RuntimeConfig>;
    acquireVsCodeApi?: () => unknown;
    workbuddy?: { invoke(method: string, params?: unknown): Promise<unknown> };
  }
}

/**
 * Whether the page is running inside the VS Code webview.
 *
 * Read from the DOM rather than from `transport`: the workbench marks `<body>`
 * with `vscode-*` classes and a `data-vscode-theme-kind` attribute, which is
 * exactly what theme resolution keys off. Nothing else paints those, so this
 * cannot mistake another host with the same transport value for VS Code.
 */
export function isVsCodeWebview(): boolean {
  const body = document.body;
  if (!body) return false;
  return (
    !!body.dataset?.vscodeThemeKind ||
    body.classList.contains("vscode-dark") ||
    body.classList.contains("vscode-light") ||
    body.classList.contains("vscode-high-contrast") ||
    body.classList.contains("vscode-high-contrast-light")
  );
}

export function runtimeConfig(): RuntimeConfig {
  const injected = window.__WORKBUDDY__;
  if (injected?.transport) {
    return {
      transport: injected.transport,
      token: injected.token ?? "",
      baseUrl: injected.baseUrl ?? "",
      version: injected.version ?? "",
      hostVersion: injected.hostVersion,
      theme: injected.theme,
      locale: injected.locale,
      cssVars: injected.cssVars,
      canToggleModelGroup: injected.canToggleModelGroup === true,
      // Default to TRUE so existing standalone / VS Code webview hosts (which
      // don't pass `display`) keep their title and subtitle. Hosts that embed
      // core into a frame with their own title (e.g. dsh's Settings nav) opt
      // out explicitly with `display: { title: false, subtitle: false }`.
      display: injected.display ?? { title: true, subtitle: true },
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
