// E2E: the real bot process (bot/dist) + real OpenCode V2 + mock model + fake Telegram Bot API.
// No manual waits around prompts: this proves the readiness gate, auto-capture, Telegram
// commands and skill approval through the bot's own code paths.
// Needs `opencode` (V2) on PATH and `npm run build`. Usage: node scripts/e2e-bot.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startFakeTelegram } from "./fake-telegram.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
if (!/v?2\./.test(version)) throw new Error(`OpenCode V2 required, found: ${version}`);
if (!existsSync(join(root, "bot", "dist", "index.js"))) throw new Error("run `npm run build` first");

const USER_ID = 777001;
const work = mkdtempSync(join(tmpdir(), "aao-e2e-bot-"));
const proj = join(work, "proj");
const botHome = join(work, "bothome");
const snapshotPath = join(botHome, "aao", "export", "MEMORY.md");
const mockLog = join(work, "mock.jsonl");
const children = [];
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  LULUS" : "  GAGAL"}  ${label}${!cond && detail ? `\n         ${String(detail).slice(0, 400)}` : ""}`);
  if (!cond) failures++;
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
const waitUntil = async (fn, timeoutMs, stepMs = 200) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
};
const snapshot = () => (existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : "");
const mockRequests = () => readFileSync(mockLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).body);
const rssMb = (pid) => Math.round(Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]) / 1024);

