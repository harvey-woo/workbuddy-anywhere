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
import * as path from "node:path";
import { BrowserWindow, Menu, Tray, app, nativeImage, shell } from "electron";
import { installRpcBridge } from "./ipc";
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

function log(message: string): void {
  console.log(`[core] ${message}`);
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

async function main(): Promise<void> {
  // A second launch must focus the running app, not start a rival whose token
  // tick would fight over the same credential file.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => show());

  const service = createDesktopService(log);
  installRpcBridge(service);
  // autoCheckin: claim the daily bonus for every account on startup, on BOTH
  // clusters. core also arms a timer for the day rollover, so a tray app that
  // stays open for weeks keeps claiming without anyone opening the window.
  await service.init({ autoCheckin: true });

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
  if (!app.getLoginItemSettings().wasOpenedAtLogin) show("accounts");

  // Clicking the dock icon after the window was hidden should bring it back.
  app.on("activate", () => show());

  // Deliberately empty. Electron quits once the last window closes unless
  // something handles this — and the tray, plus the refresh loop that keeps
  // every account alive, must outlive the window.
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    quitting = true;
    tray?.destroy();
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
