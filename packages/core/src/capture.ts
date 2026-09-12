/**
 * Tool-call capture for non-standard text channels.
 *
 * Some models behind the gateway emit tool calls as PLAIN TEXT
 * instead of the OpenAI `tool_calls` streaming field. Three text shapes are
 * handled here (the standard `delta.tool_calls` channel is handled directly
 * in provider.ts):
 *
 * 1. Custom template (GLM family):
 *      <tool_calls:6124c78e>
 *      <tool_call:6124c78e>NAME<tool_sep:6124c78e>
 *      <arg_key:6124c78e>k</arg_key:6124c78e>
 *      <arg_value:6124c78e>v</arg_value:6124c78e>
 *      </tool_call:6124c78e></tool_calls:6124c78e>
 *
 * 2. Claude/antml style (observed: deepseek-v4-flash):
 *      <invoke name="NAME">
 *      <parameter name="k">v</parameter>
 *      </invoke>
 *    optionally wrapped in <function_calls>…</function_calls>.
 *
 * 3. Bare JSON `{"name":…,"arguments":…}` in content (sniff helper).
 *
 * All shapes span many SSE chunks (parameter values contain newlines), so
 * per-delta sniffing never matches — blocks are BUFFERED by a state machine
 * and parsed on close. Chunk boundaries can split any tag; trailing partial
 * openers are held back across chunks.
 *
 * This module is vscode-free so tests can exercise the compiled JS directly.
 */

export interface CapturedCall {
  id: string;
  name: string;
  args: string;
}

export type CaptureKind = "content" | "reasoning";

/**
 * Parse every complete <invoke name="X">…</invoke> block in the buffer.
 * Parameter values that look like JSON are parsed into objects so strict
 * tool schemas (e.g. array parameters) validate downstream; everything
 * else stays a string.
 */
export function parseAntmlInvokes(buf: string): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const invokeRe = /<invoke\s+name="([^"]*)"\s*>([\s\S]*?)<\/invoke>/g;
  for (const m of buf.matchAll(invokeRe)) {
    const name = m[1].trim();
    const params: Record<string, unknown> = {};
    const paramRe = /<parameter\s+name="([^"]*)"\s*>([\s\S]*?)<\/parameter>/g;
    for (const p of m[2].matchAll(paramRe)) {
      const key = p[1].trim();
      const raw = p[2];
      let val: unknown = raw;
      const t = raw.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          val = JSON.parse(t);
        } catch {
          /* keep the raw string */
        }
      }
      params[key] = val;
    }
    calls.push({
      id: `cb-antml-${Date.now()}-${calls.length}`,
      name,
      args: JSON.stringify(params),
    });
  }
  return calls;
}

/**
 * Parse a <tool_calls:TAG> template block (shape 1 above). The TAG suffix is
 * a nonce constant across all tags of one block; nonce-less blocks are
 * handled by the empty-tag branch. Values that look like JSON are parsed.
 */
export function parseToolCallTemplate(block: string): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const m =
    block.match(/<tool_calls:([^>]+)>/) ?? block.match(/<tool_call:([^>]+)>/);
  const tag = m?.[1] ?? "";
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const t = (name: string) => (tag ? `${name}:${esc}` : name);
  const callRe = new RegExp(
    `<tool_call${t("")}>([\\s\\S]*?)</tool_call${t("")}>`,
    "g"
  );
  for (const cm of block.matchAll(callRe)) {
    const body = cm[1];
    const sepIdx = body.indexOf(`<tool_sep${t("")}>`);
    if (sepIdx < 0) continue;
    const name = body.slice(0, sepIdx).trim();
    if (!name) continue;
    const rest = body.slice(sepIdx + `<tool_sep${t("")}>`.length);
    const pairRe = new RegExp(
      `<arg_key${t("")}>([\\s\\S]*?)</arg_key${t("")}>\\s*<arg_value${t("")}>([\\s\\S]*?)</arg_value${t("")}>`,
      "g"
    );
    const input: Record<string, unknown> = {};
    for (const pm of rest.matchAll(pairRe)) {
      const key = pm[1].trim();
      const raw = pm[2];
      let value: unknown = raw;
      const trimmed = raw.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          value = JSON.parse(trimmed);
        } catch {
          value = raw; // keep raw string when JSON is invalid
        }
      }
      input[key] = value;
    }
    calls.push({
      id: `cb-tool-tpl-${Date.now()}-${calls.length}`,
      name,
      args: JSON.stringify(input),
    });
  }
  return calls;
}

