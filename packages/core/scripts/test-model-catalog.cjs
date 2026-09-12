#!/usr/bin/env node
/**
 * Regression test for `/v3/config` catalog parsing (`src/models.ts`).
 *
 * The fixture mirrors the REAL response shape (captured 2026-09-11): 29 models,
 * of which the `cli` agent lists 15 and one is an image-GENERATION model tagged
 * ["text-to-image","image-to-image"].
 *
 * The rules this pins down:
 *   - the picker offers the WHOLE catalog (the app does), and the agent's list
 *     only decides ORDER — restricting it to the agent's 15 silently hid models
 *     the app serves (hy4-preview-x, deepseek-v4-flash, glm-4.6, …);
 *   - non-chat entries (generation, `lite` helpers) are reported as excluded,
 *     never offered, and can be switched on explicitly via modelAllowlist;
 *   - a blacklist entry outranks a whitelist entry;
 *   - `disabledMultimodal` was dropped, so a deliberately text-only model
 *     still looked vision-capable;
 *   - `onlyReasoning` was dropped, so the UI could offer to "turn off"
 *     thinking on a model where the server will not allow it.
 *
 * Run: node scripts/test-model-catalog.cjs
 */

const assert = require("assert");

const { parseModelCatalog, pickAgent, applyModelOverrides } = require("../out/models.js");
const { DEFAULT_SETTINGS } = require("../out/settings.js");

const FIXTURE = {
  agents: [
    {
      name: "cli",
      models: ["hy3", "deepseek-v4.1-flash", "glm-5v-turbo", "glm-4.6", "hy4-preview-x"],
    },
  ],
  models: [
    {
      id: "hy3",
      name: "Hy3",
      maxInputTokens: 200000,
      maxOutputTokens: 8192,
      supportsImages: true,
      disabledMultimodal: false,
      supportsToolCall: true,
      supportsReasoning: true,
      onlyReasoning: true,
      reasoning: { effort: "high", defaultEffort: "high", supportedEfforts: ["low", "high"] },
    },
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      supportsImages: true,
      disabledMultimodal: false,
      supportsToolCall: true,
      supportsReasoning: true,
      onlyReasoning: true,
      temperature: 0.6,
      top_p: 0.9,
      descriptionZh: "中文描述",
      descriptionEn: "English description",
      vendor: "deepseek",
    },
    { id: "glm-5v-turbo", name: "GLM 5V Turbo", supportsImages: true, supportsToolCall: true },
    { id: "glm-4.6", name: "GLM 4.6", disabledMultimodal: true, supportsToolCall: true },
    { id: "hy4-preview-x", name: "hy4-preview-x", supportsImages: true, supportsToolCall: true },

    // In the catalog and NOT listed by the cli agent — still offered:
    { id: "glm-4.6v", name: "GLM 4.6V", supportsImages: true },
    // An internal helper (context summary, titles) — must not be offered:
    { id: "lite", name: "Lite", tags: ["lite"] },
    // ...and a generation model, which must never reach a chat picker:
    {
      id: "hunyuan-image-v3.0-art",
      name: "Hunyuan Image",
      tags: ["text-to-image", "image-to-image"],
    },
  ],
};

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log("parseModelCatalog()");
const parsed = parseModelCatalog(FIXTURE);

check("keeps every catalog entry", () => assert.strictEqual(parsed.models.length, 8));

const byId = Object.fromEntries(parsed.models.map((m) => [m.id, m]));

check("disabledMultimodal wins over a truthy supportsImages", () => {
  const glm46 = byId["glm-4.6"];
  assert.strictEqual(glm46.capabilities.imageInput, false);
  assert.strictEqual(glm46.capabilities.multimodalDisabled, true);
});

check("a vision model with no flag stays vision-capable", () => {
  assert.strictEqual(byId["glm-5v-turbo"].capabilities.imageInput, true);
});

check("onlyReasoning is surfaced", () => {
  assert.strictEqual(byId["hy3"].capabilities.reasoningOnly, true);
  assert.strictEqual(byId["glm-4.6"].capabilities.reasoningOnly, undefined);
});

check("sampling defaults are carried through", () => {
  assert.deepStrictEqual(byId["deepseek-v4.1-flash"].sampling, {
    temperature: 0.6,
    topP: 0.9,
  });
});

check("English description wins over Chinese", () => {
  assert.strictEqual(byId["deepseek-v4.1-flash"].description, "English description");
});

check("vendor is carried through", () => {
  assert.strictEqual(byId["deepseek-v4.1-flash"].vendor, "deepseek");
});

check("hy<N>-x gets a readable display name", () => {
  assert.strictEqual(byId["hy4-preview-x"].displayName, "Hy 4 Preview X");
});

check("no sampling block when the server sent neither field", () => {
  assert.strictEqual(byId["hy3"].sampling, undefined);
});

console.log("pickAgent() — the picker offers the catalog, the agent list orders it");
const picked = pickAgent(parsed, "cli");

check("an agent is found", () => assert.ok(picked));
check("every chat model is offered, in the agent's order first", () => {
  assert.deepStrictEqual(
    picked.models.map((m) => m.id),
    ["hy3", "deepseek-v4.1-flash", "glm-5v-turbo", "glm-4.6", "hy4-preview-x", "glm-4.6v"]
  );
});
check("models the agent does not list are STILL offered (app parity)", () => {
  assert.ok(picked.models.some((m) => m.id === "glm-4.6v"));
});
check("the image-generation model never reaches a chat picker", () => {
  assert.ok(!picked.models.some((m) => m.id === "hunyuan-image-v3.0-art"));
});
check("nor does an internal `lite` helper", () => {
  assert.ok(!picked.models.some((m) => m.id === "lite"));
});
check("non-chat entries are reported with a reason, not silently dropped", () => {
  const reasons = Object.fromEntries(picked.excluded.map((e) => [e.id, e.reason]));
  assert.strictEqual(reasons["hunyuan-image-v3.0-art"], "generation");
  assert.strictEqual(reasons["lite"], "helper");
  assert.strictEqual(reasons["glm-4.6v"], undefined);
});

