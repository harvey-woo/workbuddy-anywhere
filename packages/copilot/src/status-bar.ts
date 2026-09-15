/**
 * The status-bar entry.
 *
 * ONE status-bar item. Its text is the brand icon plus the chosen region's
 * remaining credits; its hover is a card with ONE ROW PER REGION (CN + Global),
 * each showing that region's remaining percentage, a progress bar, and the
 * daily check-in state.
 *
 * ── Why the card is an SVG ────────────────────────────────────────────
 * A tooltip is a `MarkdownString`, and VS Code sanitizes its HTML hard. The
 * only `style` it keeps is on `<span>`, and only these three properties, in
 * this exact order:
 *
 *     color  →  background-color  →  border-radius
 *
 * (see `allowedMarkdownHtmlAttributes` in vscode's markdownRenderer.ts.) No
 * flex, no grid, no padding, no margin. So an HTML layout that lines numbers
 * up in columns is impossible, and a progress bar is right out. SVG is the
 * only surface where coordinates are ours to choose — and a card where the
 * percent column actually lines up is most of what "looks tidy" means here.
 *
 * The one thing `<span>` CAN do is draw a rounded, tinted capsule, which is
 * exactly a button. So the actions under the card are capsule-styled links.
 *
 * ── Why the palette is theme-aware ────────────────────────────────────
 * An SVG inside `<img>` is its own document: it cannot read the host's CSS
 * custom properties. A hard-coded `#d4d4d4` is invisible on a light theme, so
 * the card picks its palette from `activeColorTheme` and re-renders on
 * `onDidChangeActiveColorTheme`. The alternative is one theme where the card
 * cannot be read.
 */

import * as vscode from "vscode";
import type { AccountSummary, ServiceState, WorkbuddyService } from "@wbaw/core";
import { REGIONS, REGION_PROFILES, type Region } from "@wbaw/core";

/** The icon id declared in package.json under `contributes.icons`. */
const ICON = "$(codebuddy-icon)";

/** Card width in px, and therefore the bar width. Sized to fit VS Code's hover. */
const CARD_W = 420;
/** The one font stack used by every generated SVG in this file. */
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
/**
 * Horizontal inset, on BOTH sides, shared by the card and the action row.
 *
 * It is 10 because that is the `padding` VS Code's own markdown stylesheet
 * applies to a table cell (`th, td { padding: 5px 10px }`), and the action row
 * is a table. Whatever this number is, the card's left text edge and the left
 * edge of the first button land on the same x — which is the whole reason it
 * is a shared constant instead of a literal in two places.
 */
const PAD_X = 10;

// ── Palette ─────────────────────────────────────────────────────────────

interface Palette {
  fg: string;
  muted: string;
  track: string;
  danger: string;
  warn: string;
  ok: string;
  /**
   * Button surfaces, mirrored by hand from the theme's `--vscode-button-*`
   * variables. They have to be literals because the buttons are SVG images:
   * an SVG inside `<img>` is its own document and cannot read the host's CSS
   * custom properties. (The alternative — a `<span>` capsule that CAN read
   * them — was rejected because its height is fixed by font metrics, so it can
   * never look like anything but a label.)
   */
  primaryBg: string;
  primaryFg: string;
  secondaryBg: string;
  secondaryFg: string;
  /** High-contrast themes need an outline; a flat fill is not enough. */
  buttonOutline?: string;
}

