/* Offline test of the rewritten sse.ts parser: normal, split-across-chunks,
 * multi-line JSON, [DONE], pretty-printed tool_calls. */
const path = require("path");
// Compile sse.ts in-memory via tsc? Simpler: use ts-node-less require of out/
const { parseSSEStream } = require(path.join(__dirname, "..", "out", "sse.js"));

function makeResponse(frames) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (i < frames.length) return { done: false, value: encoder.encode(frames[i++]) };
            return { done: true, value: undefined };
          },
          releaseLock() {},
          cancel() {},
        };
      },
    },
  };
}

async function run(label, frames, expect) {
  const got = [];
  for await (const { data } of parseSSEStream(makeResponse(frames))) got.push(data);
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`${label}: ${ok ? "OK" : "FAIL"} got=${JSON.stringify(got).slice(0, 140)}`);
  return ok;
}

const tc1 = `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"run_command","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}`;

(async () => {
  let all = true;
  // 1. normal single-line events
  all &= await run("normal", [
    `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
    `data: ${tc1}\n\n`,
    `data: [DONE]\n\n`,
  ], [
    { choices: [{ delta: { content: "hi" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "run_command", arguments: '{"command":"ls"}' } }] } }] },
  ]);

  // 2. one event SPLIT across two network chunks
  const ev = `data: ${tc1}\n\n`;
  all &= await run("split event", [ev.slice(0, 20), ev.slice(20)], [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "run_command", arguments: '{"command":"ls"}' } }] } }] },
  ]);

  // 3. pretty-printed multi-line JSON in one data payload
  const pretty = `data: {\n  "choices": [{\n    "delta": {"tool_calls": [{"index": 0, "id": "c2", "function": {"name": "edit_file", "arguments": "{}"}}]}\n  }]\n}\n\n`;
  all &= await run("multi-line pretty JSON", [pretty], [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "edit_file", arguments: "{}" } }] } }] },
  ]);

  // 4. tool_calls chunk arriving AFTER [DONE] in a broken gateway (trailing)
  all &= await run("trailing after DONE-split", [
    `data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n`,
    `data: ${tc1}\n\n`,
  ], [
    { choices: [{ delta: { content: "a" } }] },
  ]);

  // 5. blank line inside multi-line JSON payload
  all &= await run("blank line inside payload", [
    `data: {\n\n  "choices": [{"delta": {"content": "x"}}]\n\n}\n\n`,
  ], [{ choices: [{ delta: { content: "x" } }] }]);

  console.log(all ? "ALL PASS" : "SOME FAILED");
  process.exit(all ? 0 : 1);
})();
