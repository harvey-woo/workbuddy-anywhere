/**
 * Static file serving for the built Vue UI (ui-dist).
 *
 * The config injection used to live here too; it moved to `config-inject.ts`
 * because the VS Code webview needs it as well and must not import this module
 * (which pulls in fs/path).
 */

import * as fs from "fs/promises";
import * as path from "path";

export { CONFIG_PLACEHOLDER, injectConfig } from "../config-inject";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Resolve a URL path inside `root`. Returns undefined for anything that
 * escapes the root or does not exist — the caller decides 404 vs SPA
 * fallback.
 */
export async function readStatic(
  root: string,
  urlPath: string
): Promise<{ body: Buffer; contentType: string } | undefined> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(rootAbs, rel.replace(/^\/+/, ""));
  // Traversal guard: the resolved path must stay INSIDE rootAbs. Comparing
  // against `rootAbs + sep` prevents "/root-evil" from matching "/root".
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    return undefined;
  }
  try {
    const body = await fs.readFile(resolved);
    return {
      body,
      contentType:
        MIME[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
    };
  } catch {
    return undefined;
  }
}