function paletteFor(kind: vscode.ColorThemeKind): Palette {
  // Colour theme kinds are compared by VALUE, not identity: the enum arrives
  // from the host, and the mock in smoke-extension.cjs supplies plain numbers.
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return {
        fg: "#1f1f1f",
        muted: "#5f5f5f",
        track: "#d6d6d6",
        danger: "#c62828",
        warn: "#8a6d00",
        ok: "#127a3d",
        primaryBg: "#007acc",
        primaryFg: "#ffffff",
        secondaryBg: "#e7e7e7",
        secondaryFg: "#1f1f1f",
      };
    case vscode.ColorThemeKind.HighContrastLight:
      return {
        fg: "#000000",
        muted: "#000000",
        track: "#767676",
        danger: "#a80000",
        warn: "#6b5300",
        ok: "#005c1f",
        primaryBg: "#0f4a85",
        primaryFg: "#ffffff",
        secondaryBg: "#ffffff",
        secondaryFg: "#000000",
        buttonOutline: "#000000",
      };
    case vscode.ColorThemeKind.HighContrast:
      return {
        fg: "#ffffff",
        muted: "#ffffff",
        track: "#ffffff",
        danger: "#ff8080",
        warn: "#ffd700",
        ok: "#7dff9b",
        primaryBg: "#ffd700",
        primaryFg: "#000000",
        secondaryBg: "#000000",
        secondaryFg: "#ffffff",
        buttonOutline: "#ffffff",
      };
    default:
      return {
        fg: "#d4d4d4",
        muted: "#9d9d9d",
        track: "#3c3c3c",
        danger: "#f14c4c",
        warn: "#cca700",
        ok: "#3fb950",
        primaryBg: "#0e639c",
        primaryFg: "#ffffff",
        secondaryBg: "#3a3d41",
        secondaryFg: "#cccccc",
      };
  }
}

// ── Row model ───────────────────────────────────────────────────────────

/** One region's aggregated line in the hover card. */
interface RegionRow {
  region: Region;
  label: string;
  /** At least one account exists on this cluster. */
  loggedIn: boolean;
  /** Remaining fraction, 0–100. 0 when nothing has been reported. */
  percent: number;
  remain: number;
  size: number;
  /** How many accounts reported a quota figure — a hedge on the sum. */
  reported: number;
  /** `none` = this cluster has no check-in feature at all (chip is omitted). */
  checkin: "claimed" | "unclaimed" | "unknown" | "none";
  /** Total bonus credits claimed today, when the cluster reports one. */
  credit: number;
  /** Why there is no number for this region, when there is a reason. */
  error?: string;
}

/**
 * Fold one region's accounts into a single row.
 *
 * WHICH accounts contribute depends on auto-select, because the two modes
 * answer different questions:
 *
 *   - AUTO ON  → every account in the region. A request can be served by any
 *                of them, so the only honest figure is the region's total. A
 *                single account's balance would under-report what is
 *                actually available.
 *   - AUTO OFF → the region's ACTIVE account only. The next request is pinned
 *                to that one account, so the region total would over-report
 *                what that request can spend.
 *
 * Falls back to the sum when auto is off but no account is marked active
 * (the active key is only written when the user picks one explicitly), so the
 * row is never blank just because nothing has been selected yet.
 */
function buildRegionRow(
  region: Region,
  accounts: AccountSummary[],
  checkinEnabled: boolean,
  autoSelect: boolean
): RegionRow {
  const mine = accounts.filter((a) => (a.region ?? "cn") === region);
  const contributors = autoSelect
    ? mine
    : (() => {
        const active = mine.filter((a) => a.active);
        return active.length > 0 ? active : mine;
      })();

  let remain = 0;
  let size = 0;
  let reported = 0;
  let error: string | undefined;
  for (const a of contributors) {
    if (a.usage) {
      reported += 1;
      remain += a.usage.remain;
      size += a.usage.size;
    } else if (a.usageError && !error) {
      // Keep the FIRST error: a list of identical failures is noise, and
      // several different ones mean something bigger than one stale token.
      error = a.usageError;
    }
  }

  // Check-in folds the same way, but the verdict is "is there anything LEFT to
  // claim", not a sum: one unclaimed account means the user still has a button
  // to press. Claimed credits DO sum — "you got 300 today" is a real total.
  let checkin: RegionRow["checkin"] = "none";
  let credit = 0;
  if (checkinEnabled && mine.length > 0) {
    const states = mine.map((a) => a.checkin?.state);
    if (states.some((s) => s === "unclaimed")) checkin = "unclaimed";
    else if (states.some((s) => s === "claimed")) checkin = "claimed";
    else checkin = "unknown";
    for (const a of mine) {
      if (a.checkin?.state === "claimed" && typeof a.checkin.credit === "number") {
        credit += a.checkin.credit;
      }
    }
  }

  return {
    region,
    label: REGION_PROFILES[region].label,
    loggedIn: mine.length > 0,
    percent: size > 0 ? Math.round((remain / size) * 100) : 0,
    remain,
    size,
    reported,
    checkin,
    credit,
    error,
  };
}

