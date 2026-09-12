<script setup lang="ts">
/**
 * Accounts — the management page, and the app's landing screen.
 *
 * It owns everything about the hosted accounts:
 *
 *   - who is signed in, and which one requests use by default;
 *   - quota per account, with the per-PACKAGE breakdown one expand away
 *     (a single number is not enough when an account holds several packs);
 *   - daily check-in, for one account or all of them at once;
 *   - the account key a client pastes into its API key field.
 *
 * The client-integration notes sit at the BOTTOM on purpose: they are setup
 * help, not day-to-day information.
 */
import { computed, onMounted, ref } from "vue";
import type { AccountSummary } from "@core/service";
import { call } from "../lib/client";
import ToggleSwitch from "../components/ToggleSwitch.vue";
import {
  accountsIn,
  busy,
  refreshState,
  region,
  regionLabel,
  run,
  settings,
  state,
  stateError,
} from "../lib/store";
import { compact, levelColor, num, pct, percentOf, shortDate } from "../lib/format";
import { runtimeConfig } from "../lib/config";
import { navigate } from "../lib/router";

const cfg = runtimeConfig();
const copied = ref("");
const notice = ref("");
/** Already claimed today — the per-account button disables on this. *//** The one account a check-in is currently running for (drives its own button). */
const checkingKey = ref("");
const refreshing = ref(false);
/** Which account cards have their package table expanded. */
const expanded = ref<Record<string, boolean>>({});

/**
 * Accounts are scoped to the currently selected region. The two clusters
 * have independent account universes (CN tokens are 401 on INTL billing and
 * vice-versa), so showing them in one list — or one active key — would
 * make the page misleading on either side.
 */
const accounts = computed(() => accountsIn(region.value));
const hasAccounts = computed(() => accounts.value.length > 0);
const marker = computed(() => state.value?.activeKey ?? "<account-key>");
/**
 * Auto-select: requests are allocated across accounts (expiry-first, sticky
 * per session). The manual selection REMAINS SHOWN (the SELECTED badge is
 * honest about what the stored pick is) but switching is disabled — auto has
 * higher priority than the manual pick, so the buttons would be lies.
 */
const autoOverride = ref<boolean | null>(null);
const autoOn = computed(() => autoOverride.value ?? settings.value?.autoSelectAccount ?? false);

/**
 * The URL a client should be pointed at. `baseUrl` is "" for the http
 * transport when the UI is served by the API itself — "same origin" is useless
 * as something to copy into another program, so use the real origin. INTL
 * users get `/intl/v1` so requests hit the international gateway.
 */
const baseUrl = computed(() => {
  const origin = cfg.baseUrl || window.location.origin;
  const prefix = region.value === "intl" ? "/intl" : "";
  return `${origin.replace(/\/$/, "")}${prefix}/v1`;
});

/** Across THIS region's accounts — the headline number for that cluster. */
const totals = computed(() => {
  let remain = 0;
  let size = 0;
  let reported = 0;
  for (const a of accounts.value) {
    if (!a.usage) continue;
    reported += 1;
    remain += a.usage.remain;
    size += a.usage.size;
  }
  return { remain, size, reported, percent: percentOf(remain, size) };
});

function toggle(key: string): void {
  expanded.value = { ...expanded.value, [key]: !expanded.value[key] };
}

/**
 * Every package on the account, ACTIVE ones first.
 *
 * Deliberately NOT filtered down to packages that still have credits: the point
 * of expanding this is to answer "where did my quota go", and a depleted
 * package is part of that answer. Filtering also produced a count that
 * contradicted the API — 3 shown for an account the gateway reports 7 packages
 * on.
 */
function packagesOf(a: AccountSummary) {
  const remaining = (p: { cycleCapacityRemain?: number; capacityRemain?: number }) =>
    p.cycleCapacityRemain ?? p.capacityRemain ?? 0;
  return [...(a.usage?.packages ?? [])].sort((x, y) => {
    const depleted = (remaining(x) > 0 ? 0 : 1) - (remaining(y) > 0 ? 0 : 1);
    if (depleted !== 0) return depleted;
    return (
      (Date.parse(x.cycleEndTime) || Number.POSITIVE_INFINITY) -
      (Date.parse(y.cycleEndTime) || Number.POSITIVE_INFINITY)
    );
  });
}

function isDepleted(p: { cycleCapacityRemain?: number; capacityRemain?: number }): boolean {
  return (p.cycleCapacityRemain ?? p.capacityRemain ?? 0) <= 0;
}

