import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import { MemoryStore } from "../src/memories.js";

let store: MemoryStore;
let changes: number;
let clock: number;

beforeEach(() => {
  changes = 0;
  clock = 1_000;
  store = new MemoryStore(openDb(":memory:"), {}, () => clock++, () => changes++);
});

describe("MemoryStore.write", () => {
  it("menyimpan dan mencatat audit", () => {
    const r = store.write({ text: "Pengguna memakai Laravel 11.", actor: "tool" });
    expect(r).toMatchObject({ status: "saved", memory: { id: 1, text: "Pengguna memakai Laravel 11.", source: "tool" } });
    expect(store.history()[0]).toMatchObject({ action: "insert", memoryId: 1, afterText: "Pengguna memakai Laravel 11." });
    expect(changes).toBe(1);
  });

  it("menolak duplikat persis (beda huruf besar/tanda baca) tanpa menulis", () => {
    store.write({ text: "Server produksi pengguna memakai Ubuntu 24.04.", actor: "tool" });
    const r = store.write({ text: "server produksi pengguna memakai ubuntu 24.04", actor: "capture" });
    expect(r).toMatchObject({ status: "duplicate", existing: { id: 1 } });
    expect(store.list()).toHaveLength(1);
  });

  it("parafrase dikembalikan sebagai kandidat; force menyimpan", () => {
    store.write({ text: "Server produksi pengguna memakai Ubuntu 24.04.", actor: "tool" });
    const r = store.write({ text: "Server produksi pengguna menjalankan Ubuntu 24.04.", actor: "tool" });
    expect(r.status).toBe("similar");
    if (r.status === "similar") expect(r.candidates[0]).toMatchObject({ memory: { id: 1 }, numbersDiffer: false });
    expect(store.write({ text: "Server produksi pengguna menjalankan Ubuntu 24.04.", actor: "tool", force: true }).status).toBe(
      "saved",
    );
  });

  it("menandai kemungkinan pembaruan saat angka berbeda", () => {
    store.write({ text: "Pengguna memakai Laravel 10.", actor: "tool" });
    const r = store.write({ text: "Pengguna memakai Laravel 11.", actor: "tool" });
    expect(r).toMatchObject({ status: "similar", candidates: [{ numbersDiffer: true }] });
  });

  it("data uji VPS (entri berbahasa Indonesia): 7 tulisan untuk 3 fakta menjadi 3 entri", () => {
    const writes = [
      "Lebih suka jawaban dalam Bahasa Indonesia yang ringkas.",
      "Server produksi pengguna memakai Ubuntu 24.04.",
      "Server produksi pengguna memakai Ubuntu 24.04.",
      "Lebih suka jawaban dalam Bahasa Indonesia yang ringkas.",
      "Server produksi pengguna menjalankan Ubuntu 24.04.",
      "Lebih suka jawaban dalam Bahasa Indonesia yang ringkas.",
      "Stack utama pengguna Laravel 11 dan Flutter.",
    ];
    for (const text of writes) store.write({ text, actor: "capture" });
    expect(store.list().map((m) => m.text)).toEqual([
      "Lebih suka jawaban dalam Bahasa Indonesia yang ringkas.",
      "Server produksi pengguna memakai Ubuntu 24.04.",
      "Stack utama pengguna Laravel 11 dan Flutter.",
    ]);
  });

  it("menolak rahasia, teks terlalu panjang, dan saat anggaran penuh", () => {
    expect(store.write({ text: "kata sandi adalah kucing123", actor: "tool" })).toMatchObject({ reason: "secret" });
    expect(store.write({ text: "a".repeat(301), actor: "tool" })).toMatchObject({ reason: "too_long" });

    const small = new MemoryStore(openDb(":memory:"), { maxTotalChars: 60 });
    expect(small.write({ text: "Pengguna memakai Laravel 11 untuk Dry24.", actor: "tool" }).status).toBe("saved");
    expect(small.write({ text: "Pengguna mengajar di Polbeng sejak lama.", actor: "tool" })).toMatchObject({
      status: "rejected",
      reason: "budget",
    });
    expect(changes).toBe(0);
  });

  it("menyimpan versi tersanitasi (private disamarkan, satu baris)", () => {
    const r = store.write({ text: "## Pengguna kerja di\n<private>kantor X</private> Bengkalis", actor: "tool" });
    expect(r).toMatchObject({ status: "saved", memory: { text: "Pengguna kerja di [REDACTED] Bengkalis" } });
  });
});

describe("replace, remove, undo, search", () => {
  it("replace memperbarui, menolak bila jadi duplikat entri lain, dan not_found", () => {
    store.write({ text: "Pengguna memakai Laravel 10.", actor: "tool" });
    store.write({ text: "Pengguna memakai Flutter 3.", actor: "tool" });
    expect(store.replace(1, "Pengguna memakai Laravel 11.", "tool")).toMatchObject({ status: "saved", memory: { id: 1 } });
    expect(store.replace(1, "pengguna memakai flutter 3", "tool")).toMatchObject({ status: "duplicate", existing: { id: 2 } });
    expect(store.replace(99, "x", "tool")).toMatchObject({ status: "not_found", id: 99 });
    expect(store.get(1)?.text).toBe("Pengguna memakai Laravel 11.");
  });

  it("undo bertingkat mengembalikan delete, update, lalu insert", () => {
    store.write({ text: "Pengguna memakai Laravel 10.", actor: "tool" });
    store.replace(1, "Pengguna memakai Laravel 11.", "tool");
    store.remove(1, "tool");
    expect(store.list()).toHaveLength(0);

    expect(store.undo()).toMatchObject({ status: "undone", entry: { action: "delete" } });
    expect(store.get(1)?.text).toBe("Pengguna memakai Laravel 11.");
    expect(store.undo()).toMatchObject({ status: "undone", entry: { action: "update" } });
    expect(store.get(1)?.text).toBe("Pengguna memakai Laravel 10.");
    expect(store.undo()).toMatchObject({ status: "undone", entry: { action: "insert" } });
    expect(store.list()).toHaveLength(0);
    expect(store.undo()).toEqual({ status: "nothing" });
  });

  it("pencarian FTS5 trigram menemukan potongan kata dan mengabaikan entri terhapus", () => {
    store.write({ text: "Server produksi pengguna memakai Ubuntu 24.04.", actor: "tool" });
    store.write({ text: "Stack utama pengguna Laravel 11 dan Flutter.", actor: "tool" });
    store.write({ text: "Pengguna lebih suka jawaban ringkas.", actor: "tool" });
    expect(store.search("ubuntu").map((m) => m.id)).toEqual([1]);
    expect(store.search("larav flutt").map((m) => m.id)).toEqual([2]);
    store.remove(1, "tool");
    expect(store.search("ubuntu")).toEqual([]);
    expect(store.search('"; DROP TABLE memories; --')).toEqual([]);
  });
});