// ── The status bar item ─────────────────────────────────────────────────

export class AccountStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly service: WorkbuddyService;
  /** Re-render on theme change: the SVG's colours are baked in at build time. */
  private readonly themeListener: vscode.Disposable;

  constructor(service: WorkbuddyService) {
    this.service = service;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    // Clicking opens the management page — the only place a region can be
    // switched, an account picked, or a check-in claimed in full. It uses the
    // palette entry, not the gears' hook: a click here carries no vendor, so it
    // must not be read as "the user chose this cluster".
    this.item.command = "codebuddy.openPanel";
    this.item.text = ICON;
    this.item.show();

    this.themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
      void this.refresh();
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    const state = await this.service.getState();
    const settings = state.settings;
    const autoSelect = settings.autoSelectAccount === true;
    const rows = REGIONS.map((r) =>
      buildRegionRow(r, state.accounts, checkinEnabled(settings, r), autoSelect)
    );

    // `settings.region` is what the management page is showing, and it
    // defaults to CN — so a user who only signed in to Global would otherwise
    // watch a permanently empty bar. Prefer the chosen region, fall back to
    // whichever region actually has a number.
    const chosen =
      rows.find((r) => r.region === settings.region && r.reported > 0) ??
      rows.find((r) => r.reported > 0) ??
      rows.find((r) => r.region === settings.region) ??
      rows[0];

    this.item.text =
      chosen && chosen.reported > 0 ? `${ICON} ${compactCredits(chosen.remain)}` : ICON;
    this.item.tooltip = buildTooltip(
      rows,
      paletteFor(vscode.window.activeColorTheme.kind),
      autoSelect
    );
  }

  dispose(): void {
    this.themeListener.dispose();
    this.item.dispose();
  }
}

/**
 * Whether the daily check-in feature exists for a region.
 *
 * The INTL gateway has no check-in endpoint, so it ships disabled in settings.
 * Read from config rather than hard-coded so a cluster that gains the endpoint
 * is enabled by flipping one value.
 */
function checkinEnabled(settings: ServiceState["settings"], region: Region): boolean {
  const flags = settings.checkinByRegion;
  if (!flags) return false;
  return region === "intl" ? !!flags.intl : !!flags.cn;
}

/** Compact credits for the narrow status bar: 1234567 -> 1.2M, 12345 -> 12.3k. */
function compactCredits(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

// ── The hover card ──────────────────────────────────────────────────────

function escapeSvgText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape for the HTML attributes/text handed to the markdown renderer. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Approximate text width in px, for truncation only. CJK is full-width, ASCII
 * roughly 0.55em. A guess by design: measuring text in SVG needs a real layout
 * pass, which a hover cannot afford.
 */
function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      c >= 0x1100 &&
      (c <= 0x115f ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe4f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6) ||
        c >= 0x20000);
    if (wide) w += size;
    else if (ch === " ") w += size * 0.33;
    else w += size * 0.55;
  }
  return w;
}

