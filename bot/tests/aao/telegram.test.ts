import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Context } from "grammy";
import type { AuditEntry, Skill } from "@aao/memory";
import { AaoRuntime } from "../../src/aao/runtime.js";
import type { AaoConfig } from "../../src/aao/config.js";
import {
  buildDigest,
  buildMemoryView,
  buildSkillCard,
  describeUndo,
  handleCallback,
  runDigestIfDue,
} from "../../src/aao/telegram.js";
import { resetRuntimeLocale, setRuntimeLocale } from "../../src/i18n/index.js";

let runtime: AaoRuntime;
let dataDir: string;

beforeEach(() => {
  setRuntimeLocale("id");
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aao-tg-"));
  const config: AaoConfig = {
    enabled: true,
    dataDir,
    dbPath: path.join(dataDir, "memory.db"),
    snapshotPath: path.join(dataDir, "export", "MEMORY.md"),
    mcpHost: "127.0.0.1",
    mcpPort: 0,
    mcpToken: null,
    captureEnabled: true,
    captureDailyLimit: 30,
    captureCooldownMs: 60_000,
    digestHour: 20,
    readinessTimeoutMs: 1000,
    readinessMarginMs: 0,
  };
  runtime = new AaoRuntime(config);
});

afterEach(() => {
  runtime.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  resetRuntimeLocale();
});

const callbackDataOf = (view: ReturnType<typeof buildMemoryView>) =>
  (view.keyboard?.inline_keyboard ?? []).flat().map((b) => ("callback_data" in b ? b.callback_data : ""));

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: "deploy-laravel",
  name: "Deploy Laravel",
  description: "Langkah deploy.",
  body: "1. Test\n2. Build",
  status: "pending",
  risk: [],
  proposedBy: "tool",
  proposedAt: 0,
  decidedAt: null,
  decidedBy: null,
  ...over,
});

describe("aao/telegram views", () => {
  it("shows an empty memory with an undo button", () => {
    const view = buildMemoryView(runtime);
    expect(view.text).toBe("📭 Memori masih kosong.");
    expect(callbackDataOf(view)).toEqual(["aao:mem:undo"]);
  });

  it("lists entries with delete buttons, usage and actions", () => {
    runtime.service.memories.write({ text: "Pengguna memakai Laravel 11.", actor: "tool" });
    runtime.service.memories.write({ text: "Server produksi memakai Ubuntu 24.04.", actor: "capture" });
    const view = buildMemoryView(runtime);
    expect(view.text).toContain("🧠 Memori (2 entri, 65/4000 karakter)");
    expect(view.text).toContain("[1] Pengguna memakai Laravel 11.");
    expect(view.text).toContain("[2] Server produksi memakai Ubuntu 24.04.");
    expect(callbackDataOf(view)).toEqual(["aao:mem:del:1", "aao:mem:del:2", "aao:mem:undo", "aao:mem:list"]);
  });

  it("keeps the message within the Telegram limit when memory is large", () => {
    for (let i = 0; i < 40; i++) {
      runtime.service.memories.write({ text: `Proyek nomor ${i} memakai kerangka ${"x".repeat(80)} versi ${i}.`, actor: "tool", force: true });
    }
    const view = buildMemoryView(runtime);
    expect(view.text.length).toBeLessThanOrEqual(4096);
    expect(view.text).toMatch(/…dan \d+ entri lain/);
  });

  it("builds a skill card with translated risk flags, truncation and short callback data", () => {
    const longId = "a".repeat(48);
    const view = buildSkillCard(skill({ id: longId, risk: ["shell", "url"], body: "x".repeat(2000) }), true);
    expect(view.text.startsWith("🔔 Agen mengusulkan skill baru:")).toBe(true);
    expect(view.text).toContain("Penanda risiko: perintah shell, URL");
    expect(view.text).toContain("(dipotong, ketuk 👁 untuk melihat semua)");
    for (const data of callbackDataOf(view)) expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(buildSkillCard(skill(), false).text).toContain("Penanda risiko: tidak ada");
  });

  it("describes undo results", () => {
    expect(describeUndo(runtime)).toBe("Tidak ada perubahan untuk dibatalkan.");
    runtime.service.memories.write({ text: "Pengguna memakai Vim.", actor: "tool" });
    expect(describeUndo(runtime)).toBe("↩️ Dibatalkan: tambah [1] Pengguna memakai Vim.");
    expect(runtime.service.memories.list()).toEqual([]);
  });
});