function checkinLabel(a: AccountSummary): string {
  const c = a.checkin;
  if (!c) return "not checked yet";
  if (c.state === "claimed") {
    return c.credit
      ? `checked in${c.freshlyClaimed ? " (just now)" : ""} +${compact(c.credit)}`
      : "checked in";
  }
  if (c.state === "unclaimed") return "not claimed yet";
  return c.error ? `unknown (${c.error})` : "unknown";
}

/** Already claimed today — the per-account button disables on this. */
function isClaimed(a: AccountSummary): boolean {
  return a.checkin?.state === "claimed";
}

async function copy(text: string, tag: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = tag;
    window.setTimeout(() => {
      if (copied.value === tag) copied.value = "";
    }, 1500);
  } catch {
    // Clipboard can be denied inside a webview; the value is selectable right
    // there, so there is nothing to recover from.
  }
}

async function switchTo(key: string): Promise<void> {
  notice.value = "";
  await run(async () => {
    await call("switchAccount", { key });
    await refreshState();
  });
}

/**
 * Flip auto-select. Never touches the stored selection — it stays shown.
 *
 * The switch flips OPTIMISTICALLY (before the RPC lands): a toggle that
 * waits for updateSettings + a state roundtrip before moving feels broken.
 * updateSettings returns the new Settings, so we patch the store directly —
 * no full refreshState (which would re-read everything for one flag).
 */
async function setAuto(value: boolean): Promise<void> {
  autoOverride.value = value;
  try {
    await run(async () => {
      const next = (await call("updateSettings", { autoSelectAccount: value })) as NonNullable<
        typeof state.value
      >["settings"];
      if (state.value) state.value.settings = next;
    });
  } finally {
    autoOverride.value = null;
  }
}

async function remove(key: string, label: string): Promise<void> {
  notice.value = "";
  await run(async () => {
    await call("removeAccount", { key });
    await refreshState();
    notice.value = `Removed ${label}.`;
  });
}

async function checkinOne(key: string): Promise<void> {
  notice.value = "";
  checkingKey.value = key;
  try {
    await run(async () => {
      const result = await call("checkin", { key });
      await refreshState();
      notice.value =
        result.state === "claimed"
          ? result.freshlyClaimed
            ? `Checked in${result.credit ? ` — +${result.credit} credits` : ""}.`
            : "Already checked in today."
          : `Check-in unavailable${result.error ? `: ${result.error}` : "."}`;
    });
  } finally {
    checkingKey.value = "";
  }
}

/** Re-read quota for every account without claiming anything. */
async function refreshAll(): Promise<void> {
  notice.value = "";
  refreshing.value = true;
  try {
    await run(async () => {
      await call("refreshAllUsage");
    });
  } finally {
    refreshing.value = false;
  }
}

onMounted(() => {
  // Deep-linking straight to #/accounts can beat the first state load.
  if (!state.value) void refreshState();
});
</script>

