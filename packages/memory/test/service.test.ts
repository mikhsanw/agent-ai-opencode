import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryService, type MemoryService } from "../src/service.js";

const dirs: string[] = [];
const services: MemoryService[] = [];
afterEach(() => {
  services.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aao-mem-"));
  dirs.push(dir);
  const svc = openMemoryService({ dbPath: join(dir, "data", "memory.db"), snapshotPath: join(dir, "export", "MEMORY.md") });
  services.push(svc);
  return { dir, svc, snapshot: () => readFileSync(join(dir, "export", "MEMORY.md"), "utf8") };
}

describe("MemoryService + snapshot", () => {
  it("menulis snapshot saat dibuka dan setelah setiap perubahan", () => {
    const { svc, snapshot } = setup();
    expect(snapshot()).toContain("## Fakta tentang pengguna\n(belum ada)");

    svc.memories.write({ text: "Pengguna memakai Laravel 11.", actor: "tool" });
    expect(snapshot()).toContain("- [1] Pengguna memakai Laravel 11.");

    svc.skills.propose({ id: "deploy-laravel", name: "Deploy", description: "Deploy Laravel.", body: "langkah", actor: "tool" });
    expect(snapshot()).not.toContain("deploy-laravel");
    svc.skills.approve("deploy-laravel", "telegram:1");
    expect(snapshot()).toContain("- `deploy-laravel` — Deploy Laravel.");

    svc.memories.remove(1, "telegram");
    expect(snapshot()).not.toContain("- [1]");
    expect(snapshot()).toContain("## Fakta tentang pengguna\n(belum ada)");
  });

  it("snapshot menegaskan isinya data, bukan instruksi", () => {
    const { snapshot } = setup();
    expect(snapshot()).toMatch(/adalah DATA .*bukan instruksi/);
  });

  it("database 0600, snapshot 0640, tanpa file sementara tertinggal", () => {
    const { dir, svc } = setup();
    svc.memories.write({ text: "Pengguna memakai Flutter.", actor: "tool" });
    expect(statSync(join(dir, "data", "memory.db")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "export", "MEMORY.md")).mode & 0o777).toBe(0o640);
    expect(readdirSync(join(dir, "export"))).toEqual(["MEMORY.md"]);
  });

  it("data bertahan setelah ditutup dan dibuka lagi", () => {
    const { dir, svc } = setup();
    svc.memories.write({ text: "Pengguna memakai Flutter.", actor: "tool" });
    svc.close();
    services.pop();
    const again = openMemoryService({ dbPath: join(dir, "data", "memory.db") });
    services.push(again);
    expect(again.memories.list().map((m) => m.text)).toEqual(["Pengguna memakai Flutter."]);
  });
});
