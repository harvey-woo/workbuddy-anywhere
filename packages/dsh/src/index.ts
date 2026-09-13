/**
 * DeepSeek Harness (dsh) plugin entry — WorkBuddy Anywhere LLM adapter.
 *
 * This is the Cordis plugin shape dsh loads: `name` + `inject` + `Config` +
 * `apply`. It mirrors the VS Code Copilot extension one-for-one in spirit:
 * both reuse `@wbaw/core`'s `WorkbuddyService` in-process and only add the
 * host-specific glue (here, the dsh LLM seam; there, the VS Code
 * `LanguageModelChatProvider` seam).
 *
 * The two provider routes (`workbuddy` / `workbuddy-intl`) correspond to the
 * two vendors copilot registers, and the model catalog is written into dsh's
 * configuration by serving it from `resolveModel` / `listModels` — so dsh's
 * Models settings page lists WorkBuddy models without any lifecycle change.
 */

import type { Context } from "@deepseek-ai/cordis";
import * as os from "node:os";
import * as path from "node:path";
import { FileAuthStore, FileSettingsStore, WorkbuddyService } from "@wbaw/core";
import z from "@deepseek-ai/schemastery";
import { WorkbuddyAdapter, toDiscoveredModel } from "./adapter.js";
import { registerWorkbuddyWeb } from "./webui.js";
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from "@deepseek-ai/dsh-llm";

/** Same data directory the desktop app and `wbaw serve` use, so login is shared. */
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".workbuddy-anywhere");

/** One dsh provider route per WorkBuddy cluster. */
const ROUTES = [
  { route: "workbuddy", region: "cn" as const, displayName: "WorkBuddy Anywhere" },
  { route: "workbuddy-intl", region: "intl" as const, displayName: "WorkBuddy Anywhere (Global)" },
];

export const name = "@wbaw/dsh-workbuddy";
// `llm` for the adapter seam; `webServer` to serve the management UI + RPC.
export const inject = ["llm", "webServer"];

/**
 * Serve the WorkBuddy model catalog to dsh's Models settings page. dsh calls
 * `discoverModels(settingsNs, request)` per configurable provider; we branch on
 * `request.provider` to the right cluster and return the cached catalog from
 * `@wbaw/core`. This is the dsh equivalent of the Copilot extension writing the
 * model list into VS Code's LanguageModelChat picker.
 */
async function discoverWorkbuddyModels(
  service: WorkbuddyService,
  request: LlmModelDiscoveryRequest
): Promise<LlmDiscoveredModel[]> {
  const region = request.provider === "workbuddy-intl" ? "intl" : "cn";
  const state = await service.getState(region);
  return state.models.map((m) => toDiscoveredModel(m, request.provider ?? ""));
}

export interface Config {
  /** Data directory holding `codebuddy-auth.json` / `workbuddy-settings.json`. */
  dataDir?: string;
  /** Subset of provider routes to activate. */
  providers?: string[];
}

export const Config: z<Config> = z.object({
  dataDir: z.string().default(DEFAULT_DATA_DIR),
  providers: z.array(z.string()).default(ROUTES.map((r) => r.route)),
});

export function apply(ctx: Context, config: Config): void {
  const dir = config.dataDir || DEFAULT_DATA_DIR;
  const auth = new FileAuthStore(dir);
  const settings = new FileSettingsStore(dir);
  const service = new WorkbuddyService({
    auth,
    settings,
    log: (msg) => {
      const logger = (ctx as unknown as { logger?: { debug?: (s: string) => void } }).logger;
      if (logger?.debug) logger.debug(`[workbuddy] ${msg}`);
    },
  });

  // Start the 60s token-refresh + catalog-caching tick (host-neutral; safe to
  // call from a plugin — it only starts timers, which Cordis disposes on unload).
  void service.init().catch((err) => {
    const logger = (ctx as unknown as { logger?: { warn?: (s: string) => void } }).logger;
    logger?.warn?.(`[workbuddy] init failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  // init() warms ONLY the active account's region catalog; the other cluster's
  // getState() then serves an empty model list, which makes dsh drop that
  // model group entirely (groups with no models are filtered out of the
  // browser catalog). Warm BOTH regions so the two groups always exist.
  for (const r of ROUTES) {
    service.ensureCatalog(r.region).catch(() => {});
  }

  const providers = config.providers ?? ROUTES.map((r) => r.route);
  for (const r of ROUTES) {
    if (!providers.includes(r.route)) continue;
    const adapter = new WorkbuddyAdapter(service, r.route, r.region);
    // Effect-based registration (HMR-safe): disposed automatically on unload.
    ctx.llm.registerAdapter([r.route], adapter);
    // Makes WorkBuddy appear as a configurable provider in dsh's Models page —
    // the dsh equivalent of "writing the model list into config".
    ctx.llm.registerConfigurableProviders([
      { provider: r.route, displayName: r.displayName, settingsNs: name, settingsPath: [] },
    ]);
  }

  // Let the Models settings page fetch and show the WorkBuddy catalog.
  ctx.llm.registerModelDiscovery(name, (request) => discoverWorkbuddyModels(service, request));

  // Debug: confirm registration reached the live LLM directory (visible in the
  // server log; harmless in production).
  console.error(
    `[workbuddy] routes=${ctx.llm
      .listProviders()
      .map((p) => p.id)
      .join(",")} configurable=${ctx.llm.listConfigurableProviders().map((p) => p.provider).join(",")}`
  );

  // Serve the core Vue management UI at /workbuddy/ and proxy its RPC at
  // /workbuddy/api/*. The dsh settings panel embeds it as a settings.section.
  registerWorkbuddyWeb(ctx, service);

  const ctxAny = ctx as unknown as { on?: (e: string, cb: () => void) => void };
  ctxAny.on?.("dispose", () => {
    const dispose = (service as unknown as { dispose?: () => void | Promise<void> }).dispose;
    if (dispose) void dispose.call(service);
  });
}
