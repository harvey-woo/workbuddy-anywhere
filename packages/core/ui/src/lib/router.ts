/**
 * Hash router — a handful of routes and no nesting, so a router library would
 * be pure overhead. Hash routing also survives being served from a webview or
 * from file:// where the host does not rewrite paths.
 *
 * `accounts` is the landing page: it answers "who am I, and how much is left"
 * without making the user pick a tab first. `login` is deliberately NOT a tab —
 * it is reached from Accounts, which owns the list and the "add account" action.
 */

import { ref } from "vue";

export type RouteName = "accounts" | "login" | "models" | "settings";

export const ROUTE_ORDER: RouteName[] = ["accounts", "login", "models", "settings"];

const BY_HASH: Record<string, RouteName> = {
  "#/": "accounts",
  "#/accounts": "accounts",
  "#/login": "login",
  "#/models": "models",
  "#/settings": "settings",
};

function parse(): RouteName {
  return BY_HASH[window.location.hash] ?? "accounts";
}

export const route = ref<RouteName>(parse());

export function navigate(name: RouteName): void {
  window.location.hash = name === "accounts" ? "#/" : `#/${name}`;
}

window.addEventListener("hashchange", () => {
  route.value = parse();
});