describe("aao/telegram digest", () => {
  const entry = (over: Partial<AuditEntry>): AuditEntry => ({
    id: 1,
    ts: 0,
    actor: "capture",
    action: "insert",
    memoryId: 1,
    beforeText: null,
    afterText: "Pengguna memakai Vim.",
    undone: false,
    ...over,
  });

  it("groups changes, skips undone entries and returns null when nothing happened", () => {
    const text = buildDigest(
      [
        entry({}),
        entry({ id: 2, memoryId: 2, afterText: "Dibatalkan", undone: true }),
        entry({ id: 3, action: "delete", actor: "telegram", beforeText: "Lama", afterText: "Lama", memoryId: 3 }),
        entry({ id: 4, action: "undo" }),
      ],
      { skipped: 2, failed: 1 },
      1,
    );
    expect(text).toBe(
      [
        "🗓 Ringkasan memori 24 jam terakhir",
        "Ditambahkan (1):\n- [1] Pengguna memakai Vim. (capture)",
        "Dihapus (1):\n- [3] Lama (telegram)",
        "Auto-capture melewati 2 fakta (mirip, duplikat, atau rahasia).",
        "Auto-capture gagal 1 kali; lihat log bot.",
        "1 skill menunggu persetujuan: /skills_pending",
      ].join("\n\n"),
    );
    expect(buildDigest([], { skipped: 0, failed: 0 }, 0)).toBeNull();
  });

  it("sends at most once per day, only after the configured hour", async () => {
    const api = { sendMessage: vi.fn(async () => ({})) } as unknown as Api;
    runtime.service.memories.write({ text: "Pengguna memakai Vim.", actor: "tool" });
    const morning = new Date(2026, 9, 24, 9, 0);
    const evening = new Date(2026, 9, 24, 20, 30);
    expect(await runDigestIfDue(runtime, api, 1, morning)).toBe(false);
    expect(await runDigestIfDue(runtime, api, 1, evening)).toBe(true);
    expect(await runDigestIfDue(runtime, api, 1, new Date(2026, 9, 24, 23, 0))).toBe(false);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(fs.statSync(path.join(dataDir, "digest-state.json")).mode & 0o777).toBe(0o600);
  });
});

function fakeCtx(data: string) {
  const sent: string[] = [];
  const answers: unknown[] = [];
  const ctx = {
    callbackQuery: { data, message: { message_id: 7 } },
    chat: { id: 123 },
    from: { id: 123 },
    api: { sendMessage: vi.fn(async (_chat: number, text: string) => void sent.push(text)) },
    answerCallbackQuery: vi.fn(async (arg?: unknown) => void answers.push(arg)),
    editMessageReplyMarkup: vi.fn(async () => true),
  };
  return { ctx: ctx as unknown as Context, sent, answers, raw: ctx };
}

describe("aao/telegram callbacks", () => {
  it("deletes a memory and re-sends the list", async () => {
    runtime.service.memories.write({ text: "Pengguna memakai Vim.", actor: "tool" });
    const { ctx, sent } = fakeCtx("aao:mem:del:1");
    await handleCallback(ctx, runtime);
    expect(sent[0]).toBe("🗑 Entri [1] dihapus: Pengguna memakai Vim.");
    expect(sent[1]).toBe("📭 Memori masih kosong.");
    expect(runtime.service.memories.history()[0]).toMatchObject({ action: "delete", actor: "telegram" });
  });

  it("approves a pending skill, removes the buttons and records who approved it", async () => {
    runtime.service.skills.propose({ id: "cek-log", name: "Cek log", description: "d", body: "b", actor: "tool" });
    const { ctx, sent, raw } = fakeCtx("aao:sk:ok:cek-log");
    await handleCallback(ctx, runtime);
    expect(runtime.service.skills.getApproved("cek-log")).toMatchObject({ decidedBy: "telegram:123" });
    expect(raw.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [] } });
    expect(sent).toEqual(["✅ Skill cek-log aktif. Sesi baru akan melihatnya."]);
  });

  it("rejects, and refuses decisions on proposals that are gone", async () => {
    runtime.service.skills.propose({ id: "cek-log", name: "Cek log", description: "d", body: "b", actor: "tool" });
    await handleCallback(fakeCtx("aao:sk:no:cek-log").ctx, runtime);
    expect(runtime.service.skills.listApproved()).toEqual([]);

    const again = fakeCtx("aao:sk:ok:cek-log");
    await handleCallback(again.ctx, runtime);
    expect(again.answers[0]).toEqual({ text: "Usulan ini sudah tidak tersedia (sudah diputuskan atau kedaluwarsa).", show_alert: true });
    expect(runtime.service.skills.listApproved()).toEqual([]);
  });

  it("shows the full body of a pending skill in chunks", async () => {
    runtime.service.skills.propose({ id: "panjang", name: "Panjang", description: "d", body: "y".repeat(7000), actor: "tool" });
    const { ctx, sent } = fakeCtx("aao:sk:view:panjang");
    await handleCallback(ctx, runtime);
    expect(sent.length).toBe(2);
    expect(sent.join("")).toContain("y".repeat(7000));
  });
});
