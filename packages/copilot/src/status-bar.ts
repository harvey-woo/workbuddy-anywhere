/**
 * The status-bar entry.
 *
 * Presentation is deliberately UNCHANGED from the pre-split extension: the
 * brand icon plus the current account's remaining percentage, and the same SVG
 * hover card. Only the DATA SOURCE moved — it now comes from the shared core
 * service, so the number reflects whichever account is currently selected.
 *
 * The SVG card is generated rather than composed from VS Code's Markdown
 * hover, because a table with right-aligned numeric columns and a progress bar
 * cannot be expressed any other way.
 */

import * as vscode from "vscode";
import type {
  AccountSummary,
  BillingAccount,
  CheckinResult,
  ServiceState,
  WorkbuddyService,
} from "@wbaw/core";

/** The icon id declared in package.json under `contributes.icons`. */
const ICON = "$(codebuddy-icon)";

/**
 * The status bar — ONE entry that follows the user's current region.
 *
 * The two clusters are independent account universes, but the bar is a single
 * slot: when the user switches region in the management page the bar re-renders
 * to show the OTHER cluster's active account, the way the desktop app does.
 * No region label is shown — the number alone is what the user reads, and the
 * management page is one click away when they need to know which side it is.
 */
export class AccountStatusBar {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90
  );
  private readonly service: WorkbuddyService;
  /** The region the bar is currently showing (from settings). */
  private lastRegion: "cn" | "intl" = "cn";

  constructor(service: WorkbuddyService) {
    this.service = service;
    // Clicking opens the management page. There is only one panel; the page
    // already shows the current region, so a single command is enough.
    this.item.command = "codebuddy.manageProvider";
    this.item.text = ICON;
    this.item.show();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    // Follow the current region so the user always sees the active account
    // for whichever cluster the management page is on. `getState` is
    // region-aware: it returns accounts scoped to the named region plus
    // the active pick on that region.
    const settings = (await this.service.getSettings()) as {
      region: "cn" | "intl";
      autoSelectAccount: boolean;
    };
    this.lastRegion = settings.region;
    const state = await this.service.getState(this.lastRegion);

    // AUTO MODE: requests rotate across accounts, so ONE account's balance
    // would mislead — the bar shows the REGION TOTAL instead.
    if (settings.autoSelectAccount) {
      const totals = regionTotals(state.accounts, this.lastRegion);
      if (!totals) {
        this.item.text = ICON;
        this.item.tooltip = this.explainMissing(state, state.accounts.find((a) => a.active));
        return;
      }
      this.item.text = `${ICON} ${compactCredits(totals.remain)}`;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(
        `**CodeBuddy** — auto-select across ${totals.reported} ` +
          `${totals.reported === 1 ? "account" : "accounts"}\n\n`
      );
      md.appendMarkdown(
        `**${Math.round(totals.remain).toLocaleString()}** credits remaining ` +
          `(of ${Math.round(totals.size).toLocaleString()})\n\n`
      );
      md.appendMarkdown("_Click to open the management page._");
      this.item.tooltip = md;
      return;
    }

    const active = state.accounts.find((a) => a.active);

    if (!active || !active.usage) {
      this.item.text = ICON;
      this.item.tooltip = this.explainMissing(state, active);
      return;
    }

    this.item.text = `${ICON} ${compactCredits(active.usage.remain)}`;
    this.item.tooltip = buildUsageTooltip(active, active.checkin);
  }

  /** Hover text for the states where there is no percentage to draw. */
  private explainMissing(
    state: ServiceState,
    active: AccountSummary | undefined
  ): vscode.MarkdownString | string {
    const md = new vscode.MarkdownString();
    if (!active) {
      md.appendMarkdown(
        "**CodeBuddy** — no account is signed in.\n\n_Click to open the management page._"
      );
      return md;
    }
    md.appendMarkdown(`**CodeBuddy** — ${active.label}\n\n`);
    md.appendMarkdown(
      active.usageError
        ? `Quota unavailable: ${active.usageError}\n\n`
        : "Quota has not been read yet.\n\n"
    );
    if (state.accounts.length > 1) {
      md.appendMarkdown(
        `${state.accounts.length} accounts are signed in; this is the selected one.\n\n`
      );
    }
    md.appendMarkdown("_Click to open the management page._");
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}

