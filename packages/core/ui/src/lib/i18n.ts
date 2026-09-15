/**
 * Lightweight i18n — no external dependency.
 *
 * `t(key, params?)` returns the translated string for the current locale.
 * The locale is reactive: when it changes, Vue components re-render
 * automatically because `t()` calls `locale.value` internally.
 *
 * The locale is READ FROM THE HOST and never chosen in the UI — a picker here
 * would be a second source of truth next to the user's editor/OS language
 * setting. Signals, in priority order:
 *
 *   1. `RuntimeConfig.locale` — a host that knows its own language.
 *      dsh needs this: our page runs in an iframe, so
 *      `documentElement.lang` is OUR document's, not the host's.
 *   2. `documentElement.lang` — the VS Code workbench sets it from the
 *      display language, and it tracks changes.
 *   3. `navigator.language` — the browser / OS, for the standalone server and
 *      Electron. `languagechange` keeps it current.
 */

import { computed, ref } from "vue";
import en from "./locales/en";
import zh from "./locales/zh";
import { isVsCodeWebview, runtimeConfig } from "./config";

export type Locale = "en" | "zh";

const bundles: Record<Locale, Record<string, string | ((params: Record<string, string>) => string)>> = { en, zh };

/** The active locale. Reactive so Vue re-renders when it changes. */
export const locale = ref<Locale>("en");

/** Map any BCP-47 tag onto a bundle we ship; `undefined` means "not ours". */
function normalize(tag: string | undefined | null): Locale | undefined {
  if (!tag) return undefined;
  return tag.toLowerCase().startsWith("zh") ? "zh" : tag.toLowerCase().startsWith("en") ? "en" : undefined;
}

/** A language chosen in Settings. Outranks the ambient signals until a host pushes. */
let override: Locale | null = null;

/** Resolve the locale from every host signal, in priority order. */
function resolveLocale(): Locale {
  // 0. An explicit choice from Settings wins over the ambient signals below.
  if (override) return override;
  return (
    normalize(runtimeConfig().locale) ??
    normalize(document.documentElement.lang) ??
    normalize(navigator.language) ??
    "en"
  );
}

/** Apply a locale without persisting it — the host owns the choice. */
export function applyLocale(next: Locale): void {
  locale.value = next;
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
}

/** Re-resolve from the host and apply. Safe to call repeatedly. */
export function refreshLocale(): void {
  const next = resolveLocale();
  if (next !== locale.value) applyLocale(next);
}

let started = false;

/**
 * Start following the host's language. Idempotent.
 *
 * Called once from `main.ts` before mount so the first paint is already
 * translated.
 */
export function initLocale(): void {
  if (started) return;
  started = true;

  applyLocale(resolveLocale());
  // The browser fires this when the user changes their preferred language.
  window.addEventListener?.("languagechange", refreshLocale);
}

/**
 * Apply a locale pushed by a host (dsh's frame forwarding its own language).
 */
export function setLocale(next: Locale): void {
  // The host outranks a stored preference — otherwise a user's old pick here
  // would silently beat the host they are currently embedded in.
  override = null;
  applyLocale(next);
}

/** Apply a choice made in Settings. */
export function chooseLocale(next: Locale): void {
  override = next;
  applyLocale(next);
}

/**
 * Whether a host has already decided the language, making a picker pointless.
 *
 * True when the host injects a value (dsh, whose iframe cannot be reached
 * through `documentElement.lang`) or in the VS Code webview, where the
 * workbench owns `documentElement.lang` and rewrites it on a language change.
 */
export function isHostControlledLocale(): boolean {
  return runtimeConfig().locale !== undefined || isVsCodeWebview();
}

/**
 * Apply a language TAG pushed by the embedding host ("zh-CN", "en-US", …).
 *
 * The host's frame lives in a different document, so it cannot set our
 * reactive locale directly — it calls the bridge exposed in `main.ts` with
 * whatever tag its own locale system resolved. Returns whether the tag maps
 * to a bundle we ship, so the caller can tell "applied" from "not ours".
 */
export function applyHostLocale(tag: string): boolean {
  const next = normalize(tag);
  if (!next) return false;
  override = null;
  applyLocale(next);
  return true;
}

/**
 * Translate a key with optional parameter interpolation.
 *
 * Usage:
 *   t("accounts.creditsRemaining", { count: "3" })
 *   t("tab.accounts")
 *
 * Unresolved keys are returned as-is (no crash) so the UI degrades
 * gracefully if a translation is missing.
 */
export function t(
  key: string,
  params?: Record<string, string>
): string {
  const bundle = bundles[locale.value] ?? bundles.en;
  const entry = bundle[key] ?? bundles.en[key];
  if (entry === undefined) return key;
  if (typeof entry === "function") return entry(params ?? {});
  return entry;
}

/**
 * Composable for use in `<script setup>`.
 *
 * Returns a reactive `t` function: `const { t } = useI18n()`
 * The returned `t` is NOT reactive itself — it reads `locale.value`
 * on each call, so Vue tracks the dependency.
 */
export function useI18n() {
  return { t, locale: computed(() => locale.value) };
}
