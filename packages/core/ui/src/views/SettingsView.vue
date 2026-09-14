<script setup lang="ts">
/**
 * Settings page. Everything here is stored through the host's own settings
 * store — VS Code keeps them in `codebuddy.*` user settings (so nothing moves
 * for existing users), the server/desktop keep them in a JSON file next to the
 * session.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { ThinkingEffort } from "@core/settings";
import type { ServerStatus } from "@core/rpc";
import { call } from "../lib/client";
import { refreshState, run, settings } from "../lib/store";
import { runtimeConfig } from "../lib/config";
import { useI18n } from "../lib/i18n";
import { navigate } from "../lib/router";

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

// ── API server management (desktop only) ──────────────────────────────

const isDesktop = cfg.transport === "ipc";

/** Current server status from the main process. */
const server = ref<ServerStatus>({ running: false, port: 0, error: "" });
/** The port the user is editing (may differ from `server.value.port`). */
const editPort = ref(0);
/** Whether the port input has been changed from the saved value. */
const portDirty = computed(() => editPort.value !== server.value.port && editPort.value > 0);
const serverBusy = ref(false);

/** Load server status from the main process. */
async function loadServerStatus(): Promise<void> {
  if (!isDesktop) return;
  try {
    const s = (await call("getServerStatus")) as ServerStatus;
    server.value = s;
    editPort.value = s.port;
  } catch {
    // transport does not support this method — ignore
  }
}

/** Start the API server. */
async function startServer(): Promise<void> {
  if (serverBusy.value) return;
  serverBusy.value = true;
  try {
    const s = (await call("startServer")) as ServerStatus;
    server.value = s;
  } catch {
    // ignore
  } finally {
    serverBusy.value = false;
  }
}

/** Restart: save port, stop, then start with the new port. */
async function restartServer(): Promise<void> {
  if (serverBusy.value) return;
  serverBusy.value = true;
  try {
    // Save the new port first.
    await call("setServerPort", { port: editPort.value });
    // Stop the old server.
    await call("stopServer");
    // Start with the new port.
    const s = (await call("startServer")) as ServerStatus;
    server.value = s;
    notice.value = t("settings.saved", { label: t("settings.serverPort") });
    window.setTimeout(() => (notice.value = ""), 2000);
  } catch {
    // ignore
  } finally {
    serverBusy.value = false;
  }
}

/** Stop the API server. */
async function stopServer(): Promise<void> {
  if (serverBusy.value) return;
  serverBusy.value = true;
  try {
    const s = (await call("stopServer")) as ServerStatus;
    server.value = s;
  } catch {
    // ignore
  } finally {
    serverBusy.value = false;
  }
}

// Listen for server state changes pushed from the main process.
function onServerStateChanged(_event: unknown, state: ServerStatus): void {
  server.value = state;
  editPort.value = state.port;
}

onMounted(() => {
  void loadServerStatus();
  // Electron main process pushes state changes via this custom event.
  window.addEventListener("workbuddy:serverStateChanged", onServerStateChanged as EventListener);
});

onUnmounted(() => {
  window.removeEventListener("workbuddy:serverStateChanged", onServerStateChanged as EventListener);
});

// ── API docs link ─────────────────────────────────────────────────────

/**
 * The OpenAPI schema URL of the wbaw API service:
 *   - http transport (core serve)        -> `${baseUrl}/openapi.json`  (real)
 *   - ipc / vscode transport             -> `http://127.0.0.1:<port>/openapi.json`
 * Picked at render time so the same button always opens the schema that
 * matches the host the panel is actually running in.
 */
const apiDocsUrl = computed(() => {
  const base = cfg.baseUrl || (server.value.port ? `http://127.0.0.1:${server.value.port}` : "");
  return base ? base.replace(/\/$/, "") + "/docs" : "";
});

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

/** Open the API docs page in the system browser. */
async function openDocs(): Promise<void> {
  if (apiDocsUrl.value) openExternal(apiDocsUrl.value);
}
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

    <!--
      API server management — desktop app only.
      Shows port input, start/restart/stop buttons, and status/error.
    -->
    <div v-if="isDesktop" class="wb-card mb-4 p-4">
      <div class="mb-2 text-[12.5px] font-medium">{{ t('settings.serverTitle') }}</div>
      <p class="mb-3 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{ t('settings.serverHint') }}
      </p>

      <!-- Status badge -->
      <div class="mb-3 flex items-center gap-2 text-[11.5px]">
        <span
          class="inline-block h-2 w-2 rounded-full"
          :style="{ backgroundColor: server.running ? 'var(--wb-ok)' : server.error ? 'var(--wb-danger)' : 'var(--wb-muted)' }"
        />
        <span :style="{ color: server.running ? 'var(--wb-ok)' : server.error ? 'var(--wb-danger)' : 'var(--wb-muted)' }">
          {{ server.running ? t('settings.serverRunning', { port: String(server.port) }) : server.error ? t('settings.serverError') : t('settings.serverStopped') }}
        </span>
      </div>

      <!-- Error message -->
      <div
        v-if="server.error"
        class="mb-3 rounded-md border p-2 text-[11.5px]"
        :style="{ borderColor: 'var(--wb-danger)', color: 'var(--wb-danger)', backgroundColor: 'rgba(231,76,60,0.08)' }"
      >
        {{ server.error }}
      </div>

      <!-- Port input + action button -->
      <div class="flex items-end gap-3">
        <div class="flex-1">
          <label class="wb-label">{{ t('settings.serverPort') }}</label>
          <input
            type="number"
            class="wb-input"
            :value="editPort"
            min="1"
            max="65535"
            :disabled="serverBusy"
            @input="editPort = Number(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="flex gap-2 pb-0.5">
          <!-- Running: show Restart (if port changed) or Stop -->
          <template v-if="server.running">
            <button
              v-if="portDirty"
              type="button"
              class="wb-btn wb-btn-primary"
              :disabled="serverBusy"
              @click="restartServer"
            >
              {{ serverBusy ? t('settings.serverBusy') : t('settings.serverRestart') }}
            </button>
            <button
              type="button"
              class="wb-btn"
              :disabled="serverBusy"
              @click="stopServer"
            >
              {{ t('settings.serverStop') }}
            </button>
          </template>
          <!-- Stopped or error: show Start -->
          <button
            v-else
            type="button"
            class="wb-btn wb-btn-primary"
            :disabled="serverBusy || editPort < 1 || editPort > 65535"
            @click="startServer"
          >
            {{ serverBusy ? t('settings.serverBusy') : t('settings.serverStart') }}
          </button>
        </div>
      </div>
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
        :disabled="!server.running"
        @click="openDocs"
      >
        {{ t('settings.apiDocs') }}
      </button>
    </div>
  </section>
</template>
