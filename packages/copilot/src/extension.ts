/**
 * CodeBuddy / WorkBuddy chat for VS Code.
 *
 * The extension is a HOST for `@wbaw/core`. Core owns the accounts,
 * the model catalog, the OpenAI payload, the stream and the day-to-day
 * bookkeeping (token refresh for every account, check-in). This file is the VS
 * Code surface on top of it — the same service the desktop app and the local
 * HTTP server drive.
 *
 * Interaction model: there is ONE place to do things, and it is the management
 * page. The status bar opens it directly. Native VS Code pickers are avoided on
 * purpose — they can only ever show a subset of what the page shows (per-account
 * quota, per-package breakdown, check-in status), and having two half-menus that
 * disagree is worse than having one that is complete.
 *
 * Including the vision-fallback picker: the page asks the extension for the
 * models registered in VS Code's LM namespace (`listVisionModels`) and renders
 * them itself, so the webview, the desktop app and a plain browser all use the
 * same control.
 */

import * as vscode from "vscode";
import type { WorkbuddyService } from "@wbaw/core";
import type { Region } from "@wbaw/core";
import { showManagementPanel } from "./management-panel";
import { CodeBuddyChatProvider } from "./provider";
import { AccountStatusBar } from "./status-bar";
import { createVsCodeService } from "./vscode-adapters";

let channel: vscode.OutputChannel | undefined;
function info(message: string): void {
  try {
    channel ??= vscode.window.createOutputChannel("WorkBuddy Anywhere");
    channel.appendLine(`${new Date().toISOString()} ${message}`);
  } catch {
    // Logging must never break activation.
  }
}

/**
 * Picker vendor id → cluster.
 *
 * One table, because two places need the same fact: the group switch in
 * `activate` and the vendor argument of `codebuddy.manageProvider` (VS Code
 * passes the vendor to a provider's `managementCommand`). Held separately they
 * can disagree — and a gear that opens the cluster the switch just hid is what
 * that disagreement looks like from the outside.
 */
const VENDOR_REGION: ReadonlyMap<string, Region> = new Map([
  ["codebuddy", "cn"],
  ["codebuddy-intl", "intl"],
]);

function regionOfVendor(vendor: string): Region | undefined {
  return VENDOR_REGION.get(vendor);
}

