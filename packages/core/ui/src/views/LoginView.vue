<script setup lang="ts">
/**
 * Sign-in page.
 *
 * The two regions share one state/poll protocol (verified 2026-09-11: the
 * international cluster serves `/v2/plugin/auth/*` on `www.workbuddy.ai` with
 * `platform=workbuddy-ai`), so both panels poll; only the presentation
 * differs — CN shows a QR for the scan, INTL opens the login page in the
 * browser where the user picks Google / GitHub / X themselves.
 *
 * The UI drives the polling loop itself so a single implementation serves all
 * three transports, the countdown stays honest, and no request is left open
 * for minutes.
 */
import { computed, onBeforeUnmount, ref } from "vue";
import QRCode from "qrcode";
import type { LoginStart } from "@core/service";
import { call, errorMessage } from "../lib/client";
import { refreshState, region, regionLabel } from "../lib/store";
import { countdown } from "../lib/format";
import { runtimeConfig } from "../lib/config";
import { navigate } from "../lib/router";
import { useI18n } from "../lib/i18n";

const { t } = useI18n();

type Phase = "idle" | "waiting" | "success" | "expired" | "error";

const isIntl = computed(() => region.value === "intl");

const cfg = runtimeConfig();
const phase = ref<Phase>("idle");
const message = ref("");
const authUrl = ref("");
const qrSvg = ref("");
const expiresAt = ref(0);
const now = ref(Date.now());
const copied = ref(false);

let pollTimer: number | undefined;
let tickTimer: number | undefined;
let pollIntervalMs = 2000;

const left = computed(() => Math.max(0, expiresAt.value - now.value));

function stop(): void {
  window.clearTimeout(pollTimer);
  window.clearInterval(tickTimer);
  pollTimer = undefined;
  tickTimer = undefined;
}

async function expire(): Promise<void> {
  if (phase.value !== "waiting") return;
  stop();
  phase.value = "expired";
  message.value = t("login.expired");
}

// React to global region changes: reset the in-flight login so a stale
// state from the previous region never gets polled against the new cluster.
import { watch } from "vue";
watch(region, () => {
  if (phase.value !== "waiting") return;
  stop();
  phase.value = "idle";
  message.value = "";
  authUrl.value = "";
  qrSvg.value = "";
});

async function poll(): Promise<void> {
  if (phase.value !== "waiting") return;
  if (Date.now() >= expiresAt.value) {
    await expire();
    return;
  }
  try {
    const res = await call("pollLogin", { region: region.value });
    if (phase.value !== "waiting") return;
    if (res.status === "success") {
      await succeed(res.nickname);
      return;
    }
    if (res.status === "expired") {
      await expire();
      return;
    }
  } catch {
    // Transient (network hiccup, gateway restart): keep polling silently.
  }
  pollTimer = window.setTimeout(() => void poll(), pollIntervalMs);
}

async function succeed(nickname?: string): Promise<void> {
  stop();
  phase.value = "success";
  message.value = nickname ? t("login.signedInAs", { nickname }) : t("login.signedIn");
  await refreshState();
  window.setTimeout(() => navigate("accounts"), 700);
}

