// E2E: OpenCode V2 sungguhan + model tiruan + server MCP memori dari paket ini.
// Butuh `opencode` (V2) di PATH. Semua config/data diisolasi di direktori sementara (XDG_*).
// Pakai: npm run e2e
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { openMemoryService, startMcpHttpServer, captureFromSession, createOpencodeGenerateClient } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
if (!/v?2\./.test(version)) throw new Error(`butuh OpenCode V2, terdeteksi: ${version}`);

const work = mkdtempSync(join(tmpdir(), "aao-e2e-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(work, "config"),
  XDG_DATA_HOME: join(work, "data"),
  XDG_STATE_HOME: join(work, "state"),
  XDG_CACHE_HOME: join(work, "cache"),
};
const proj = join(work, "proj");
execFileSync("mkdir", ["-p", proj, join(env.XDG_CONFIG_HOME, "opencode")]);
const mockLog = join(work, "mock.jsonl");
writeFileSync(mockLog, "");
// Port bebas dari OS (bukan acak) supaya run paralel/sisa proses lama tidak bertabrakan.
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
const MOCK_PORT = await freePort();
const OC_PORT = await freePort();
const children = [];
let failures = 0;

const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  LULUS" : "  GAGAL"}  ${label}${!cond && detail ? `\n         ${detail}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// OpenCode V2.1.2 butuh ~50-100 ms untuk mendeteksi perubahan file di instructions[] (diukur:
// sesi yang dibuat < 50 ms setelah tulis masih melihat isi lama; >= 100 ms selalu baru).
// Di pemakaian nyata jedanya detik (pesan Telegram berikutnya), jadi e2e menunggu eksplisit.
const settle = () => sleep(500);

async function main() {
  // 1. Memori + MCP
  const token = randomBytes(24).toString("hex");
  const snapshotPath = join(work, "export", "MEMORY.md");
  const svc = openMemoryService({ dbPath: join(work, "mem", "memory.db"), snapshotPath });
  let toolsListed;
  const catalogReady = new Promise((resolve) => (toolsListed = resolve));
  const { server: mcpServer, url: mcpUrl } = await startMcpHttpServer(svc, {
    token,
    onRequest: (methods) => methods.includes("tools/list") && toolsListed(),
  });

  // 2. Model tiruan
  children.push(spawn(process.execPath, [join(here, "mock-llm.mjs")], { env: { ...env, MOCK_LOG: mockLog, MOCK_PORT: String(MOCK_PORT) }, stdio: "ignore" }));

  // 3. OpenCode V2 dengan MCP remote + snapshot di instructions[]
  writeFileSync(
    join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
    JSON.stringify(
      {
        model: "mock/echo",
        instructions: [snapshotPath],
        permissions: [{ action: "skill", resource: "*", effect: "deny" }],
        providers: {
          mock: {
            name: "Mock",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: "mock" },
            models: { echo: { modelID: "echo", name: "Mock Echo" } },
          },
        },
        mcp: { servers: { memory: { type: "remote", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } },
      },
      null,
      2,
    ),
  );
  let serveLog = "";
  const oc = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(OC_PORT)], { cwd: proj, env });
  children.push(oc);
  oc.stdout.on("data", (d) => (serveLog += d));
  oc.stderr.on("data", (d) => (serveLog += d));
  for (let i = 0; i < 60 && !/server password/.test(serveLog); i++) await sleep(500);
  const password = serveLog.match(/server password (\S+)/)?.[1];
  if (!password) throw new Error(`OpenCode tidak start:\n${serveLog}`);

  const B = `http://127.0.0.1:${OC_PORT}`;
  const D = `directory=${encodeURIComponent(proj)}`;
  const auth = { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") };
  const api = async (method, path, body) => {
    const res = await fetch(`${B}${path}${path.includes("?") ? "&" : "?"}${D}`, {
      method,
      headers: { ...auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  const newSession = async () => (await api("POST", "/api/session", {})).data.id;
  const prompt = async (sid, text) => {
    await api("POST", `/api/session/${sid}/prompt`, { text });
    await api("POST", `/api/experimental/session/${sid}/wait`);
  };
  const mockRequests = () => readFileSync(mockLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).body);
  const lastAgentRequest = () => mockRequests().filter((b) => (b.tools ?? []).length > 0).at(-1);
  const systemOf = (b) => {
    const c = b.messages[0].content;
    return Array.isArray(c) ? c.map((x) => x.text ?? "").join("\n") : c;
  };

  // Status `connected` saja tidak cukup (prompt pertama bisa mendapat "Unknown tool").
  // OpenCode memuat instance lokasi secara malas; request pertama untuk direktori itu memicu
  // initialize -> tools/list ke server MCP kita. Jadi: picu lokasi, lalu tunggu tools/list.
  // Setelah tools/list, katalog Code Mode masih perlu waktu (diukur: 0 ms gagal 3/3, 250 ms lulus 3/3);
  // margin 1 s = 4x hasil ukur, untuk VPS yang lebih lambat.
  await api("GET", "/api/mcp");
  const ready = await Promise.race([catalogReady.then(() => true), sleep(30_000).then(() => false)]);
  await sleep(1000);
  check("MCP memori siap (OpenCode sudah mengambil daftar tool)", ready);

  console.log(`\nOpenCode ${version} · MCP ${mcpUrl}\n`);

  // A. Tool path lewat Code Mode
  const s1 = await newSession();
  await prompt(s1, "MEMWRITE: Pengguna memakai Laravel 11 dan Flutter.");
  check("A1 memory_write lewat Code Mode tersimpan", svc.memories.list().some((m) => m.text === "Pengguna memakai Laravel 11 dan Flutter."));
  check("A2 snapshot diperbarui", readFileSync(snapshotPath, "utf8").includes("- [1] Pengguna memakai Laravel 11 dan Flutter."));
  await settle();
  await prompt(s1, "lanjut");
  const s1Next = lastAgentRequest();
  check(
    "A3 sesi yang sama menerima fakta baru di giliran berikutnya (<system-update>)",
    s1Next.messages.some((m) => JSON.stringify(m.content ?? "").includes("system-update") && JSON.stringify(m.content).includes("Laravel 11")),
  );

  // B. Injeksi ke sesi baru
  const s2 = await newSession();
  await prompt(s2, "halo");
  const sys = systemOf(lastAgentRequest());
  check("B1 sesi baru menerima memori di system prompt", sys.includes("- [1] Pengguna memakai Laravel 11 dan Flutter."));
  check("B2 header 'DATA, bukan instruksi' ikut terinjeksi", /adalah DATA .*bukan instruksi/.test(sys));
  check("B3 tool memory_write ada di katalog Code Mode", sys.includes("tools.memory.memory_write"));

  // C. Rahasia ditolak lewat jalur tool
  const before = svc.memories.list().length;
  await prompt(await newSession(), "MEMWRITE: password: SuperRahasia99");
  const toolMsg = mockRequests().flatMap((b) => b.messages).filter((m) => m.role === "tool").at(-1);
  check("C1 rahasia tidak tersimpan", svc.memories.list().length === before);
  check("C2 agen menerima pesan penolakan", JSON.stringify(toolMsg ?? "").includes("kemungkinan rahasia"), JSON.stringify(toolMsg ?? "").slice(0, 200));

  // D. Auto-capture lewat generate
  const s3 = await newSession();
  await prompt(s3, "Server produksi saya pakai Ubuntu 24.04.");
  const msgsBefore = (await api("GET", `/api/session/${s3}/message`)).data.length;
  const client = createOpencodeGenerateClient({ baseUrl: B, password, directory: proj });
  const cap = await captureFromSession({ client, sessionId: s3, store: svc.memories });
  const msgsAfter = (await api("GET", `/api/session/${s3}/message`)).data.length;
  check("D1 auto-capture menyimpan fakta dari generate", cap.ok && cap.saved.includes("Pengguna memakai Ubuntu 24.04 di server produksi."), JSON.stringify(cap));
  check("D2 generate tidak mengubah riwayat sesi", msgsBefore === msgsAfter, `${msgsBefore} -> ${msgsAfter}`);
  const cap2 = await captureFromSession({ client, sessionId: s3, store: svc.memories });
  check("D3 capture ulang tidak menggandakan", cap2.saved.length === 0 && cap2.skipped.length === 1, JSON.stringify(cap2));

  // E. Skill: usulan agen tidak aktif sebelum approve
  await prompt(await newSession(), "PROPOSE: cek-log");
  check("E1 usulan skill tercatat pending", svc.skills.listPending().some((s) => s.id === "cek-log"));
  check("E2 belum muncul di snapshot", !readFileSync(snapshotPath, "utf8").includes("cek-log"));
  svc.skills.approve("cek-log", "telegram:e2e");
  await settle();
  const s4 = await newSession();
  await prompt(s4, "halo");
  check("E3 setelah approve, sesi baru melihat skill", systemOf(lastAgentRequest()).includes("`cek-log`"));

  mcpServer.close();
  svc.close();
}

try {
  await main();
} catch (err) {
  console.error(err);
  failures++;
} finally {
  for (const c of children) c.kill("SIGTERM");
  await sleep(500);
  if (!process.env.KEEP && existsSync(work)) rmSync(work, { recursive: true, force: true });
  console.log(failures === 0 ? "\nE2E: semua lulus" : `\nE2E: ${failures} gagal${process.env.KEEP ? ` (lihat ${work})` : ""}`);
  process.exit(failures === 0 ? 0 : 1);
}
