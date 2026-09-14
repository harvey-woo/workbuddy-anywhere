/**
 * Protocol mapping tests: request in, frames out.
 *
 * Offline ON PURPOSE. The gateway interaction is shared with the already
 * working chat-completions path, so what these three protocols add is exactly
 * the MAPPING — and that is a pure function of the request body and the
 * engine's event list. Driving it with a canned event list makes every
 * assertion about ORDER, which is the part that is easy to get subtly wrong
 * (a text delta after a tool block opened lands in the wrong block; a tool
 * result placed after its turn's text breaks call/result adjacency upstream).
 *
 * Runs against the COMPILED output, so it tests what ships.
 *
 *   node scripts/test-protocols.cjs
 */

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const OUT = path.join(__dirname, "..", "out", "server");
/** The chat engine lives outside `server/`; the payload builder is there. */
const CHAT_OUT = path.join(__dirname, "..", "out", "chat");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const result = fn();
    // Async assertions are supported: an unhandled rejection would otherwise
    // be reported as "ok" and the guarantee would go untested.
    if (result && typeof result.then === "function") {
      return result.then(
        () => {
          passed += 1;
          console.log(`  ok  ${name}`);
        },
        (err) => {
          failed += 1;
          console.log(`  FAIL ${name}\n       ${err.message}`);
        }
      );
    }
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

/** Event names, in order, from a list of SSE frames. */
function events(frames) {
  const names = [];
  for (const frame of frames) {
    const match = /^event: (\S+)/m.exec(frame);
    if (match) names.push(match[1]);
    else if (frame.startsWith("data: ")) names.push("(data)");
  }
  return names;
}

/** Parsed `data:` payloads in order. */
function payloads(frames) {
  return frames
    .flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data: ")))
    .map((line) => JSON.parse(line.slice(6)));
}

