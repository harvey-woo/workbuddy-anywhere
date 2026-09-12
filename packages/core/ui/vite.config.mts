import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import * as path from "path";

/**
 * The UI is built into ../ui-dist and consumed by three hosts:
 *   - the local server serves it as static files (same origin as the API)
 *   - the VS Code extension loads it from media/ui in a webview
 *   - the Electron app loads it from disk in a BrowserWindow
 *
 * `base: "./"` keeps every asset reference relative, which is what makes the
 * webview and file:// cases work without a bundler-specific rewrite.
 */
const apiTarget = process.env.WORKBUDDY_API ?? "http://127.0.0.1:8787";
/** Config dir. `import.meta.dirname` replaces __dirname under native ESM. */
const here = import.meta.dirname;

export default defineConfig({
  root: here,
  base: "./",
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      // Lets the UI import the RPC contract directly from source. Only
      // `import type` plus the browser-safe rpc.ts may be imported from here —
      // everything else in src/ pulls in Node modules.
      "@core": path.resolve(here, "..", "src"),
    },
  },
  build: {
    outDir: path.resolve(here, "..", "ui-dist"),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      "/api": apiTarget,
      "/v1": apiTarget,
      "/openapi.json": apiTarget,
      "/health": apiTarget,
    },
  },
});
