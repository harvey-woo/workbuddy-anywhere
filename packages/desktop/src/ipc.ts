import { ipcMain, shell } from "electron";
import {
  createRpcHandlers,
  type RpcMethod,
  type WorkbuddyService,
} from "@wbaw/core";

/**
 * The channel the renderer's preload bridge invokes.
 *
 * Deliberately NOT core's `RPC_CHANNEL`: that one carries fire-and-forget
 * envelopes for postMessage hosts (the VS Code webview), while
 * `ipcRenderer.invoke` already round-trips a promise — an envelope here would
 * be a second id to keep in sync for nothing.
 */
export const IPC_INVOKE = "workbuddy:invoke";

/**
 * Wire the renderer to core's ONE RPC implementation, the same one the HTTP
 * server and the VS Code extension dispatch through.
 */
export function installRpcBridge(service: WorkbuddyService): void {
  const handlers = createRpcHandlers(service, {
    // The management page links to the API docs; a renderer cannot open a
    // browser itself, and without this the call fails loudly.
    openExternal: (url) => shell.openExternal(url),
  });

  ipcMain.handle(IPC_INVOKE, async (_event, method: string, params: unknown) => {
    const handler = handlers[method as RpcMethod];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    return handler((params ?? {}) as Record<string, unknown>);
  });
}
