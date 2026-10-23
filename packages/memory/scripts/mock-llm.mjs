// Model tiruan (OpenAI-compatible chat completions) untuk e2e. Merekam setiap request ke MOCK_LOG.
// Perilaku deterministik berdasarkan pesan pengguna terakhir:
//   "MEMWRITE: <teks>"  -> panggil tools.memory.memory_write lewat Code Mode (tool `execute`)
//   "PROPOSE: <id>"     -> panggil tools.memory.skill_propose
//   prompt auto-capture -> balas JSON fakta
//   lainnya             -> "OK"
import http from "node:http";
import fs from "node:fs";

const LOG = process.env.MOCK_LOG;
const PORT = Number(process.env.MOCK_PORT);

const textOf = (m) =>
  typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join("\n") : "";

function plan(body) {
  const msgs = body.messages ?? [];
  const last = msgs[msgs.length - 1];
  if (last?.role === "tool") return { text: "DONE" };
  const user = [...msgs].reverse().find((m) => m.role === "user");
  const text = user ? textOf(user) : "";
  if (text.includes("TUGAS INTERNAL")) return { text: '{"facts": ["Pengguna memakai Ubuntu 24.04 di server produksi."]}' };
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const w = text.match(/MEMWRITE:\s*(.+)/);
  if (w && tools.includes("execute")) {
    return { tool: "execute", args: { code: `return await tools.memory.memory_write({ text: ${JSON.stringify(w[1].trim())} })` } };
  }
  const p = text.match(/PROPOSE:\s*(\S+)/);
  if (p && tools.includes("execute")) {
    const args = { id: p[1], name: "Cek log", description: "Cara membaca log aplikasi Laravel.", body: "1. Buka storage/logs.\n2. Cari ERROR." };
    return { tool: "execute", args: { code: `return await tools.memory.skill_propose(${JSON.stringify(args)})` } };
  }
  return { text: "OK" };
}

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      fs.appendFileSync(LOG, JSON.stringify({ url: req.url, body }) + "\n");
      if (!req.url.includes("chat/completions")) return res.writeHead(404).end();
      const p = plan(body);
      const base = { id: "mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (p.tool) {
        sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: p.tool, arguments: "" } }] } }] });
        sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(p.args) } }] } }] });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: p.text } }] });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      sse(res, { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  })
  .listen(PORT, "127.0.0.1");
