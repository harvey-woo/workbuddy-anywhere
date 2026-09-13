<script setup lang="ts">
/**
 * Model catalog page: what the gateway offers, plus the user's own extra IDs.
 *
 * `modelsSource` matters here — before sign-in the list is the PUBLIC catalog,
 * so the page says so instead of pretending it is the user's full entitlement.
 */
import { computed, ref } from "vue";
import type { ExclusionReason, ModelConfig } from "@core/models";
import { call } from "../lib/client";
import {
  models,
  refreshState,
  region,
  regionLabel,
  run,
  settings,
  state,
} from "../lib/store";
import { compact } from "../lib/format";
import ToggleSwitch from "../components/ToggleSwitch.vue";
import { useI18n } from "../lib/i18n";

const { t } = useI18n();

const filter = ref("");
const newId = ref("");
const newName = ref("");
const busyLabel = ref("");

/**
 * The Models page mirrors the global region setting: switch it in the sidebar
 * to inspect a different cluster's catalog. The Models page itself is a
 * viewer, not a switcher.
 */

/**
 * One row per model the catalog knows about, switched on or off.
 *
 * "Off" is what the effective list already does: the model is not a chat model
 * (image/video generation, or an internal `lite` helper), or the user turned it
 * off. Both are the SAME switch, and it is written to settings — so flipping it
 * changes the list the HOST receives (the VS Code picker, /v1/models), not just
 * this table:
 *   on  → force it INTO the list (modelAllowlist, a whitelist)
 *   off → force it OUT of the list (modelBlocklist, applied last so it wins)
 */
interface ModelRow {
  id: string;
  model: ModelConfig;
  on: boolean;
  reason?: ExclusionReason;
}

const rows = computed<ModelRow[]>(() => {
  const out: ModelRow[] = models.value.map((m) => ({ id: m.id, model: m, on: true }));
  for (const e of state.value?.excludedModels ?? []) {
    out.push({ id: e.id, model: e, on: false, reason: e.reason });
  }
  return out;
});

const offCount = computed(() => rows.value.filter((r) => !r.on).length);

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) =>
      r.id.toLowerCase().includes(q) || r.model.displayName.toLowerCase().includes(q)
  );
});

/** Short reason a row sits off, shown as a tag next to the switch. */
function offReason(row: ModelRow): string {
  if (row.reason === "blocked") return t("models.offBlocked");
  if (row.reason === "helper") return t("models.offHelper");
  return t("models.offMedia");
}

/**
 * Flip one model.
 *
 * Both lists are edited together so an id can never sit in the allowlist and
 * the blocklist at once: whichever way the switch was moved is the one that
 * takes effect.
 */
const setRow = (row: ModelRow, on: boolean): Promise<void> =>
  withBusy(`toggle:${row.id}`, async () => {
    const current = settings.value;
    if (!current) return;
    const allow = new Set(current.modelAllowlist ?? []);
    const deny = new Set(current.modelBlocklist ?? []);
    if (on) {
      allow.add(row.id);
      deny.delete(row.id);
    } else {
      deny.add(row.id);
      allow.delete(row.id);
    }
    await call("updateSettings", {
      modelAllowlist: [...allow],
      modelBlocklist: [...deny],
    });
    await refreshState();
  });

const customIds = computed(
  () => new Set((settings.value?.customModels ?? []).map((m) => m.id))
);

/**
 * The catalog's `credits` field has no enforced shape: servers may send
 * `"0.29"`, `"x0.29"`, `"0.29 credits"`, `"0.29×/req"`, etc. Strip known
 * noise (units, the multiplier symbol at either end, whitespace) so the
 * displayed form is always just `<num>×`.
 */
function costLabel(raw: string | undefined): string {
  if (!raw) return "—";
  const trimmed = raw
    .trim()
    .replace(/^(?:x|×)\s*/i, "")
    .replace(/\s*(?:x|×|credits?|per[\s-]?req(?:uest)?|\/req(?:uest)?|请求|积分)\s*$/i, "")
    .trim();
  if (!trimmed) return "—";
  // If what remains isn't numeric, fall back to the original minus its
  // trailing unit, so we never hide real information.
  return /^[0-9]+(?:\.[0-9]+)?$/.test(trimmed) ? `${trimmed}×` : raw.trim();
}

const sourceNote = computed(() => {
  const s = state.value;
  if (!s) return "";
  if (s.modelsSource === "auth") return t("models.sourceFromAccount");
  if (s.modelsSource === "anonymous") return t("models.sourcePublic");
  return t("models.sourceUnavailable");
});

async function withBusy(label: string, fn: () => Promise<void>): Promise<void> {
  busyLabel.value = label;
  await run(fn);
  busyLabel.value = "";
}

const refresh = (): Promise<void> =>
  withBusy("refresh", async () => {
    await call("refreshModels", { region: region.value });
    await refreshState(region.value);
  });

const add = (): Promise<void> =>
  withBusy("add", async () => {
    const id = newId.value.trim();
    if (!id) return;
    await call("addCustomModel", {
      id,
      displayName: newName.value.trim() || undefined,
    });
    newId.value = "";
    newName.value = "";
    await refreshState();
  });

const remove = (id: string): Promise<void> =>
  withBusy(`remove:${id}`, async () => {
    await call("removeCustomModel", { id });
    await refreshState();
  });

const setEnabled = (value: boolean): Promise<void> =>
  withBusy("toggle", async () => {
    await call("updateSettings", { enabled: value });
    await refreshState();
  });
</script>

