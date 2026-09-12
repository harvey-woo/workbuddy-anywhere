/* Diagnose why the template capture swallows tool calls.
 * Enumerates failure shapes: partial closes, multi-call blocks, missing
 * final close, trailing text after close, nested-looking content, etc. */
const escT = (tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseToolCallTemplate(block) {
  const calls = [];
  const m = block.match(/<tool_calls:([^>]+)>/) ?? block.match(/<tool_call:([^>]+)>/);
  if (!m) return calls;
  const tag = m[1];
  const e = escT(tag);
  const callRe = new RegExp(`<tool_call:${e}>([\\s\\S]*?)</tool_call:${e}>`, "g");
  for (const cm of block.matchAll(callRe)) {
    const body = cm[1];
    const sepIdx = body.indexOf(`<tool_sep:${e}>`);
    if (sepIdx < 0) continue;
    const name = body.slice(0, sepIdx).trim();
    if (!name) continue;
    const rest = body.slice(sepIdx + `<tool_sep:${e}>`.length);
    const pairRe = new RegExp(
      `<arg_key:${e}>([\\s\\S]*?)</arg_key:${e}>\\s*<arg_value:${e}>([\\s\\S]*?)</arg_value:${e}>`,
      "g"
    );
    const input = {};
    for (const pm of rest.matchAll(pairRe)) {
      const key = pm[1].trim();
      const raw = pm[2];
      let value = raw;
      const trimmed = raw.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try { value = JSON.parse(trimmed); } catch { value = raw; }
      }
      input[key] = value;
    }
    calls.push({ id: `tpl-${calls.length}`, name, args: JSON.stringify(input) });
  }
  return calls;
}

// State machine copied verbatim from provider.ts
let templateBuf = "", inTemplate = false, pendingPrefix = "";
const emittedText = []; let lastCalls = [];
function reset() { templateBuf = ""; inTemplate = false; pendingPrefix = ""; emittedText.length = 0; lastCalls = []; }
function feed(deltaContent) {
  let text = deltaContent;
  if (!inTemplate) {
    if (pendingPrefix) { text = pendingPrefix + text; pendingPrefix = ""; }
    const openIdx = text.indexOf("<tool_calls:") >= 0 ? text.indexOf("<tool_calls:") : text.indexOf("<tool_call:");
    if (openIdx >= 0) {
      const before = text.slice(0, openIdx);
      if (before.trim()) emittedText.push(before);
      templateBuf = text.slice(openIdx);
      inTemplate = true;
      text = "";
    } else {
      for (let l = Math.min(text.length, 12); l > 0; l--) {
        if ("<tool_calls:".startsWith(text.slice(-l)) || "<tool_call:".startsWith(text.slice(-l))) {
          pendingPrefix = text.slice(-l); text = text.slice(0, -l); break;
        }
      }
    }
  } else {
    templateBuf += text; text = "";
  }
  if (inTemplate && (templateBuf.includes("</tool_calls:") || /<\/tool_calls\s*>/.test(templateBuf))) {
    lastCalls = parseToolCallTemplate(templateBuf);
    if (lastCalls.length === 0) emittedText.push(templateBuf);
    templateBuf = ""; inTemplate = false;
  } else if (!inTemplate && text) {
    emittedText.push(text);
  }
}
function flush() {
  // mirrors provider end-of-stream flush
  if (inTemplate && templateBuf) {
    const calls = parseToolCallTemplate(templateBuf + "</tool_calls>");
    if (calls.length > 0) { lastCalls = calls; }
    else { emittedText.push("[RAW] " + templateBuf.slice(0, 60)); }
    templateBuf = ""; inTemplate = false;
  }
  if (pendingPrefix) { emittedText.push(pendingPrefix); pendingPrefix = ""; }
}

const TAG = "abc123";
function one(name, args) {
  return `<tool_calls:${TAG}><tool_call:${TAG}>${name}<tool_sep:${TAG}><arg_key:${TAG}>command</arg_key:${TAG}><arg_value:${TAG}>${args}</arg_value:${TAG}></tool_call:${TAG}></tool_calls:${TAG}>`;
}

// Shape 1: well-formed (baseline)
reset(); for (const c of chunk(one("run_command", "npm run build"), 20)) feed(c); flush();
report("1 well-formed");

// Shape 2: model closes with </tool_calls> but TAG mismatch / no tag
reset(); feed(`<tool_calls:${TAG}><tool_call:${TAG}>run_command<tool_sep:${TAG}><arg_key:${TAG}>command</arg_key:${TAG}><arg_value:${TAG}>ls</arg_value:${TAG}></tool_call:${TAG}></tool_calls>`); flush();
report("2 close without tag");

// Shape 3: stream ENDS without closing tag (model truncated by max_tokens)
reset(); feed(`<tool_calls:${TAG}><tool_call:${TAG}>run_command<tool_sep:${TAG}><arg_key:${TAG}>command</arg_key:${TAG}><arg_value:${TAG}>npm run bu`); flush();
report("3 no close (truncated)");

// Shape 4: multi-call block
reset();
feed(`<tool_calls:${TAG}>` +
  `<tool_call:${TAG}>run_command<tool_sep:${TAG}><arg_key:${TAG}>command</arg_key:${TAG}><arg_value:${TAG}>a</arg_value:${TAG}></tool_call:${TAG}>` +
  `<tool_call:${TAG}>run_command<tool_sep:${TAG}><arg_key:${TAG}>command</arg_key:${TAG}><arg_value:${TAG}>b</arg_value:${TAG}></tool_call:${TAG}>` +
  `</tool_calls:${TAG}>`);
flush();
report("4 multi-call");

// Shape 5: arg_value CONTAINS a string that looks like a tag close (e.g. editing HTML)
reset();
feed(`<tool_calls:${TAG}><tool_call:${TAG}>replace_string<tool_sep:${TAG}><arg_key:${TAG}>newString</arg_key:${TAG}><arg_value:${TAG}>x = "</tool_calls:"; // tricky</arg_value:${TAG}></tool_call:${TAG}></tool_calls:${TAG}>`);
flush();
report("5 value contains close-tag string");

// Shape 6: reasoning_content interleaved, template spans across a reasoning chunk
reset();
feed(`<tool_call`); feed(`s:${TAG}><tool_call:${TAG}>run_command<tool_sep:${TAG}><arg_key:${TAG}>command</arg_key:${TAG}><arg_value:${TAG}>ok</arg_value:${TAG}></tool_call:${TAG}></tool_calls:${TAG}>`);
flush();
report("6 split across two feeds");

// Shape 7: block WITHOUT leading <tool_calls:...> wrapper (model forgot)
reset(); feed(`<tool_call:${TAG}>run_command<tool_sep:${TAG}><arg_key:${TAG}>command</arg_key:${TAG}><arg_value:${TAG}>x</arg_value:${TAG}></tool_call:${TAG}>`); flush();
report("7 no wrapper");

function chunk(s, n) { const o = []; let i = 0; while (i < s.length) { o.push(s.slice(i, i + n)); i += n; } return o; }
function report(label) {
  console.log(
    `${label}: calls=${lastCalls.length} text=${emittedText.length === 0 ? "none" : JSON.stringify(emittedText.map((t) => t.slice(0, 60)))}`
  );
}
