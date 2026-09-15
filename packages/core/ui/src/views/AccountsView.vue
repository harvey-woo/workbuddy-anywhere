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
import { navigate } from "../lib/router";
import { useI18n } from "../lib/i18n";

const { t } = useI18n();
const copied = ref("");
const notice = ref("");
/** Already claimed today — the per-account button disables on this. */
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
/**
 * Auto-select: requests are allocated across accounts (expiry-first, sticky
 * per session). The manual selection REMAINS SHOWN (the SELECTED badge is
 * honest about what the stored pick is) but switching is disabled — auto has
 * higher priority than the manual pick, so the buttons would be lies.
 */
const autoOverride = ref<boolean | null>(null);
const autoOn = computed(() => autoOverride.value ?? settings.value?.autoSelectAccount ?? false);

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
  if (!c) return t("accounts.checkinPending");
  if (c.state === "claimed") {
    if (!c.credit) return t("accounts.checkinDone");
    const creditPart = t("accounts.checkinCredits", { credits: compact(c.credit) });
    return c.freshlyClaimed
      ? `${t("accounts.checkinDoneJustNow")} ${creditPart}`
      : `${t("accounts.checkinDone")} ${creditPart}`;
  }
  if (c.state === "unclaimed") return t("accounts.checkinPending");
  return c.error ? `unknown (${c.error})` : "unknown";
}

/** Already claimed today — the per-account button disables on this. */
function isClaimed(a: AccountSummary): boolean {
  return a.checkin?.state === "claimed";
}

/**
 * Whether THIS account's cluster has the check-in feature at all. The flags
 * live in settings (`checkinByRegion`, default {cn: true, intl: false});
 * a region without the feature renders no check-in status line and no
 * per-account check-in button — the feature does not exist there, so the
 * card must not pretend it does.
 */