<template>
  <section class="mx-auto max-w-[780px] p-5">
    <div class="mb-4 flex items-start justify-between gap-3">
      <div>
        <h1 class="text-[15px] font-semibold">
          {{ t('models.title') }} <span class="wb-pill ml-1">{{ regionLabel(region) }}</span>
        </h1>
        <p class="mt-0.5 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
          {{ t('models.regionHint') }}
        </p>
      </div>
      <button class="wb-btn" :disabled="!!busyLabel" @click="refresh">
        {{ busyLabel === "refresh" ? t('models.refreshing') : t('models.refreshFromServer') }}
      </button>
    </div>

    <div class="wb-card mb-4 p-4">
      <ToggleSwitch
        :model-value="settings?.enabled ?? true"
        :label="t('models.offerToHost')"
        :hint="t('models.offerHint')"
        :disabled="!!busyLabel"
        @update:model-value="setEnabled"
      />
    </div>

    <div class="wb-card mb-4 p-4">
      <div class="mb-2 flex items-baseline justify-between">
        <div class="text-[12.5px] font-medium">
          {{ t('models.title') }}
          <span class="wb-pill ml-1">{{ t('models.modelCount', { count: String(models.length) }) }}</span>
          <span v-if="offCount" class="wb-pill ml-1">{{ t('models.offCount', { count: String(offCount) }) }}</span>
        </div>
        <input v-model="filter" class="wb-input max-w-[220px]" :placeholder="t('models.filterPlaceholder')" />
      </div>
      <div class="text-[11.5px] mb-3" :style="{ color: 'var(--wb-muted)' }"
        >{{ sourceNote }} {{ t('models.sourceNote') }}</div
      >
      <!-- min-w-max + overflow-x-auto: the table keeps its natural column
           widths so capabilities pills never wrap; the wrapper scrolls
           horizontally on narrow viewports. -->
      <div class="overflow-x-auto">
        <table class="wb-table min-w-max">
          <thead>
            <tr>
              <th>{{ t('models.colModel') }}</th>
              <th>{{ t('models.colContext') }}</th>
              <th class="whitespace-nowrap">{{ t('models.colCapabilities') }}</th>
              <th>{{ t('models.colCost') }}</th>
              <th class="text-right">{{ t('models.colOn') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filtered" :key="row.id" :style="row.on ? undefined : { opacity: 0.45 }">
              <td>
                <div class="font-medium">{{ row.model.displayName }}</div>
                <div class="wb-mono" :style="{ color: 'var(--wb-muted)' }">{{ row.id }}</div>
                <div class="mt-1 flex items-center gap-1.5">
                  <span v-if="!row.on" class="wb-pill">{{ offReason(row) }}</span>
                  <button
                    v-if="customIds.has(row.id)"
                    class="wb-btn wb-btn-danger"
                    :disabled="!!busyLabel"
                    @click="remove(row.id)"
                  >
                    {{ t('models.remove') }}
                  </button>
                </div>
              </td>
              <td :style="{ color: 'var(--wb-muted)' }">
                {{ compact(row.model.contextLength) }}
                <span v-if="row.model.maxOutputTokens">
                  / {{ compact(row.model.maxOutputTokens) }} out</span
                >
              </td>
              <td class="whitespace-nowrap">
                <span
                  class="wb-pill mr-1"
                  :class="{ 'wb-pill-on': row.model.capabilities.toolCalling }"
                >
                  {{ t('models.capTools') }}
                </span>
                <span
                  class="wb-pill mr-1"
                  :class="{ 'wb-pill-on': row.model.capabilities.imageInput }"
                >
                  {{ t('models.capVision') }}
                </span>
                <span class="wb-pill" :class="{ 'wb-pill-on': row.model.capabilities.reasoning }">
                  {{ t('models.capThinking') }}
                </span>
                <span v-if="row.model.reasoningConfig?.defaultEffort" class="wb-pill ml-1">
                  {{ row.model.reasoningConfig.defaultEffort }}
                </span>
              </td>
              <td :style="{ color: 'var(--wb-muted)' }">
                {{ costLabel(row.model.credits) }}
              </td>
              <td class="text-right">
                <ToggleSwitch
                  :model-value="row.on"
                  :disabled="!!busyLabel"
                  @update:model-value="(value) => setRow(row, value)"
                />
              </td>
            </tr>
            <tr v-if="filtered.length === 0">
              <td colspan="5" :style="{ color: 'var(--wb-muted)' }">{{ t('models.noMatch') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="wb-card p-4">
      <div class="mb-2 text-[12.5px] font-medium">{{ t('models.customIds') }}</div>
      <div class="mb-3 text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{ t('models.customIdsHint') }}
      </div>
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-[180px] flex-1">
          <label class="wb-label">{{ t('models.modelId') }}</label>
          <input v-model="newId" class="wb-input" :placeholder="t('models.modelIdPlaceholder')" />
        </div>
        <div class="min-w-[140px] flex-1">
          <label class="wb-label">{{ t('models.displayName') }}</label>
          <input v-model="newName" class="wb-input" :placeholder="t('models.displayNamePlaceholder')" />
        </div>
        <button class="wb-btn wb-btn-primary" :disabled="!newId.trim() || !!busyLabel" @click="add">
          {{ t('models.add') }}
        </button>
      </div>
      <div v-if="settings?.customModels?.length" class="mt-3 flex flex-wrap gap-2">
        <span v-for="cm in settings.customModels" :key="cm.id" class="wb-pill">
          {{ cm.displayName || cm.id }}
          <button
            class="ml-1.5"
            :style="{ color: 'var(--wb-danger)' }"
            :disabled="!!busyLabel"
            @click="remove(cm.id)"
          >
            ×
          </button>
        </span>
      </div>
    </div>
  </section>
</template>
