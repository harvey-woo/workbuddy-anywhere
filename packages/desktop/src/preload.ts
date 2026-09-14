import { contextBridge, ipcRenderer } from "electron";

/** Must match `IPC_INVOKE` in ./ipc.ts. */
const IPC_INVOKE = "workbuddy:invoke";
/** Push channel for state-changed notifications (desktop main → webview). */
const IPC_STATE_CHANGED = "workbuddy:stateChanged";

/**
 * The bridge the management UI talks through.
 *
 * The bundle discovers its host by feature detection — `runtimeConfig()` looks
 * for `window.workbuddy.invoke` and picks the "ipc" transport — so nothing here
 * has to announce which host this is. The `__WORKBUDDY__` payload carries only
 * what detection cannot know, which today is the version string.
 */
function injectedVersion(): string {
  const flag = process.argv.find((arg) => arg.startsWith("--workbuddy-version="));
  return flag ? flag.slice("--workbuddy-version=".length) : "";
}

/** The HTTP API server URL the desktop app hosts for external clients. */
function injectedApiUrl(): string {
  const flag = process.argv.find((arg) => arg.startsWith("--workbuddy-api-url="));
  return flag ? flag.slice("--workbuddy-api-url=".length) : "";
}

contextBridge.exposeInMainWorld("workbuddy", {
  invoke: (method: string, params?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_INVOKE, method, params),
  /**
   * Subscribe to host-pushed state-changed notifications (billing refresh,
   * settings update). The renderer hooks this into its window message
   * listener; main pushes via `webContents.send(IPC_STATE_CHANGED)`.
   */
  onStateChanged: (handler: () => void): (() => void) => {
    const listener = (): void => handler();
    ipcRenderer.on(IPC_STATE_CHANGED, listener);
    return () => ipcRenderer.off(IPC_STATE_CHANGED, listener);
  },
});

contextBridge.exposeInMainWorld("__WORKBUDDY__", {
  transport: "ipc",
  version: injectedVersion(),
  baseUrl: injectedApiUrl(),
});
