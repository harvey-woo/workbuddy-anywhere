/**
 * Command line entry point.
 *
 *   workbuddy-anywhere serve [--port N] [--host H] [--data-dir DIR]
 *
 * The VS Code extension and the Electron app embed this package as a library;
 * this CLI is the "give me an OpenAI-compatible local endpoint plus the web UI"
 * path for any other client.
 *
 * There is no authentication by default: the process HOSTS the signed-in
 * accounts, so a caller is not proving an identity, it is choosing whose quota
 * to spend. That choice is a plain account marker (see `--help`). `--token`
 * remains available for anyone who binds beyond localhost.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSettingsStore } from "./settings";
import { FileAuthStore } from "./storage";
import { WorkbuddyService } from "./service";
import { startApiServer } from "./server/index";
import { DEFAULT_PORT } from "./server/openapi";

interface Args {
  port: number;
  host: string;
  dataDir: string;
  /** Explicit acknowledgement that the port may be reachable off-machine. */
  allowRemote: boolean;
}

const USAGE = `workbuddy-anywhere — serve WorkBuddy models to any client

Usage:
  workbuddy-anywhere serve [options]

Options:
  --port <n>        Port to bind (default ${DEFAULT_PORT})
  --host <addr>     Address to bind (default 127.0.0.1)
  --data-dir <dir>  Where the sessions and settings live
                    (default ~/.workbuddy-anywhere)
  --allow-remote    Permit a non-loopback --host. Anyone who can reach the port
                    can spend EVERY hosted account's quota.
  -h, --help        Show this help

Accounts:
  This server hosts the signed-in accounts and needs no authorization. A request
  chooses whose quota to spend by putting the account KEY in the standard
  credential slot, so a client's ordinary "API key" field is enough:

    Authorization: Bearer <account-key>

  Keys are listed by GET /api/state. Without one, the request uses whichever
  account is currently selected.
`;

function packageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf-8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Where sessions and settings live by default.
 *
 * The product used to be called "workbuddy-proxy"; an existing
 * `~/.workbuddy-proxy` is still used rather than abandoned, because silently
 * starting from an empty directory would look exactly like being signed out.
 * The move is announced so it is not a permanent surprise.
 */
function defaultDataDir(): string {
  const preferred = path.join(os.homedir(), ".workbuddy-anywhere");
  const legacy = path.join(os.homedir(), ".workbuddy-proxy");
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
    process.stderr.write(
      `Using the pre-rename data directory ${legacy}.\n` +
        `Move it to ${preferred} when convenient.\n`
    );
    return legacy;
  }
  return preferred;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: DEFAULT_PORT,
    host: "127.0.0.1",
    // Resolved at the END of parsing: computing it here would run the
    // pre-rename check (and print its notice) even when --data-dir is given.
    dataDir: "",
    allowRemote: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case "--port":
        args.port = Number(value());
        if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
          throw new Error(`Invalid --port`);
        }
        break;
      case "--host":
        args.host = value();
        break;
      case "--data-dir":
        args.dataDir = path.resolve(value());
        break;
      case "--token":
        throw new Error(
          "--token was removed: the Authorization header now carries the ACCOUNT KEY, which is a selector, not a secret."
        );
      case "--no-auth":
        throw new Error("--no-auth was removed: this server never requires authorization.");
      case "--allow-remote":
        args.allowRemote = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!args.dataDir) args.dataDir = defaultDataDir();
  return args;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  if (command !== "serve") {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  let args: Args;
  try {
    args = parseArgs(rest);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const service = new WorkbuddyService({
    auth: new FileAuthStore(args.dataDir),
    settings: new FileSettingsStore(args.dataDir),
    log: (msg) => console.log(`[core] ${msg}`),
  });
  const state = await service.init();

  // Accounts are the thing worth protecting. The account key is a SELECTOR,
  // not a secret, so a reachable port means every hosted account is spendable
  // by anyone — hence the explicit acknowledgement rather than a silent bind.
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(args.host);
  if (!loopback && !args.allowRemote) {
    process.stderr.write(
      `Refusing to bind ${args.host}.\n` +
        `This server spends your signed-in accounts' quota, and the account key is a selector,\n` +
        `not a secret — so anyone who can reach the port can use every account.\n` +
        `Pass --allow-remote if that is really what you want.\n`
    );
    service.dispose();
    process.exitCode = 1;
    return;
  }

  const server = await startApiServer({
    service,
    host: args.host,
    port: args.port,
    version: packageVersion(),
    log: (msg) => console.log(`[server] ${msg}`),
  });

  const active = state.accounts.find((a) => a.active);
  console.log("");
  console.log(`  WorkBuddy Anywhere v${packageVersion()}`);
  console.log(`  UI          ${server.url}/`);
  console.log(`  OpenAI API  ${server.url}/v1`);
  console.log(`  OpenAPI     ${server.url}/openapi.json`);
  console.log(`  Data dir    ${args.dataDir}`);
  if (!loopback) {
    console.log(
      `  ! EXPOSED   bound to ${args.host} — anyone who can reach this port can spend every account`
    );
  }
  console.log(
    `  Accounts    ${state.accounts.length} hosted${active ? ` (current: ${active.label})` : ""}`
  );
  if (state.accounts.length > 0) {
    console.log(`  Select one  Authorization: Bearer <account-key>`);
  }
  console.log(
    `  Session     ${active ? `ready as ${active.label}` : "not signed in — open the UI to scan the QR code"}`
  );
  console.log(`  Models      ${state.models.length} (${state.modelsSource})`);
  if (state.catalogError) {
    console.log(`  Catalog     FAILED: ${state.catalogError}`);
  }
  console.log("");

  const shutdown = async (): Promise<void> => {
    await server.close();
    service.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
