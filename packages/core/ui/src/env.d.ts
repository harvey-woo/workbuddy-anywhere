/// <reference types="vite/client" />

/** Editor-only shim: the UI is compiled by Vite (esbuild), not by tsc. */
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
