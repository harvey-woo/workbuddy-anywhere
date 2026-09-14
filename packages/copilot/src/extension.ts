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
  for (const [vendor, provider] of [
    ["codebuddy", cnProvider],
    ["codebuddy-intl", intlProvider],
  ] as const) {
    try {
      context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider(vendor, provider)
      );
    } catch (err) {
      info(
        `could not register the "${vendor}" vendor: ${
          err instanceof Error ? err.message : String(err)
        } — another installed copy of this extension may still own it ` +
          `(check ~/.vscode/extensions for an older version directory)`
      );
    }
  }

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
      void refreshCatalogs(cnProvider, intlProvider, service);
      void status.refresh();
    }),
  });

  registerCommands(context, service, cnProvider, intlProvider, status);

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
  cnProvider: CodeBuddyChatProvider,
  intlProvider: CodeBuddyChatProvider,
  status: AccountStatusBar
): void {
  const register = (id: string, handler: () => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await handler();
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

  // The status bar and the command palette both land here.
  const openPage = (route: Parameters<typeof showManagementPanel>[2]) => () =>
    showManagementPanel(context, service, route);

  register("codebuddy.manageProvider", openPage("accounts"));
  register("codebuddy-intl.manageProvider", openPage("accounts"));
  register("codebuddy.menu", openPage("accounts"));
  register("codebuddy.login", openPage("login"));
  register("codebuddy.showUsage", openPage("accounts"));
  register("codebuddy.settings", openPage("settings"));

  register("codebuddy.logout", async () => {
    const state = await service.getState();
    if (state.accounts.length === 0) {
      void vscode.window.showInformationMessage("WorkBuddy Anywhere: no account is signed in.");
      return;
    }
    // No picker: the page lists every account with its quota, which is a far
    // better basis for "which one do I remove?" than a bare list of names.
    await showManagementPanel(context, service, "accounts");
  });

  register("codebuddy.refreshModels", async () => {
    // Refresh BOTH clusters — toggling a model group off only on CN would
    // leave the Global picker showing stale state. The toggle command itself
    // operates on `settings.enabled`, which is region-agnostic.
    const cn = await service.refreshModels("cn");
    const intl = await service.refreshModels("intl");
    cnProvider.setModels(cn);
    intlProvider.setModels(intl);
    void vscode.window.showInformationMessage(
      `WorkBuddy Anywhere: ${cn.length} CN, ${intl.length} Global models.`
    );
  });

  // Wired to the hover card's "refresh" link. Re-reads quota for every
  // account so the numbers the user is looking at are the ones they just
  // asked for — the background tick is 60s and a hover is a deliberate act.
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

  register("codebuddy.toggleProvider", async () => {
    const settings = await service.getSettings();
    await service.updateSettings({ enabled: !settings.enabled });
    cnProvider.notifyChanged();
    intlProvider.notifyChanged();
    void vscode.window.showInformationMessage(
      `CodeBuddy model group ${settings.enabled ? "disabled" : "enabled"}.`
    );
  });

  // Kept as a command so existing keybindings keep working. The list itself is
  // rendered by the management page, which asks this extension for the models
  // registered in VS Code's LM namespace — so every entry is selectable, not
  // just the ones a native QuickPick could present.
  register("codebuddy.selectVisionFallback", async () => {
    await showManagementPanel(context, service, "settings");
  });
}
