/** Small formatting helpers shared by the views. */

export function percentOf(remain: number, size: number): number {
  return size > 0 ? (remain / size) * 100 : 0;
}

export function pct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

export function num(value: number | undefined): string {
  return (value ?? 0).toLocaleString();
}

export function compact(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  return String(value);
}

export function shortDate(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString();
}

/** Quota bar / text colour by remaining percentage. */
export function levelColor(percent: number): string {
  if (percent < 20) return "var(--wb-danger)";
  if (percent < 50) return "var(--wb-warn)";
  return "var(--wb-ok)";
}

export function countdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
