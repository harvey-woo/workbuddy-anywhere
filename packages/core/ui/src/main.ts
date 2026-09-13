import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import { initTheme } from "./lib/theme";
import { initLocale, applyHostLocale } from "./lib/i18n";

/**
 * Initialize theme and locale before mounting.
 *
 * Both are READ FROM THE HOST and then followed for the lifetime of the page —
 * there is no picker, so this is the only place either is decided:
 *
 *   theme  → VS Code's body attributes (observed), else prefers-color-scheme
 *   locale → host config, else documentElement.lang, else navigator.language
 *
 * Running before `createApp` means the first paint already has the right
 * palette and language instead of flashing the defaults.
 */
initTheme();
initLocale();

/**
 * Bridge for an embedding host that lives in ANOTHER document.
 *
 * A parent frame cannot reach this module directly, and our own
 * `documentElement.lang` is this document's (from index.html), not the host's —
 * so an iframe host (dsh) has no way to tell us its language through the DOM.
 * It calls this instead, on load and again whenever its own locale changes.
 *
 * The host passes its RAW tag (`zh-CN`) rather than a normalized id, because
 * normalization lives here: only we know which bundles we ship.
 */
declare global {
  interface Window {
    __WORKBUDDY_APPLY_LOCALE__?: (tag: string) => boolean;
  }
}
window.__WORKBUDDY_APPLY_LOCALE__ = applyHostLocale;

createApp(App).mount("#app");
