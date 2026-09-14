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

/** Status of the local API server, shared with the renderer. */
export interface ServerState {
  running: boolean;
  port: number;
  error: string;
}

/**
 * Wire the renderer to core's ONE RPC implementation, the same one the HTTP
 * server and the VS Code extension dispatch through.
 *
 * `serverActions` provides the desktop-specific server lifecycle methods that
 * live in main.ts (start / stop / status). They are called through the same
 * IPC channel so the renderer has a single transport for everything.
 */
export function installRpcBridge(
  service: WorkbuddyService,
  serverActions: {
    getState(): ServerState;
    start(): Promise<ServerState>;
    stop(): Promise<ServerState>;
    setPort(port: number): Promise<void>;
  }
): void {
  const handlers = createRpcHandlers(service, {
    // The management page links to the API docs; a renderer cannot open a
    // browser itself, and without this the call fails loudly.
    openExternal: (url) => shell.openExternal(url),
  });

  ipcMain.handle(IPC_INVOKE, async (_event, method: string, params: unknown) => {
    // Desktop-only server lifecycle methods — not part of core's RPC table.
    switch (method) {
      case "getServerStatus":
        return serverActions.getState();
      case "startServer":
        return serverActions.start();
      case "stopServer":
        return serverActions.stop();
      case "setServerPort":
        await serverActions.setPort((params as { port?: number })?.port ?? 0);
        return { ok: true as const };
    }

    const handler = handlers[method as RpcMethod];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    return handler((params ?? {}) as Record<string, unknown>);
  });
}
