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

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERR", err.message);
  process.exitCode = 1;
});
