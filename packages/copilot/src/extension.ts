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
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("codebuddy", cnProvider),
    vscode.lm.registerLanguageModelChatProvider("codebuddy-intl", intlProvider)
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
