/**
 * Public surface of @wbaw/core.
 *
 * Deliberately host-neutral and side-effect free: importing this module must
 * not start timers, open sockets or touch the network.
 *
 * NOT exported here: `./server` (the HTTP API). It is a separate entry point
 * so embedding it — the VS Code extension bundles this package — does not pull
 * node:http in, and so the browser UI can keep importing types from this
 * package without ever resolving a Node-only module at runtime.
 */

export * from "./auth";
export * from "./billing";
export * from "./capture";
export * from "./config-inject";
export * from "./errors";
export * from "./models";
export * from "./region";
export * from "./schema";
export * from "./service";
export * from "./settings";
export * from "./sse";
export * from "./storage";
export * from "./vision";
// The RPC contract + its one shared implementation. Safe to export here: these
// modules import nothing but types, so an embedding host (the VS Code
// extension) can route UI calls without pulling in the HTTP server.
export * from "./rpc";
export * from "./rpc-handlers";

// The API server — only useful for Node.js hosts (desktop, CLI). The VS Code
// extension never starts one, so this does not change its bundle.
export { startApiServer, type ApiServerHandle } from "./server/index";
export * from "./chat/types";
export * from "./chat/engine";
