/**
 * WorkBuddy desktop client — Electron main process.
 *
 * A HOST for @wbaw/core, exactly like the VS Code extension: core
 * owns the accounts, the quota, the catalog and the chat engine; this file is
 * only the desktop surface on top of it.
 *
 * Shape of the app: the TRAY is home, the window is a page you open, and
 * closing the window hides it. That is deliberate — the background token tick
 * is what keeps every hosted account signed in, so quitting on window close
 * would silently sign people out of an app they thought was still running.
 */
import * as net from "node:net";
import * as path from "node:path";
import { BrowserWindow, Menu, Tray, app, nativeImage, shell } from "electron";
import { startApiServer, type ApiServerHandle } from "@wbaw/core";
import { installRpcBridge, IPC_INVOKE, type ServerState } from "./ipc";
import { createDesktopService } from "./service";
import { createTray, type TrayRoute } from "./tray";

/**
 * The app is called WorkBuddy Anywhere, everywhere.
 *
 * When run from source (`electron .`) the Dock / app menu would otherwise say
 * "Electron", because that name comes from the Electron binary's Info.plist and
 * is only overridden by packaging. `setName` fixes the About panel and the
 * menu title; a packaged .app (see the `pack` script) fixes the Dock.
 */
app.setName("WorkBuddy Anywhere");

/** The management UI, staged from core's ui-dist by esbuild.mjs. */
const UI_ENTRY = path.join(__dirname, "ui", "index.html");

/**
 * Storage must not move when the product is renamed.
 *
 * `app.getPath("userData")` is derived from `app.getName()`, which follows
 * package.json `name`/`productName` — so setting a productName silently
 * relocates every session (it did once, and the app came up signed out).
 * Pinning the directory here ends that: naming cannot move it again.
 */
app.setPath("userData", path.join(app.getPath("appData"), "workbuddy-anywhere"));

type Route = TrayRoute | "models" | "settings";

let win: BrowserWindow | undefined;
/** Held so the tray is not garbage collected (and to destroy it on quit). */
let tray: Tray | undefined;
/** Distinguishes "hide the window" from "actually quit". */
let quitting = false;
/** Which tab the window currently shows, so a tray action can move it. */
let shownRoute: Route = "accounts";

// ── API server state ───────────────────────────────────────────────────

let apiServer: ApiServerHandle | null = null;
let serverState: ServerState = { running: false, port: 0, error: "" };

function log(message: string): void {
  console.log(`[core] ${message}`);
}

/** Push the current server state to the renderer. */
function pushServerState(): void {
  void win?.webContents.send("workbuddy:serverStateChanged", serverState);
}

/**
 * Try to listen on a port to see if it is available.
 * Returns true if the port is free, false if something is already bound.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Find an available port starting from `preferred`. If the preferred port is
 * taken, try the next one up to `preferred + 99`.
 */
async function findAvailablePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 100; port++) {
    if (await isPortFree(port)) return port;
  }
  // Last resort: let the OS pick one.
  return 0;
}

/** Start the API server on the given port. */
async function doStartServer(port: number): Promise<void> {
  if (apiServer) return; // already running
  try {
    const handle = await startApiServer({
      service,
      port,
      version: app.getVersion(),
      log: (msg) => log(msg),
    });
    apiServer = handle;
    serverState = { running: true, port: handle.port, error: "" };
    log(`API server listening on ${handle.url}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    serverState = { running: false, port, error: msg };
    log(`API server failed: ${msg}`);
  }
  pushServerState();
}

/** Stop the API server. */
async function doStopServer(): Promise<void> {
  if (!apiServer) return;
  try {
    await apiServer.close();
  } catch {
    // best-effort
  }
  apiServer = null;
  serverState = { running: false, port: serverState.port, error: "" };
  log("API server stopped");
  pushServerState();
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 540,
    title: "WorkBuddy Anywhere",
    // Shown explicitly (or not, when launched at login) — a window that appears
    // on its own before the UI has rendered is a flash of empty frame.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--workbuddy-version=${app.getVersion()}`],
    },
  });

  // window.open() from the webview (or anchor target=_blank) must leave the
  // app — by default Electron opens a new BrowserWindow inside the same
  // shell, which is not what the user wants when they click /docs or /openapi.
  created.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void created.loadFile(UI_ENTRY);

  // Close means hide — see the note at the top of this file.
  created.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    created.hide();
  });

  return created;
}

