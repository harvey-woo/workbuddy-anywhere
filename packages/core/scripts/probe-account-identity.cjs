#!/usr/bin/env node
/**
 * Which endpoint can tell us WHO a session belongs to?
 *
 * The login flow calls `GET /v2/plugin/login/account?state=...` right after the
 * token is issued. That endpoint needs a LIVE state and it is easy for the call
 * to come back empty, which leaves the account with no uid and no nickname —
 * and, worse, an account key of "default", so a SECOND login would overwrite
 * the first.
 *
 * This probe uses an ALREADY-AUTHENTICATED session to look for a profile
 * endpoint that works from the tokens alone. It prints response SHAPES and
 * key names only — never values, never tokens.
 *
 * Usage:
 *   node scripts/probe-account-identity.cjs [dataDir]
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const dir = process.argv[2] ?? path.join(os.homedir(), ".workbuddy-anywhere");
const file = path.join(dir, "codebuddy-auth.json");

let auth;
try {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  auth = raw.version === 2 ? Object.values(raw.accounts)[0] : raw;
} catch {
  console.error(`No readable session at ${file}`);
  process.exit(1);
}
if (!auth?.accessToken) {
  console.error(`No access token at ${file}`);
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${auth.accessToken}`,
  "Content-Type": "application/json",
  Origin: "https://www.codebuddy.cn",
  Referer: "https://www.codebuddy.cn/",
  "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
  "X-Client-Platform": "web",
  "X-Product": "SaaS",
};

/** Key names and types only — this must never print a token or an id. */
function shape(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.length ? shape(value[0], depth + 1) : ""}]×${value.length}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (depth >= 2) return `{${keys.slice(0, 10).join(",")}}`;
    return `{${keys.slice(0, 14).join(",")}}`;
  }
  return typeof value;
}

/** Does any leaf look like a name/id? Report the PATH, never the value. */
function findIdentity(value, prefix = "", out = []) {
  if (value === null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (/nick|username|displayname|^name$|userid|^uid$|accountid|enterprise/i.test(k)) {
      out.push(`${p} = ${v === "" || v === undefined ? "(empty)" : `<${typeof v}>`}`);
    }
    if (v && typeof v === "object") findIdentity(v, p, out);
  }
  return out;
}

const CANDIDATES = [
  ["GET", "/v3/config"],
  ["GET", "/v3/user/info"],
  ["GET", "/v2/user/info"],
  ["GET", "/v3/account/info"],
  ["GET", "/v3/user/profile"],
  ["GET", "/v2/plugin/login/account"],
  ["POST", "/billing/meter/get-user-resource"],
  ["GET", "/v3/user/enterprise"],
  ["GET", "/v3/user/base-info"],
];

(async () => {
  for (const [method, p] of CANDIDATES) {
    const init = { method, headers: HEADERS };
    if (method === "POST") {
      init.body = JSON.stringify({
        PageNumber: 1,
        PageSize: 5,
        ProductCode: "p_tcaca",
        Status: [0, 3],
        OnlyValidPeriod: true,
      });
    }
    try {
      const res = await fetch(`https://copilot.tencent.com${p}`, init);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* HTML error page */
      }
      const status = `http=${res.status}`;
      if (!json) {
        console.log(`${p.padEnd(38)} ${status}  non-JSON: ${text.trim().slice(0, 50)}`);
        continue;
      }
      const code = json.code !== undefined ? `code=${json.code}` : "code=?";
      console.log(`${p.padEnd(38)} ${status}  ${code}  data=${shape(json.data)}`);
      const hits = findIdentity(json.data ?? {});
      for (const h of hits) console.log(`    ${h}`);
    } catch (err) {
      console.log(`${p.padEnd(38)} network error: ${err.message}`);
    }
  }
})();
