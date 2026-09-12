/* RAW probe: reproduce the exact CodeBuddy chat request and dump the raw
 * SSE bytes to find where the stream truncates after "……： ". Uses the
 * real stored credentials. SAFE: read-only, one request, small max_tokens. */
const fs = require("fs");
const os = require("os");

const authPath =
  os.homedir() +
  "/Library/Application Support/Code/User/globalStorage/codebuddy-chat.codebuddy-chat/codebuddy-auth.json";
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
console.log("auth keys:", Object.keys(auth).join(","));

const BASE_URL = "https://copilot.tencent.com";
const CHAT_PATH = "/v2/chat/completions";

const body = {
  model: "g-mdgssd8zjy0f", // placeholder — replace after listing models? just try a common one
  messages: [
    { role: "user", content: "运行构建告诉我有没有错误。清理旧的 vite preview 进程后重启。" },
  ],
  stream: true,
  max_tokens: 512,
};

(async () => {
  // model: use whatever is stored in the auth or a sane default
  body.model = process.argv[2] || "g-mdjubkftdxrab";
  const res = await fetch(`${BASE_URL}${CHAT_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${auth.accessToken}`,
      "X-Client-Platform": "web",
      "X-Product": "SaaS",
      "User-Agent": "CodeBuddy-IDE",
    },
    body: JSON.stringify(body),
  });
  console.log("HTTP", res.status, res.headers.get("content-type"));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let bytes = 0;
  let events = 0;
  let lastChunkAt = Date.now();
  const start = Date.now();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        console.log(`STREAM DONE after ${bytes}B, ${Date.now() - start}ms`);
        break;
      }
      bytes += value.length;
      const text = new TextDecoder().decode(value);
      // Print raw bytes verbatim (escaped) FIRST 3000 chars total
      if (bytes <= 3000) console.log("RAW:", JSON.stringify(text).slice(0, 600));
      void lastChunkAt;
    }
  } catch (e) {
    console.log("STREAM ERROR after", bytes, "B:", e.message);
  }
  console.log("total bytes:", bytes);
})().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
