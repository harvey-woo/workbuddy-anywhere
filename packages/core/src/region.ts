/**
 * Region catalogue.
 *
 * WorkBuddy ships two clusters:
 *   - cn  : the Tencent-hosted API used in mainland China. Sign-in is the
 *           device-code-style scan-and-poll protocol on `/v2/plugin/auth/*`,
 *           the same protocol the WorkBuddy Anywhere UI has been driving.
 *   - intl: the global Tencent-hosted API. Sign-in is **OAuth** (Keycloak with
 *           Google / GitHub / X as identity brokers); the device-code protocol
 *           does not exist there, and the existing access token does not
 *           cross over (verified 2026-09-11: same bearer returns 200 OK on
 *           `/v3/config` and 401 on `/billing/...` and `/v2/plugin/login/account`).
 *
 * Picking the right host is the FIRST decision every request makes — wrong host
 * means 401 on every call, never a clean fallback.
 *
 * `intl` is the canonical label for the international cluster because it is the
 * value the upstream bundle emits in its `IS_INTERNATIONAL_EDITION` flag
 * (`https://www.workbuddy.ai/login/?platform=website&state=2&...` — `state=2`
 * maps to it). CN uses `state=1`.
 */
export type Region = "cn" | "intl";

export const REGIONS: readonly Region[] = ["cn", "intl"] as const;

export interface RegionProfile {
  label: string;
  baseUrl: string;
  /** Origin used for Origin / Referer on upstream requests. */
  origin: string;
  /**
   * The User-Agent this cluster's OWN client presents when it asks for the
   * product configuration.
   *
   * This is NOT cosmetic: the gateway keys the whole response off it, and the
   * two identities return DIFFERENT CATALOGS (verified 2026-09-11, both
   * clusters, with a real session):
   *   - `cn`   : the CLI identity returns 29 models INCLUDING `hy4-preview` and
   *              `hy4-preview-x`; the desktop-app UA returns 37 that contain no
   *              hy4 at all.
   *   - `intl` : the desktop-app UA returns the 21-model list the WorkBuddy AI
   *              app actually shows (`hy4-preview-f`, `hy4-preview`, `hy3`,
   *              `deepseek-v4.1-flash`, `gpt-6-astra`); the CLI UA returns 35
   *              with no hy4 at all.
   * Sending the other one silently yields a different product's catalog, which
   * is exactly why the picker used to be missing models the app shows.
   */
  clientUserAgent: string;
  /** Send `X-Requested-With: XMLHttpRequest`, like the desktop client does. */
  clientXhr?: boolean;
  /**
   * The product key sent to the login page (`?product=...`) so the upstream
   * knows which portal to render and which rate-limited OAuth client to use.
   * `workbuddy` is the value the bundle itself emits.
   */
  loginProduct: string;
  /**
   * Upstream login state: `1` = CN, `2` = INTL. Hard-coded on the gateway.
   */
  loginState: 1 | 2;
}

export const REGION_PROFILES: Record<Region, RegionProfile> = {
  cn: {
    label: "中国大陆",
    baseUrl: "https://copilot.tencent.com",
    origin: "https://www.codebuddy.cn",
    clientUserAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
    loginProduct: "workbuddy",
    loginState: 1,
  },
  intl: {
    label: "Global",
    baseUrl: "https://www.codebuddy.ai",
    origin: "https://www.workbuddy.ai",
    clientUserAgent: "WorkBuddy/1.0",
    clientXhr: true,
    loginProduct: "workbuddy",
    loginState: 2,
  },
};

/** Default when the persisted preference is missing or unrecognised. */
export const DEFAULT_REGION: Region = "cn";

/** User-facing helper to convert between region ids and labels. */
export function regionLabel(region: Region): string {
  return REGION_PROFILES[region].label;
}