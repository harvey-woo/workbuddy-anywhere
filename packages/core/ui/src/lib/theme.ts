/**
 * Theme — READ FROM THE HOST, never chosen in the UI.
 *
 * Every host already has an authoritative theme, so offering a picker here just
 * creates a second source of truth that drifts (and in the VS Code webview it
 * could not win anyway). This module resolves the theme from the host and keeps
 * following it:
 *
 *   VS Code webview   body[data-vscode-theme-kind] + body.vscode-* classes
 *                     → observed with a MutationObserver: the user can switch
 *                       themes at any time and VS Code rewrites those attrs
 *   any host          prefers-color-scheme media query
 *                     → subscribed; covers the OS switching at sunset and is
 *                       the right default for standalone / Electron
 *   explicit host     RuntimeConfig.theme, for a host that knows better
 */

import { ref } from "vue";
import { runtimeConfig } from "./config";

export type Theme = "dark" | "light";

/** The active theme. Reactive so Vue re-renders when the host changes it. */
export const theme = ref<Theme>("dark");

const listeners = new Set<(t: Theme) => void>();

/** Subscribe to resolved-theme changes. Returns an unsubscribe function. */
export function onThemeChange(fn: (t: Theme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(next: Theme): void {
  if (theme.value === next) return;
  theme.value = next;
  applyThemeDom(next);
  for (const fn of listeners) fn(next);
}

/**
 * Paint the theme onto the document.
 *
 * VS Code paints its own `body.vscode-*` classes and derived variables, so we
 * only toggle our own class — writing a competing class there would fight the
 * host's stylesheet. Everywhere else the `light` class flips our CSS variables.
 */
function applyThemeDom(next: Theme): void {
  document.documentElement.classList.toggle("light", next === "light");
}

/** Read the theme VS Code is currently painting, when we are in its webview. */
function readVsCodeTheme(): Theme | null {
  const kind = document.body?.dataset?.vscodeThemeKind;
  if (kind) {
    // vscode-dark | vscode-light | vscode-high-contrast | vscode-high-contrast-light
    return kind.includes("light") ? "light" : "dark";
  }
  if (document.body?.classList.contains("vscode-light")) return "light";
  if (document.body?.classList.contains("vscode-dark")) return "dark";
  if (document.body?.classList.contains("vscode-high-contrast-light")) return "light";
  if (document.body?.classList.contains("vscode-high-contrast")) return "dark";
  return null;
}

/** Resolve the theme from every signal we have, in priority order. */
function resolveTheme(): Theme {
  // 1. An explicit host declaration wins — the host can see things we cannot.
  const injected = runtimeConfig().theme;
  if (injected === "light" || injected === "dark") return injected;
  // 2. VS Code's live theme.
  const vscode = readVsCodeTheme();
  if (vscode) return vscode;
  // 3. The OS / browser preference.
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Re-resolve and publish. Safe to call repeatedly. */
export function refreshTheme(): void {
  publish(resolveTheme());
}

let started = false;

/**
 * Start following the host's theme. Idempotent.
 *
 * Called once from `main.ts` before mount, so the very first paint already has
 * the right palette instead of flashing the default.
 */
export function initTheme(): void {
  if (started) return;
  started = true;

  applyThemeDom(theme.value);
  refreshTheme();

  // VS Code rewrites the theme attributes on <body>. Watching attributes only
  // (not childList) keeps the observer off the hot path.
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(refreshTheme).observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "data-vscode-theme-kind"],
    });
  }
  // The OS preference can flip while the page is open.
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", refreshTheme);
}

/** A host pushing a theme it decided on (dsh's frame, the desktop tray). */
export function applyTheme(next: Theme): void {
  publish(next);
}

/** Theme is host-owned now; there is no picker left to save from. */
export async function setTheme(next: Theme): Promise<void> {
  publish(next);
}

/** Theme is host-owned now, so every surface is host-controlled. */
export function isHostControlledTheme(): boolean {
  return true;
}