async function main() {
  const ocEnv = {
    ...process.env,
    XDG_CONFIG_HOME: join(work, "oc", "config"),
    XDG_DATA_HOME: join(work, "oc", "data"),
    XDG_STATE_HOME: join(work, "oc", "state"),
    XDG_CACHE_HOME: join(work, "oc", "cache"),
  };
  mkdirSync(join(ocEnv.XDG_CONFIG_HOME, "opencode"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: proj });
  writeFileSync(join(proj, "README.md"), "# proj\n");
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "add", "."], { cwd: proj });
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "init"], { cwd: proj });
  writeFileSync(mockLog, "");

  const [mockPort, ocPort, mcpPort] = [await freePort(), await freePort(), await freePort()];
  const token = randomBytes(24).toString("hex");

  children.push(
    spawn(process.execPath, [join(root, "packages", "memory", "scripts", "mock-llm.mjs")], {
      env: { ...process.env, MOCK_LOG: mockLog, MOCK_PORT: String(mockPort) },
      stdio: "ignore",
    }),
  );
  const telegram = await startFakeTelegram({ userId: USER_ID });
  globalThis.__telegramCalls = telegram.calls;

  writeFileSync(
    join(ocEnv.XDG_CONFIG_HOME, "opencode", "opencode.json"),
    JSON.stringify({
      model: "mock/echo",
      instructions: [snapshotPath],
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
      providers: {
        mock: {
          name: "Mock",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "mock" },
          models: { echo: { modelID: "echo", name: "Mock Echo" } },
        },
      },
      mcp: { servers: { memory: { type: "remote", url: `http://127.0.0.1:${mcpPort}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
    }),
  );
  // Fixed password (OPENCODE_SERVER_PASSWORD) so OpenCode can be restarted mid-test.
  const password = randomBytes(18).toString("hex");
  const auth = { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") };
  const startOpencode = async () => {
    let log = "";
    const proc = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(ocPort)], {
      cwd: proj,
      env: { ...ocEnv, OPENCODE_SERVER_PASSWORD: password },
    });
    children.push(proc);
    proc.stdout.on("data", (d) => (log += d));
    proc.stderr.on("data", (d) => (log += d));
    const up = await waitUntil(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${ocPort}/api/info`, { headers: auth })).ok;
      } catch {
        return false;
      }
    }, 30_000);
    if (!up) throw new Error(`OpenCode did not start:\n${log}`);
    return proc;
  };
  let oc = await startOpencode();

  // The bot needs a current project; take its id from OpenCode (does not load the location's MCP).
  const projects = await (await fetch(`http://127.0.0.1:${ocPort}/api/project`, { headers: auth })).json();
  const list = Array.isArray(projects) ? projects : projects.data;
  const project = (list ?? []).find((p) => p.worktree === proj) ?? { id: "global", worktree: proj };
  mkdirSync(botHome, { recursive: true });
  writeFileSync(join(botHome, "settings.json"), JSON.stringify({ currentProject: { id: project.id, worktree: proj, name: "proj" } }));

  let botLog = "";
  // Production runs Node with heap caps (PRD K16); E2E_NODE_OPTIONS="" measures without them.
  const nodeOptions = process.env.E2E_NODE_OPTIONS ?? "--max-old-space-size=128 --max-semi-space-size=2";
  const bot = spawn(process.execPath, [...nodeOptions.split(" ").filter(Boolean), join(root, "bot", "dist", "index.js")], {
    cwd: work,
    env: {
      ...process.env,
      OPENCODE_TELEGRAM_HOME: botHome,
      TELEGRAM_BOT_TOKEN: "123456:fake-token-for-e2e",
      TELEGRAM_ALLOWED_USER_ID: String(USER_ID),
      TELEGRAM_API_ROOT: telegram.url,
      OPENCODE_SERVER_VERSION: "v2",
      OPENCODE_API_URL: `http://127.0.0.1:${ocPort}`,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_MODEL_PROVIDER: "mock",
      OPENCODE_MODEL_ID: "echo",
      BOT_LOCALE: "id",
      LOG_LEVEL: "info",
      AAO_MCP_PORT: String(mcpPort),
      AAO_MCP_TOKEN: token,
      AAO_DIGEST_HOUR: "-1",
      // No event subscription at startup: the first prompt's session creation loads the location
      // milliseconds before the prompt, which is exactly the "Unknown tool" race the gate covers.
      TRACK_BACKGROUND_SESSIONS: "false",
    },
  });
  children.push(bot);
  bot.stdout.on("data", (d) => (botLog += d));
  bot.stderr.on("data", (d) => (botLog += d));

  const polling = await telegram.waitFor((c) => c.method === "deleteWebhook" || c.method === "getMe", { since: 0, timeoutMs: 30_000, label: "bot startup" }).then(() => true, () => false);
  check("bot start dan tersambung ke Telegram tiruan", polling, botLog.slice(-1500));
  check("runtime memori aktif (MCP 127.0.0.1)", await waitUntil(() => /\[AAO\] Memory MCP listening/.test(botLog), 10_000), botLog.slice(-800));
  await waitUntil(() => existsSync(snapshotPath), 5000);
  await sleep(1500); // let long polling begin

  console.log(`\nOpenCode ${version} · bot ${join(root, "bot")}\n`);
  const sentText = (c, pattern) => (c.method === "sendMessage" || c.method === "editMessageText") && pattern.test(c.params.text ?? "");

  // 1. Commands registered, Indonesian, and /memory on an empty store
  let t = telegram.sendText("/memory");
  const commands = await telegram.waitFor((c) => c.method === "setMyCommands" && (c.params.commands ?? []).length > 0, { since: t, label: "setMyCommands" }).catch(() => null);
  const names = (commands?.params.commands ?? []).map((c) => `${c.command}=${c.description}`);
  check("perintah aao terdaftar di Telegram (bahasa Indonesia)", ["memory=Memori jangka panjang", "undo=Batalkan perubahan memori terakhir", "skills_pending=Skill yang menunggu persetujuan"].every((n) => names.includes(n)), names.join(" | "));
  check("/memory pada memori kosong", await telegram.waitFor((c) => sentText(c, /Memori masih kosong/), { since: t }).then(() => true, () => false));

  // 2. First prompt in a cold location: the gate must prevent "Unknown tool"
  t = telegram.sendText("MEMWRITE: Pengguna memakai Laravel 11 dan Flutter.");
  const saved = await waitUntil(() => snapshot().includes("Pengguna memakai Laravel 11 dan Flutter."), 45_000);
  const unknownTool = mockRequests().flatMap((b) => b.messages ?? []).some((m) => m.role === "tool" && JSON.stringify(m.content ?? "").includes("Unknown tool"));
  check("prompt pertama: memori tersimpan lewat Code Mode", saved, botLog.slice(-1500));
  check("gerbang kesiapan: tidak ada 'Unknown tool' di lokasi baru", !unknownTool);

  // 3. Auto-capture after idle (mock answers the capture prompt with a JSON fact)
  const captured = await waitUntil(() => snapshot().includes("Pengguna memakai Ubuntu 24.04 di server produksi."), 30_000);
  check("auto-capture setelah sesi idle menyimpan fakta", captured, botLog.slice(-1500));
  const capturesBefore = mockRequests().filter((b) => JSON.stringify(b.messages ?? "").includes("TUGAS INTERNAL")).length;
  await sleep(4000);
  const capturesAfter = mockRequests().filter((b) => JSON.stringify(b.messages ?? "").includes("TUGAS INTERNAL")).length;
  check("auto-capture tidak berulang terus (generate tidak memicu idle baru)", capturesAfter === capturesBefore && capturesBefore >= 1, `${capturesBefore} -> ${capturesAfter}`);

  // 4. /memory lists both, delete one with the button, then /undo
  t = telegram.sendText("/memory");
  const listing = await telegram.waitFor((c) => sentText(c, /🧠 Memori \(2 entri/), { since: t }).catch(() => null);
  const buttons = JSON.stringify(listing?.params.reply_markup ?? "");
  check("/memory menampilkan 2 entri dengan tombol hapus", Boolean(listing) && buttons.includes("aao:mem:del:2") && buttons.includes("aao:mem:undo"), listing?.params.text);
  t = telegram.pressButton("aao:mem:del:2");
  check("tombol 🗑 menghapus entri", await telegram.waitFor((c) => sentText(c, /Entri \[2\] dihapus/), { since: t }).then(() => true, () => false));
  check("snapshot ikut diperbarui setelah hapus", await waitUntil(() => !snapshot().includes("Ubuntu 24.04"), 3000));
  t = telegram.sendText("/undo");
  check("/undo mengembalikan penghapusan", await telegram.waitFor((c) => sentText(c, /Dibatalkan: hapus \[2\]/), { since: t }).then(() => true, () => false));
  check("entri kembali di snapshot", await waitUntil(() => snapshot().includes("Ubuntu 24.04"), 3000));

  // 5. Skill proposal -> notification -> approve -> visible to new sessions
  t = telegram.sendText("PROPOSE: cek-log");
  const card = await telegram.waitFor((c) => sentText(c, /Agen mengusulkan skill baru/), { since: t, timeoutMs: 45_000 }).catch(() => null);
  check("notifikasi usulan skill terkirim dengan tombol", Boolean(card) && JSON.stringify(card.params.reply_markup ?? "").includes("aao:sk:ok:cek-log"), botLog.slice(-1200));
  check("usulan belum aktif sebelum disetujui", !snapshot().includes("cek-log"));
  t = telegram.pressButton("aao:sk:ok:cek-log");
  check("tombol ✅ mengaktifkan skill", await telegram.waitFor((c) => sentText(c, /Skill cek-log aktif/), { since: t }).then(() => true, () => false));
  check("skill muncul di snapshot untuk sesi baru", await waitUntil(() => snapshot().includes("`cek-log`"), 3000));

  // 6. OpenCode restarts while the bot keeps running; prompt right away (fresh tool catalogs)
  oc.kill("SIGTERM");
  await new Promise((resolve) => oc.once("exit", resolve));
  const requestsBeforeRestart = mockRequests().length;
  oc = await startOpencode();
  t = telegram.sendText("MEMWRITE: Pengguna suka kopi tanpa gula.");
  const savedAfterRestart = await waitUntil(() => snapshot().includes("Pengguna suka kopi tanpa gula."), 45_000);
  const unknownAfterRestart = mockRequests()
    .slice(requestsBeforeRestart)
    .flatMap((b) => b.messages ?? [])
    .some((m) => m.role === "tool" && JSON.stringify(m.content ?? "").includes("Unknown tool"));
  check("restart OpenCode terdeteksi oleh gerbang (pid berubah)", /\[AAO\] OpenCode restart detected/.test(botLog), botLog.slice(-1500));
  check("prompt seketika setelah restart: memori tersimpan", savedAfterRestart, botLog.slice(-1500));
  check("prompt seketika setelah restart: tidak ada 'Unknown tool'", !unknownAfterRestart);

  // 7. Memory footprint (PRD S8)
  const botRss = rssMb(bot.pid);
  const ocRss = rssMb(oc.pid);
  console.log(`\n  RSS proses bot + memori: ${botRss} MB (NODE_OPTIONS: ${nodeOptions || "-"}) · OpenCode: ${ocRss} MB`);
  check("RSS bot + memori <= 150 MB (S8)", botRss <= 150, `${botRss} MB`);
  telegram.close();
}

try {
  await main();
} catch (error) {
  console.error(error);
  failures++;
} finally {
  for (const child of children) child.kill("SIGTERM");
  await sleep(800);
  if (process.env.KEEP && globalThis.__telegramCalls) {
    writeFileSync(join(work, "telegram-calls.json"), JSON.stringify(globalThis.__telegramCalls, null, 1));
  }
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
  console.log(failures === 0 ? "\nE2E bot: semua lulus" : `\nE2E bot: ${failures} gagal${process.env.KEEP ? ` (lihat ${work})` : ""}`);
  process.exit(failures === 0 ? 0 : 1);
}
