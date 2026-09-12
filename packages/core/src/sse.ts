/**
 * SSE (Server-Sent Events) stream parser for OpenAI-compatible chat completions.
 *
 * Reads a ReadableStream<Uint8Array> from an HTTP response and yields
 * individual JSON chunks, stripping "data: " prefixes and [DONE] markers.
 *
 * Robustness: some gateways emit a single SSE event as MULTIPLE physical
 * lines (pretty-printed JSON, or a TCP chunk splitting a data line so that
 * fragments arrive on separate reads). Naive line-by-line JSON.parse
 * silently drops those — which manifested as "tool call swallowed and the
 * stream just ends". This parser buffers each data payload by BRACE DEPTH
 * (string-aware): the payload is parsed only once its braces balance, no
 * matter how many lines or network chunks it spans.
 */

export interface SSEChunk {
  /** Parsed JSON payload from one "data:" line. */
  data: Record<string, unknown>;
}

export async function* parseSSEStream(
  response: Response
): AsyncGenerator<SSEChunk, void, unknown> {
  if (!response.body) {
    throw new Error("Response body is null — cannot read SSE stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Accumulated (possibly multi-line) payload of the current data event.
  let dataBuf = "";
  // Brace depth inside dataBuf, honoring string literals and escapes.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let hasPayload = false;

  const resetAccum = (): void => {
    dataBuf = "";
    depth = 0;
    inString = false;
    escaped = false;
    hasPayload = false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        let line = rawLine.trim();

        // Skip empty lines and comments — but only OUTSIDE a payload (a
        // gateway splitting JSON across lines yields blank fragments that
        // belong to the buffered object).
        if (!line || line.startsWith(":")) {
          if (!hasPayload) continue;
          continue;
        }

        if (!hasPayload && line.startsWith("event:")) continue;

        // Strip "data: " prefix (may be layered by proxies).
        if (line.startsWith("data:")) {
          while (line.startsWith("data:")) {
            line = line.slice(5).trimStart();
          }
          hasPayload = true;
          dataBuf += (dataBuf && dataBuf !== "" ? "\n" : "") + line;
        } else if (hasPayload) {
          // Continuation fragment of a multi-line payload.
          dataBuf += "\n" + line;
        } else {
          // Unknown line type outside a payload — ignore.
          continue;
        }

        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === "\\") {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inString = !inString;
            continue;
          }
          if (inString) continue;
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }

        const trimmed = dataBuf.trim();
        if (trimmed === "[DONE]") {
          resetAccum();
          return;
        }
        if (depth <= 0 && hasPayload && trimmed) {
          // Payload complete → emit.
          resetAccum();
          try {
            yield { data: JSON.parse(trimmed) as Record<string, unknown> };
          } catch {
            // Genuinely malformed — drop (previous behaviour).
          }
        }
      }
    }
    // Trailing complete payload left in the accumulator at stream end.
    const trailing = dataBuf.trim();
    if (hasPayload && depth <= 0 && trailing && trailing !== "[DONE]") {
      try {
        yield { data: JSON.parse(trailing) as Record<string, unknown> };
      } catch {
        // malformed — drop
      }
    }
  } finally {
    reader.releaseLock();
  }
}
