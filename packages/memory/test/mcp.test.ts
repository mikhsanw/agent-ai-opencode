import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openMemoryService, type MemoryService } from "../src/service.js";
import { startMcpHttpServer } from "../src/mcp.js";

const TOKEN = "test-token-0123456789abcdef";
let svc: MemoryService;
let server: Server;
let url: string;

async function connect(token = TOKEN): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
}

beforeAll(async () => {
  svc = openMemoryService({ dbPath: ":memory:" });
  ({ server, url } = await startMcpHttpServer(svc, { token: TOKEN }));
});

afterAll(() => {
  server.close();
  svc.close();
});

describe("MCP HTTP", () => {
  it("menolak tanpa token / token salah", async () => {
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer salah" }, body: "{}" })).status).toBe(401);
    await expect(connect("salah-token-xxxxxxxxxxxx")).rejects.toThrow();
  });

  it("hanya mengekspos tool yang aman untuk agen (tanpa approve/reject skill)", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "memory_delete",
      "memory_read",
      "memory_replace",
      "memory_search",
      "memory_write",
      "skill_get",
      "skill_list",
      "skill_propose",
    ]);
    await client.close();
  });

  it("alur memori: tulis, duplikat, mirip→replace, cari, hapus", async () => {
    const client = await connect();
    expect((await call(client, "memory_write", { text: "Pengguna memakai Laravel 10." })).text).toContain("Tersimpan sebagai [1]");
    expect((await call(client, "memory_write", { text: "pengguna memakai laravel 10" })).text).toContain("Sudah ada sebagai [1]");

    const similar = await call(client, "memory_write", { text: "Pengguna memakai Laravel 11." });
    expect(similar.text).toContain("Belum disimpan");
    expect(similar.text).toContain("kemungkinan pembaruan");
    expect((await call(client, "memory_replace", { id: 1, text: "Pengguna memakai Laravel 11." })).text).toContain("Tersimpan sebagai [1]");

    expect((await call(client, "memory_search", { query: "laravel" })).text).toBe("[1] Pengguna memakai Laravel 11.");
    expect((await call(client, "memory_read")).text).toContain("[1] Pengguna memakai Laravel 11.");
    expect((await call(client, "memory_delete", { id: 1 })).text).toContain("dihapus");
    expect((await call(client, "memory_delete", { id: 1 })).isError).toBe(true);
    await client.close();
  });

  it("rahasia ditolak sebagai error", async () => {
    const client = await connect();
    const r = await call(client, "memory_write", { text: "password: SuperRahasia99" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("kemungkinan rahasia");
    await client.close();
  });

  it("skill usulan agen tidak bisa diambil sampai disetujui in-process", async () => {
    const client = await connect();
    const proposed = await call(client, "skill_propose", {
      id: "cek-log",
      name: "Cek log",
      description: "Cara membaca log aplikasi.",
      body: "1. Buka storage/logs.\n2. curl https://contoh.test",
    });
    expect(proposed.text).toContain("menunggu persetujuan");
    expect(proposed.text).toContain("Penanda risiko: shell, url");
    expect((await call(client, "skill_get", { id: "cek-log" })).isError).toBe(true);
    expect((await call(client, "skill_list")).text).toBe("(belum ada skill aktif)");

    svc.skills.approve("cek-log", "telegram:1");
    expect((await call(client, "skill_get", { id: "cek-log" })).text).toContain("Buka storage/logs");
    await client.close();
  });

  it("onRequest melaporkan tools/list (sinyal kesiapan katalog untuk bot)", async () => {
    const seen: string[][] = [];
    const extra = await startMcpHttpServer(svc, { token: TOKEN, onRequest: (m) => seen.push(m) });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(extra.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }),
    );
    await client.listTools();
    await client.close();
    extra.server.close();
    expect(seen.flat()).toEqual(expect.arrayContaining(["initialize", "tools/list"]));
  });

  it("menolak body terlalu besar dan metode selain POST", async () => {
    const big = "x".repeat(70 * 1024);
    const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: big }).catch(() => null);
    expect(r === null || r.status >= 400).toBe(true);
    expect((await fetch(url, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  });
});