function checkinEnabledFor(a: AccountSummary): boolean {
  const flags = state.value?.settings?.checkinByRegion;
  if (!flags) return true;
  return a.region === "intl" ? !!flags.intl : !!flags.cn;
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
    notice.value = t('accounts.removedNotice', { name: label });
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
            ? t('accounts.checkinJustNow', {
                credits: result.credit ? String(result.credit) : '',
              })
            : t('accounts.checkinAlreadyToday')
          : t('accounts.checkinUnavailable', { error: result.error ?? '' });
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
          {{ t('accounts.title') }} <span class="wb-pill ml-1">{{ regionLabel(region) }}</span>
        </h1>
        <p class="mt-0.5 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
          {{ t('accounts.regionHint', { region: regionLabel(region) }) }}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button class="wb-btn wb-btn-primary" @click="navigate('login')">{{ t('accounts.addAccount') }}</button>
        <button class="wb-btn" :disabled="busy || refreshing || !hasAccounts" @click="refreshAll">
          {{ refreshing ? t('accounts.refreshing') : t('accounts.refresh') }}
        </button>
      </div>
    </div>

    <!-- Auto account selection. Lives here, not in Settings: it changes what
         THIS list means — manual switching is disabled while it is on, and the
         status bar / tray report the region total instead of one account. -->
    <div class="wb-card mb-4 p-4">
      <ToggleSwitch
        :model-value="autoOn"
        :label="t('accounts.autoSelect')"
        :hint="t('accounts.autoSelectHint')"
        :disabled="busy"
        @update:model-value="setAuto"
      />
    </div>

    <!-- Total across accounts -->
    <div v-if="totals.reported > 0" class="wb-card mb-4 p-4">
      <div class="mb-2 flex items-baseline justify-between">
        <div class="text-[12px]" :style="{ color: 'var(--wb-muted)' }">
          {{ t('accounts.creditsRemaining', { count: String(totals.reported) }) }}
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
        {{ t('accounts.creditsOfTotal', { remain: num(totals.remain), size: num(totals.size) }) }}
      </div>
    </div>

    <p v-if="stateError" class="mb-3 text-[11.5px]" :style="{ color: 'var(--wb-danger)' }">
      {{ stateError }}
    </p>
    <p v-if="notice" class="mb-3 text-[11.5px]" :style="{ color: 'var(--wb-ok)' }">
      {{ notice }}
    </p>

    <div v-if="!hasAccounts" class="wb-card p-6 text-center">
      <div class="mb-3 text-[13px]">{{ t('accounts.noAccounts', { region: regionLabel(region) }) }}</div>
      <button class="wb-btn wb-btn-primary" @click="navigate('login')">
        {{ region === "intl" ? t('accounts.signInBrowser') : t('accounts.signInQR') }}
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
            :style="{ background: 'var(--wb-ok)', color: '#08130c' }">{{ t('accounts.selected') }}</span>
          <span v-if="a.expired" class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
            :style="{ background: 'var(--wb-warn)', color: '#1a1405' }">{{ t('accounts.tokenExpired') }}</span>
          <span class="ml-auto text-[11px]" :style="{ color: 'var(--wb-muted)' }">
            {{ t('accounts.expiresUntil', { date: shortDate(new Date(a.expiresAt ?? 0).toISOString()) }) }}
          </span>
        </div>

        <!-- Quota for THIS account -->
        <div class="mb-2">
          <template v-if="a.usage">
            <div class="mb-1 flex items-baseline justify-between">
              <span class="text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
                {{ t('accounts.creditsOfTotalWithPackages', {
                  remain: num(a.usage.remain),
                  size: num(a.usage.size),
                  packages: t('accounts.packages', { count: String(packagesOf(a).length) }),
                }) }}
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
            {{ t('accounts.quotaUnavailable') }}<span v-if="a.usageError"> — {{ a.usageError }}</span>
          </span>
        </div>

        <div class="mb-3 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
          <span v-if="checkinEnabledFor(a)" :style="{ color: a.checkin?.state === 'claimed' ? 'var(--wb-ok)' : undefined }">
            {{ checkinLabel(a) }}
          </span>
          <span>
            · {{ t('accounts.keyLabel') }} <code class="wb-mono">{{ a.key }}</code>
            <button
              class="wb-icon-btn ml-1"
              :title="copied === a.key ? t('accounts.copied') : t('accounts.copyKey')"
              :aria-label="t('accounts.copyKey')"
              @click="copy(a.key, a.key)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="5.2" y="5.2" width="8.6" height="8.6" rx="2"
                  fill="none" stroke="currentColor" stroke-width="1.3" />
                <path d="M10.8 3.6V3.2a1.2 1.2 0 0 0-1.2-1.2H3.2A1.2 1.2 0 0 0 2 3.2v6.4a1.2 1.2 0 0 0 1.2 1.2h.4"
                  fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              </svg>
            </button>
          </span>
        </div>

        <p v-if="a.refreshError" class="mb-2 text-[11px]"
          :style="{ color: 'var(--wb-danger)' }">
          {{ t('accounts.sessionRefreshFailed', { error: a.refreshError }) }}
        </p>

        <!-- Actions -->
        <div class="flex flex-wrap gap-2">
          <button
            class="wb-btn"
            :disabled="busy || a.active || autoOn"
            :title="autoOn ? t('accounts.autoSelect') : undefined"
            @click="switchTo(a.key)"
          >
            {{ a.active ? t('accounts.selected') : t('accounts.switchTo') }}
          </button>
          <button
            v-if="checkinEnabledFor(a)"
            class="wb-btn"
            :disabled="busy || isClaimed(a)"
            @click="checkinOne(a.key)"
          >
            {{
              checkingKey === a.key
                ? t('accounts.refreshing')
                : isClaimed(a)
                  ? t('accounts.checkinDone')
                  : t('accounts.checkin')
            }}
          </button>
          <button
            class="wb-btn"
            :disabled="!a.usage"
            @click="toggle(a.key)"
          >
            {{ expanded[a.key] ? "Hide packages" : t('accounts.packages', { count: String(packagesOf(a).length) }) }}
          </button>
          <button class="wb-btn wb-btn-danger" :disabled="busy" @click="remove(a.key, a.label)">
            {{ t('accounts.delete') }}
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
                    {{ t('accounts.noPackages') }}
                  </td>
                </tr>
                <tr
                  v-for="pkg in packagesOf(a)"
                  :key="pkg.accountId"
                  :style="isDepleted(pkg) ? { opacity: 0.55 } : undefined"
                >
                  <td>
                    {{ pkg.packageName || t('accounts.unnamedPackage') }}
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
  </section>
</template>
