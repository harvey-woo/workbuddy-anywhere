<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { navigate, route } from "./lib/router";
import {
  accountsIn,
  refreshState,
  ready,
  region,
  regionLabel,
  REGIONS,
  setRegion,
  state,
  stateError,
  type Region,
} from "./lib/store";
import { runtimeConfig } from "./lib/config";
import { call } from "./lib/client";
import AccountsView from "./views/AccountsView.vue";
import LoginView from "./views/LoginView.vue";
import ModelsView from "./views/ModelsView.vue";
import SettingsView from "./views/SettingsView.vue";

const TABS = [
  { name: "accounts", label: "Accounts" },
  { name: "models", label: "Models" },
  { name: "settings", label: "Settings" },
] as const;

const VIEWS = {
  accounts: AccountsView,
  login: LoginView,
  models: ModelsView,
  settings: SettingsView,
};

const current = computed(() => VIEWS[route.value]);
const cfg = runtimeConfig();

const sessionLabel = computed(() => {
  const s = state.value;
  if (!s) return "Loading…";
  if (!s.loggedIn) return "Not signed in";
  // Count only the CURRENT region's accounts — the two clusters have
  // independent account universes, so the sidebar should not mix them.
  const count = accountsIn(region.value).length;
  if (count === 0) return "No accounts in this region";
  const name = s.nickname || s.uid || "Signed in";
  return count > 1 ? `${name} +${count - 1}` : name;
});

const sessionDot = computed(() => (state.value?.loggedIn ? "var(--wb-ok)" : "var(--wb-muted)"));

onMounted(async () => {
  await refreshState();
  // No auto-redirect: Accounts IS the landing page and already renders a clear
  // "no accounts yet -> sign in" state. Yanking the user to another tab on
  // load is more surprising than helpful, especially with a deep link.

  // Host pushes "state changed" after every chat so the cache stays current
  // without a timer; we just re-fetch state when it fires.
  const onStateChanged = (): void => {
    void refreshState();
  };
  window.addEventListener("workbuddy:stateChanged", onStateChanged);
});

/**
 * Switch the global region. Persists via `setRegion` (which also refreshes
 * state, so the new cluster's account list and catalog land in one step).
 */
async function pickRegion(r: Region): Promise<void> {
  if (region.value === r) return;
  await setRegion(r);
}

/**
 * Claim the daily bonus for EVERY account on BOTH clusters in one sweep, then
 * re-read state so the per-account labels and this button's own count follow.
 */
const checkinBusy = ref(false);
async function checkinAllRegions(): Promise<void> {
  if (checkinBusy.value) return;
  checkinBusy.value = true;
  try {
    await call("checkinAll");
    await refreshState();
  } finally {
    checkinBusy.value = false;
  }
}

/**
 * How many accounts across BOTH clusters still have today's bonus unclaimed.
 * Drives the check-in button's label and disabled state. "unknown" states do
 * not count — an account we could not reach is not a confirmed pending claim.
 */
const checkinPending = computed(
  () => (state.value?.accounts ?? []).filter((a) => a.checkin?.state === "unclaimed").length
);
</script>

