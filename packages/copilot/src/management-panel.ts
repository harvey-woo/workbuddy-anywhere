/**
 * The management page, as a VS Code webview.
 *
 * It serves the SAME built Vue bundle that the local HTTP server and the
 * desktop app serve — copied into `media/ui-dist` by `esbuild.mjs`. The UI does
 * not know which host it is on: it asks over `postMessage`, and this file
 * forwards those calls to the very same RPC handlers the server uses. One
 * implementation of the management UI, one implementation of its backend, so a
 * feature cannot exist on one host and be missing on another.
 */

import * as vscode from "vscode";
import {
  createRpcHandlers,
  injectConfig,
  RPC_CHANNEL,
  type RpcEnvelope,
  type RpcMethod,
  type RpcReply,
  type WorkbuddyService,
} from "@wbaw/core";

export type ManagementRoute = "accounts" | "login" | "models" | "settings";

let panel: vscode.WebviewPanel | undefined;
/** Which tab the open panel is showing, so a menu command can move it. */
let shownRoute: ManagementRoute = "accounts";

/**
 * Open (or reveal) the management page.
 *
 * `route` only affects the tab it opens on; switching tabs afterwards is the
 * UI's business.
 */
export function showManagementPanel(
  context: vscode.ExtensionContext,
  service: WorkbuddyService,
  route: ManagementRoute = "accounts"
): void {
  if (panel) {
    panel.reveal();
    if (shownRoute !== route) {
      // The webview transport only understands RPC replies, so there is no
      // channel to tell a running page "go to Settings". Re-rendering is the
      // honest way: it reloads the SPA at the requested tab.
      shownRoute = route;
      const target = panel;
      void renderHtml(context, target.webview, route).then((html) => {
        if (panel === target) target.webview.html = html;
      });
    }
    return;
  }

  const created = vscode.window.createWebviewPanel(
    "codebuddy.manage",
    "WorkBuddy Anywhere",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      // Reopening the page must not lose the QR code the user is scanning.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media", "ui-dist")],
    }
  );
  panel = created;
  shownRoute = route;

  const handlers = createRpcHandlers(service, {
    // The webview has no browser of its own; the host opens links. The boolean
    // vscode.env.openExternal resolves with is not part of the hook's contract.
    openExternal: async (url) => {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
  });

  const onChange = service.onChange(() => {
    // Tell the webview to re-fetch: a chat just spent credits, the cached
    // billing snapshot is stale, and a timer would only add latency.
    void created.webview.postMessage({ channel: "stateChanged" });
  });

  const subscription = created.webview.onDidReceiveMessage(
    async (message: RpcEnvelope) => {
      if (!message || message.channel !== RPC_CHANNEL) return;
      const reply: RpcReply = { channel: RPC_CHANNEL, id: message.id };
      const handler = handlers[message.method as RpcMethod];
      if (!handler) {
        reply.error = { message: `Unknown method: ${message.method}` };
      } else {
        try {
          reply.result = await handler(
            (message.params ?? {}) as Record<string, unknown>
          );
        } catch (err) {
          reply.error = {
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
      void created.webview.postMessage(reply);
    }
  );

  created.onDidDispose(() => {
    onChange();
    subscription.dispose();
    panel = undefined;
    shownRoute = "accounts";
  });

  void renderHtml(context, created.webview, route).then((html) => {
    // The panel may have been closed while index.html was being read.
    if (panel === created) created.webview.html = html;
  });
}

async function renderHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  route: ManagementRoute
): Promise<string> {
  const dir = vscode.Uri.joinPath(context.extensionUri, "media", "ui-dist");

  let html: string;
  try {
    html = Buffer.from(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, "index.html"))
    ).toString("utf8");
  } catch {
    return missingUiHtml();
  }

  // The built html references "./assets/…", which a webview is not allowed to
  // load. Rewrite those to the webview URI scheme.
  const assets = webview
    .asWebviewUri(vscode.Uri.joinPath(dir, "assets"))
    .toString();
  html = html.split('"./assets/').join(`"${assets}/`);

  // Opening tab: set the hash BEFORE the bundle runs — the UI's router reads
  // `window.location.hash` at module load, so no host-specific plumbing is
  // needed.
  if (route !== "accounts") {
    html = html.replace(
      "<head>",
      `<head><script>window.location.hash="#/${route}";</script>`
    );
  }

  // The version is what the sidebar header shows next to the brand; without
  // it the badge silently disappears (runtimeConfig() defaults to "").
  return injectConfig(html, {
    transport: "vscode",
    version: context.extension?.packageJSON?.version as string | undefined,
  });
}

/** A readable explanation beats a blank panel when the UI was never built. */
function missingUiHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font:13px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;padding:24px">
<h3>The management UI was not bundled into this build.</h3>
<p>Build it, then reload the window:</p>
<pre style="background:rgba(127,127,127,.15);padding:10px;border-radius:6px">
yarn workspace @wbaw/core ui:build
yarn workspace workbuddy-anywhere-for-copilot bundle</pre>
</body></html>`;
}
