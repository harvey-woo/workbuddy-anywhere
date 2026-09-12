import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import {
  FileAuthStore,
  FileSettingsStore,
  WorkbuddyService,
} from "@wbaw/core";

/**
 * Where the desktop app keeps its sessions and settings.
 *
 * `app.getPath("userData")` follows the package's `name`/`productName`, so a
 * RENAME moves it — and an empty directory looks exactly like being signed out.
 * The pre-rename directory is therefore reused while it is the one holding
 * sessions; otherwise the current one is used, and created on first write.
 *
 * Deliberately NOT the CLI's directory (`~/.workbuddy-anywhere`, or the
 * pre-rename `~/.workbuddy-proxy` while it exists): two processes must never
 * refresh — and rewrite — the same credential file, and this is a different app
 * with its own lifecycle. `WORKBUDDY_DATA_DIR` overrides everything, which is
 * what makes a scratch instance possible without touching real accounts.
 */
export function dataDir(): string {
  if (process.env.WORKBUDDY_DATA_DIR) return process.env.WORKBUDDY_DATA_DIR;

  const current = path.join(app.getPath("userData"), "data");
  const legacy = path.join(app.getPath("appData"), "workbuddy-desktop", "data");
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

/**
 * Build the core service for this host.
 *
 * No `vision` helper on purpose: core's built-in one describes images with the
 * account's own catalog models, which is all a client without an LM namespace
 * can do — and it needs no code here.
 */
export function createDesktopService(log: (msg: string) => void): WorkbuddyService {
  const dir = dataDir();
  log(`data dir: ${dir}`);
  return new WorkbuddyService({
    auth: new FileAuthStore(dir),
    settings: new FileSettingsStore(dir),
    log,
  });
}
