#!/usr/bin/env node
/**
 * Qoder CN (lingma) — Auth + Models + Chat test
 *
 * Connects to the lingma Go binary's WebSocket (same mechanism as the lingma
 * VS Code extension), performs Aliyun SSO login, then tests models & chat.
 *
 * Prerequisites:
 *   - tongyi-lingma extension installed (Go binary running on a port)
 *   - npm install ws (in /tmp/lingma-test or globally)
 *
 * Usage:
 *   node scripts/test-lingma-auth.js
 */

const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");

// ── Lingma WebSocket connection ─────────────────────────────────────────

const INFO_FILE = path.join(
  os.homedir(),
  ".lingma/vscode/sharedClientCache/.info"
);

function getPort() {
  if (!fs.existsSync(INFO_FILE)) {
    console.error("[!] Lingma .info not found — is tongyi-lingma extension installed and running?");
    process.exit(1);
  }
  const lines = fs.readFileSync(INFO_FILE, "utf-8").trim().split("\n");
  return parseInt(lines[0], 10);
}

/**
 * LSP-style JSON-RPC over WebSocket.
 * Messages are framed as: Content-Length: <len>\r\n\r\n<json>
 */
class LingmaConnection {
  constructor(port) {
    this.port = port;
    this.nextId = 1;
    this.ws = null;
    this.pending = new Map(); // id → { resolve, reject }
    this.notificationHandlers = new Map(); // method → callback[]
    this.anyHandler = null;
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`, {
        perMessageDeflate: false,
        maxPayload: 256 * 1024 * 1024,
      });
      this.ws.on("open", () => {
        this.connected = true;
        console.log(`[ws] connected to ws://127.0.0.1:${this.port}`);
        resolve();
      });
      this.ws.on("error", (err) => reject(err));
      this.ws.on("close", (code) => {
        this.connected = false;
        console.log(`[ws] closed: ${code}`);
      });

      let buf = Buffer.alloc(0);
      this.ws.on("message", (raw) => {
        buf = Buffer.concat([buf, raw]);
        while (true) {
          const he = buf.indexOf("\r\n\r\n");
          if (he === -1) break;
          const m = buf.slice(0, he).toString().match(/Content-Length:\s*(\d+)/i);
          if (!m) break;
          const len = parseInt(m[1], 10);
          const start = he + 4;
          if (buf.length < start + len) break;
          const body = buf.slice(start, start + len).toString();
          buf = buf.slice(start + len);
          this._onMessage(JSON.parse(body));
        }
      });
    });
  }

  _onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(msg.error) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const handlers = this.notificationHandlers.get(msg.method) || [];
      for (const h of handlers) h(msg.params);
      if (this.anyHandler) this.anyHandler(msg);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: "2.0", method, params, id });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`request ${method} timed out`));
        }
      }, 30000);
    });
  }

  onNotification(method, cb) {
    if (!this.notificationHandlers.has(method)) this.notificationHandlers.set(method, []);
    this.notificationHandlers.get(method).push(cb);
  }

  _send(msg) {
    const json = JSON.stringify(msg);
    this.ws.send(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// ── Auth flow (mirrors lingma extension) ───────────────────────────────

async function waitForAuth(conn, timeoutMs = 300_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await conn.request("auth/status");
    if (status && status.status === 0) {
      console.log(`[auth] ✓ 登录成功: ${status.name || status.id}`);
      return status;
    }
    if (status && status.status === 2) {
      throw new Error(`auth failed: status=${status.status} (${JSON.stringify(status)})`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("auth timeout — user did not complete login within 5 minutes");
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const port = getPort();
  console.log(`\n=== Qoder CN Auth Test ===`);
  console.log(`Port: ${port}\n`);

  const conn = new LingmaConnection(port);
  await conn.connect();

  // 1. Initialize
  console.log("1. Initialize...");
  const initResult = await conn.request("initialize", {
    processId: process.pid,
    clientInfo: { name: "qoder-test", version: "0.1.0" },
  });
  console.log("   ✓ OK\n");

  // 2. Check current auth status
  console.log("2. Check auth status...");
  const auth0 = await conn.request("auth/status");
  console.log("   status:", auth0.status, auth0.status === 0 ? "(已登录)" : "(未登录)");

  if (auth0.status !== 0) {
    // 3. Trigger auth/login → get Aliyun SSO URL
    console.log("\n3. Trigger auth/login...");
    const loginResult = await conn.request("auth/login");
    console.log("   login result:", JSON.stringify(loginResult).slice(0, 500));

    const url = loginResult?.url || loginResult?.loginUrl || loginResult?.authUrl;
    if (url) {
      console.log(`\n   🌐 Opening login URL in browser...`);
      try {
        execSync(`open "${url}"`, { stdio: "pipe" });
      } catch {
        console.log(`   Please open this URL manually:\n   ${url}`);
      }

      // 4. Poll auth/status
      console.log("\n4. Waiting for login completion...");
      const auth = await waitForAuth(conn, 300_000);
      console.log("   ✓ Auth completed\n");
    } else {
      console.log("   ⚠ No URL returned. Full response:", JSON.stringify(loginResult));
      console.log("   You may need to login via the lingma VS Code extension first.");
      console.log("   Continuing with remaining tests...\n");
    }
  }

  // 5. Config: query models
  console.log("5. Query models...");
  try {
    const models = await conn.request("config/queryModels");
    if (models && typeof models === "object") {
      const keys = Object.keys(models);
      console.log(`   Model categories: ${keys.length}`);
      for (const key of keys) {
        const cat = models[key];
        if (Array.isArray(cat)) {
          console.log(`   ${key}: ${cat.length} models`);
          for (const m of cat.slice(0, 3)) {
            console.log(`     - ${m.id || m.name || JSON.stringify(m).slice(0, 80)}`);
          }
        } else {
          console.log(`   ${key}:`, JSON.stringify(cat).slice(0, 120));
        }
      }
    }
  } catch (e) {
    console.log("   Error:", JSON.stringify(e).slice(0, 200));
  }

  // 6. Credit usage
  console.log("\n6. Credit usage...");
  try {
    const credits = await conn.request("credit/usage");
    console.log("   Credits:", JSON.stringify(credits).slice(0, 300));
  } catch (e) {
    console.log("   Error:", JSON.stringify(e).slice(0, 200));
  }

  // 7. List sessions
  console.log("\n7. List sessions...");
  try {
    const sessions = await conn.request("chat/listAllSessions");
    const list = Array.isArray(sessions) ? sessions : sessions?.sessions || [];
    console.log(`   Found ${list.length} sessions`);
    for (const s of list.slice(0, 3)) {
      console.log(`   - ${s.sessionId || s.id}: ${s.title || s.name || "(no title)"}`);
    }
  } catch (e) {
    console.log("   Error:", JSON.stringify(e).slice(0, 200));
  }

  // 8. Chat ask (test)
  console.log("\n8. Test chat/ask...");
  const sessionId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  console.log(`   sessionId: ${sessionId}`);

  const answerTexts = [];
  conn.onNotification("chat/answer", (params) => {
    if (params.text) answerTexts.push(params.text);
  });
  conn.onNotification("chat/finish", (params) => {
    console.log("\n   [chat/finish]", JSON.stringify(params).slice(0, 200));
  });
  conn.onNotification("chat/start", (params) => {
    console.log("   [chat/start] requestId:", params.requestId);
  });

  try {
    const askResult = await conn.request("chat/ask", {
      chatTask: 0,
      sessionType: "CHAT",
      mode: "CHAT",
      sessionId,
      requestId,
      source: 1,
      stream: true,
      isReply: false,
      codeLanguage: "",
      fileLanguage: "",
      taskDefinitionType: "system",
      preferredLanguage: "zh-CN",
      questionText: "你好，请用一句话介绍你自己。",
      chatContext: { text: "你好，请用一句话介绍你自己。" },
      extra: { context: [] },
      closeTypewriter: true,
    });
    console.log("   ask sent:", JSON.stringify(askResult).slice(0, 200));

    // Wait for streaming response (up to 15s)
    await new Promise((r) => setTimeout(r, 15000));

    if (answerTexts.length > 0) {
      console.log("\n   ✅ Response:", answerTexts.join(""));
    } else {
      console.log("\n   ⚠ No response received. Check auth status.");
    }
  } catch (e) {
    console.log("   Error:", JSON.stringify(e).slice(0, 300));
  }

  conn.close();
  console.log("\n=== Test complete ===");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