export function activate(context: vscode.ExtensionContext): void {
  const service = createVsCodeService({
    context,
    log: (message) => info(`[core] ${message}`),
  });
  context.subscriptions.push({ dispose: () => service.dispose() });

  // Two providers, one per cluster — VS Code's model picker shows them
  // as two separate vendors (`codebuddy` for CN, `codebuddy-intl` for Global),
  // so a model registered on one side never appears on the other. They share
  // a single service for accounts, tokens and chat.
  const cnProvider = new CodeBuddyChatProvider(service, "cn");
  const intlProvider = new CodeBuddyChatProvider(service, "intl");
  context.subscriptions.push(cnProvider, intlProvider);

  // Register each vendor SEPARATELY and tolerate failure.
  //
  // The two `vscode.lm.registerLanguageModelChatProvider` calls used to share
  // one `subscriptions.push(...)`: an argument-list evaluation, so a throw on
  // the FIRST one aborted `activate()` before the status bar, the commands and
  // `service.init()` ever ran. The whole extension died with a single line in
  // the Extension Host log, which is a hard failure mode to spot from the UI.
  //
  // It is also a failure that happens in practice: a STALE BUILD left in
  // `~/.vscode/extensions/` still owns one of these vendor ids, and the host
  // rejects the duplicate. Registering independently means whichever vendor is
  // free still comes up, and the log says which one did not — instead of the
  // picker silently missing half its models.
  // One entry per picker vendor, derived from the vendor→region table above so
  // the two can never drift. The PROVIDER objects outlive their registrations
  // (see `registrations` below).
  const providers: Record<Region, CodeBuddyChatProvider> = {
    cn: cnProvider,
    intl: intlProvider,
  };
  const VENDORS = [...VENDOR_REGION].map(([vendor, region]) => ({
    vendor,
    region,
    provider: providers[region],
  }));

  /**
   * Live registrations, keyed by vendor. Empty while the group is withdrawn.
   *
   * The PROVIDER objects outlive these: disposing a registration only
   * unsubscribes it from the LM namespace, while the provider keeps its catalog
   * and its emitters, so re-registering brings the same models back without a
   * refetch. That is why the providers are disposed separately (they are in
   * `context.subscriptions`).
   */
  const registrations = new Map<string, vscode.Disposable>();

  /**
   * Offer or withdraw each model group, per region.
   *
   * VS Code has no "hide this vendor" flag: the ONLY way to take a group out of
   * the model picker is to unregister its provider, so the setting is applied
   * by disposing and recreating that vendor's registration. That is what makes
   * this a real control rather than a flag nothing reads.
   *
   * Per vendor rather than one global switch, because the two clusters are two
   * independent groups in the picker: a user may want the CN models without a
   * second cluster cluttering the list, or the reverse.
   *
   * `registrations` IS the state, so this is idempotent by construction and
   * carries no "last value" memory to go stale — `onChange` fires for every
   * settings write and every quota refresh.
   */
  function syncModelGroup(byRegion: { cn: boolean; intl: boolean }): void {
    for (const { vendor, region, provider } of VENDORS) {
      const wanted = byRegion[region] !== false;
      const live = registrations.get(vendor);
      if (wanted === !!live) continue;

      if (!wanted) {
        live?.dispose();
        registrations.delete(vendor);
        info(`model group "${vendor}" withdrawn — provider unregistered`);
        continue;
      }

      try {
        registrations.set(
          vendor,
          vscode.lm.registerLanguageModelChatProvider(vendor, provider)
        );
        info(`model group "${vendor}" offered`);
      } catch (err) {
        info(
          `could not register the "${vendor}" vendor: ${
            err instanceof Error ? err.message : String(err)
          } — another installed copy of this extension may still own it ` +
            `(check ~/.vscode/extensions for an older version directory)`
        );
      }
    }
  }

  /** Re-read the setting and apply it. Safe to call as often as onChange fires. */
  function syncModelGroupFromSettings(): void {
    void service
      .getSettings()
      .then((settings) => syncModelGroup(settings.enabledByRegion))
      .catch(() => {});
  }

  // Apply immediately so a stored `false` never lets a hidden group flash into
  // the picker on activation, then hand the registrations to the context so
  // they are released with the extension.
  syncModelGroupFromSettings();
  context.subscriptions.push({
    dispose: () => {
      for (const registration of registrations.values()) registration.dispose();
      registrations.clear();
    },
  });

  // The whole extension tracks whichever vendor the user is actually chatting
  // with: send through the `codebuddy-intl` picker entry and the region — the
  // status-bar figure, the quota card, and the management page's segment —
  // follows to Global.
  //
  // This is done by PERSISTING `settings.region`, not by messaging the webview.
  // An earlier attempt only posted a message to the panel: it did nothing at
  // all while the panel was closed, and nothing at all for the status bar, so
  // the displayed quota kept belonging to the wrong cluster — which is exactly
  // the bug this is meant to fix. Writing the setting makes every reader
  // (status bar, quota card, page, RPC region hint) follow from ONE source,
  // and the settings change already fans out through `service.onChange`.
  //
  // The write is skipped when the value already matches, so a chat costs at
  // most one settings write per region switch, not one per message.
  const trackProviderRegion = (region: "cn" | "intl"): void => {
    void (async () => {
      try {
        const settings = await service.getSettings();
        if (settings.region === region) return;
        info(`chat used the ${region} vendor — switching the tracked region`);
        await service.updateSettings({ region });
        // The figures on screen belong to the region the user just LEFT, so
        // re-read quota before the new region is drawn. Without this the card
        // shows the other cluster's totals for up to a minute (the background
        // tick), which reads as "nothing happened".
        await service.refreshAllUsage();
      } catch (err) {
        info(
          `could not switch the tracked region to ${region}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    })();
  };

  context.subscriptions.push(
    cnProvider.onDidChangeLastUsedRegion(trackProviderRegion),
    intlProvider.onDidChangeLastUsedRegion(trackProviderRegion)
  );

  // ONE status bar that always tracks the current region. The management page
  // is the one place the user can change the region, and a region flip comes
  // back through the same onChange callback that re-fetches the catalogs —
  // so the bar re-renders against the new region in one step, just like the
  // desktop app.
  const status = new AccountStatusBar(service);
  context.subscriptions.push(status);

  context.subscriptions.push({
    dispose: service.onChange(() => {
      // One fan-out, three reactions: the catalogs may have changed, the bar
      // shows the region the user is on, and the model-group toggle may have
      // been flipped from the management page.
      void refreshCatalogs(cnProvider, intlProvider, service);
      void status.refresh();
      syncModelGroupFromSettings();
    }),
  });

  registerCommands(context, service, status);

  void service
    .init({ autoCheckin: true })
    .then(async (state) => {
      // `init` only warms the ACTIVE account's region catalog. The other
      // region's picker would be empty until the user signed in there or
      // clicked "refresh" — invisible until you happened to log into one
      // cluster first. Warm both in parallel so the picker shows the full
      // model list the moment we register the providers, regardless of
      // which cluster the user signed in to.
      await service.warmAllCatalogs();
      await refreshCatalogs(cnProvider, intlProvider, service);
      status.refresh();
      info(`ready — ${state.accounts.length} account(s), ${cnProvider.count()} CN models, ${intlProvider.count()} Global models`);
    })
    .catch((err) => info(`init failed: ${err instanceof Error ? err.message : err}`));
}

/**
 * Re-fetch the model catalog for each provider from its own region and push
 * the result into the provider's cache. Errors are swallowed per region so a
 * failed INTL fetch does not take down the CN picker.
 */
async function refreshCatalogs(
  cn: CodeBuddyChatProvider,
  intl: CodeBuddyChatProvider,
  service: WorkbuddyService
): Promise<void> {
  try {
    cn.setModels((await service.getState("cn")).models);
  } catch (err) {
    info(`CN catalog refresh failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    intl.setModels((await service.getState("intl")).models);
  } catch (err) {
    info(`Global catalog refresh failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function deactivate(): void {
  // Everything is on context.subscriptions.
}

// ── Commands ────────────────────────────────────────────────────────────

function registerCommands(
  context: vscode.ExtensionContext,
  service: WorkbuddyService,
  status: AccountStatusBar
): void {
  /**
   * Register a command, forwarding its arguments.
   *
   * Args matter for one caller in particular: VS Code passes the VENDOR to a
   * provider's `managementCommand`
   * (`commandService.executeCommand(cmd, vendor.vendor)`), which is how the
   * gear beside a model group in the picker knows which cluster it belongs to.
   * The host wrapper used to drop arguments on the floor, so both gears were
   * indistinguishable.
   */
  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          info(`${id} failed: ${message}`);
          void vscode.window.showErrorMessage(`WorkBuddy Anywhere: ${message}`);
        } finally {
          await status.refresh();
        }
      })
    );
  };

  /**
   * The one place that opens the management page.
   *
   * `vendor` is only ever supplied by a host, never by a user. VS Code invokes a
   * provider's `managementCommand` as `executeCommand(cmd, vendor.vendor)`, and
   * that argument is what makes the gear honest: without it, clicking the gear
   * beside the Global group opened a page that could be showing CN. Switching
   * here follows the same rule as sending a chat through that vendor — the page
   * reflects the cluster you are actually working with.
   *
   * A user-driven entry passes nothing and lands on whatever cluster is already
   * active, which is why the two callers below are not the same command.
   *
   * The page itself replaced ten palette commands — six of which only opened it
   * on a particular tab, which its own tabs already do, and one of which was
   * named "Sign Out" while doing nothing of the sort.
   */
  const openPanel = async (vendor?: unknown): Promise<void> => {
    const region = typeof vendor === "string" ? regionOfVendor(vendor) : undefined;
    if (region) {
      const settings = await service.getSettings();
      if (settings.region !== region) await service.updateSettings({ region });
    }
    await showManagementPanel(context, service, "accounts");
  };

  // The palette entry, named for what the user asks for rather than for what the
  // page happens to contain, so typing "open" finds it. No vendor: opening the
  // page is not a statement about which cluster you are working with.
  register("codebuddy.openPanel", async () => openPanel());

  // The providers' `managementCommand`; both vendors point here. Declared so the
  // manifest's reference resolves, and hidden from the palette because it is the
  // gear's hook — leaving it visible would give the page a second, worse entry
  // that silently switches clusters.
  register("codebuddy.manageProvider", async (vendor?: unknown) => openPanel(vendor));

  // ── Wired to the hover card, NOT to the palette ────────────────────────
  //
  // Deliberately absent from `contributes.commands`. They exist as the two
  // buttons under the status-bar hover, where they are one click from the
  // numbers they act on; listing them in the palette would offer a second,
  // context-free way to do the same thing.

  // Re-reads quota for every account so the numbers the user is looking at are
  // the ones they just asked for — the background tick is 60s, and a hover is a
  // deliberate act.
  register("codebuddy.refreshUsage", async () => {
    await service.refreshAllUsage();
  });

  // Wired to the hover card's "check in" link. Claims the daily bonus for
  // EVERY account on both clusters in one sweep (the user's "签到一起签"),
  // then reports what actually happened — including the case where the
  // cluster has no check-in endpoint, which must not look like success.
  register("codebuddy.checkinAll", async () => {
    const result = await service.checkinAll();
    const outcomes = Object.values(result.results ?? {});
    const claimed = outcomes.filter((r) => r.state === "claimed").length;
    const unsupported = outcomes.filter((r) => r.state === "unknown").length;
    if (claimed === 0 && unsupported === outcomes.length && outcomes.length > 0) {
      void vscode.window.showInformationMessage(
        "WorkBuddy Anywhere: this cluster has no daily check-in."
      );
      return;
    }
    const credit = outcomes.reduce(
      (sum, r) => sum + (typeof r.credit === "number" ? r.credit : 0),
      0
    );
    void vscode.window.showInformationMessage(
      `WorkBuddy Anywhere: checked in ${claimed} account(s)` +
        (credit > 0 ? `, +${credit} credits` : ".")
    );
  });
}
