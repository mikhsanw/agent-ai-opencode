import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { MemoryService } from "./service.js";
import type { WriteResult } from "./memories.js";
import type { ProposeResult } from "./skills.js";

/**
 * Permukaan MCP yang dilihat agen OpenCode.
 *
 * Aturan batas: hanya operasi yang aman bila dipanggil agen yang sudah disusupi.
 * Approve/reject skill TIDAK ada di sini; itu hanya lewat API in-process untuk handler Telegram.
 */

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function describeWrite(r: WriteResult, svc: MemoryService): ToolResult {
  const usage = `(${svc.memories.totalChars()}/${svc.memories.limits.maxTotalChars} karakter terpakai)`;
  switch (r.status) {
    case "saved":
      return ok(`Tersimpan sebagai [${r.memory.id}]: ${r.memory.text} ${usage}`);
    case "duplicate":
      return ok(`Sudah ada sebagai [${r.existing.id}]: ${r.existing.text}. Tidak perlu disimpan lagi.`);
    case "similar": {
      const list = r.candidates
        .map(
          (c) =>
            `- [${c.memory.id}] ${c.memory.text} (kemiripan ${c.score.toFixed(2)}${c.numbersDiffer ? ", angka/versi berbeda: kemungkinan pembaruan" : ""})`,
        )
        .join("\n");
      return ok(
        `Belum disimpan: mirip dengan entri yang sudah ada.\n${list}\n` +
          "Jika ini pembaruan dari entri tersebut, panggil memory_replace dengan id-nya. " +
          "Jika memang fakta yang berbeda, panggil memory_write lagi dengan force=true.",
      );
    }
    case "not_found":
      return fail(`Entri [${r.id}] tidak ditemukan. Lihat daftar dengan memory_read.`);
    case "rejected":
      switch (r.reason) {
        case "secret":
          return fail(
            `Ditolak: terdeteksi kemungkinan rahasia (${r.findings.map((f) => f.kind).join(", ")}). Memori tidak boleh berisi password, token, atau key.`,
          );
        case "too_long":
          return fail(`Ditolak: ${r.length} karakter, maksimal ${r.max}. Ringkas menjadi satu fakta singkat.`);
        case "budget":
          return fail(
            `Ditolak: memori penuh (${r.total}/${r.max} karakter). Gabungkan atau hapus entri lama dengan memory_replace/memory_delete terlebih dahulu.`,
          );
        case "empty":
          return fail("Ditolak: teks kosong setelah dibersihkan.");
      }
  }
}

function describePropose(r: ProposeResult): ToolResult {
  if (r.status === "pending") {
    const risk = r.skill.risk.length > 0 ? ` Penanda risiko: ${r.skill.risk.join(", ")}.` : "";
    return ok(`Usulan skill \`${r.skill.id}\` tercatat dan menunggu persetujuan pengguna. Skill belum aktif.${risk}`);
  }
  if (r.reason === "secret") return fail(`Ditolak: skill berisi kemungkinan rahasia (${r.findings.map((f) => f.kind).join(", ")}).`);
  return fail(`Ditolak (${r.reason})${r.detail ? `: ${r.detail}` : ""}.`);
}

