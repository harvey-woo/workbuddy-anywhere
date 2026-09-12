/* Offline test for parseToolCallTemplate with the user's real sample. */
const esc = (tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseToolCallTemplate(block) {
  const calls = [];
  const m = block.match(/<tool_calls:([^>]+)>/);
  if (!m) return calls;
  const tag = m[1];
  const e = esc(tag);
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

// Simulate CHUNKED arrival: split the block into random-ish chunks and buffer
const TAG = "6124c78e";
const sample =
  `<tool_calls:${TAG}>\n` +
  `<tool_call:${TAG}>multi_replace_string_in_file<tool_sep:${TAG}>\n` +
  `<arg_key:${TAG}>explanation</arg_key:${TAG}>\n` +
  `<arg_value:${TAG}>Simplify server redirects.ts: remove the data-driven article index.</arg_value:${TAG}>\n` +
  `<arg_key:${TAG}>replacements</arg_key:${TAG}>\n` +
  `<arg_value:${TAG}>[{"filePath":"server/utils/redirects.ts","oldString":"import { existsSync } from 'node:fs'","newString":"export interface RedirectEntry {"},{"filePath":"server/utils/redirects.ts","oldString":"const CONTENT_LOCALES = ['en']","newString":"// removed"}]</arg_value:${TAG}>\n` +
  `</tool_call:${TAG}>\n` +
  `</tool_calls:${TAG}>`;

// chunk it like SSE deltas would (5-40 chars)
const chunks = [];
let i = 0;
while (i < sample.length) {
  const n = 5 + Math.floor(Math.random() * 35);
  chunks.push(sample.slice(i, i + n));
  i += n;
}

// Simulate the streaming state machine
let templateBuf = "";
let inTemplate = false;
let pendingPrefix = "";
const emittedText = [];
let parsed = [];
for (const c of chunks) {
  let text = c;
  if (!inTemplate) {
    if (pendingPrefix) { text = pendingPrefix + text; pendingPrefix = ""; }
    let openIdx = text.indexOf("<tool_calls:");
    if (openIdx < 0) openIdx = text.indexOf("<tool_call:");
    if (openIdx >= 0) {
      const before = text.slice(0, openIdx);
      if (before.trim()) emittedText.push(before);
      templateBuf = text.slice(openIdx);
      inTemplate = true;
      text = "";
    } else {
      for (let l = Math.min(text.length, 12); l > 0; l--) {
        if ("<tool_calls:".startsWith(text.slice(-l)) || "<tool_call:".startsWith(text.slice(-l))) {
          pendingPrefix = text.slice(-l);
          text = text.slice(0, -l);
          break;
        }
      }
    }
  } else {
    templateBuf += text;
    text = "";
  }
  if (inTemplate && templateBuf.includes("</tool_calls:")) {
    parsed = parseToolCallTemplate(templateBuf);
    templateBuf = "";
    inTemplate = false;
  } else if (!inTemplate && text) {
    emittedText.push(text);
  }
}

console.log("calls parsed:", parsed.length);
console.log("name:", parsed[0]?.name);
const input = JSON.parse(parsed[0]?.args || "{}");
console.log("explanation:", JSON.stringify(input.explanation));
console.log("replacements is array:", Array.isArray(input.replacements), "len:", input.replacements?.length);
console.log("replacement[0].filePath:", input.replacements?.[0]?.filePath);
console.log("leaked text chunks:", emittedText.length === 0 ? "NONE (good)" : emittedText);
console.log(parsed.length === 1 && Array.isArray(input.replacements) && emittedText.length === 0 ? "PASS" : "FAIL");