/**
 * Show the window, optionally on a specific tab.
 *
 * Moving tabs means reloading: the UI's router reads `location.hash` at module
 * load and the RPC transport has no channel for "navigate" (the VS Code webview
 * host works the same way, for the same reason).
 */
function show(route: Route = shownRoute): void {
  if (!win) return;
  if (route !== shownRoute) {
    shownRoute = route;
    void win.loadFile(UI_ENTRY, { hash: `/${route}` });
  }
  win.show();
  win.focus();
}

// ── Service + server startup ───────────────────────────────────────────

let service: ReturnType<typeof createDesktopService>;

async function main(): Promise<void> {
  // A second launch must focus the running app, not start a rival whose token
  // tick would fight over the same credential file.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => show());

  service = createDesktopService(log);

  // autoCheckin: claim the daily bonus for every account on startup, on BOTH
  // clusters. core also arms a timer for the day rollover, so a tray app that
  // stays open for weeks keeps claiming without anyone opening the window.
  await service.init({ autoCheckin: true });

  // Determine the port: read from settings, or find an available one on first launch.
  const settings = await service.getSettings();
  let port = settings.serverPort;
  if (!port) {
    port = await findAvailablePort(8787);
    await service.updateSettings({ serverPort: port });
    log(`First launch: assigned port ${port}`);
  }

  // Start the API server. If it fails the UI will show the error and offer a
  // retry — the app stays alive so the user can fix the port in settings.
  serverState = { running: false, port, error: "" };
  await doStartServer(port);

  installRpcBridge(service, {
    getState: () => serverState,
    start: async () => {
      await doStartServer(serverState.port);
      return serverState;
    },
    stop: async () => {
      await doStopServer();
      return serverState;
    },
    setPort: async (port: number) => {
      await service.updateSettings({ serverPort: port });
      serverState = { ...serverState, port };
    },
  });

  win = createWindow();
  // Only the packaged app gets its icon from the bundle; in development the
  // Dock would show Electron's, which makes "is this our app?" unanswerable.
  if (process.platform === "darwin" && app.dock) {
    const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png"));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
  tray = createTray(service, {
    open: (route) => show(route),
    quit: () => {
      quitting = true;
      app.quit();
    },
  });

  // The management window is the only way a desktop user sees their quota
  // tables. Without this push it would show a stale count until the user
  // opened the Refresh button by hand.
  service.onChange(() => {
    void win?.webContents.send("workbuddy:stateChanged", {});
  });

  // Starting at login must NOT throw a window in the user's face: waiting
  // quietly in the tray is the whole point of starting with the system.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) {
    // If the server failed to start, go straight to settings so the user can
    // fix the port. Otherwise land on accounts as usual.
    show(serverState.error ? "settings" : "accounts");
  }

  // Clicking the dock icon after the window was hidden should bring it back.
  app.on("activate", () => show());

  // Deliberately empty. Electron quits once the last window closes unless
  // something handles this — and the tray, plus the refresh loop that keeps
  // every account alive, must outlive the window.
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    quitting = true;
    tray?.destroy();
    void doStopServer();
    service.dispose();
  });
}

void app.whenReady().then(() => {
  // The whole app lives in the tray + management window — no menu bar.
  // Removing it removes a focus-stealing trap (the Mac menu bar absorbs
  // Cmd+Tab focus) and the unnecessary Edit/View/Window items Electron
  // ships by default.
  Menu.setApplicationMenu(null);
  return main();
});