async function main() {
  const codecs = await import(pathToFileURL(path.join(OUT, "codecs.js")).href);
  const messages = await import(pathToFileURL(path.join(OUT, "messages.js")).href);
  const responses = await import(pathToFileURL(path.join(OUT, "responses.js")).href);

  // ── Anthropic request ─────────────────────────────────────────────────
  console.log("anthropic: request -> ChatRequest");

  test("system becomes a system message, tool results become their own turn", () => {
    const { request } = messages.toAnthropicChatRequest({
      model: "glm-5.3",
      max_tokens: 1024,
      system: [{ type: "text", text: "be terse" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAEC" } },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { file: "a" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "hello" },
            { type: "text", text: "and now" },
          ],
        },
      ],
    });

    assert.deepStrictEqual(
      request.messages.map((m) => m.role),
      ["system", "user", "assistant", "tool", "user"],
      "tool results must come BEFORE the text riding on the same turn"
    );
    assert.strictEqual(request.messages[0].text, "be terse");
    assert.strictEqual(request.messages[1].images.length, 1);
    assert.deepStrictEqual(request.messages[1].images[0].data, new Uint8Array([0, 1, 2]));
    assert.deepStrictEqual(request.messages[2].toolCalls, [
      { id: "toolu_1", name: "read", input: { file: "a" } },
    ]);
    assert.strictEqual(request.messages[3].toolResults[0].callId, "toolu_1");
    assert.strictEqual(request.messages[3].toolResults[0].text, "hello");
    assert.strictEqual(request.messages[4].text, "and now");
  });

  test("max_tokens is accepted but NOT forwarded (it truncates thinking)", () => {
    const { ignored } = messages.toAnthropicChatRequest({
      model: "glm-5.3",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.ok(ignored.includes("max_tokens"), `expected max_tokens to be ignored, got ${ignored}`);
  });

  test("tool_choice 'auto' maps to auto, anything else to required", () => {
    const auto = messages.toAnthropicChatRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "t", input_schema: {} }],
      tool_choice: { type: "auto" },
    });
    const any = messages.toAnthropicChatRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "t", input_schema: {} }],
      tool_choice: { type: "any" },
    });
    assert.strictEqual(auto.request.toolMode, "auto");
    assert.strictEqual(any.request.toolMode, "required");
  });

  // ── Anthropic stream ──────────────────────────────────────────────────
  console.log("anthropic: events -> frames");

  test("a text-only turn opens, streams, and stops the message", () => {
    const codec = codecs.messagesProtocol.create("glm-5.3");
    const frames = [...codec.start(), ...codec.text("Hel"), ...codec.text("lo"), ...codec.finish({ prompt_tokens: 5, completion_tokens: 2 })];
    assert.deepStrictEqual(events(frames), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const blocks = payloads(frames).filter((p) => p.type === "content_block_delta");
    assert.strictEqual(blocks.map((b) => b.delta.text).join(""), "Hello");
    const delta = payloads(frames).find((p) => p.type === "message_delta");
    assert.strictEqual(delta.delta.stop_reason, "end_turn");
    assert.strictEqual(delta.usage.output_tokens, 2);
  });

  test("a tool call closes the text block first and reports stop_reason tool_use", () => {
    const codec = codecs.messagesProtocol.create("m");
    const frames = [
      ...codec.start(),
      ...codec.text("let me check"),
      ...codec.toolCalls([{ id: "toolu_9", name: "read", input: { file: "a" } }]),
      ...codec.finish(),
    ];
    const names = events(frames);
    // The text block must be closed BEFORE the tool block opens, or the deltas
    // address the wrong block index.
    assert.deepStrictEqual(names, [
      "message_start",
      "content_block_start", // text
      "content_block_delta",
      "content_block_stop", // text closed
      "content_block_start", // tool_use
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const starts = payloads(frames).filter((p) => p.type === "content_block_start");
    assert.strictEqual(starts[0].content_block.type, "text");
    assert.strictEqual(starts[1].content_block.type, "tool_use");
    assert.strictEqual(starts[1].content_block.id, "toolu_9", "the id must round-trip for tool_result");
    assert.strictEqual(starts[1].index, 1);

    const argDelta = payloads(frames).find((p) => p.delta?.type === "input_json_delta");
    assert.deepStrictEqual(JSON.parse(argDelta.delta.partial_json), { file: "a" });
    assert.strictEqual(payloads(frames).find((p) => p.type === "message_delta").delta.stop_reason, "tool_use");
  });

  // ── Responses request ─────────────────────────────────────────────────
  console.log("responses: request -> ChatRequest");

  test("instructions, consecutive function_calls and outputs map onto the engine's shape", () => {
    const { request } = responses.toResponsesChatRequest({
      model: "glm-5.3",
      instructions: "be terse",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "do it" }] },
        { type: "function_call", call_id: "call_1", name: "read", arguments: '{"file":"a"}' },
        { type: "function_call", call_id: "call_2", name: "write", arguments: '{"file":"b"}' },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { type: "message", role: "user", content: "next" },
      ],
    });

    assert.deepStrictEqual(
      request.messages.map((m) => m.role),
      ["system", "user", "assistant", "tool", "user"]
    );
    assert.strictEqual(
      request.messages[2].toolCalls.length,
      2,
      "consecutive function_calls must merge into ONE assistant message"
    );
    assert.deepStrictEqual(request.messages[2].toolCalls[1].input, { file: "b" });
    assert.strictEqual(request.messages[3].toolResults[0].callId, "call_1");
  });

  test("a bare string input is a user message", () => {
    const { request } = responses.toResponsesChatRequest({ model: "m", input: "hello" });
    assert.deepStrictEqual(request.messages, [{ role: "user", text: "hello" }]);
  });

  test("developer role folds into system", () => {
    const { request } = responses.toResponsesChatRequest({
      model: "m",
      input: [{ type: "message", role: "developer", content: "be nice" }],
    });
    assert.strictEqual(request.messages[0].role, "system");
  });

  test("max_output_tokens is accepted but NOT forwarded", () => {
    const { ignored } = responses.toResponsesChatRequest({ model: "m", input: "x", max_output_tokens: 10 });
    assert.ok(ignored.includes("max_output_tokens"));
  });

  // ── Responses stream ──────────────────────────────────────────────────
  console.log("responses: events -> frames");

  test("the envelope opens, the item closes, and completed carries the output", () => {
    const codec = codecs.responsesProtocol.create("glm-5.3");
    const frames = [
      ...codec.start(),
      ...codec.text("Hel"),
      ...codec.text("lo"),
      ...codec.toolCalls([{ id: "call_7", name: "read", input: { file: "a" } }]),
      ...codec.finish({ prompt_tokens: 3, completion_tokens: 1 }),
    ];
    assert.deepStrictEqual(events(frames), [
      "response.created",
      "response.in_progress",
      "response.output_item.added", // message
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done", // message closed BEFORE the call opens
      "response.output_item.added", // function_call
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);

    const seq = payloads(frames).map((p) => p.sequence_number);
    assert.deepStrictEqual(seq, [...seq].sort((a, b) => a - b), "sequence_number must increase");

    const completed = payloads(frames).find((p) => p.type === "response.completed");
    assert.strictEqual(completed.response.status, "completed");
    assert.deepStrictEqual(
      completed.response.output.map((item) => item.type),
      ["message", "function_call"]
    );
    assert.strictEqual(completed.response.output[0].content[0].text, "Hello");
    assert.strictEqual(
      completed.response.output[1].arguments,
      '{"file":"a"}',
      "the call's arguments must survive into the final object"
    );
    assert.strictEqual(completed.response.usage.output_tokens, 1);
  });

  test("the stream reports no output when the turn is empty", () => {
    const codec = codecs.responsesProtocol.create("m");
    const frames = [...codec.start(), ...codec.finish()];
    const completed = payloads(frames).find((p) => p.type === "response.completed");
    assert.deepStrictEqual(completed.response.output, []);
  });

  // ── chat-completions regression ───────────────────────────────────────
  console.log("chat-completions: unchanged through the refactor");

  test("still ends with [DONE] and a usage chunk with an empty choices array", () => {
    const codec = codecs.chatCompletionsProtocol.create("m");
    const frames = [...codec.text("hi"), ...codec.finish({ prompt_tokens: 1, completion_tokens: 1 })];
    assert.ok(frames[frames.length - 1].endsWith("[DONE]\n\n") === false, "tail is separate");
    assert.strictEqual(codec.tail, "data: [DONE]\n\n");
    const last = payloads(frames)[payloads(frames).length - 1];
    assert.deepStrictEqual(last.choices, []);
    assert.ok(last.usage);
  });

  test("still reports finish_reason tool_calls once, with every call in one chunk", () => {
    const codec = codecs.chatCompletionsProtocol.create("m");
    const frames = [
      ...codec.toolCalls([
        { id: "call_a", name: "read", input: {} },
        { id: "call_b", name: "write", input: {} },
      ]),
      ...codec.finish(),
    ];
    const callChunks = payloads(frames).filter((p) => p.choices?.[0]?.delta?.tool_calls);
    assert.strictEqual(callChunks.length, 1);
    assert.strictEqual(callChunks[0].choices[0].delta.tool_calls.length, 2);
    assert.strictEqual(
      payloads(frames).find((p) => p.choices?.[0]?.finish_reason).choices[0].finish_reason,
      "tool_calls"
    );
  });

  // ── error envelopes ───────────────────────────────────────────────────
  console.log("errors");

  test("each protocol answers in its OWN envelope", () => {
    assert.deepStrictEqual(Object.keys(messages.anthropicError("boom")), ["type", "error"]);
    assert.ok(codecs.chatCompletionsProtocol.error("boom").error);
    assert.ok(codecs.responsesProtocol.error("boom").error);
  });

  test("a bad body is rejected", () => {
    assert.throws(() => messages.toAnthropicChatRequest({ model: "m", messages: [] }));
    assert.throws(() => responses.toResponsesChatRequest({ model: "m" }));
    assert.throws(() => messages.toAnthropicChatRequest({ messages: [{ role: "user", content: "x" }] }));
  });

  // ── the wire payload's leading system message ─────────────────────────
  //
  // The INTL gateway rejects a payload whose first message is not `system`:
  //
  //   400 {"code":11128,"msg":"first message is not system prompt"}
  //
  // VS Code folds its system prompt into the first USER message, so nothing
  // upstream guarantees the shape. These tests pin the guarantee. The
  // behaviour was measured against the live gateway by
  // `scripts/probe-intl-system-prompt.cjs`.
  console.log("chat payload: leading system message");

  const engine = await import(pathToFileURL(path.join(CHAT_OUT, "engine.js")).href);
  const baseOpts = { model: undefined, settings: {} };
  const build = (messages) => engine.buildOpenAIMessages(messages, baseOpts);

  await test("a user-first transcript gets a system message prepended", async () => {
    const out = await build([{ role: "user", text: "hi" }]);
    assert.strictEqual(out.length, 2, "expected system + the original message");
    assert.strictEqual(out[0].role, "system");
    assert.strictEqual(out[1].role, "user");
    assert.strictEqual(out[1].content, "hi", "the original message must be untouched");
  });

  await test("the prepended message is EMPTY — it must not invent a prompt", async () => {
    // VS Code's system prompt is already inside the first user message.
    // Injecting text here would override the editor's own instructions.
    const out = await build([{ role: "user", text: "hi" }]);
    assert.strictEqual(out[0].content, "");
  });

  await test("an existing system message is left alone (no double system)", async () => {
    // The HTTP server and dsh hosts DO supply a real system prompt; a second
    // one would be both redundant and a behaviour change for them.
    const out = await build([
      { role: "system", text: "be terse" },
      { role: "user", text: "hi" },
    ]);
    assert.strictEqual(out.length, 2, "nothing should have been inserted");
    assert.strictEqual(out[0].content, "be terse", "the real prompt must survive");
  });

  await test("an empty transcript is not given a lone system message", async () => {
    // A request with no messages is invalid on its own terms; a system-only
    // payload would not make it valid, and would hide the real problem.
    const out = await build([]);
    assert.deepStrictEqual(out, []);
  });

  await test("a tool-result-first transcript also gets the system message", async () => {
    // Not reachable from VS Code today, but the guarantee is about position,
    // not about which role happens to be first.
    const out = await build([
      { role: "assistant", toolCalls: [{ id: "c1", name: "read", input: {} }] },
      { role: "tool", toolResults: [{ callId: "c1", text: "ok" }] },
    ]);
    assert.strictEqual(out[0].role, "system");
    // …and the call/result adjacency the engine guarantees is still intact.
    const callIdx = out.findIndex((m) => m.role === "assistant");
    assert.strictEqual(out[callIdx + 1].role, "tool", "result must stay adjacent to its call");
  });

  await test("the guard runs AFTER mending, so an orphaned call is still mended", async () => {
    // Ordering matters: the orphan repair inserts a message at index 0 + 1 when
    // the very first message issues an un-answered tool call. Prepending the
    // system message afterwards (rather than before) keeps that splice valid.
    const out = await build([
      { role: "assistant", toolCalls: [{ id: "orphan", name: "read", input: {} }] },
    ]);
    assert.strictEqual(out[0].role, "system");
    assert.strictEqual(out[1].role, "assistant");
    assert.strictEqual(out[2].role, "tool", "the orphan must still be mended");
    assert.strictEqual(out[2].tool_call_id, "orphan");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERR", err.message);
  process.exitCode = 1;
});