<template>
  <div class="flex h-full">
    <aside
      class="flex w-[186px] shrink-0 flex-col border-r"
      :style="{ borderColor: 'var(--wb-border)', background: 'var(--wb-panel)' }"
    >
      <div class="px-4 pb-3 pt-4">
        <!-- Two-line brand, version parked to the right so the footer stays
             lean (the transport is the only thing that belongs down there). -->
        <div class="flex items-start justify-between gap-1">
          <div class="text-[13px] font-semibold leading-[1.2] tracking-tight">
            WorkBuddy<br />Anywhere
          </div>
          <span
            v-if="cfg.version"
            class="wb-mono mt-0.5 text-[9.5px] leading-none"
            :style="{ color: 'var(--wb-muted)' }"
            >v{{ cfg.version }}</span
          >
        </div>
        <div class="mt-1 text-[11px]" :style="{ color: 'var(--wb-muted)' }">
          Accounts, quota &amp; models
        </div>
      </div>

      <!--
        Which world am I in? The two clusters never share tokens, so this is a
        real fork rather than a filter. Setting it once here is the same as
        setting it everywhere — login, models, accounts, the catalog all
        follow.
      -->
      <div class="px-3 pb-3">
        <div class="wb-region-switch">
          <button
            v-for="r in REGIONS"
            :key="r"
            class="wb-region-btn"
            :class="{ active: region === r }"
            :title="`${regionLabel(r)} — ${accountsIn(r).length} account(s)`"
            @click="void pickRegion(r)"
          >
            <span>{{ regionLabel(r) }}</span>
            <span class="wb-region-count">{{ accountsIn(r).length }}</span>
          </button>
        </div>
      </div>

      <nav class="flex flex-col gap-0.5 px-2">
        <button
          v-for="tab in TABS"
          :key="tab.name"
          class="wb-nav"
          :class="{ active: route === tab.name }"
          @click="navigate(tab.name)"
        >
          {{ tab.label }}
        </button>
      </nav>

      <!--
        Check-in all, pinned to the BOTTOM of the sidebar (just above the
        session footer). It is CROSS-REGION on purpose:
        one sweep claims the daily bonus for every account on BOTH clusters, so
        it does not belong inside the region-scoped Accounts page. The label
        shows what is still to claim across all regions, and the button
        disables itself when nothing is left.
      -->
      <div class="mt-auto px-2 pb-2">
        <button
          class="wb-btn w-full"
          :disabled="checkinBusy || checkinPending === 0"
          :title="`Claim the daily bonus for every account on both clusters (${checkinPending} left)`"
          @click="checkinAllRegions"
        >
          {{ checkinBusy ? "Checking in…" : `Check in all (${checkinPending})` }}
        </button>
      </div>

      <div
        class="border-t px-4 py-3 text-[11px]"
        :style="{ borderColor: 'var(--wb-border)', color: 'var(--wb-muted)' }"
      >
        <!-- min-w-0 + truncate: a long account label ellipsises instead of
             pushing layout around, and shrink-0 keeps the status dot visible
             no matter how long the name is. -->
        <div class="flex min-w-0 items-center gap-1.5">
          <span
            class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            :style="{ background: sessionDot }"
          />
          <span class="truncate" :title="sessionLabel">{{ sessionLabel }}</span>
        </div>
      </div>
    </aside>

    <main class="flex-1 overflow-auto">
      <div
        v-if="stateError"
        class="wb-card m-5 px-4 py-2.5 text-[12px]"
        :style="{ borderColor: 'var(--wb-danger)', color: 'var(--wb-danger)' }"
      >
        {{ stateError }}
      </div>
      <component :is="current" v-if="ready" />
      <div v-else class="p-6 text-[12px]" :style="{ color: 'var(--wb-muted)' }">
        Loading…
      </div>
    </main>
  </div>
</template>

<style scoped>
.wb-nav {
  display: block;
  width: 100%;
  border: none;
  border-radius: 7px;
  background: transparent;
  padding: 6px 10px;
  text-align: left;
  font-size: 12.5px;
  color: var(--wb-muted);
  cursor: pointer;
}
.wb-nav:hover {
  background: var(--wb-panel-2);
  color: var(--wb-text);
}
.wb-nav.active {
  background: var(--wb-accent-soft);
  color: var(--wb-accent);
  font-weight: 600;
}
.wb-region-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  padding: 3px;
  border-radius: 8px;
  background: var(--wb-panel-2);
}
.wb-region-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: none;
  border-radius: 6px;
  background: transparent;
  padding: 5px 6px;
  font-size: 11.5px;
  color: var(--wb-muted);
  cursor: pointer;
}
.wb-region-btn:hover {
  color: var(--wb-text);
}
.wb-region-btn.active {
  background: var(--wb-bg);
  color: var(--wb-text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
}
.wb-region-count {
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  opacity: 0.7;
}
</style>
