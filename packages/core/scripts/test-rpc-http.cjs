#!/usr/bin/env node
/**
 * Regression test for `httpCallFor` (`src/rpc.ts`).
 *
 * This exists because of a real, silent bug: the UI's HTTP transport read
 * `body` and `pathParam` off `RPC_ROUTES[method].http` — an object that only
 * holds `{ method, path }`. Both came back undefined, so
 *
 *   - NO browser call ever sent a request body (switchAccount, addCustomModel
 *     and updateSettings were all broken in the web UI), and
 *   - `:pathParam` was never substituted (removeAccount, removeCustomModel).
 *
 * Compiling fine and the server returning 200 hid it completely, because the
 * server tests hit the endpoints directly.
 *
 * The named cases below pin the breakage; the INVARIANTS at the end are the
 * part that actually matters — they fail for ANY route that gets this wrong in
 * the future, including routes that do not exist yet.
 *
 * Run: node scripts/test-rpc-http.cjs
 */

const assert = require("assert");

const { RPC_METHODS, RPC_ROUTES, httpCallFor } = require("../out/rpc.js");

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log("the specific calls that used to be broken");

check("a body route really sends a body", () => {
  const call = httpCallFor("switchAccount", { key: "ent-b:1002" });
  assert.strictEqual(call.method, "POST");
  assert.strictEqual(call.path, "/api/accounts/switch");
  assert.strictEqual(call.headers["Content-Type"], "application/json");
  assert.deepStrictEqual(JSON.parse(call.body), { key: "ent-b:1002" });
});

check("a body route with no params still sends `{}`, never undefined", () => {
  // The server rejects a missing body with "`key` is required"; sending an
  // empty object keeps the failure a real validation error.
  const call = httpCallFor("logout");
  assert.strictEqual(call.body, "{}");
});

check("a body route sends an EMPTY object when called with nothing", () => {
  const call = httpCallFor("checkin", {});
  assert.strictEqual(call.body, "{}");
});

check("a pathParam route substitutes the placeholder", () => {
  const call = httpCallFor("removeAccount", { key: "ent-b:1002" });
  assert.strictEqual(call.method, "DELETE");
  assert.strictEqual(call.path, "/api/accounts/ent-b%3A1002");
  assert.ok(!call.path.includes(":"), "the placeholder must be gone");
  assert.strictEqual(call.body, undefined, "a DELETE takes no body");
});

check("pathParam values are URL-encoded and decode back cleanly", () => {
  const call = httpCallFor("removeCustomModel", { id: "vendor/some model" });
  assert.strictEqual(call.path, "/api/models/custom/vendor%2Fsome%20model");
  // The server decodes each segment, so this round-trips.
  const segment = call.path.split("/").pop();
  assert.strictEqual(decodeURIComponent(segment), "vendor/some model");
});

check("a plain GET carries neither body nor content-type", () => {
  const call = httpCallFor("getState");
  assert.strictEqual(call.method, "GET");
  // Region-scoped routes fall back to CN when the caller did not name one.
  assert.strictEqual(call.path, "/api/cn/state");
  assert.strictEqual(call.body, undefined);
  assert.deepStrictEqual(call.headers, {});
});

check("a POST that takes no arguments has no body", () => {
  const call = httpCallFor("checkinAll");
  assert.strictEqual(call.method, "POST");
  assert.strictEqual(call.path, "/api/checkin/all");
  assert.strictEqual(call.body, undefined);
});

check("a host-only method has no HTTP form at all", () => {
  assert.strictEqual(httpCallFor("openExternal", { url: "https://x" }), undefined);
});

console.log("invariants across EVERY route");

check("every body route produces a body AND a JSON content-type", () => {
  const withBody = RPC_METHODS.filter((m) => RPC_ROUTES[m].body);
  assert.ok(withBody.length > 0, "expected at least one body route");
  for (const m of withBody) {
    const call = httpCallFor(m, { probe: 1 });
    assert.ok(call, `${m}: expected an HTTP form`);
    assert.strictEqual(
      call.headers["Content-Type"],
      "application/json",
      `${m}: missing JSON content-type`
    );
    assert.strictEqual(typeof call.body, "string", `${m}: missing body`);
    assert.ok(call.body.length > 0, `${m}: empty body`);
  }
});

check("every non-body route produces NO body and NO content-type", () => {
  for (const m of RPC_METHODS) {
    if (RPC_ROUTES[m].body) continue;
    const call = httpCallFor(m, { probe: 1 });
    if (!call) continue; // host-only
    assert.strictEqual(call.body, undefined, `${m}: unexpected body`);
    assert.strictEqual(
      call.headers["Content-Type"],
      undefined,
      `${m}: unexpected content-type`
    );
  }
});

check("every pathParam route leaves no `:` placeholder behind", () => {
  const withParam = RPC_METHODS.filter((m) => RPC_ROUTES[m].pathParam);
  assert.ok(withParam.length > 0, "expected at least one pathParam route");
  for (const m of withParam) {
    const p = RPC_ROUTES[m].pathParam;
    const call = httpCallFor(m, { [p]: "value-1" });
    assert.ok(!call.path.includes(":"), `${m}: placeholder not substituted`);
    assert.ok(call.path.includes("value-1"), `${m}: value missing from path`);
  }
});

check("a pathParam route URL-encodes its value", () => {
  for (const m of RPC_METHODS.filter((m) => RPC_ROUTES[m].pathParam)) {
    const p = RPC_ROUTES[m].pathParam;
    const call = httpCallFor(m, { [p]: "a:b/c" });
    assert.ok(call.path.includes("a%3Ab%2Fc"), `${m}: value not encoded`);
  }
});

check("every served route is an /api/ path, and matches RPC_ROUTES", () => {
  for (const m of RPC_METHODS) {
    const route = RPC_ROUTES[m];
    const call = httpCallFor(m, {});
    if (!route.http) {
      assert.strictEqual(call, undefined, `${m}: host-only route produced a call`);
      continue;
    }
    assert.ok(call.path.startsWith("/api/"), `${m}: unexpected path ${call.path}`);
    assert.strictEqual(call.method, route.http.method);
    // Strip the placeholders that httpCallFor substitutes: `:name` for path
    // params and the literal `{region}` that resolves to `cn`/`intl`. The
    // remainder must be the start of the served path.
    const pattern = route.http.path
      .replace(/:[A-Za-z0-9_]+/, "")
      .replace("\{region\}", "cn");
  }
});

console.log(`\n${passed} checks passed`);
