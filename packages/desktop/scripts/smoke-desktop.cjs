/**
 * Smoke test for the desktop app.
 *
 * Launches nothing itself: it attaches to a RUNNING app over the Chrome
 * DevTools Protocol and asserts on the real renderer, because "the process is
 * alive" proves nothing about whether the page rendered or whether the IPC
 * bridge answers.
 *
 *   yarn workspace @wbaw/desktop start --remote-debugging-port=9222
 *   node scripts/smoke-desktop.cjs
 *
 * Uses Node's global WebSocket (Node >= 22) so there is no dependency to add.
 */

const PORT = process.env.WORKBUDDY_DEBUG_PORT ?? "9222";

/** The one expression that answers every question we care about. */
const PROBE = `(async () => {
  const out = { title: document.title, text: "", bridge: typeof window.workbuddy?.invoke, config: null, state: null, error: null };
  out.text = (document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 300);
  out.config = window.__WORKBUDDY__ ?? null;
  try {
    out.state = await window.workbuddy.invoke("getState");
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }
  return out;
})()`;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n       ${detail}` : ""}`);
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("no debuggable page — is the app running with --remote-debugging-port?");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    entry(msg);
  });

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("devtools websocket failed")), { once: true });
  });

  const result = await send("Runtime.evaluate", {
    expression: PROBE,
    awaitPromise: true,
    returnByValue: true,
  });

  const value = result?.result?.value;
  if (!value) throw new Error(`the page returned nothing: ${JSON.stringify(result).slice(0, 300)}`);

  console.log("attached renderer");
  check("the shared management UI is what loaded", value.title.includes("WorkBuddy Anywhere") && value.text.includes("Accounts"), `title="${value.title}" text="${value.text.slice(0, 120)}…"`);
  check("the preload bridge is exposed", value.bridge === "function", `window.workbuddy.invoke: ${value.bridge}`);
  check("the host config reached the page", value.config?.transport === "ipc", JSON.stringify(value.config));
  check("IPC answered getState (no host hook needed)", !value.error && !!value.state, value.error ?? "ok");
  check("the catalog reached the desktop app", Array.isArray(value.state?.models) && value.state.models.length > 0, `${value.state?.models?.length ?? 0} models, source=${value.state?.modelsSource}`);
  check("settings came from the desktop's own store", value.state?.settings?.enabled === true, JSON.stringify(value.state?.settings));

  // The tray title is exactly this number, so assert the SHAPE (and report what
  // the menu bar should be showing) rather than a fixed account count: the app
  // is usable signed out, with one account, or with several.
  const accounts = value.state?.accounts ?? [];
  const active = accounts.find((a) => a.key === value.state?.activeKey) ?? accounts[0];
  check("accounts are tray-shaped", accounts.every((a) => typeof a.key === "string" && typeof a.label === "string"), `${accounts.length} account(s)`);
  check("the tray title has the active account's percentage", accounts.length === 0 || typeof active?.usage?.percent === "number", accounts.length === 0 ? "(signed out — the tray shows the icon alone)" : `menu bar should read "${active.usage.percent.toFixed(1)}%" for ${active.label}`);

  ws.close();

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERR", err.message);
  process.exitCode = 1;
});