export function buildMcpServer(svc: MemoryService): McpServer {
  const server = new McpServer({ name: "memory", version: "0.1.0" });

  server.registerTool(
    "memory_read",
    { description: "Baca semua memori jangka panjang tentang pengguna, lengkap dengan nomor entri." },
    async () => {
      const items = svc.memories.list();
      const usage = `${svc.memories.totalChars()}/${svc.memories.limits.maxTotalChars} karakter terpakai`;
      return ok(items.length === 0 ? `(memori kosong; ${usage})` : `${items.map((m) => `[${m.id}] ${m.text}`).join("\n")}\n(${usage})`);
    },
  );

  server.registerTool(
    "memory_search",
    {
      description: "Cari memori jangka panjang berdasarkan kata kunci.",
      inputSchema: { query: z.string().min(1).max(200) },
    },
    async ({ query }) => {
      const items = svc.memories.search(query);
      return ok(items.length === 0 ? "Tidak ada memori yang cocok." : items.map((m) => `[${m.id}] ${m.text}`).join("\n"));
    },
  );

  server.registerTool(
    "memory_write",
    {
      description:
        "Simpan SATU fakta atau preferensi tahan lama tentang pengguna. Bahasa Indonesia, singkat, orang ketiga. Jangan simpan rahasia.",
      inputSchema: {
        text: z.string().min(1).max(1000),
        force: z.boolean().optional().describe("true hanya jika sistem bilang mirip tetapi ini memang fakta berbeda"),
      },
    },
    async ({ text, force }) => describeWrite(svc.memories.write({ text, actor: "tool", force: force ?? false }), svc),
  );

  server.registerTool(
    "memory_replace",
    {
      description: "Ganti isi satu entri memori (mis. fakta yang berubah). Gunakan nomor entri dari memory_read.",
      inputSchema: { id: z.number().int().positive(), text: z.string().min(1).max(1000) },
    },
    async ({ id, text }) => describeWrite(svc.memories.replace(id, text, "tool"), svc),
  );

  server.registerTool(
    "memory_delete",
    {
      description: "Hapus satu entri memori yang salah atau tidak berlaku lagi.",
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      const r = svc.memories.remove(id, "tool");
      return r.status === "deleted" ? ok(`Entri [${id}] dihapus: ${r.memory.text}`) : fail(`Entri [${id}] tidak ditemukan.`);
    },
  );

  server.registerTool(
    "skill_list",
    { description: "Daftar skill hasil belajar yang sudah disetujui pengguna." },
    async () => {
      const skills = svc.skills.listApproved();
      return ok(skills.length === 0 ? "(belum ada skill aktif)" : skills.map((s) => `${s.id} — ${s.description}`).join("\n"));
    },
  );

  server.registerTool(
    "skill_get",
    {
      description: "Ambil isi lengkap satu skill hasil belajar yang sudah disetujui.",
      inputSchema: { id: z.string().min(1).max(64) },
    },
    async ({ id }) => {
      const s = svc.skills.getApproved(id);
      return s ? ok(`# ${s.name}\n\n${s.description}\n\n${s.body}`) : fail(`Skill \`${id}\` tidak ada atau belum disetujui.`);
    },
  );

  server.registerTool(
    "skill_propose",
    {
      description:
        "Usulkan prosedur yang berhasil sebagai skill untuk dipakai ulang. Skill TIDAK aktif sampai pengguna menyetujuinya lewat Telegram.",
      inputSchema: {
        id: z.string().min(3).max(48).describe("huruf kecil, angka, '-' (mis. deploy-laravel)"),
        name: z.string().min(1).max(80),
        description: z.string().min(1).max(300).describe("kapan skill ini dipakai, satu kalimat"),
        body: z.string().min(1).max(8000).describe("langkah-langkah dalam Markdown"),
      },
    },
    async (args) => describePropose(svc.skills.propose({ ...args, actor: "tool" })),
  );

  return server;
}

const MAX_BODY_BYTES = 64 * 1024;

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(provided), digest(token));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface McpHttpOptions {
  token: string;
  path?: string;
  /**
   * Dipanggil setelah sebuah request selesai dijawab, dengan daftar method JSON-RPC-nya.
   * Status MCP `connected` di OpenCode V2 BUKAN tanda katalog Code Mode sudah memuat tool kita
   * (teramati: prompt pertama mendapat "Unknown tool"). Request `tools/list` dari OpenCode adalah
   * sinyal kesiapan yang bisa diandalkan; bot memakainya sebelum meneruskan prompt pertama.
   */
  onRequest?: (methods: string[]) => void;
}

/** Handler HTTP (stateless Streamable HTTP) yang bisa dipasang di server Node mana pun, termasuk proses bot. */
export function createMcpHttpHandler(svc: MemoryService, opts: McpHttpOptions) {
  if (opts.token.length < 16) throw new Error("token MCP minimal 16 karakter");
  const path = opts.path ?? "/mcp";
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req, opts.token)) {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
      return;
    }
    const server = buildMcpServer(svc);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    if (opts.onRequest) {
      const methods = (Array.isArray(body) ? body : [body])
        .map((m) => (m && typeof m === "object" && "method" in m ? String((m as { method: unknown }).method) : ""))
        .filter(Boolean);
      opts.onRequest(methods);
    }
  };
}

/** Server MCP mandiri (dipakai untuk e2e, atau bila memori dijalankan sebagai proses terpisah). */
export function startMcpHttpServer(
  svc: MemoryService,
  opts: McpHttpOptions & { host?: string; port?: number },
): Promise<{ server: Server; url: string }> {
  const handler = createMcpHttpHandler(svc, opts);
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({ server, url: `http://${host}:${port}/mcp` });
    });
  });
}