console.log("pickAgent() — an agent that lists nothing changes only the order");
{
  const empty = parseModelCatalog({
    agents: [{ name: "cli", models: [] }],
    models: FIXTURE.models,
  });
  const fallback = pickAgent(empty, "cli");
  check("the whole chat catalog is still offered", () => {
    assert.strictEqual(fallback.models.length, 6);
  });
  check("but still never offers a non-chat model", () => {
    assert.ok(!fallback.models.some((m) => m.id === "hunyuan-image-v3.0-art"));
    assert.ok(!fallback.models.some((m) => m.id === "lite"));
  });
}

console.log("pickAgent() — agent fallback order");
{
  const noCli = parseModelCatalog({
    agents: [{ name: "other", models: ["glm-4.6"] }],
    models: FIXTURE.models,
  });
  const pickedOther = pickAgent(noCli, "cli");
  check("unknown preferred name falls back to the first agent", () => {
    assert.strictEqual(pickedOther.agent.name, "other");
  });
  check("and that agent's list still only sorts", () => {
    assert.strictEqual(pickedOther.models[0].id, "glm-4.6");
    assert.strictEqual(pickedOther.models.length, 6);
  });
}

console.log("parseModelCatalog() — hostile input");
check("undefined data yields an empty catalog", () => {
  const empty = parseModelCatalog(undefined);
  assert.deepStrictEqual(empty, { agents: [], models: [] });
});
check("missing model fields fall back to sane defaults", () => {
  const one = parseModelCatalog({ models: [{ id: "x" }] });
  assert.strictEqual(one.models[0].contextLength, 200_000);
  assert.strictEqual(one.models[0].maxOutputTokens, 8_192);
  assert.strictEqual(one.models[0].capabilities.toolCalling, true);
  assert.strictEqual(one.models[0].capabilities.imageInput, false);
});

console.log("applyModelOverrides() — the effective list (whitelist / blacklist)");
{
  const base = pickAgent(parsed, "cli");
  const withSettings = (patch) => ({ ...DEFAULT_SETTINGS, ...patch });
  const ids = (list) => list.map((m) => m.id);

  const plain = applyModelOverrides(base, withSettings({}));
  check("no overrides leaves the catalog exactly as served", () => {
    assert.deepStrictEqual(ids(plain.models), ids(base.models));
    assert.deepStrictEqual(plain.excluded.map((e) => e.id), base.excluded.map((e) => e.id));
  });

  const blocked = applyModelOverrides(base, withSettings({ modelBlocklist: ["hy3"] }));
  check("blacklist forces an included model OUT", () => {
    assert.ok(!ids(blocked.models).includes("hy3"));
  });
  check("and it stays visible, with its full config, so it can be switched back on", () => {
    const row = blocked.excluded.find((e) => e.id === "hy3");
    assert.strictEqual(row.reason, "blocked");
    assert.ok(row.displayName);
    assert.ok(row.contextLength > 0);
  });

  const allowed = applyModelOverrides(
    base,
    withSettings({ modelAllowlist: ["hunyuan-image-v3.0-art"] })
  );
  check("whitelist forces an excluded model back IN", () => {
    assert.ok(ids(allowed.models).includes("hunyuan-image-v3.0-art"));
    assert.ok(!allowed.excluded.some((e) => e.id === "hunyuan-image-v3.0-art"));
  });
  check("a whitelisted model keeps its real config, not the synthetic one", () => {
    const original = parsed.models.find((m) => m.id === "hunyuan-image-v3.0-art");
    const revived = allowed.models.find((m) => m.id === "hunyuan-image-v3.0-art");
    assert.strictEqual(revived.displayName, original.displayName);
    assert.deepStrictEqual(revived.tags, original.tags);
  });
  check("and a `lite` helper can be whitelisted too", () => {
    const withLite = applyModelOverrides(base, withSettings({ modelAllowlist: ["lite"] }));
    assert.ok(ids(withLite.models).includes("lite"));
  });

  const both = applyModelOverrides(
    base,
    withSettings({ modelAllowlist: ["hy3"], modelBlocklist: ["hy3"] })
  );
  check("blacklist wins when an id is in both lists", () => {
    assert.ok(!ids(both.models).includes("hy3"));
    assert.strictEqual(both.excluded.find((e) => e.id === "hy3").reason, "blocked");
  });

  const overCustom = applyModelOverrides(
    base,
    withSettings({
      customModels: [{ id: "my-model", displayName: "Mine" }],
      modelBlocklist: ["my-model"],
    })
  );
  check("blacklist beats a custom id too (it is applied last)", () => {
    assert.ok(!ids(overCustom.models).includes("my-model"));
  });
  check("custom ids are still added when not blocked", () => {
    const withCustom = applyModelOverrides(
      base,
      withSettings({ customModels: [{ id: "my-model", displayName: "Mine" }] })
    );
    assert.ok(ids(withCustom.models).includes("my-model"));
  });
  check("an allowlisted id the catalog never mentions still resolves", () => {
    const unknown = applyModelOverrides(base, withSettings({ modelAllowlist: ["brand-new"] }));
    assert.ok(ids(unknown.models).includes("brand-new"));
  });
}

console.log(`\n${passed} checks passed`);