/**
 * Sniff a complete OpenAI-style `{"name":…,"arguments":{…}}` payload in
 * content. Conservative: requires the exact shape, so ordinary prose or
 * code snippets never match.
 */
const TOOL_CALL_JSON_RE =
  /^\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*\}\s*\}\s*$/;

export function sniffToolCallFromContent(content: string): CapturedCall | null {
  if (!TOOL_CALL_JSON_RE.test(content)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (
    !obj ||
    typeof obj !== "object" ||
    Array.isArray(obj) ||
    typeof (obj as Record<string, unknown>).name !== "string" ||
    typeof (obj as Record<string, unknown>).arguments !== "object"
  ) {
    return null;
  }
  const o = obj as { name: string; arguments: object; id?: string };
  return {
    id: typeof o.id === "string" ? o.id : `cb-tool-sniff-${Date.now()}`,
    name: o.name,
    args: JSON.stringify(o.arguments),
  };
}

/**
 * Streaming state machine. Feed every content/reasoning delta through
 * processText; it returns the text that should reach the UI (empty while
 * inside a captured block). Recovered calls accumulate internally — drain
 * them with takeCalls(). At end-of-stream call endFlush(): it attempts to
 * recover calls from UNCLOSED blocks (truncation) and returns any leftover
 * text that must be surfaced rather than silently dropped.
 */
export class ToolCallCapture {
  private readonly log: (msg: string) => void;

  // ── <tool_calls:TAG> template machine state ──
  private templateBuf = "";
  private inTemplate = false;
  /** Trailing partial opener ("<tool_calls:" family) held across chunks. */
  private pendingPrefix = "";

  // ── antml invoke machine state ──
  private inAntml = false;
  private antmlWrapped = false;
  private antmlBuf = "";
  /** Trailing partial antml opener held across chunks. */
  private pendingAntmlPrefix = "";

  private captured: CapturedCall[] = [];
  private traceSeq = 0;

  /** Total deltas fed through processText (diagnostics). */
  get deltas(): number {
    return this.traceSeq;
  }

  constructor(log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  /** True while buffering inside any capture block (diagnostics). */
  get isBusy(): boolean {
    return this.inTemplate || this.inAntml;
  }

  /** Drain calls recovered since the last drain. */
  takeCalls(): CapturedCall[] {
    const out = this.captured;
    this.captured = [];
    return out;
  }

  /**
   * Feed one text delta (content OR reasoning_content) through the machine.
   * Returns the text that should reach the UI.
   */
  processText(delta: string, kind: CaptureKind): string {
    this.log(
      `stream #${++this.traceSeq} ${kind} ${JSON.stringify(delta.slice(0, 80))}${delta.length > 80 ? ` (+${delta.length - 80}ch)` : ""}`
    );
    let text = delta;
    let ui = "";

    // Outer loop: after a block closes, the remaining text re-enters
    // opener detection (handles several blocks inside one delta).
    for (;;) {
      if (this.inTemplate) {
        this.templateBuf += text;
        text = "";
        const closed =
          this.templateBuf.includes("</tool_calls:") ||
          /<\/tool_calls\s*>/.test(this.templateBuf);
        if (closed) {
          const calls = parseToolCallTemplate(this.templateBuf);
          if (calls.length > 0) {
            this.log(
              `capture: template CLOSED -> ${calls.length} call(s): ${calls.map((c) => c.name).join(",")}`
            );
            this.captured.push(...calls);
          } else {
            // Unparseable block — surface it as text rather than silently
            // dropping whatever the model tried to do.
            this.log(
              `capture: template CLOSED but UNPARSEABLE (${this.templateBuf.length} ch): ${JSON.stringify(this.templateBuf.slice(0, 120))}`
            );
            ui += this.templateBuf;
          }
          this.templateBuf = "";
          this.inTemplate = false;
        }
        // Still open: keep buffering — nothing reaches the UI.
        break;
      }

      if (this.inAntml) {
        this.antmlBuf += text;
        text = "";
        const closeTag = this.antmlWrapped ? "</function_calls>" : "</invoke>";
        const ci = this.antmlBuf.lastIndexOf(closeTag);
        if (ci >= 0) {
          const consumed = this.antmlBuf.slice(0, ci + closeTag.length);
          const calls = parseAntmlInvokes(consumed);
          this.log(
            `capture: antml CLOSED -> ${calls.length} call(s): ${calls.map((c) => c.name).join(",")}`
          );
          this.captured.push(...calls);
          const rest = this.antmlBuf.slice(ci + closeTag.length);
          this.antmlBuf = "";
          this.inAntml = false;
          this.antmlWrapped = false;
          if (rest.trim()) {
            // Rest may contain another opener — re-enter detection.
            text = rest;
            continue;
          }
        }
        // Still open: keep buffering — nothing reaches the UI.
        break;
      }

      // ── Opener detection (no block open) ────────────────────────────
      if (this.pendingAntmlPrefix) {
        text = this.pendingAntmlPrefix + text;
        this.pendingAntmlPrefix = "";
      }
      if (this.pendingPrefix) {
        text = this.pendingPrefix + text;
        this.pendingPrefix = "";
      }

      // Find the EARLIEST opener across BOTH capture shapes.
      const cand: Array<{ idx: number; antml: boolean; wrapped: boolean }> = [];
      const wrapIdx = text.indexOf("<function_calls>");
      if (wrapIdx >= 0) cand.push({ idx: wrapIdx, antml: true, wrapped: true });
      const invIdx = text.indexOf("<invoke ");
      if (invIdx >= 0) cand.push({ idx: invIdx, antml: true, wrapped: false });
      let tagIdx = text.indexOf("<tool_calls:");
      if (tagIdx < 0) tagIdx = text.indexOf("<tool_call:");
      if (tagIdx < 0) tagIdx = text.indexOf("<tool_calls>");
      if (tagIdx < 0) tagIdx = text.indexOf("<tool_call>");
      if (tagIdx >= 0) cand.push({ idx: tagIdx, antml: false, wrapped: false });
      cand.sort((a, b) => a.idx - b.idx);

      if (cand.length > 0) {
        const before = text.slice(0, cand[0].idx);
        if (before.trim()) ui += before;
        if (cand[0].antml) {
          this.antmlBuf = text.slice(cand[0].idx);
          this.antmlWrapped = cand[0].wrapped;
          this.inAntml = true;
          this.log(
            `capture: antml OPENED (buf=${JSON.stringify(this.antmlBuf.slice(0, 40))})${this.antmlWrapped ? " (wrapped)" : ""}`
          );
        } else {
          this.templateBuf = text.slice(cand[0].idx);
          this.inTemplate = true;
          this.log(
            `capture: template OPENED (opener=${JSON.stringify(this.templateBuf.slice(0, 24))})`
          );
        }
        text = "";
        // Fall through so a SAME-DELTA close is processed immediately.
        continue;
      }

      // Hold back a trailing PARTIAL opener across chunk boundaries — a
      // chunk may end mid-"<invoke name=…", mid-"<function_cal", or
      // mid-"<tool_calls:". Order matters only for which buffer holds it;
      // both are restored at detection entry.
      const partials = [
        "<tool_calls:",
        "<tool_call:",
        "<function_calls>",
        "<invoke ",
      ];
      for (let l = Math.min(text.length, 16); l > 0; l--) {
        const suffix = text.slice(-l);
        const hit = partials.find((op) => op.startsWith(suffix));
        if (hit) {
          if (hit === "<function_calls>" || hit === "<invoke ") {
            this.pendingAntmlPrefix = suffix;
          } else {
            this.pendingPrefix = suffix;
          }
          ui += text.slice(0, text.length - l);
          text = "";
          break;
        }
      }
      ui += text;
      break;
    }

    return ui;
  }

  /**
   * End-of-stream flush. Attempts to recover calls from UNCLOSED blocks
   * (truncation mid-template/mid-invoke) and returns leftover text that
   * must be surfaced rather than silently dropped. Drain takeCalls() after.
   */
  endFlush(): string {
    let out = "";
    if (this.inAntml && this.antmlBuf) {
      // Try with an appended close tag — recovers complete parameters of a
      // block truncated before its close tag.
      const calls = parseAntmlInvokes(this.antmlBuf + "</invoke>");
      this.log(`capture: antml END-FLUSH -> ${calls.length} call(s)`);
      if (calls.length > 0) {
        this.captured.push(...calls);
      } else {
        out += this.antmlBuf;
      }
      this.antmlBuf = "";
      this.inAntml = false;
      this.antmlWrapped = false;
    }
    if (this.inTemplate && this.templateBuf) {
      const calls = parseToolCallTemplate(this.templateBuf + "</tool_calls>");
      if (calls.length > 0) {
        this.captured.push(...calls);
      } else {
        out += this.templateBuf;
      }
      this.templateBuf = "";
      this.inTemplate = false;
    }
    if (this.pendingAntmlPrefix) {
      out += this.pendingAntmlPrefix;
      this.pendingAntmlPrefix = "";
    }
    if (this.pendingPrefix) {
      out += this.pendingPrefix;
      this.pendingPrefix = "";
    }
    return out;
  }
}
