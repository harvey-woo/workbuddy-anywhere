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

const cfg = runtimeConfig();
const notice = ref("");

const EFFORTS: Array<{ value: ThinkingEffort; label: string; hint: string }> = [
  { value: "auto", label: "Auto", hint: "Per-model default from the server" },
  { value: "low", label: "Low", hint: "Minimal thinking, fastest" },
  { value: "medium", label: "Medium", hint: "Balanced thinking" },
  { value: "high", label: "High", hint: "Deep thinking, slower" },
  { value: "off", label: "Off", hint: "Disable reasoning entirely" },
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
  if (ok !== undefined) notice.value = `${label} saved`;
  window.setTimeout(() => (notice.value = ""), 2000);
}

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
    <!-- Settings are GLOBAL (thinking effort, vision fallback, auto-select,
         curl example) — not scoped to one cluster — so there is no region
         pill in the header. The header still follows the same h1 + muted
         description shape as the region-scoped pages. -->
    <div class="mb-4 flex items-start justify-between gap-3">
      <div>
        <h1 class="text-[15px] font-semibold">Settings</h1>
        <p class="mt-0.5 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
          These options apply to both clusters.
        </p>
      </div>
      <span v-if="notice" class="text-[11.5px]" :style="{ color: 'var(--wb-ok)' }">
        {{ notice }}
      </span>
    </div>

    <div class="wb-card mb-4 p-4">
      <label class="wb-label">Thinking effort</label>
      <div class="mb-2 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{
          EFFORTS.find((e) => e.value === settings?.thinkingEffort)?.hint ??
          "Per-model default from the server"
        }}
      </div>
      <select
        class="wb-select"
        :value="settings?.thinkingEffort ?? 'auto'"
        @change="save({ thinkingEffort: ($event.target as HTMLSelectElement).value }, 'Thinking effort')"
      >
        <option v-for="effort in EFFORTS" :key="effort.value" :value="effort.value">
          {{ effort.label }} — {{ effort.hint }}
        </option>
      </select>
      <div class="mt-2 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        Per-model overrides from the host's model configuration menu take priority.
      </div>
    </div>

    <div class="wb-card mb-4 p-4">
      <label class="wb-label">Vision fallback model</label>
      <div class="mb-2 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        When the selected model cannot accept images, this model describes them
        instead. Candidates come from
        <span class="wb-mono">{{ visionSourceLabel }}</span>.
      </div>
      <select
        class="wb-select"
        :value="currentVision"
        @change="
          save(
            { visionFallbackModel: ($event.target as HTMLSelectElement).value },
            'Vision fallback model'
          )
        "
      >
        <option value="">Auto — first available model</option>
        <option v-if="visionStale" :value="currentVision">
          {{ currentVision }} (not offered by this host)
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
        No image-describing model is available here, so an image sent to a
        non-vision model cannot be described.
      </div>
    </div>

    <!--
      Quick pointer for non-extension hosts: the management window is just
      a UI on top of an OpenAI-compatible local API. Open the docs in a
      browser to see every route and payload.
    -->
    <div v-if="cfg.transport !== 'vscode'" class="wb-card mb-4 p-4">
      <div class="mb-2 text-[12.5px] font-medium">Using WorkBuddy from another tool</div>
      <p class="text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        WorkBuddy serves an OpenAI-compatible API on this machine — sign in
        here once, then point any HTTP-capable client (Claude Code,
        OpenAI&nbsp;SDK, curl, your editor's AI assistant) at the base URL
        printed on the Accounts page and use an account key as the bearer
        token. Pick the matching regional path for international accounts.
      </p>
      <button
        type="button"
        class="wb-btn wb-btn-primary mt-3"
        @click="openExternal('https://github.com/harvey-woo/workbuddy-anywhere#api')"
      >
        Open the API docs ↗
      </button>
    </div>
  </section>
</template>
