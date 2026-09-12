/**
 * The "server side" of the RPC contract — ONE implementation for every host.
 *
 * The local HTTP server and the VS Code extension both dispatch through this
 * map, so a method can never be served by one host and forgotten by another.
 * Host-specific bits are injected as hooks (opening a browser is the only one
 * today: the extension can, a server cannot).
 */

import type { RpcMethod } from "./rpc";
import { DEFAULT_REGION, type Region } from "./region";
import { BadRequestError } from "./errors";
import type { Settings } from "./settings";
import type { WorkbuddyService } from "./service";

export type RpcHandler = (args: Record<string, unknown>) => Promise<unknown>;
export type RpcHandlers = Record<RpcMethod, RpcHandler>;

export interface RpcHostHooks {
  /**
   * Open a URL in the user's browser. Hosts without a UI (the plain server)
   * leave this unset, and the call then fails with a clear message instead of
   * silently doing nothing.
   */
  openExternal?: (url: string) => Promise<void> | void;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) throw new Error(`\`${key}\` is required`);
  return value;
}

/** Absent is fine — it means "the active account". */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Read a region argument.
 *
 * An UNRECOGNISED value is rejected instead of defaulted: silently falling back
 * to CN would send an international sign-in to the Chinese cluster, which fails
 * with a 401 that looks like "your account is broken" rather than "that region
 * does not exist".
 */
function optionalRegion(args: Record<string, unknown>): Region | undefined {
  const value = args.region;
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "cn" || value === "intl") return value;
  throw new BadRequestError(`\`region\` must be "cn" or "intl", got ${JSON.stringify(value)}`);
}

export function createRpcHandlers(
  service: WorkbuddyService,
  hooks: RpcHostHooks = {}
): RpcHandlers {
  return {
    getState: (args) => {
      const r = args?.region;
      return service.getState(r === "cn" || r === "intl" ? r : undefined);
    },
    startLogin: (args) => {
      const region = optionalRegion(args) ?? DEFAULT_REGION;
      // The international region needs a broker; CN ignores it. We accept the
      // field on CN too so the UI does not have to special-case the request.
      if (args.broker !== undefined && args.broker !== "google" && args.broker !== "github" && args.broker !== "twitter") {
        throw new BadRequestError(
          `\`broker\` must be "google", "github" or "twitter", got ${JSON.stringify(args.broker)}`
        );
      }
      return service.startLogin(region, args.broker);
    },
    pollLogin: (args) => service.pollLogin(optionalRegion(args) ?? DEFAULT_REGION),
    logout: (args) => service.logout(optionalString(args, "key")),
    switchAccount: (args) => service.switchAccount(requireString(args, "key")),
    removeAccount: (args) => service.removeAccount(requireString(args, "key")),
    getUsage: (args) => service.getUsage(optionalString(args, "key")),
    refreshAllUsage: () => service.refreshAllUsage(),
    checkin: (args) => service.checkin(optionalString(args, "key")),
    checkinAll: () => service.checkinAll(),
    getModels: () => service.getModels(),
    refreshModels: (args) => service.refreshModels(optionalRegion(args)),
    addCustomModel: (args) =>
      service.addCustomModel(
        requireString(args, "id"),
        typeof args.displayName === "string" ? args.displayName : undefined
      ),
    removeCustomModel: (args) => service.removeCustomModel(requireString(args, "id")),
    getSettings: () => service.getSettings(),
    updateSettings: (args) => service.updateSettings(args as Partial<Settings>),
    listVisionModels: () => service.listVisionModels(),
    openExternal: async (args) => {
      const url = requireString(args, "url");
      if (!hooks.openExternal) {
        throw new Error(
          "This host has no browser to open — use the desktop app or VS Code for that action."
        );
      }
      await hooks.openExternal(url);
      return { ok: true };
    },
  };
}
