/**
 * Tiny shared store — module-level reactive state, no Pinia.
 *
 * The only stateful things in this UI are "what does the service look like
 * right now" and "is an action in flight", so a store library would be more
 * machinery than the app has state.
 */

import { computed, ref } from "vue";
import type { ServiceState } from "@core/service";
import { DEFAULT_REGION, REGION_PROFILES, REGIONS, type Region } from "@core/region";
import { setRegionForCalls } from "@core/rpc";
import { call, errorMessage } from "./client";

export const state = ref<ServiceState | null>(null);
export const stateError = ref<string | null>(null);
export const busy = ref(false);
/**
 * True once the FIRST state load has finished, successfully or not.
 *
 * Views are only mounted after this: a child's onMounted runs BEFORE the
 * parent's, so a view that reads `state` on mount would otherwise always see
 * the empty initial value and silently do nothing.
 */
export const ready = ref(false);

export async function refreshState(region?: Region): Promise<void> {
  try {
    // Keep the RPC layer's region hint in lock-step with the global setting
    // so region-scoped URLs are built from the right cluster prefix. The FIRST
    // load has neither (no state yet, no explicit region), which is not a bug —
    // fall back to the default instead of leaving the hint unset, or the RPC
    // layer logs a "no region hint set" warning on every cold start. The
    // persisted region may be garbage (see the comment on `region` below),
    // so validate before forwarding it as the RPC hint.
    const persisted = state.value?.settings?.region;
    const validPersisted = persisted === "cn" || persisted === "intl" ? persisted : undefined;
    setRegionForCalls(validPersisted ?? region ?? DEFAULT_REGION);
    let next = await call("getState", region ? { region } : undefined);
    // A session can appear while we are already running (the user signs in from
    // the VS Code webview, or an auth file is dropped into the data dir). The
    // cached catalog would still be the public one, so upgrade it once.
    if (next.loggedIn && next.modelsSource !== "auth") {
      await call("refreshModels");
      next = await call("getState");
    }
    state.value = next;
    stateError.value = null;
  } catch (err) {
    stateError.value = errorMessage(err);
  } finally {
    ready.value = true;
  }
}

export const settings = computed(() => state.value?.settings ?? null);
export const models = computed(() => state.value?.models ?? []);

/**
 * The region the user is currently looking at.
 *
 * One global notion, persisted as `settings.region`, so every page reads the
 * SAME value. Active account selection is independent — the Accounts page
 * shows each region's own active account, and switching region here does not
 * touch which account is in use.
 */
export const region = computed<Region>(
  // The persisted region may contain garbage from an earlier buggy write
  // (e.g. a label string was passed where a Region key was expected, or an
  // external tool wrote to settings.json by hand). Treat anything that isn't
  // a valid Region as "no choice" and fall back to DEFAULT_REGION so the UI
  // is never stranded with no region button highlighted.
  () => {
    const r = state.value?.settings?.region;
    return r === "cn" || r === "intl" ? r : DEFAULT_REGION;
  }
);

export function accountsIn(r: Region): ServiceState["accounts"] {
  return (state.value?.accounts ?? []).filter((a) => a.region === r);
}

export function regionLabel(r: Region): string {
  return REGION_PROFILES[r].label;
}

export { REGIONS };
export type { Region };

/**
 * Set the global region. Persists to settings and refreshes state so the new
 * cluster's catalog + account list show up immediately. The refresh is asked
 * FOR the new region explicitly — the default refresh path follows the
 * active account, which stays on the old cluster after the switch, so without
 * the explicit override the page would show a stale catalog.
 */
export async function setRegion(r: Region): Promise<void> {
  if (region.value === r) return;
  await call("updateSettings", { region: r });
  await refreshState(r);
}

/** Run an action with the shared busy flag; failures land in `stateError`. */
export async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = true;
  try {
    const result = await fn();
    stateError.value = null;
    return result;
  } catch (err) {
    stateError.value = errorMessage(err);
    return undefined;
  } finally {
    busy.value = false;
  }
}
