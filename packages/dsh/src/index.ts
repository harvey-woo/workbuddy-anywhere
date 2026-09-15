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

/**
 * Data directory shared with the CLI and `wbaw serve`.
 *
 * NOT the desktop app's: that one keeps its own store under `userData/data`
 * (deliberately — see `packages/desktop/src/service.ts`), so accounts added
 * there do not show up here unless `dataDir` is pointed at it explicitly.
 */
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
  const active = ROUTES.filter((r) => providers.includes(r.route));

  /**
   * One registration handle per route, for the adapter and for the provider
   * directory.
   *
   * The handles are what make the per-region flags real controls here: dsh has
   * no "hide this provider" flag either, so the group is taken out of the model
   * picker by emptying these registrations. `replace([])` is atomic (the API
   * swaps route sets in one synchronous section, so no request observes a gap)
   * and deliberately legal, which is exactly the "a settings section that
   * emptied holds zero routes while staying registered" case. Disposing them
   * instead would work once, but leaves nothing to restore.
   */
  const routeHandles = active.map((r) => {
    const adapter = new WorkbuddyAdapter(service, r.route, r.region);
    const entry = {
      provider: r.route,
      displayName: r.displayName,
      settingsNs: name,
      settingsPath: [] as string[],
    };
    return {
      route: r.route,
      region: r.region,
      // These are live from the moment they are created, which is what the
      // switch below compares against instead of keeping a separate memo.
      offered: true,
      // Effect-based registration (HMR-safe): disposed automatically on unload.
      adapter: ctx.llm.registerAdapter([r.route], adapter),
      // Makes WorkBuddy appear as a configurable provider in dsh's Models page —
      // the dsh equivalent of "writing the model list into config".
      directory: ctx.llm.registerConfigurableProviders([entry]),
      entry,
    };
  });

  let disposed = false;

  /**
   * Offer or withdraw each model group, per region.
   *
   * Per route rather than one global switch, because the two clusters are two
   * independent groups in dsh's model picker: a user may want the CN models
   * without a second provider cluttering the list, or the reverse.
   *
   * Idempotent, and idempotent by comparing against the handles themselves:
   * `service.onChange` fires for every settings write and every quota refresh,
   * and `replace` must not run for each of those.
   */
  function syncModelGroup(byRegion: { cn: boolean; intl: boolean }): void {
    if (disposed) return;
    for (const handle of routeHandles) {
      const wanted = byRegion[handle.region] !== false;
      if (handle.offered === wanted) continue;
      handle.offered = wanted;
      // Both handles are emptied together so dsh never shows a configurable
      // provider whose adapter cannot serve it (or the reverse).
      handle.adapter.replace(wanted ? [handle.route] : []);
      handle.directory.replace(wanted ? [handle.entry] : []);
      console.error(
        `[workbuddy] "${handle.route}" ${wanted ? "offered" : "withdrawn"} — routes=${ctx.llm
          .listProviders()
          .map((p) => p.id)
          .join(",")}`
      );
    }
  }

  function syncModelGroupFromSettings(): void {
    void settings
      .get()
      .then((s) => syncModelGroup(s.enabledByRegion))
      .catch(() => {});
  }

  // Let the Models settings page fetch and show the WorkBuddy catalog.
  ctx.llm.registerModelDiscovery(name, (request) => discoverWorkbuddyModels(service, request));

  // Apply the stored value, and follow it live: the management page's Models
  // tab writes the same setting through the RPC layer.
  syncModelGroupFromSettings();
  service.onChange(syncModelGroupFromSettings);

  // Serve the core Vue management UI at /workbuddy/ and proxy its RPC at
  // /workbuddy/api/*. The dsh settings panel embeds it as a settings.section.
  registerWorkbuddyWeb(ctx, service);

  const ctxAny = ctx as unknown as { on?: (e: string, cb: () => void) => void };
  ctxAny.on?.("dispose", () => {
    // Before anything else: a settings read still in flight would otherwise
    // call `replace` on a registration Cordis has already released, which
    // throws `REGISTRATION_DISPOSED`. (The sync path already checks `disposed`;
    // this is what sets it.)
    disposed = true;
    const dispose = (service as unknown as { dispose?: () => void | Promise<void> }).dispose;
    if (dispose) void dispose.call(service);
  });
}
