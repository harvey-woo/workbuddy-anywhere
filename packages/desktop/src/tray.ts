import * as path from "node:path";
import { Menu, Tray, app, nativeImage } from "electron";
import type {
  AccountSummary,
  ServiceState,
  WorkbuddyService,
} from "@wbaw/core";
import { trayT, type TrayLocale } from "./tray-i18n";

/** The tabs a tray action can ask the window to show. */
export type TrayRoute = "accounts" | "login";

export interface TrayActions {
  open(route: TrayRoute): void;
  quit(): void;
}

/**
 * Create the tray, which is this app's real home: the window is something you
 * open, closing it hides it, and the background token refresh has to keep
 * running either way.
 *
 * The title mirrors the VS Code status bar — just the ACTIVE account's
 * percentage — so the number people already recognise is in the same place.
 * The menu carries what that status bar deliberately does not: per-account
 * switching, check-in and the startup toggle.
 */
export function createTray(
  service: WorkbuddyService,
  actions: TrayActions
): Tray {
  const tray = new Tray(trayIcon());
  tray.setToolTip("WorkBuddy Anywhere");

  const refresh = async (): Promise<void> => {
    let state: ServiceState;
    try {
      state = await service.getState();
    } catch (err) {
      // Keep the last title and menu rather than blanking a working tray.
      console.error(`[tray] state read failed: ${messageOf(err)}`);
      return;
    }
    const active =
      state.accounts.find((account) => account.key === state.activeKey) ??
      state.accounts[0];

    // AUTO MODE: requests rotate across accounts, so the title shows the
    // REGION TOTAL — one account's balance would mislead.
    const auto = state.settings.autoSelectAccount;
    if (auto) {
      const totals = regionTotals(state.accounts, state.region);
      if (totals) {
        tray.setTitle(` ${compactCredits(totals.remain)}`);
        tray.setContextMenu(buildAutoMenu(service, state, totals, actions, refresh));
        return;
      }
    }

    // macOS draws the title flush against the image, so the gap is made here:
    // a leading space, rather than padding baked into the icon (which would
    // eat into the 18pt menu-bar height).
    tray.setTitle(active?.usage ? ` ${compactCredits(active.usage.remain)}` : "");
    tray.setContextMenu(buildMenu(service, state, active, actions, refresh));
  };

  // Account switches, check-ins and quota refreshes all arrive through here.
  service.onChange(() => void refresh());
  void refresh();

  return tray;
}

function buildMenu(
  service: WorkbuddyService,
  state: ServiceState,
  active: AccountSummary | undefined,
  actions: TrayActions,
  refresh: () => Promise<void>
): Menu {
  const locale: TrayLocale = state.settings.locale === "zh" ? "zh" : "en";
  const theme = state.settings.theme === "light" ? "light" : "dark";

  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: active ? `${labelOf(active)} — ${creditsOf(active)} credits` : trayT(locale, "notSignedIn"),
      enabled: false,
    },
    { type: "separator" },
    { label: trayT(locale, "openManagement"), click: () => actions.open("accounts") },
  ];

  for (const region of ["cn", "intl"] as const) {
    const inRegion = state.accounts.filter((a) => (a.region ?? "cn") === region);
    if (inRegion.length === 0) continue;
    items.push({
      label: trayT(locale, region === "cn" ? "switchAccountCn" : "switchAccountIntl"),
      submenu: inRegion.map((account) => ({
        label: `${account.key === state.activeKey ? "●" : "○"} ${labelOf(account)} — ${creditsOf(account)}`,
        click: () => void act(() => service.switchAccount(account.key), refresh),
      })),
    });
  }

  items.push(
    { type: "separator" },
    { label: trayT(locale, "checkinAll"), click: () => void act(() => service.checkinAll(), refresh) },
    { label: trayT(locale, "refreshUsage"), click: () => void act(() => service.refreshAllUsage(), refresh) },
    { type: "separator" },
    // ── Theme submenu ───────────────────────────────────────────────────
    {
      label: trayT(locale, "theme"),
      submenu: [
        {
          label: trayT(locale, "dark"),
          type: "radio",
          checked: theme === "dark",
          click: () => void act(() => service.updateSettings({ theme: "dark" }), refresh),
        },
        {
          label: trayT(locale, "light"),
          type: "radio",
          checked: theme === "light",
          click: () => void act(() => service.updateSettings({ theme: "light" }), refresh),
        },
      ],
    },
    // ── Language submenu ────────────────────────────────────────────────
    {
      label: trayT(locale, "language"),
      submenu: [
        {
          label: trayT(locale, "english"),
          type: "radio",
          checked: locale === "en",
          click: () => void act(() => service.updateSettings({ locale: "en" }), refresh),
        },
        {
          label: trayT(locale, "chinese"),
          type: "radio",
          checked: locale === "zh",
          click: () => void act(() => service.updateSettings({ locale: "zh" }), refresh),
        },
      ],
    },
    {
      label: trayT(locale, "openAtLogin"),
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        const actual = app.getLoginItemSettings().openAtLogin;
        if (actual !== item.checked) {
          console.error(`[tray] could not change the login item (still ${actual})`);
        }
        void refresh();
      },
    },
    { type: "separator" },
    { label: trayT(locale, "quit"), click: () => actions.quit() }
  );

  return Menu.buildFromTemplate(items);
}

/** Run a menu action, then re-read state — `onChange` is not the only path. */
async function act(
  task: () => Promise<unknown>,
  refresh: () => Promise<void>
): Promise<void> {
  try {
    await task();
  } catch (err) {
    console.error(`[tray] ${messageOf(err)}`);
  }
  await refresh();
}