/** Open `url` in the user's browser, falling back to a tab when the host has no shell. */
function openUrl(url: string): void {
  if (cfg.transport === "http") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void call("openExternal", { url }).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

/**
 * One entry point for both clusters: the global `region` decides which
 * `/v2/plugin/auth/state?platform=...` the service hits, and the response's
 * authUrl/polling is the same shape on both sides. The only UI difference is
 * CN renders a QR; INTL opens the login page in the user's browser.
 */
async function begin(): Promise<void> {
  stop();
  copied.value = false;
  qrSvg.value = "";
  phase.value = "waiting";
  message.value = t("login.requestingLink");

  let start: LoginStart;
  try {
    start = await call("startLogin", { region: region.value });
  } catch (err) {
    phase.value = "error";
    message.value = errorMessage(err);
    return;
  }

  authUrl.value = start.authUrl;
  if (region.value === "cn") {
    qrSvg.value = await QRCode.toString(start.authUrl, {
      type: "svg",
      margin: 1,
      width: 176,
      errorCorrectionLevel: "M",
    });
    message.value = t("login.waitingScan");
  } else {
    openUrl(start.authUrl);
    message.value = t("login.completeInBrowser");
  }
  pollIntervalMs = Math.max(1000, start.pollIntervalMs);
  expiresAt.value = Date.now() + start.expiresInMs;
  tickTimer = window.setInterval(() => {
    now.value = Date.now();
    if (phase.value === "waiting" && left.value <= 0) void expire();
  }, 500);
  void poll();
}

function openExternally(): void {
  if (cfg.transport === "http") {
    window.open(authUrl.value, "_blank", "noopener,noreferrer");
    return;
  }
  void call("openExternal", { url: authUrl.value }).catch(() => {
    window.open(authUrl.value, "_blank", "noopener,noreferrer");
  });
}

async function copyUrl(): Promise<void> {
  try {
    await navigator.clipboard.writeText(authUrl.value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard access can be denied inside a webview; the URL is visible and
    // selectable right above, so there is nothing to recover from.
  }
}

onBeforeUnmount(stop);
</script>

<template>
  <section class="mx-auto max-w-[600px] p-5">
    <div class="mb-4">
      <h1 class="text-[15px] font-semibold">
        {{ t('login.title') }} <span class="wb-pill ml-1">{{ regionLabel(region) }}</span>
      </h1>
      <p class="mt-0.5 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{ t('login.regionHint') }}
      </p>
    </div>

    <!--
      One sign-in UI for both regions. CN renders a QR (the cluster's scan
      page); INTL opens the login page in the user's browser where they
      pick an identity provider. The /v2/plugin/auth/* protocol is the same
      on both sides, so a single state/poll loop covers both.
    -->
    <div class="wb-card p-5">
      <div v-if="qrSvg" class="flex gap-5">
        <div class="h-fit shrink-0 rounded-lg bg-white p-3">
          <div class="wb-qr" v-html="qrSvg" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="mb-1 text-[12.5px] font-medium">
            {{ t('login.scanQR') }}
          </div>
          <div
            class="wb-mono mb-3 break-all"
            :style="{ color: 'var(--wb-muted)' }"
          >
            {{ authUrl }}
          </div>
          <div class="flex flex-wrap gap-2">
            <button class="wb-btn" @click="openExternally">{{ t('login.openInBrowser') }}</button>
            <button class="wb-btn" @click="copyUrl">
              {{ copied ? t('login.copiedUrl') : t('login.copyUrl') }}
            </button>
            <button v-if="phase !== 'waiting'" class="wb-btn wb-btn-primary" @click="void begin()">
              {{ t('login.tryAgain') }}
            </button>
          </div>
          <div class="mt-3 flex items-center gap-2 text-[12px]">
            <span
              v-if="phase === 'waiting'"
              class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent"
              :style="{ color: 'var(--wb-muted)' }"
            />
            <span
              :style="{
                color:
                  phase === 'success'
                    ? 'var(--wb-ok)'
                    : phase === 'expired' || phase === 'error'
                      ? 'var(--wb-danger)'
                      : 'var(--wb-muted)',
              }"
            >
              {{ message }}
              <span v-if="phase === 'waiting'"> · {{ countdown(left) }}</span>
            </span>
          </div>
        </div>
      </div>

      <div v-else>
        <div class="mb-3 text-[12.5px]">
          <template v-if="isIntl">
            {{ t('login.completeInBrowser') }}
          </template>
          <template v-else>
            {{ t('login.scanQR') }}
          </template>
        </div>
        <button
          v-if="!authUrl"
          class="wb-btn wb-btn-primary"
          :disabled="phase === 'waiting'"
          @click="void begin()"
        >
          {{ isIntl ? t('login.openInBrowser') : t('login.scanQR') }}
        </button>
        <div v-else class="mt-3 break-all font-mono text-[11px]" :style="{ color: 'var(--wb-muted)' }">
          {{ authUrl }}
        </div>
        <div class="mt-3 flex items-center gap-2 text-[12px]">
          <span
            v-if="phase === 'waiting'"
            class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent"
            :style="{ color: 'var(--wb-muted)' }"
          />
          <span
            :style="{
              color:
                phase === 'success'
                  ? 'var(--wb-ok)'
                  : phase === 'expired' || phase === 'error'
                    ? 'var(--wb-danger)'
                    : 'var(--wb-muted)',
            }"
          >
            {{ message }}
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.wb-qr :deep(svg) {
  display: block;
  width: 176px;
  height: 176px;
}
</style>
