# @aao/memory

Memori jangka panjang dan skill hasil belajar untuk agent-ai-opencode (OpenCode V2). Paket ini berjalan **di dalam proses bot** (user OS `aao-bot`) dan diekspos ke OpenCode lewat MCP HTTP di `127.0.0.1`. Latar belakang dan keputusan desain: [`docs/PRD.md`](../../docs/PRD.md).

## Isi

| Modul | Fungsi |
|---|---|
| `MemoryStore` | Simpan, ganti, hapus, cari (SQLite FTS5 trigram), audit + undo bertingkat |
| dedup | Duplikat persis ditolak diam-diam; kemiripan trigram ≥ 0,6 dikembalikan sebagai kandidat (agen memilih `memory_replace` atau `force`). Angka/versi berbeda ditandai "kemungkinan pembaruan" |
| `findSecrets` | Token GitHub/OpenAI/Anthropic/Google/AWS/Slack/Telegram, JWT, private key, kredensial di URL, `password=`/`kata sandi adalah`, hex panjang, string berentropi tinggi. Tulis ditolak utuh |
| `stripPrivate` | `<private>…</private>` → `[REDACTED]`, gagal tertutup |
| batas | 300 karakter per entri, 4.000 karakter total (snapshot disalin ke setiap sesi) |
| `SkillStore` | Agen hanya bisa **mengusulkan**; `approve`/`reject`/`revoke` hanya in-process (handler Telegram). Usulan kedaluwarsa 14 hari. Penanda risiko: `shell`, `url`, `sensitive_path`, `override`, `encoded` |
| snapshot | `MEMORY.md` ditulis atomik setelah setiap perubahan; didaftarkan di `instructions[]` OpenCode |
| auto-capture | `captureFromSession` memanggil `POST /api/session/{id}/generate` lalu menyimpan fakta secara konservatif (yang mirip dilewati, alasannya dikembalikan) |
| MCP | `memory_read`, `memory_search`, `memory_write`, `memory_replace`, `memory_delete`, `skill_list`, `skill_get`, `skill_propose`. Bearer token, body maks 64 KB, hanya POST |

## Pemakaian (di proses bot)

```ts
import { openMemoryService, createMcpHttpHandler, captureFromSession, createOpencodeGenerateClient } from "@aao/memory";

const memory = openMemoryService({
  dbPath: "/var/lib/aao-bot/memory.db",           // 0600, milik aao-bot
  snapshotPath: "/var/lib/aao-bot/export/MEMORY.md", // 0640, grup agen boleh baca
});

// Pasang di server HTTP lokal milik bot (127.0.0.1)
const handler = createMcpHttpHandler(memory, {
  token: process.env.AAO_MEMORY_TOKEN!,
  onRequest: (methods) => { if (methods.includes("tools/list")) markCatalogLoaded(); },
});

// Setelah event session.execution.succeeded
const client = createOpencodeGenerateClient({ baseUrl: "http://127.0.0.1:49374", password, directory });
const result = await captureFromSession({ client, sessionId, store: memory.memories });

// Handler Telegram
memory.skills.listPending();
memory.skills.approve(id, `telegram:${userId}`);
memory.memories.undo("telegram");
```

### Kesiapan sebelum prompt pertama (penting)

Status MCP `connected` di OpenCode V2.1.2 **bukan** tanda tool kita sudah ada di katalog Code Mode. Prosedur yang terbukti (lihat PRD K15):

1. Picu lokasi: `GET /api/mcp?directory=<proyek>`.
2. Tunggu `onRequest` melaporkan `tools/list`.
3. Beri margin 1 detik, baru teruskan prompt.

Config OpenCode yang dipakai e2e (ringkas):

```json
{
  "instructions": ["/var/lib/aao-bot/export/MEMORY.md"],
  "permissions": [{ "action": "skill", "resource": "*", "effect": "deny" }],
  "mcp": { "servers": { "memory": { "type": "remote", "url": "http://127.0.0.1:18090/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
}
```

## Runner mandiri

```bash
AAO_MEMORY_TOKEN=<min 16 karakter> node dist/cli.js serve --db ./memory.db --snapshot ./MEMORY.md --port 18090
```

Token tidak pernah diterima lewat argumen (supaya tidak terlihat di `ps`). Jalankan Node dengan `--max-old-space-size=48 --max-semi-space-size=2`: tanpa batas, RSS naik ke ~169 MB karena GC malas; dengan batas, tertahan ~95 MB pada 3.600 request.

## Pengembangan

```bash
npx -y npm@11 install   # npm 10.9 (bawaan Node 22) crash pada optional peer dependency vitest
npm test                # 88 unit test
npm run typecheck
npm run e2e             # butuh `opencode` V2 di PATH; OpenCode sungguhan + model tiruan, terisolasi via XDG_*
```

E2E memeriksa: tool lewat Code Mode, injeksi ke sesi baru dan `<system-update>` di sesi berjalan, penolakan rahasia, auto-capture lewat `generate` (riwayat sesi tidak berubah, tidak menggandakan), dan skill yang tidak aktif sebelum di-approve.
