/**
 * Handing runtime configuration to the shared UI.
 *
 * The UI bundle reads `window.__WORKBUDDY__` to learn which transport it is on
 * (`http` / `vscode` / `ipc`) and where to send calls. Every host injects it
 * the same way: replace a placeholder in the built `index.html`.
 *
 * This lives on its own — and is deliberately dependency-free — because it is
 * needed by BOTH the HTTP server (which has fs/path) and the VS Code extension
 * webview (which must not pull `node:http` in just to inject a script tag).
 */

/** Placeholder the UI's index.html carries, if present. */
export const CONFIG_PLACEHOLDER = "<!--WORKBUDDY_CONFIG-->";

/**
 * Replace the placeholder with a config script tag, falling back to injecting
 * before `</head>`. The value is JSON-encoded and `<` is escaped so the
 * payload can never break out of the script element.
 */
export function injectConfig(html: string, config: unknown): string {
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  const tag = `<script>window.__WORKBUDDY__=${json};</script>`;
  return html.includes(CONFIG_PLACEHOLDER)
    ? html.replace(CONFIG_PLACEHOLDER, tag)
    : html.replace("</head>", `${tag}</head>`);
}