<template>
  <section class="mx-auto max-w-[780px] p-5">
    <div class="mb-4 flex items-start justify-between gap-3">
      <div>
        <h1 class="text-[15px] font-semibold">
          Accounts <span class="wb-pill ml-1">{{ regionLabel(region) }}</span>
        </h1>
        <p class="mt-0.5 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
          {{ regionLabel(region) }} accounts only. Switch the region in the
          sidebar to manage the other cluster.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button class="wb-btn wb-btn-primary" @click="navigate('login')">Add account</button>
        <button class="wb-btn" :disabled="busy || refreshing || !hasAccounts" @click="refreshAll">
          {{ refreshing ? "Refreshing…" : "Refresh" }}
        </button>
      </div>
    </div>

    <!-- Auto account selection. Lives here, not in Settings: it changes what
         THIS list means (manual switching disabled, AUTO badge on the account
         requests will use, status bar/tray show the region total). -->
    <div class="wb-card mb-4 p-4">
      <ToggleSwitch
        :model-value="autoOn"
        label="Auto-select account"
        hint="Allocate requests across accounts: credits that expire soonest are spent first, and one account serves a conversation (30 min of inactivity resets it). The manual selection below stays as a fallback but switching is disabled. An explicit account key in an API request still wins."
        :disabled="busy"
        @update:model-value="setAuto"
      />
    </div>

    <!-- Total across accounts -->
    <div v-if="totals.reported > 0" class="wb-card mb-4 p-4">
      <div class="mb-2 flex items-baseline justify-between">
        <div class="text-[12px]" :style="{ color: 'var(--wb-muted)' }">
          Credits remaining across {{ totals.reported }}
          {{ totals.reported === 1 ? "account" : "accounts" }}
        </div>
        <div>
          <span class="text-[17px] font-semibold" :style="{ color: 'var(--wb-ok)' }">{{ num(totals.remain) }}</span>
          <span class="ml-1 text-[10.5px]" :style="{ color: 'var(--wb-muted)' }">({{ pct(totals.percent) }})</span>
        </div>
      </div>
      <div class="mb-2 h-[6px] w-full overflow-hidden rounded-full"
        :style="{ background: 'var(--wb-panel-2)' }">
        <div class="h-full rounded-full transition-all" :style="{
          width: `${Math.min(100, Math.max(0, totals.percent))}%`,
          background: levelColor(totals.percent),
        }" />
      </div>
      <div class="text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{ num(totals.remain) }} / {{ num(totals.size) }} credits
      </div>
    </div>

    <p v-if="stateError" class="mb-3 text-[11.5px]" :style="{ color: 'var(--wb-danger)' }">
      {{ stateError }}
    </p>
    <p v-if="notice" class="mb-3 text-[11.5px]" :style="{ color: 'var(--wb-ok)' }">
      {{ notice }}
    </p>

    <div v-if="!hasAccounts" class="wb-card p-6 text-center">
      <div class="mb-3 text-[13px]">No {{ regionLabel(region) }} accounts yet.</div>
      <button class="wb-btn wb-btn-primary" @click="navigate('login')">
        {{ region === "intl" ? "Sign in via browser" : "Sign in with QR code" }}
      </button>
    </div>

    <!-- One card per account -->
    <div v-else class="flex flex-col gap-3">
      <div v-for="a in accounts" :key="a.key" class="wb-card p-4">
        <!-- Identity. The page is already region-scoped (the sidebar picks
             the cluster), so the per-account region badge is noise here. -->
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="text-[13.5px] font-medium">{{ a.label }}</span>
          <span v-if="a.active" class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
            :style="{ background: 'var(--wb-ok)', color: '#08130c' }">SELECTED</span>
          <span v-if="a.auto" class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
            :style="{ background: 'var(--wb-accent-soft)', color: 'var(--wb-accent)' }">AUTO</span>
          <span v-if="a.expired" class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
            :style="{ background: 'var(--wb-warn)', color: '#1a1405' }">TOKEN EXPIRED</span>
          <span class="ml-auto text-[11px]" :style="{ color: 'var(--wb-muted)' }">
            until {{ shortDate(new Date(a.expiresAt ?? 0).toISOString()) }}
          </span>
        </div>

        <!-- Quota for THIS account -->
        <div class="mb-2">
          <template v-if="a.usage">
            <div class="mb-1 flex items-baseline justify-between">
              <span class="text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
                {{ num(a.usage.remain) }} / {{ num(a.usage.size) }} credits ·
                {{ packagesOf(a).length }}
                {{ packagesOf(a).length === 1 ? "package" : "packages" }}
              </span>
              <span class="whitespace-nowrap">
                <span class="text-[13px] font-semibold" :style="{ color: 'var(--wb-ok)' }">{{ num(a.usage.remain) }}</span>
                <span class="ml-1 text-[10.5px]" :style="{ color: 'var(--wb-muted)' }">({{ pct(a.usage.percent) }})</span>
              </span>
            </div>
            <div class="h-[5px] w-full overflow-hidden rounded-full"
              :style="{ background: 'var(--wb-panel-2)' }">
              <div class="h-full rounded-full transition-all" :style="{
                width: `${Math.min(100, Math.max(0, a.usage.percent))}%`,
                background: levelColor(a.usage.percent),
              }" />
            </div>
          </template>
          <span v-else class="text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
            quota unavailable<span v-if="a.usageError"> — {{ a.usageError }}</span>
          </span>
        </div>

        <div class="mb-3 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
          <span :style="{ color: a.checkin?.state === 'claimed' ? 'var(--wb-ok)' : undefined }">
            {{ checkinLabel(a) }}
          </span>
          <span> · key <code class="wb-mono">{{ a.key }}</code></span>
        </div>

        <p v-if="a.refreshError" class="mb-2 text-[11px]"
          :style="{ color: 'var(--wb-danger)' }">
          Session refresh failed: {{ a.refreshError }}
        </p>

        <!-- Actions -->
        <div class="flex flex-wrap gap-2">
          <button
            class="wb-btn"
            :disabled="busy || a.active || autoOn"
            :title="autoOn ? 'Auto-select is on — requests are allocated automatically' : undefined"
            @click="switchTo(a.key)"
          >
            {{ a.active ? "Selected" : autoOn ? "Auto" : "Use this account" }}
          </button>
          <button
            class="wb-btn"
            :disabled="busy || isClaimed(a)"
            @click="checkinOne(a.key)"
          >
            {{
              checkingKey === a.key
                ? "Checking in…"
                : isClaimed(a)
                  ? "Checked in"
                  : "Check in"
            }}
          </button>
          <button
            class="wb-btn"
            :disabled="!a.usage"
            :title="
              a.usage
                ? undefined
                : a.usageError
                  ? `Quota unavailable — ${a.usageError}. Click Refresh to retry.`
                  : 'Quota has not been read yet. Click Refresh.'
            "
            @click="toggle(a.key)"
          >
            {{ expanded[a.key] ? "Hide packages" : `Packages (${packagesOf(a).length})` }}
          </button>
          <button class="wb-btn" @click="copy(a.key, a.key)">
            {{ copied === a.key ? "Copied" : "Copy key" }}
          </button>
          <button class="wb-btn wb-btn-danger" :disabled="busy" @click="remove(a.key, a.label)">
            Sign out
          </button>
        </div>

        <!-- Package detail: where the credits actually come from -->
        <div v-if="expanded[a.key]" class="mt-3 border-t pt-3"
          :style="{ borderColor: 'var(--wb-border)' }">
          <div class="wb-table-scroll">
            <table class="wb-table">
              <thead>
                <tr>
                  <th>Package</th>
                  <th class="text-right">Remaining</th>
                  <th class="text-right">Used</th>
                  <th class="text-right">Expires</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="packagesOf(a).length === 0">
                  <td colspan="4" :style="{ color: 'var(--wb-muted)' }">
                    No packages on this account.
                  </td>
                </tr>
                <tr
                  v-for="pkg in packagesOf(a)"
                  :key="pkg.accountId"
                  :style="isDepleted(pkg) ? { opacity: 0.55 } : undefined"
                >
                  <td>
                    {{ pkg.packageName || "(unnamed)" }}
                    <span v-if="pkg.packageCode" class="wb-mono ml-1"
                      :style="{ color: 'var(--wb-muted)' }">{{ pkg.packageCode }}</span>
                    <span v-if="isDepleted(pkg)"
                      :style="{ color: 'var(--wb-muted)' }"> · used up</span>
                  </td>
                  <td class="text-right">
                    {{ num(pkg.cycleCapacityRemain ?? pkg.capacityRemain) }} /
                    {{ num(pkg.cycleCapacitySize ?? pkg.capacitySize) }}
                  </td>
                  <td class="text-right">
                    {{ pct(100 - percentOf(
                      pkg.cycleCapacityRemain ?? pkg.capacityRemain ?? 0,
                      pkg.cycleCapacitySize ?? pkg.capacitySize ?? 0), 0) }}
                  </td>
                  <td class="text-right" :style="{ color: 'var(--wb-muted)' }">
                    {{ shortDate(pkg.cycleEndTime) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Catalog diagnostics: "where did my model go?" should have an answer. -->
    <div v-if="state?.catalogError" class="wb-card mt-4 p-4">
      <div class="mb-1 text-[12.5px] font-medium" :style="{ color: 'var(--wb-danger)' }">
        Model catalog could not be refreshed
      </div>
      <p class="wb-mono text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{ state.catalogError }}
      </p>
    </div>
    <p v-else-if="state" class="mt-4 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
      {{ state.models.length }} models offered ·
      {{ state.excludedModels.length }} withheld
      (image / video generation, internal helper models, or models you turned off — switch any
      of them on under Models).
    </p>

    <!-- Setup help, deliberately last -->
    <details v-if="hasAccounts" class="mt-5">
      <summary class="cursor-pointer text-[12px]" :style="{ color: 'var(--wb-muted)' }">
        Using these accounts from a client
      </summary>
      <div class="wb-card mt-2 p-4">
        <p class="mb-3 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
          Point an OpenAI-compatible client at
          <code class="wb-mono">{{ baseUrl }}</code> and paste an account's key
          into its API key field — the key goes in the standard
          <code class="wb-mono">Authorization: Bearer</code> slot, so no custom
          configuration is needed. Leave it empty to use the selected account.
          An unknown key is rejected rather than silently charged to another
          account.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <code class="wb-mono rounded px-2 py-1 text-[11.5px]"
            :style="{ background: 'var(--wb-panel)' }">{{ marker }}</code>
          <button class="wb-btn" @click="copy(marker, 'key')">
            {{ copied === "key" ? "Copied" : "Copy key" }}
          </button>
        </div>
      </div>
    </details>
  </section>
</template>
