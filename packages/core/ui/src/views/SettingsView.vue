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
 * The URL the curl example should use. Same-origin for the browser / http
 * transport; for VS Code / Electron the host has no real loopback server so
 * the example shows a placeholder and the API link switches to a hint.
 */
const origin = computed(() => {
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin.replace(/\/$/, "");
  return "http://127.0.0.1:8787";
});

/**
 * Open a URL through the host: `vscode.env.openExternal` in the extension,
 * `shell.openExternal` in Electron, `window.open` in a plain browser.
 *
 * The http transport (the standalone `core serve` web UI) has NO
 * openExternal hook on the server — the RPC throws "no browser to open"
 * — but the browser itself opens URLs trivially. Skip the round-trip and
 * call window.open directly there.
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
      Local API reference. Always rendered (the desktop/ipc transport has
      no /docs route, but the guide + key + curl example are useful in every
      host). The docs/openapi links open through the host (vscode.env or
      shell.openExternal) so they leave the webview instead of replacing it.
    -->
    <div class="wb-card mb-4 p-4">
      <div class="mb-2 text-[12.5px] font-medium">Using WorkBuddy from another tool</div>
      <p class="mb-3 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        Every account exposes an OpenAI-compatible API. The bearer token IS the
        account key shown on the Accounts page; the base URL is the host's
        loopback address, with the regional path prefix for the international
        cluster.
      </p>
      <pre
        class="wb-mono overflow-x-auto rounded p-2 text-[11px]"
        :style="{ background: 'var(--wb-panel-2)', color: 'var(--wb-text)' }"
      ><span v-if="cfg.baseUrl">BASE_URL={{ baseUrl }}&#10;</span><span v-else># BASE_URL — see the Accounts page for the host's loopback address&#10;</span>AUTH=&lt;account-key-from-Accounts-page&gt;
curl -sS -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d '{"model":"&lt;model-id&gt;","messages":[{"role":"user","content":"hi"}]}'</pre>
      <div class="mt-2 flex flex-wrap items-center gap-3 text-[11.5px]">
        <a
          v-if="cfg.transport === 'http'"
          href="/docs"
          target="_blank"
          rel="noreferrer"
          :style="{ color: 'var(--wb-accent)' }"
          @click.prevent="openExternal(`${origin}/docs`)"
        >/docs</a>
        <a
          v-if="cfg.transport === 'http'"
          href="/openapi.json"
          target="_blank"
          rel="noreferrer"
          :style="{ color: 'var(--wb-accent)' }"
          @click.prevent="openExternal(`${origin}/openapi.json`)"
        >/openapi.json</a>
        <!--
          Not an anchor on purpose: an <a href="#"> would actually navigate
          the SPA back to the default route (accounts) when the user clicks
          the muted hint, which is exactly the wrong UX. Plain text is honest
          about "this is not clickable".
        -->
        <span
          v-else
          :style="{ color: 'var(--wb-muted)' }"
          :title="`No HTTP server in ${cfg.transport} transport — see the curl example above for the call shape`"
        >API docs available in HTTP transport</span>
      </div>
    </div>

    <div class="wb-card p-4">
      <div class="mb-2 text-[12.5px] font-medium">About</div>
      <table class="wb-table">
        <tbody>
          <tr>
            <td :style="{ color: 'var(--wb-muted)' }">Transport</td>
            <td class="wb-mono">{{ cfg.transport }}</td>
          </tr>
          <tr v-if="cfg.version">
            <td :style="{ color: 'var(--wb-muted)' }">Version</td>
            <td class="wb-mono">{{ cfg.version }}</td>
          </tr>
          <tr>
            <td :style="{ color: 'var(--wb-muted)' }">Model source</td>
            <td class="wb-mono">{{ state?.modelsSource ?? "—" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
