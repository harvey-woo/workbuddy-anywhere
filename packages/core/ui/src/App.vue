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
import { useI18n } from "./lib/i18n";

const { t } = useI18n();

const TABS = [
  { name: "accounts", key: "tab.accounts" },
  { name: "models", key: "tab.models" },
  { name: "settings", key: "tab.settings" },
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
  if (!s) return t("sidebar.loading");
  if (!s.loggedIn) return t("sidebar.notSignedIn");
  const count = accountsIn(region.value).length;
  if (count === 0) return t("sidebar.noRegionAccounts");
  const name = s.nickname || s.uid || t("sidebar.sessionDefault");
  return count > 1 ? `${name} +${count - 1}` : name;
});

const sessionDot = computed(() => (state.value?.loggedIn ? "var(--wb-ok)" : "var(--wb-muted)"));

// Hosts that already show their own brand (e.g. dsh's Settings nav, an IDE
// webview tab title) opt out of core's redundant sidebar header. Defaults
// are TRUE so standalone / VS Code hosts keep the visible chrome.
const showTitle = computed(() => cfg.display?.title !== false);
const showSubtitle = computed(() => cfg.display?.subtitle !== false);

/**
 * Apply host-provided CSS variable overrides to the document root so core's
 * themed surfaces (`--wb-bg`, `--wb-panel`, `--wb-border`, `--wb-accent`,
 * `--wb-danger`, `--wb-ok`, `--wb-text`, `--wb-muted`, `--wb-font`) pick up
 * the host palette. Anything core does not consume is forwarded verbatim,
 * so the host can extend core's token set without forking the bundle.
 *
 * Idempotent: applying the same string twice is a no-op. Runs before
 * refreshState so the first paint already uses host colors — no flash of
 * core's defaults.
 */
function applyCssVars(vars: string | undefined): void {
  if (!vars) return;
  for (const decl of vars.split(";")) {
    const i = decl.indexOf(":");
    if (i < 1) continue;
    const name = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (!name.startsWith("--") || !value) continue;
    document.documentElement.style.setProperty(name, value);
  }
}
applyCssVars(cfg.cssVars);

onMounted(async () => {
  await refreshState();

  // Theme and locale are NOT read from settings any more: both come from the
  // host (VS Code's body attributes, dsh's injected config, the OS) and are
  // kept current by main.ts. Persisting them here would reintroduce the second
  // source of truth the pickers used to be.

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

/**
 * Whether ANY cluster has the check-in feature at all. The flags live in
 * settings (`checkinByRegion`, default {cn: true, intl: false}); when every
 * region has it off, the button is not rendered — a disabled control would
 * imply the feature exists somewhere, which it does not.
 */
const checkinAvailable = computed(() => {
  const flags = state.value?.settings?.checkinByRegion;
  return !!(flags && (flags.cn || flags.intl));
});
</script>

<template>
  <!--
    The host hosts-within-hosts problem: when the host paints its own chrome
    behind us (dsh Settings, an IDE sidebar), core looks like it's floating in
    the same paint layer as the host — no edges, no separation, easy to lose.
    A 1px border around the whole root gives core a visible boundary without
    being heavy. The border color comes from `--wb-border` so the host can
    tune it (dsh's default is `rgba(255,255,255,0.12)` — a subtle hairline).
  -->
  <!--
    The host hosts-within-hosts problem: when the host paints its own chrome
    behind us (dsh Settings, an IDE sidebar), core looks like it's floating in
    the same paint layer as the host — no edges, no separation, easy to lose.
    A hairline border on the LEFT and TOP edges gives core a visible starting
    point without wrapping it in a hard rectangle. The RIGHT and BOTTOM edges
    sit flush against the host's own panel edge (and against the iframe
    boundary), so bordering them would only add a double line the host is
    already providing.

    Rounding: the top-left and bottom-right corners get a curve. These are
    the two "outer" corners of the card from the reader's perspective (the
    other two — top-right and bottom-left — sit against the iframe / dialog
    edge and would just produce stray curves at the seam). Together with
    the top + left borders, the top-left curve starts the card visually; the
    bottom-right curve finishes it where the scrollbar / content end lives,
    so the rectangle reads as finished on a top-left → bottom-right diagonal
    without the host having to think about it.

    The border color and corner radius come from `--wb-border` and
    `--wb-radius-lg` so the host can tune both (dsh's defaults are
    `rgba(255,255,255,0.12)` and `20px` — a soft macOS-dark hairline).
  -->
  <div
    class="flex h-full"
    :style="{
      borderTop: '1px solid var(--wb-border)',
      borderLeft: '1px solid var(--wb-border)',
      borderTopLeftRadius: 'var(--wb-radius-lg, 16px)',
      borderBottomRightRadius: 'var(--wb-radius-lg, 16px)',
      overflow: 'hidden',
      background: 'var(--wb-bg)',
    }"
  >
    <aside
      class="flex w-[186px] shrink-0 flex-col border-r"
      :style="{ borderColor: 'var(--wb-border)', background: 'var(--wb-panel)' }"
    >
      <div v-if="showTitle || showSubtitle" class="px-4 pb-3 pt-4">
        <!-- Two-line brand, version parked to the right so the footer stays
             lean (the transport is the only thing that belongs down there). -->
        <div v-if="showTitle" class="flex items-start justify-between gap-1">
          <div class="text-[13px] font-semibold leading-[1.2] tracking-tight whitespace-pre-line">
            {{ t('sidebar.brand') }}
          </div>
          <span
            v-if="cfg.version"
            class="wb-mono mt-0.5 text-[9.5px] leading-none"
            :style="{ color: 'var(--wb-muted)' }"
            >v{{ cfg.version }}</span
          >
        </div>
        <div
          v-if="showSubtitle"
          class="mt-1 text-[11px]"
          :style="{ color: 'var(--wb-muted)' }"
        >
          {{ t('sidebar.subtitle') }}
        </div>
      </div>

      <!--
        Which world am I in? The two clusters never share tokens, so this is a
        real fork rather than a filter. Setting it once here is the same as
        setting it everywhere — login, models, accounts, the catalog all
        follow.

        `mt-2` keeps the segmented control visually detached from whatever
        sits above it: when the host hides our sidebar brand (dsh), the gap
        stops the buttons from looking jammed against the sidebar's top
        edge; when the brand IS shown, it stops them from looking like a
        second line of the same paragraph.
      -->
      <div class="px-3 pb-3" :class="{ 'pt-2': showTitle, 'pt-3': !showTitle }">
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
          {{ t(tab.key) }}
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
      <div v-if="checkinAvailable" class="mt-auto px-2 pb-2">
        <button
          class="wb-btn w-full"
          :disabled="checkinBusy || checkinPending === 0"
          :title="`Claim the daily bonus for every account on both clusters (${checkinPending} left)`"
          @click="checkinAllRegions"
        >
          {{ checkinBusy ? t('sidebar.checkinAllBusy') : t('sidebar.checkinAll',
 { count: String(checkinPending) }) }}
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
        {{ t('sidebar.loading') }}
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
