/* Adversarial tests for src/capture.ts — runs against the COMPILED
 * out/capture.js (no hand-copied logic). Covers: antml single/multi,
 * wrapped + unwrapped, chunk-boundary splits (1-char worst case),
 * same-delta open+close, tool_calls:TAG regression, truncation recovery,
 * UI text preservation. */
const { ToolCallCapture, parseAntmlInvokes, sniffToolCallFromContent } = require("../out/capture");

const SINGLE = `<invoke name="replace_string_in_file"> <parameter name="filePath">/Users/x/app/pages/daily-puzzle.vue</parameter> <parameter name="newString">const dailyBreadcrumbs = computed(() => [ { label: t('daily.breadcrumb'), to: '/daily-puzzle/' } ])</parameter> <parameter name="oldString">const dailyBreadcrumbs = computed(() => [ { label: t('daily.breadcrumb'), to: '/daily/' } ])</parameter> </invoke>`;

const MULTI = `<function_calls><invoke name="replace_string_in_file"> <parameter name="filePath">a.vue</parameter> <parameter name="oldString">const a = useUrl()</parameter> <parameter name="newString">const { buildUrl, buildLocalizedUrl } = useUrl()</parameter> </invoke> <invoke name="run_in_terminal"> <parameter name="command">grep -n "useUrl()" "app/pages/[difficulty].vue"</parameter> <parameter name="explanation">Check difficulty page</parameter> <parameter name="goal">Verify available</parameter> <parameter name="mode">sync</parameter> </invoke></function_calls>`;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} — ${detail}`); }
}

function chunkify(s, mode) {
  if (mode === 1) return s.split("");
  if (mode === 2) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      const n = 1 + Math.floor(Math.random() * 7);
      out.push(s.slice(i, i + n));
      i += n;
    }
    return out;
  }
  return [s];
}

function runThrough(text, mode) {
  const cap = new ToolCallCapture();
  let ui = "";
  for (const ch of chunkify(text, mode)) ui += cap.processText(ch, "content");
  const leftover = cap.endFlush();
  return { cap, calls: cap.takeCalls(), ui: ui + leftover };
}

console.log("=== 1: unwrapped single invoke, 1-char chunks ===");
{
  const { calls, cap } = runThrough(SINGLE, 1);
  check("1 call", calls.length === 1, `got ${calls.length}`);
  check("name", calls[0]?.name === "replace_string_in_file", calls[0]?.name);
  const args = JSON.parse(calls[0]?.args || "{}");
  check("filePath", args.filePath === "/Users/x/app/pages/daily-puzzle.vue", args.filePath);
  check("newString has computed", args.newString?.includes("computed(() =>"), args.newString?.slice(0, 40));
  check("oldString intact", args.oldString?.includes("/daily/"), args.oldString?.slice(0, 30));
  check("closed", !cap.isBusy);
}

console.log("=== 2: wrapped multi-invoke, random chunks, 20 runs ===");
{
  let ok = true, bad = "";
  for (let r = 0; r < 20 && ok; r++) {
    const { calls } = runThrough(MULTI, 2);
    if (calls.length !== 2) { ok = false; bad = `run ${r}: ${calls.length} calls`; continue; }
    if (calls[0].name !== "replace_string_in_file" || calls[1].name !== "run_in_terminal") {
      ok = false; bad = `run ${r}: ${calls.map(c=>c.name).join(",")}`;
    }
    const a1 = JSON.parse(calls[0].args);
    if (a1.filePath !== "a.vue") { ok = false; bad = `run ${r}: filePath=${a1.filePath}`; }
  }
  check("20/20 runs OK", ok, bad);
}

console.log("=== 3: prose before/after preserved ===");
{
  const { calls, ui } = runThrough("Let me fix that. " + SINGLE + "\n\nNext step.", 2);
  check("call captured", calls.length === 1, `got ${calls.length}`);
  check("prefix kept", ui.includes("Let me fix that."), JSON.stringify(ui.slice(0, 30)));
  check("suffix kept", ui.includes("Next step."), JSON.stringify(ui.slice(-30)));
  check("no tag leak", !ui.includes("<invoke"), ui.slice(0, 60));
}

console.log("=== 4: truncation recovery (endFlush) ===");
{
  const cap = new ToolCallCapture();
  const truncated = SINGLE.slice(0, SINGLE.length - "</invoke>".length - 5);
  for (const ch of chunkify(truncated, 2)) cap.processText(ch, "content");
  const leftover = cap.endFlush();
  const calls = cap.takeCalls();
  check("recovered call", calls.length === 1, `got ${calls.length}, leftover ${leftover.length}ch`);
  check("name recovered", calls[0]?.name === "replace_string_in_file", calls[0]?.name);
  const args = JSON.parse(calls[0]?.args || "{}");
  check("complete param kept", args.filePath === "/Users/x/app/pages/daily-puzzle.vue", args.filePath);
}

console.log("=== 5: opener split EXACTLY mid-tag ===");
{
  for (const cut of [1, 3, 7, 8]) {
    const cap = new ToolCallCapture();
    let ui = "";
    ui += cap.processText("ok " + SINGLE.slice(0, 3 + cut), "content");
    ui += cap.processText(SINGLE.slice(3 + cut), "content");
    const calls = cap.takeCalls();
    check(`split at ${cut}`, calls.length === 1 && calls[0].name === "replace_string_in_file",
      `calls=${calls.length} ui=${JSON.stringify(ui.slice(0, 30))}`);
  }
}

console.log("=== 6: <tool_calls:TAG> template regression ===");
{
  const TAG = `<tool_calls:abc12><tool_call:abc12>my_tool<tool_sep:abc12><arg_key:abc12>k</arg_key:abc12><arg_value:abc12>{"a":1}</arg_value:abc12></tool_call:abc12></tool_calls:abc12>`;
  const { calls } = runThrough(TAG, 1);
  check("template call", calls.length === 1 && calls[0].name === "my_tool", JSON.stringify(calls.map(c=>c.name)));
  check("arg JSON parsed", JSON.parse(calls[0]?.args || "{}").k?.a === 1, calls[0]?.args);
}

console.log("=== 7: open+close in ONE delta ===");
{
  const { calls } = runThrough(SINGLE, 0);
  check("single delta works", calls.length === 1, `got ${calls.length}`);
}

console.log("=== 8: two invokes in one delta (unwrapped) ===");
{
  const two = SINGLE + "\n" + SINGLE.replace("replace_string_in_file", "run_in_terminal");
  const { calls } = runThrough(two, 1);
  check("2 calls", calls.length === 2, `got ${calls.length}: ${calls.map(c=>c.name).join(",")}`);
  check("names", calls[0]?.name === "replace_string_in_file" && calls[1]?.name === "run_in_terminal", calls.map(c=>c.name).join(","));
}

console.log("=== 9: sniff helper ===");
{
  const good = sniffToolCallFromContent('{"name":"t1","arguments":{"x":1}}');
  check("sniff good", good?.name === "t1", JSON.stringify(good));
  check("sniff prose", sniffToolCallFromContent('{"a":1}') === null);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