function labelOf(account: AccountSummary): string {
  return account.label || account.key.slice(0, 8);
}

/** Compact credits for the narrow menu-bar title: 12345 -> 12.3k. */
function compactCredits(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function creditsOf(account: AccountSummary): string {
  return account.usage ? compactCredits(account.usage.remain) : "—";
}

/**
 * Sum the quota of one region's accounts that have reported usage.
 * Returns null when nobody has numbers yet.
 */
function regionTotals(
  accounts: AccountSummary[],
  region: "cn" | "intl"
): { remain: number; size: number; reported: number } | null {
  let remain = 0;
  let size = 0;
  let reported = 0;
  for (const a of accounts) {
    if ((a.region ?? "cn") !== region || !a.usage) continue;
    reported += 1;
    remain += a.usage.remain;
    size += a.usage.size;
  }
  return reported > 0 ? { remain, size, reported } : null;
}

/** The auto-mode menu: totals up top, per-account list without switching. */
function buildAutoMenu(
  service: WorkbuddyService,
  state: ServiceState,
  totals: { remain: number; size: number; reported: number },
  actions: TrayActions,
  refresh: () => Promise<void>
): Menu {
  const locale: TrayLocale = state.settings.locale === "zh" ? "zh" : "en";
  const theme = state.settings.theme === "light" ? "light" : "dark";

  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: trayT(locale, "autoDistribute", {
        count: String(totals.reported),
        total: compactCredits(totals.remain),
      }),
      enabled: false,
    },
    { type: "separator" },
    { label: trayT(locale, "openManagement"), click: () => actions.open("accounts") },
  ];

  for (const region of ["cn", "intl"] as const) {
    const inRegion = state.accounts.filter((a) => (a.region ?? "cn") === region);
    if (inRegion.length === 0) continue;
    items.push({
      label: trayT(locale, region === "cn" ? "usageCn" : "usageIntl"),
      submenu: inRegion.map((account) => ({
        label: `${account.key === state.activeKey ? "●" : "○"} ${labelOf(account)} — ${creditsOf(account)}`,
        enabled: false,
      })),
    });
  }

  items.push(
    { type: "separator" },
    { label: trayT(locale, "checkinAll"), click: () => void act(() => service.checkinAll(), refresh) },
    { label: trayT(locale, "refreshUsage"), click: () => void act(() => service.refreshAllUsage(), refresh) },
    { type: "separator" },
    {
      label: trayT(locale, "theme"),
      submenu: [
        {
          label: trayT(locale, "dark"),
          type: "radio",
          checked: theme === "dark",
          click: () => void act(() => service.updateSettings({ theme: "dark" }), refresh),
        },
        {
          label: trayT(locale, "light"),
          type: "radio",
          checked: theme === "light",
          click: () => void act(() => service.updateSettings({ theme: "light" }), refresh),
        },
      ],
    },
    {
      label: trayT(locale, "language"),
      submenu: [
        {
          label: trayT(locale, "english"),
          type: "radio",
          checked: locale === "en",
          click: () => void act(() => service.updateSettings({ locale: "en" }), refresh),
        },
        {
          label: trayT(locale, "chinese"),
          type: "radio",
          checked: locale === "zh",
          click: () => void act(() => service.updateSettings({ locale: "zh" }), refresh),
        },
      ],
    },
    {
      label: trayT(locale, "openAtLogin"),
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        const actual = app.getLoginItemSettings().openAtLogin;
        if (actual !== item.checked) {
          console.error(`[tray] could not change the login item (still ${actual})`);
        }
        void refresh();
      },
    },
    { type: "separator" },
    {
      label: trayT(locale, "quit"),
      click: () => actions.quit(),
    }
  );

  return Menu.buildFromTemplate(items);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The menu-bar icon: a macOS TEMPLATE image (black + alpha), so the system
 * renders it correctly in light and dark menu bars instead of stamping a
 * coloured bitmap on top of them.
 *
 * Sourced from the same brand mark as the extension's status-bar glyph — see
 * scripts/make-tray-icons.sh — so the two hosts cannot drift apart. The @2x
 * twin is picked up automatically by Electron's High-DPI loader.
 */
function trayIcon(): Electron.NativeImage {
  // Two raster sets ship side-by-side:
  //   - trayTemplate{,_@2x}.png is monochrome — a single-colour path used
  //     as macOS's template image (set below). The OS recolours it to match
  //     light/dark menu bars, which is the only way a tray icon can look
  //     native on a Mac without per-theme assets.
  //   - trayColor{,_@2x}.png is the full brand mark (gradient tile + path).
  //     macOS ignores it; Windows and Linux load it directly because the
  //     monochrome version would render as an opaque black square — the
  //     tray on those platforms cannot tint a template image.
  const name =
    process.platform === "darwin" ? "trayTemplate.png" : "trayColor.png";
  const file = path.join(__dirname, name);
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    // `new Tray()` on an empty image fails with an opaque platform error, and a
    // missing asset is a build problem, not a runtime one — say which.
    throw new Error(`tray icon not found at ${file} — run: node esbuild.mjs`);
  }
  if (process.platform === "darwin") {
    // macOS-only: mark the image as a template so the system tints it.
    // On Windows and Linux the setter is a no-op, so calling it
    // unconditionally would be misleading.
    image.setTemplateImage(true);
  }
  return image;
}
