#!/usr/bin/env node
/**
 * Does the INTL gateway REQUIRE a leading system message?
 *
 * Symptom: chat through the `codebuddy-intl` vendor fails with
 *
 *   400 {"code":11128,"msg":"first message is not system prompt"}
 *
 * VS Code folds its own system prompt into the first USER message (see the
 * note on `ChatMessage.role` in chat/types.ts), so what we forward starts with
 * `role: "user"`. CN accepts that; INTL apparently does not. This probe sends
 * the SAME tiny prompt twice — once with the current shape, once with a system
 * message prepended — and prints the raw gateway verdict for each.
 *
 * It prints only `code` / `msg` / HTTP status. Never tokens, never ids.
 *
 * Usage:
 *   node scripts/probe-intl-system-prompt.cjs [dataDir]
 *
 * COST: on success this spends a very small amount of the INTL account's
 * quota (a ~4-token prompt, no tools). It is the only way to tell "the
 * gateway rejects the shape" apart from "the gateway likes the shape".
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { pathToFileURL } = require("url");

const dir = process.argv[2] ?? path.join(os.homedir(), ".workbuddy-anywhere");
const file = path.join(dir, "codebuddy-auth.json");

const REGION_HOSTS = {
  intl: { base: "https://www.codebuddy.ai", origin: "https://www.workbuddy.ai", ua: "WorkBuddy/1.0" },
  cn: { base: "https://copilot.tencent.com", origin: "https://www.codebuddy.cn", ua: "CLI/2.63.2 CodeBuddy/2.63.2" },
};
/**
 * Model ids are NOT shared between clusters: CN fronts its catalogue with
 * `default`, INTL with `default-model`. Using one for the other answers
 * `11102 model [...] service info not found`, which is indistinguishable from
 * a message-shape rejection unless the model id is right — that mistake made
 * an earlier run of this probe read as "CN rejects the system message".
 */
const REGION_MODEL = { cn: "default", intl: "default-model" };
const PATH_ = "/v2/chat/completions";

let accounts;
try {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  accounts = Object.values(raw.accounts ?? {});
  if (accounts.length === 0) throw new Error("no accounts");
} catch (e) {
  console.error(`Cannot read ${file}: ${e.message}`);
  process.exit(1);
}

/** The account for a region, defaulting a missing `region` to CN (legacy rows). */
function accountFor(region) {
  return accounts.find((a) => (a.region ?? "cn") === region);
}

function headers(account, host) {
  const h = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Requested-With": "XMLHttpRequest",
    Origin: host.origin,
    Referer: host.origin + "/",
    Authorization: `Bearer ${account.accessToken}`,
    "User-Agent": account.userAgent || host.ua,
  };
  if (account.uid) h["X-User-Id"] = account.uid;
  if (account.enterpriseId) h["X-Enterprise-Id"] = account.enterpriseId;
  if (account.refreshToken) h["X-Refresh-Token"] = account.refreshToken;
  if (account.domain) h["X-Domain"] = account.domain;
  return h;
}

/**
 * End-to-end: build the payload with the REAL compiled builder, send it, and
 * report what the gateway says.
 *
 * This is the strongest available evidence short of driving VS Code. The unit
 * tests pin the shape; this pins that the shape is one the gateway accepts.
 */
