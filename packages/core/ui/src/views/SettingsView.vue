<script setup lang="ts">
/**
 * Settings page. Everything here is stored through the host's own settings
 * store — VS Code keeps them in `codebuddy.*` user settings (so nothing moves
 * for existing users), the server/desktop keep them in a JSON file next to the
 * session.
 */
import { computed, onMounted, ref } from "vue";
import type { ThinkingEffort } from "@core/settings";
import { call } from "../lib/client";
import { refreshState, run, settings } from "../lib/store";
import { runtimeConfig } from "../lib/config";
import { useI18n } from "../lib/i18n";

const { t } = useI18n();
const cfg = runtimeConfig();
const notice = ref("");

const EFFORTS: Array<{ value: ThinkingEffort; key: string }> = [
  { value: "auto", key: "effort.auto" },
  { value: "low", key: "effort.low" },
  { value: "medium", key: "effort.medium" },
  { value: "high", key: "effort.high" },
  { value: "off", key: "effort.off" },
];

const visionSources = ref<string[]>([]);
const visionModels = ref<Array<{ id: string; label: string; source: string }>>([]);

const currentVision = computed(() => settings.value?.visionFallbackModel ?? "");
/** Stored value that this host no longer offers (e.g. after switching hosts). */
const visionStale = computed(
  () => !!currentVision.value && !visionModels.value.some((m) => m.id === currentVision.value)
);
const visionSourceLabel = computed(() => visionSources.value.join(", ") || "…");

async function save(patch: Record<string, unknown>, label: string): Promise<void> {
  const ok = await run(async () => {
    await call("updateSettings", patch);
    await refreshState();
  });
  if (ok !== undefined) notice.value = t("settings.saved", { label });
  window.setTimeout(() => (notice.value = ""), 2000);
}

/**
 * The OpenAPI schema URL of the wbaw API service:
 *   - http transport (core serve)        -> `${baseUrl}/openapi.json`  (real)
 *   - ipc / vscode transport             -> `http://127.0.0.1:8787/openapi.json`
 *                                          (assumes the user runs `core serve`
 *                                          separately — same default port
 *                                          `cli.ts` listens on)
 * Picked at render time so the same button always opens the schema that
 * matches the host the panel is actually running in.
 */
const openapiUrl = computed(
  () => (cfg.baseUrl ? cfg.baseUrl.replace(/\/$/, "") : "http://127.0.0.1:8787") + "/openapi.json"
);

/**
 * Open a URL in the system browser (or a new tab on plain http). We
 * always open via the host (`vscode.env.openExternal` /
 * `shell.openExternal`) because `window.open` inside the VS Code
 * webview opens a new Editor tab — not what the user wants. The http
 * transport has no host hook, so fall straight through to window.open.
 */
async function openExternal(url: string): Promise<void> {
  if (cfg.transport === "http") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    await call("openExternal", { url });
  } catch {
    // Last-resort fallback: Electron's setWindowOpenHandler routes this to
    // the system browser; in a plain browser fallback, it opens a new tab.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * The candidate list belongs to the HOST, not to this page: VS Code resolves
 * ids against its LM namespace, the desktop app against the account catalog.
 * Filtering `state.models` here would offer ids that never resolve.
 */
async function loadVisionModels(): Promise<void> {
  const res = await run(() => call("listVisionModels"));
  if (!res) return;
  visionSources.value = res.sources;
  visionModels.value = res.models;
}

onMounted(loadVisionModels);
</script>

<template>
  <section class="mx-auto max-w-[780px] p-5">
    <div class="mb-4 flex items-start justify-between gap-3">
      <div>
        <h1 class="text-[15px] font-semibold">{{ t('settings.title') }}</h1>
        <p class="mt-0.5 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
          {{ t('settings.regionHint') }}
        </p>
      </div>
      <span v-if="notice" class="text-[11.5px]" :style="{ color: 'var(--wb-ok)' }">
        {{ notice }}
      </span>
    </div>

    <div class="wb-card mb-4 p-4">
      <label class="wb-label">{{ t('settings.thinkingEffort') }}</label>
      <div class="mb-2 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{ t('settings.thinkingHint') }}
      </div>
      <select
        class="wb-select"
        :value="settings?.thinkingEffort ?? 'auto'"
        @change="save({ thinkingEffort: ($event.target as HTMLSelectElement).value }, t('settings.thinkingEffort'))"
      >
        <option v-for="effort in EFFORTS" :key="effort.value" :value="effort.value">
          {{ t(effort.key) }}
        </option>
      </select>
      <div class="mt-2 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{ t('settings.thinkingHint') }}
      </div>
    </div>

    <div class="wb-card mb-4 p-4">
      <label class="wb-label">{{ t('settings.visionFallback') }}</label>
      <div class="mb-2 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{ t('settings.visionHint', { source: visionSourceLabel }) }}
      </div>
      <select
        class="wb-select"
        :value="currentVision"
        @change="
          save(
            { visionFallbackModel: ($event.target as HTMLSelectElement).value },
            t('settings.visionFallback')
          )
        "
      >
        <option value="">{{ t('settings.visionAuto') }}</option>
        <option v-if="visionStale" :value="currentVision">
          {{ currentVision }} {{ t('settings.visionNotOffered') }}
        </option>
        <option v-for="m in visionModels" :key="m.id" :value="m.id">
          {{ m.label }} — {{ m.id }} ({{ m.source }})
        </option>
      </select>
      <div
        v-if="visionModels.length === 0"
        class="mt-2 text-[11.5px]"
        :style="{ color: 'var(--wb-muted)' }"
      >
        {{ t('settings.visionUnavailable') }}
      </div>
    </div>

    <!--
      Quick pointer for non-extension hosts: the management window is just
      a UI on top of an OpenAI-compatible local API. Open the docs in a
      browser to see every route and payload.
    -->
    <div v-if="cfg.transport !== 'vscode'" class="wb-card mb-4 p-4">
      <div class="mb-2 text-[12.5px] font-medium">{{ t('settings.apiTitle') }}</div>
      <p class="text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{ t('settings.apiHint') }}
      </p>
      <button
        type="button"
        class="wb-btn wb-btn-primary mt-3"
        @click="openExternal('https://github.com/harvey-woo/workbuddy-anywhere#api')"
      >
        {{ t('settings.apiDocs') }}
      </button>
    </div>
  </section>
</template>
