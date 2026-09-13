/**
 * Tray menu i18n — standalone locale strings for Electron's main process.
 *
 * The tray cannot use the Vue i18n system (it runs outside the renderer),
 * so this is a minimal standalone lookup keyed on the same locale values
 * stored in Settings.
 */

export type TrayLocale = "en" | "zh";

type TrayString = string | ((params: Record<string, string>) => string);

const strings: Record<TrayLocale, Record<string, TrayString>> = {
  en: {
    notSignedIn: "Not signed in",
    openManagement: "Open management page",
    switchAccountCn: "Switch account · China",
    switchAccountIntl: "Switch account · Global",
    checkinAll: "Check in all",
    refreshUsage: "Refresh usage",
    openAtLogin: "Open at login",
    quit: "Quit WorkBuddy Anywhere",
    autoDistribute: (p: Record<string, string>) =>
      `Auto · ${p.count} accounts — ${p.total} credits total`,
    usageCn: "Usage · China",
    usageIntl: "Usage · Global",
    theme: "Theme",
    dark: "Dark",
    light: "Light",
    language: "Language",
    english: "English",
    chinese: "中文",
  },
  zh: {
    notSignedIn: "未登录",
    openManagement: "打开管理页",
    switchAccountCn: "切换账号 · 中国大陆",
    switchAccountIntl: "切换账号 · Global",
    checkinAll: "全部账号签到",
    refreshUsage: "刷新用量",
    openAtLogin: "开机自动启动",
    quit: "退出 WorkBuddy Anywhere",
    autoDistribute: (p: Record<string, string>) =>
      `自动分配 · ${p.count} 个账号 — 总计 ${p.total} credits`,
    usageCn: "账号用量 · 中国大陆",
    usageIntl: "账号用量 · Global",
    theme: "主题",
    dark: "深色",
    light: "浅色",
    language: "语言",
    english: "English",
    chinese: "中文",
  },
};

/**
 * Get a translated string. Supports simple `{param}` interpolation
 * via a params object.
 */
export function trayT(
  locale: TrayLocale,
  key: string,
  params?: Record<string, string>
): string {
  const bundle = strings[locale] ?? strings.en;
  const entry: TrayString = bundle[key] ?? strings.en[key] ?? key;
  if (typeof entry === "function") return entry(params ?? {});
  return entry;
}