/** Truncate to an estimated pixel budget, appending an ellipsis. */
function truncate(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s;
  let out = "";
  let w = 0;
  const ellW = textWidth("…", size);
  for (const ch of s) {
    const cw = textWidth(ch, size);
    if (w + cw + ellW > maxW) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/**
 * The card.
 *
 * Geometry is fixed except for the row count, so alignment is decided once
 * here instead of emerging from markup. Two edges: left at PAD_X, right at
 * CARD_W - PAD_X. The percentage and the check-in chip are `text-anchor="end"`
 * on the right edge; everything else starts at the left edge.
 */
function buildCardSvg(rows: RegionRow[], p: Palette, autoSelect: boolean): string {
  const width = CARD_W;
  const right = width - PAD_X;

  const text = (
    value: string,
    x: number,
    y: number,
    size = 13,
    weight = 400,
    color = p.fg,
    anchor: "start" | "end" = "start"
  ): string =>
    `<text x="${x}" y="${y}" fill="${color}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeSvgText(value)}</text>`;

  // 4px, not 6: at full width a 6px bar reads as a slab rather than as a
  // gauge, and it was the single heaviest element on the card.
  const bar = (percent: number, x: number, y: number, w: number): string => {
    const clamped = Math.min(Math.max(percent, 0), 100);
    const fill = Math.max(0, Math.round((clamped / 100) * w));
    const color = clamped < 20 ? p.danger : clamped < 50 ? p.warn : p.ok;
    return [
      `<rect x="${x}" y="${y}" width="${w}" height="4" rx="2" fill="${p.track}"/>`,
      fill > 0
        ? `<rect x="${x}" y="${y}" width="${fill}" height="4" rx="2" fill="${color}"/>`
        : "",
    ].join("");
  };

  // Row rhythm: name + percent, bar, then detail. `rowH` is the distance
  // between two rows' name lines; the gap AFTER a row's detail line is
  // rowH - 38, which is what keeps regions visually separate without a rule.
  const headerH = 30;
  const rowH = 52;

  const parts: string[] = [];

  // ONE text run. The previous version drew "CodeBuddy" and "额度" as two
  // elements and positioned the second with an ESTIMATED width — the estimate
  // was short, so they overlapped. One run cannot overlap itself.
  parts.push(text("CodeBuddy 额度", PAD_X, 18, 12, 600, p.fg));
  // Say WHICH figure the numbers are. In auto mode they are region totals; the
  // same balance reads very differently depending on that, and a bare number
  // invites "why is this bigger than my account?"
  if (autoSelect) {
    parts.push(text("自动分配 · 区间总额", right, 18, 11, 500, p.muted, "end"));
  }

  let y = headerH;
  for (const r of rows) {
    // 500, not 600/700: three bold lines per row made every region shout, and
    // the percentage competes better when the label is quiet.
    parts.push(text(r.label, PAD_X, y + 9, 12, 500));
    if (r.reported > 0) {
      parts.push(text(`${r.percent}%`, right, y + 9, 12, 600, p.fg, "end"));
      parts.push(bar(r.percent, PAD_X, y + 17, right - PAD_X));
      parts.push(text(formatBalance(r.remain, r.size), PAD_X, y + 36, 11, 400, p.muted));
    } else {
      // Three different reasons to have no number, needing three different
      // answers from the user: sign in / fix the account / wait.
      const note = !r.loggedIn ? "未登录" : r.error ? `额度不可用：${r.error}` : "额度读取中…";
      parts.push(text(truncate(note, 11, right - PAD_X), PAD_X, y + 24, 11, 400, p.muted));
    }
    const chip = checkinChip(r, p);
    if (chip) parts.push(text(chip.label, right, y + 36, 11, 600, chip.color, "end"));
    y += rowH;
  }

  // The canvas is sized from what was actually drawn, then the wrapper is
  // emitted FIRST. A hard-coded height is how an earlier version ended up with
  // ~25px of dead space below the last line. The last baseline is `y - 16`
  // (the row above `y` draws its detail line at `+36`), so 8px below it is
  // exactly enough to clear descenders.
  const height = y - 8;
  parts.unshift(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  );
  parts.push(`</svg>`);
  return parts.join("");
}

/**
 * `remain / size` for the detail line.
 *
 * Both halves are formatted the SAME way. Formatting one raw and one compact
 * produced `847 / 6.9k`, which reads as a ratio between two different scales.
 * Compact only kicks in once the TOTAL is large enough that the raw form would
 * run past the column.
 */
function formatBalance(remain: number, size: number): string {
  if (size >= 10_000) return `${compactCredits(remain)} / ${compactCredits(size)}`;
  return `${Math.round(remain).toLocaleString()} / ${Math.round(size).toLocaleString()}`;
}

/** The per-region check-in chip: text + colour, or null when there is none. */
function checkinChip(r: RegionRow, p: Palette): { label: string; color: string } | null {
  if (r.checkin === "none") return null;
  if (r.checkin === "claimed") {
    return { label: r.credit > 0 ? `已签到 +${r.credit}` : "今日已签到", color: p.ok };
  }
  if (r.checkin === "unclaimed") return { label: "可签到", color: p.warn };
  return { label: "签到状态未知", color: p.muted };
}

/** Local wall-clock, as `HH:MM`. */
function formatNow(): string {
  const d = new Date();
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Button metrics, matching VS Code's own control sizing. */
const BTN_H = 26;
const BTN_PAD_X = 13;
const BTN_FONT = 12;

/**
 * A command button, drawn as an SVG image.
 *
 * ── Why not a `<span>` with a background ──────────────────────────────
 * That was the previous attempt, and it cannot work. An inline element's
 * background box is sized by its own FONT METRICS — roughly 1.2em, so ~16px at
 * the host's 13px — and the one property that could extend it (`padding`) is
 * stripped by the tooltip sanitizer, which keeps only `color`,
 * `background-color` and `border-radius` on a span. The result is a chip that
 * always hugs its text: a label, never a button. Stretching the label only
 * stretches the text, and `<small>` did the opposite — it shrank the glyphs
 * while the surface stayed the same size.
 *
 * An `<img>` is a replaced element: `width` and `height` are honoured, and the
 * SVG inside it has full control over radius, inset and typography. It is the
 * only thing in a tooltip that can be drawn at a chosen size.
 *
 * ── The cost, stated plainly ──────────────────────────────────────────
 * An SVG inside `<img>` is its own document. It cannot read the host's CSS
 * variables (hence the literal palette) and it cannot react to `:hover` — so
 * this button's hover feedback is the pointer cursor and nothing more. The
 * span version did brighten its label on hover, but only because its surface
 * was too small to see; a button that is visible and a button that tints on
 * hover are not both available here, and visible wins.
 *
 * The anchor wraps the image, so the whole button is the click target.
 */
function button(
  command: string,
  label: string,
  title: string,
  kind: "primary" | "secondary",
  p: Palette,
  /** Transparent space drawn to the LEFT of the capsule. See below. */
  gutter: number
): string {
  const capsuleW = Math.ceil(textWidth(label, BTN_FONT)) + BTN_PAD_X * 2;
  const bg = kind === "primary" ? p.primaryBg : p.secondaryBg;
  const fg = kind === "primary" ? p.primaryFg : p.secondaryFg;
  // Half-pixel inset so a 1px stroke lands on the pixel grid instead of
  // straddling two of them.
  const face = p.buttonOutline
    ? `<rect x="${gutter + 0.5}" y="0.5" width="${capsuleW - 1}" height="${BTN_H - 1}" rx="4" fill="${bg}" stroke="${p.buttonOutline}"/>`
    : `<rect x="${gutter}" width="${capsuleW}" height="${BTN_H}" rx="4" fill="${bg}"/>`;
  // Optical centring: cap-height centring, not em-box centring. `0.72em` is
  // about the cap height, so this puts the visual mass of the label in the
  // middle rather than the mathematical middle of the font box.
  const baseline = Math.round((BTN_H + BTN_FONT * 0.72) / 2);
  const width = gutter + capsuleW;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BTN_H}" viewBox="0 0 ${width} ${BTN_H}">` +
    face +
    `<text x="${gutter + capsuleW / 2}" y="${baseline}" fill="${fg}" font-family="${FONT}" font-size="${BTN_FONT}" font-weight="500" text-anchor="middle">${escapeSvgText(label)}</text>` +
    `</svg>`;
  const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  // `alt` carries the label so the button is still identifiable when images
  // are unavailable, and `title` supplies the explanation on hover.
  return (
    `<a href="command:${command}" title="${escapeHtml(title)}">` +
    `<img src="${uri}" width="${width}" height="${BTN_H}" alt="${escapeHtml(label)}">` +
    `</a>`
  );
}

/**
 * The gutter is a transparent strip inside the FIRST button's own image.
 *
 * It exists because the button cannot be offset from its cell any other way:
 * `padding` and `margin` are stripped (and only survive on a span anyway), the
 * cell's own padding is the host's business, and `cellspacing` is not an
 * allowed attribute. Drawing the offset inside the image makes the capsule's
 * x-position a function of the image's x-position plus a number we choose —
 * which is exactly the relationship the card's contents already have to the
 * card image.
 */
const BTN_GUTTER = PAD_X;

/**
 * The tooltip body: the card, then a row of buttons flush left with a refresh
 * time flush right.
 *
 * ── Why the card is inside the table ──────────────────────────────────
 * The buttons have to line up with the card's own left inset, and the offset
 * between a table cell's edge and its content is the HOST's business: VS Code
 * ships no `td` padding rule for hovers, so the browser default applies
 * (`border-spacing: 2px` plus `padding: 1px`) — a value we cannot read, cannot
 * set (`cellspacing` and `cellpadding` are stripped by the sanitizer) and must
 * not hard-code, because it is whatever the browser and theme decide.
 *
 * Putting the card in the SAME table hands both to the same offset, whatever
 * it is: the card's left edge is `table.x + offset`, and so is the button
 * image's. The remaining difference is only the card's own `PAD_X`, which the
 * first button reproduces with a transparent gutter baked into its image.
 * Alignment therefore holds for any border-spacing, any cell padding, and any
 * theme — which is the point.
 *
 * ── Why it is a table at all ──────────────────────────────────────────
 * Two opposite alignments (buttons left, time right) on one line need a table:
 * there is no flex, no float, no grid, and `text-align` is not among the three
 * properties the sanitizer keeps on a span.
 *
 * `width` is the CARD width, not `100%`. A percentage resolves against the
 * hover's available width, which is wider than the card — the tooltip then
 * stretches to it and the timestamp drifts far right of the card's edge.
 */
function buildTooltipBody(rows: RegionRow[], p: Palette, cardUri: string): string {
  const actions: string[] = [];
  // Only offer check-in when something is claimable: a permanently visible
  // button for a cluster with no endpoint trains the user to ignore the row.
  if (rows.some((r) => r.checkin === "unclaimed")) {
    actions.push(button("codebuddy.checkinAll", "签到", "领取所有账号的每日额度", "primary", p, BTN_GUTTER));
  }
  // Only the first button carries the gutter, so the gap between two buttons
  // stays a plain space. The gutter is on whichever button leads the row.
  const leading = actions.length > 0 ? 0 : BTN_GUTTER;
  actions.push(button("codebuddy.refreshUsage", "刷新", "重新读取所有账号的额度", "secondary", p, leading));

  return (
    `<table width="${CARD_W}"><tbody>` +
    `<tr><td colspan="2"><img src="${cardUri}" width="${CARD_W}" alt="CodeBuddy usage"></td></tr>` +
    // A space between the images: without it they touch, and two adjacent
    // buttons read as one wide control.
    `<tr><td>${actions.join("&nbsp;")}</td>` +
    `<td align="right"><small>更新 ${formatNow()}</small></td></tr>` +
    `</tbody></table>`
  );
}

/**
 * Wrap the card into the hover VS Code renders, and add the actions under it.
 *
 * `isTrusted` is what makes `command:` links work; without it VS Code strips
 * them and the footer silently becomes dead text.
 */
function buildTooltip(
  rows: RegionRow[],
  palette: Palette,
  autoSelect: boolean
): vscode.MarkdownString {
  const svg = buildCardSvg(rows, palette, autoSelect);
  const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

  const md = new vscode.MarkdownString("", true);
  md.supportHtml = true;
  md.isTrusted = true;
  // No leading markdown image on its own line: the card is a table cell so it
  // shares the buttons' offset. The blank line keeps the table in its own
  // markdown block rather than letting the parser swallow it into a paragraph.
  md.appendMarkdown(`\n\n${buildTooltipBody(rows, palette, dataUri)}`);
  return md;
}

export type { RegionRow };