async function probeRealBuilder(region) {
  const account = accountFor(region);
  const host = REGION_HOSTS[region];
  const engine = await import(
    pathToFileURL(path.join(__dirname, "..", "out", "chat", "engine.js")).href
  );

  // Exactly what VS Code hands the provider: its system prompt folded into the
  // first user message, so there is no system role at all.
  const oaiMessages = await engine.buildOpenAIMessages(
    [{ role: "user", text: "Reply with the single word: ok" }],
    { model: undefined, settings: {} }
  );

  process.stdout.write(`\n=== [${region}] Z — REAL compiled builder ===\n`);
  process.stdout.write(
    `  roles: ${oaiMessages.map((m) => m.role).join(" -> ")}\n`
  );
  if (oaiMessages[0]?.role !== "system") {
    process.stdout.write(
      "  ✗ the builder did NOT produce a leading system message — the fix is not in this build\n"
    );
    return false;
  }

  const body = {
    model: REGION_MODEL[region],
    messages: oaiMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  try {
    const res = await fetch(`${host.base}${PATH_}`, {
      method: "POST",
      headers: headers(account, host),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    process.stdout.write(`  HTTP ${res.status}\n`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      try {
        const j = JSON.parse(text);
        process.stdout.write(`  code=${j.code}  msg=${j.msg}\n`);
      } catch {
        process.stdout.write(`  body: ${text.slice(0, 180)}\n`);
      }
      return false;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    let chunks = 0;
    while (chunks < 60 && seen.length < 1500) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
      chunks += 1;
    }
    await reader.cancel().catch(() => {});
    const hasDelta = /"content"|"delta"/.test(seen);
    process.stdout.write(
      `  ${hasDelta ? "✅" : "?"} real answer streamed (${chunks} chunk(s))\n`
    );
    return hasDelta;
  } catch (e) {
    process.stdout.write(`  ✗ transport error: ${e.message}\n`);
    return false;
  }
}

/** Print the verdict without dumping a whole stream. */
async function probe(region, label, messages) {
  const account = accountFor(region);
  const host = REGION_HOSTS[region];
  const body = {
    model: REGION_MODEL[region],
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  process.stdout.write(`\n=== [${region}] ${label} ===\n`);
  process.stdout.write(
    `  model ${REGION_MODEL[region]}, first role ${messages[0].role} (${messages.length} msg)\n`
  );
  try {
    const res = await fetch(`${host.base}${PATH_}`, {
      method: "POST",
      headers: headers(account, host),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    process.stdout.write(`  HTTP ${res.status}\n`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // The gateway answers with JSON on rejection; keep only code/msg.
      try {
        const j = JSON.parse(text);
        process.stdout.write(`  code=${j.code}  msg=${j.msg}\n`);
      } catch {
        process.stdout.write(`  body: ${text.slice(0, 180)}\n`);
      }
      return false;
    }
    // Success: read just enough of the stream to confirm real content, then
    // stop. Leaving it unread would keep the connection open.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    let chunks = 0;
    while (chunks < 40 && seen.length < 600) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
      chunks += 1;
    }
    await reader.cancel().catch(() => {});
    const hasDelta = /"delta"/.test(seen);
    const hasError = /"error"/.test(seen);
    process.stdout.write(
      `  ✅ stream opened; ${chunks} chunk(s), delta=${hasDelta}, error=${hasError}\n`
    );
    return !hasError;
  } catch (e) {
    process.stdout.write(`  ✗ transport error: ${e.message}\n`);
    return false;
  }
}

(async () => {
  const has = (r) => (accountFor(r) ? "yes" : "NO");
  process.stdout.write(
    `accounts: cn=${has("cn")}  intl=${has("intl")}  (total ${accounts.length})\n`
  );

  const results = {};

  // A: exactly what the extension forwards today — VS Code folds its system
  //    prompt into the first USER message, so there is no system role at all.
  results.intl_userFirst = await probe("intl", "A — current shape: user first", [
    { role: "user", content: "hi" },
  ]);

  // B: what the gateway is asking for.
  results.intl_systemFirst = await probe("intl", "B — system first, then user", [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "hi" },
  ]);

  // C: an EMPTY system message. If this is accepted it is the better fix —
  //    it satisfies the structural requirement without inventing a system
  //    prompt the user's editor never wrote.
  results.intl_emptySystem = await probe("intl", "C — EMPTY system first", [
    { role: "system", content: "" },
    { role: "user", content: "hi" },
  ]);

  if (accountFor("cn")) {
    // Baseline first: CN must ACCEPT the user-first shape with this model id.
    // Without it, a rejection below could be the model id rather than the
    // message shape, and the whole region-gating decision would be wrong.
    results.cn_baseline = await probe("cn", "D — CN baseline: user first", [
      { role: "user", content: "hi" },
    ]);
    results.cn_systemFirst = await probe("cn", "E — CN with system first", [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hi" },
    ]);
  }

  // Z: end-to-end through the shipped builder. This is the one that proves the
  // user-visible failure is gone rather than merely explained.
  if (accountFor("intl")) {
    results.intl_realBuilder = await probeRealBuilder("intl");
  }

  process.stdout.write("\n===== verdict =====\n");
  for (const [k, v] of Object.entries(results)) {
    process.stdout.write(`  ${k.padEnd(20)} ${v ? "accepted" : "REJECTED"}\n`);
  }
  if (!results.intl_userFirst && results.intl_systemFirst) {
    process.stdout.write("\n→ INTL requires a leading system message.\n");
    process.stdout.write(
      results.intl_emptySystem
        ? "→ An EMPTY system message is enough (no invented prompt needed).\n"
        : "→ The system message must carry content.\n"
    );
    if (!results.cn_baseline) {
      process.stdout.write(
        "→ CN baseline FAILED too: the model id is wrong, so this probe cannot " +
          "say whether CN tolerates a system message.\n"
      );
    } else if (results.cn_systemFirst === false) {
      process.stdout.write("→ CN REJECTS it: the fix must be region-gated.\n");
    } else {
      process.stdout.write("→ CN accepts it too, so the fix can be unconditional.\n");
    }
  } else if (results.intl_userFirst) {
    process.stdout.write(
      "\n→ INTL accepted the user-first shape here; the failure needs another cause.\n"
    );
  }
  if (results.intl_realBuilder) {
    process.stdout.write(
      "\n→ End-to-end through the shipped builder: INTL chat WORKS.\n"
    );
  } else if ("intl_realBuilder" in results) {
    process.stdout.write(
      "\n→ End-to-end through the shipped builder: STILL FAILING.\n"
    );
  }
})().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