/**
 * Compact credits for the narrow status bar: 1234567 -> 1.2M, 12345 -> 12.3k.
 */
function compactCredits(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * Sum the quota of one region's accounts that have reported usage.
 * Returns null when nobody has numbers yet (nothing to show).
 */
function regionTotals(
  accounts: AccountSummary[],
  region: "cn" | "intl"
): { remain: number; size: number; reported: number } | null {
  let remain = 0;
  let size = 0;
  let reported = 0;
  for (const a of accounts) {
    if ((a.region ?? "cn") !== region || !a.usage) continue;
    reported += 1;
    remain += a.usage.remain;
    size += a.usage.size;
  }
  return reported > 0 ? { remain, size, reported } : null;
}

// ── The hover card ──────────────────────────────────────────────────────
//
// Ported verbatim from the pre-split extension so the card looks identical.

/** Escape HTML special characters for SVG text. */
function escapeSvgText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the status-bar tooltip as an SVG data URI (like opencode-go does). */
function buildBillingTooltipSvg(
  billing: { totalRemain: number; totalSize: number; accounts: BillingAccount[] },
  checkin?: CheckinResult
): string {
  const width = 460;
  const padX = 14;
  const right = width - padX;
  const fg = "#d4d4d4";
  const muted = "#a6a6a6";
  const track = "#3c3c3c";
  const line = "#333333";
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  // The bar stays (a visual is worth a number); the percent TEXT is gone —
  // users read credits, not percentages.
  const pct =
    billing.totalSize > 0 ? (billing.totalRemain / billing.totalSize) * 100 : 0;

  const text = (
    value: string,
    x: number,
    y: number,
    size = 13,
    weight = 400,
    color = fg,
    anchor = "start"
  ) =>
    `<text x="${x}" y="${y}" fill="${color}" font-family="${font}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeSvgText(value)}</text>`;

  // Bar colour still follows the remaining ratio — a low bar turning red is
  // information the eye catches before any number.
  let barColor = "#4ec9b0"; // green
  if (pct < 20) barColor = "#f44747"; // red
  else if (pct < 50) barColor = "#cca700"; // yellow

  const bar = (pctVal: number, x: number, y: number, barWidth: number) => {
    const clamped = Math.min(Math.max(pctVal, 0), 100);
    const fillWidth = Math.max(0, Math.round((clamped / 100) * barWidth));
    return [
      `<rect x="${x}" y="${y}" width="${barWidth}" height="6" rx="3" fill="${track}"/>`,
      fillWidth > 0
        ? `<rect x="${x}" y="${y}" width="${fillWidth}" height="6" rx="3" fill="${barColor}"/>`
        : "",
    ].join("");
  };

  // Approximate text width (px) for layout. CJK/wide glyphs ≈ font-size,
  // ASCII/digits ≈ 0.55 * font-size, spaces smaller. Good enough to size and
  // truncate columns without an actual SVG measure step.
  const textWidth = (s: string, size: number): number => {
    let w = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (
        c >= 0x1100 &&
        (c <= 0x115f ||
          (c >= 0x2e80 && c <= 0xa4cf) ||
          (c >= 0xac00 && c <= 0xd7a3) ||
          (c >= 0xf900 && c <= 0xfaff) ||
          (c >= 0xfe30 && c <= 0xfe4f) ||
          (c >= 0xff00 && c <= 0xff60) ||
          (c >= 0xffe0 && c <= 0xffe6) ||
          c >= 0x20000)
      ) {
        w += size; // wide (CJK, fullwidth)
      } else if (ch === " ") {
        w += size * 0.33;
      } else {
        w += size * 0.55; // narrow
      }
    }
    return w;
  };
  // Truncate a string so its estimated width <= maxW, appending an ellipsis.
  const truncate = (s: string, size: number, maxW: number): string => {
    if (textWidth(s, size) <= maxW) return s;
    const ell = "…";
    let out = "";
    let w = 0;
    const ellW = textWidth(ell, size);
    for (const ch of s) {
      const cw = textWidth(ch, size);
      if (w + cw + ellW > maxW) break;
      out += ch;
      w += cw;
    }
    return out + ell;
  };

  // Package rows
  const visible = billing.accounts
    .filter((a) => (a.cycleCapacityRemain ?? a.capacityRemain ?? 0) > 0)
    .sort((a, b) => {
      const ea = a.cycleEndTime ? Date.parse(a.cycleEndTime) : Infinity;
      const eb = b.cycleEndTime ? Date.parse(b.cycleEndTime) : Infinity;
      return ea - eb;
    });

  // Numeric columns are compact and right-aligned near the right edge so the
  // (potentially long) package name gets the rest of the width.
  const remainColRight = right; // 剩余, rightmost
  const nameColRight = 340; // package name may occupy up to this x, then truncate

  let contentY = 56;

  // Header
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="200" viewBox="0 0 ${width} 200">`
  );

  // Title
  parts.push(text("CodeBuddy 额度", padX, 28, 16, 700));

  // Progress bar
  parts.push(bar(pct, padX, 42, 300));
  parts.push(text(`${billing.totalRemain} / ${billing.totalSize}`, padX, 62, 12, 400, muted));

  contentY = 82;

  // Package table
  if (visible.length > 0) {
    // Header (numeric headers right-aligned to the same anchors as the data)
    parts.push(text("套餐", padX, contentY, 11, 700, muted));
    parts.push(text("剩余", remainColRight, contentY, 11, 700, muted, "end"));
    contentY += 16;

    for (const a of visible.slice(0, 4)) {
      const remain = a.cycleCapacityRemain ?? a.capacityRemain ?? 0;
      const size = a.cycleCapacitySize ?? a.capacitySize ?? 0;
      const name = truncate(a.packageName || "(未命名套餐)", 12, nameColRight - padX);
      parts.push(text(name, padX, contentY, 12, 400, fg));
      parts.push(text(`${remain} / ${size}`, remainColRight, contentY, 12, 400, fg, "end"));
      contentY += 18;
    }
    if (visible.length > 4) {
      parts.push(text(`…还有 ${visible.length - 4} 个套餐`, padX, contentY, 11, 400, muted));
      contentY += 16;
    }
  }

  // Divider
  contentY += 4;
  parts.push(
    `<line x1="${padX}" y1="${contentY}" x2="${right}" y2="${contentY}" stroke="${line}" stroke-width="1"/>`
  );
  contentY += 16;

  // Check-in status
  if (checkin?.state === "claimed") {
    parts.push(
      text(`✅ 今日已签到${checkin.credit ? ` (+${checkin.credit})` : ""}`, padX, contentY, 12, 400, "#4ec9b0")
    );
  } else {
    parts.push(text("📋 签到领额度", padX, contentY, 12, 400, "#3794ff"));
  }
  contentY += 20;

  // Footer
  parts.push(text(`最近更新: ${new Date().toLocaleTimeString()}`, padX, contentY, 11, 400, muted));

  // Close SVG
  parts.push(`</svg>`);

  return parts.join("");
}

/** Wrap the SVG into the Markdown hover VS Code renders. */
function buildUsageTooltip(
  account: AccountSummary,
  checkin?: CheckinResult
): vscode.MarkdownString {
  // Core flattens an account's quota into { remain, size, packages }; the card
  // wants the billing shape, which is the same data under its own names.
  const billing = {
    totalRemain: account.usage?.remain ?? 0,
    totalSize: account.usage?.size ?? 0,
    accounts: account.usage?.packages ?? [],
  };
  const svg = buildBillingTooltipSvg(billing, checkin);
  const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

  const md = new vscode.MarkdownString("", true);
  md.supportHtml = true;
  md.isTrusted = true;
  md.appendMarkdown(`![CodeBuddy Usage](${dataUri})`);
  return md;
}
