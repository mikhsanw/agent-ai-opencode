# PRD — agent-ai-opencode v2

Status: **v1.3, disetujui** (23 Okt 2026) · Pemilik: Muhammad Ikhsan Wibowo
Menggantikan isi repo lama (V1), yang disimpan utuh di branch `legacy`.

---

## 1. Masalah

Bot Telegram untuk OpenCode di VPS (`opencode-telegram-bot`) sudah bagus sebagai remote control, tetapi:

1. **Tidak ada kontinuitas.** Setiap sesi OpenCode mulai dari nol. OpenCode V2 tidak punya memori lintas sesi; yang ada hanya `AGENTS.md`/`instructions` statis dan riwayat per sesi (diverifikasi: tidak ada endpoint memori di API V2).
2. **Tidak belajar.** Prosedur yang berhasil tidak tersimpan untuk dipakai ulang.
3. **Setup VPS** harus mengikuti OpenCode V2 (plugin API, server API, dan config V1 tidak kompatibel).

Inspirasi fitur: Hermes Agent (memori yang dikurasi agen, skill yang tumbuh dari pemakaian, installer satu perintah, `doctor`) — **tanpa** mengganti OpenCode sebagai agennya.

## 2. Kriteria sukses

| # | Kriteria | Cara uji |
|---|---|---|
| S1 | Fakta yang disimpan di sesi A terpakai di sesi B (Telegram maupun TUI), tanpa diulang | e2e: tulis di sesi A, cek system prompt sesi B |
| S2 | Permintaan eksplisit "ingat/catat" tersimpan ≥ 95% (baseline model saja: ~75%) | ulang `zen-memory-test` dengan auto-capture aktif |
| S3 | Tidak ada entri ganda untuk fakta yang sama (normalisasi + kemiripan) | unit test dengan data uji nyata |
| S4 | Rahasia (token, password, key) tidak pernah tersimpan | unit test pola rahasia |
| S5 | Skill hasil belajar **tidak aktif** sebelum disetujui lewat Telegram, termasuk saat agen disusupi | uji serangan: agen menulis skill via `write`, `shell`, dan REST |
| S6 | `/recall <kata>` menemukan potongan sesi lama < 1 detik untuk ~1.000 sesi | benchmark FTS5 |
| S7 | VPS kosong → bot jalan dengan satu perintah; `doctor` mendeteksi kegagalan umum | uji di VM Ubuntu 24.04 |
| S8 | Total RAM tambahan (bot + memori) ≤ 150 MB di luar OpenCode | ukur RSS |

## 3. Scope

**Masuk**
- Paket memori (`packages/memory`): store SQLite FTS5, dedup, pemindai rahasia, tag `<private>`, batas ukuran, audit + undo, snapshot instruksi, MCP HTTP, store skill hasil belajar, ekstraktor auto-capture.
- Fork bot (`bot/`, dari `grinev/opencode-telegram-bot`): memori berjalan di dalam proses bot; perintah `/memory`, `/forget`, `/recall`, `/skills_pending`; tombol approval skill; digest harian; pemicu auto-capture.
- Installer, hardening, `doctor`, `update` untuk OpenCode V2 (port dari repo lama).

**Keluar**
- Multi-platform (Discord, WhatsApp, dst.), dukungan OpenCode V1, RL/trajectory, impor OpenClaw, multi-user, web UI.
- Embedding/pencarian semantik (RAM VPS 1,9 GiB; lihat keputusan K6).

## 4. Keputusan (dengan bukti)

| # | Keputusan | Bukti / alasan |
|---|---|---|
| K1 | Hanya **OpenCode V2** (diuji di 2.1.2) | Pilihan pemilik; API V1/V2 berbeda |
| K2 | **Memori otomatis**, skill baru **butuh approval** satu tap (opsi A) | Skill yang ditulis agen = prompt injection permanen |
| K3 | Tool memori lewat **MCP**, bukan plugin | Plugin API V2 berubah lagi di 2.1; MCP stdio & HTTP terbukti jalan di V2 |
| K4 | **Code Mode** (default V2) dibiarkan aktif | Uji model Zen `big-pickle`: Code Mode 5/6, tool langsung 4/6 (sampel kecil, tidak beda bermakna; pilih default) |
| K5 | Skill hasil belajar **disajikan lewat MCP**, bukan discovery skill native; aksi `skill` native di-*deny* kecuali allowlist manual | Spike: agen bisa menanam skill native via `shell`; skill proyek bisa membayangi skill yang disetujui; `skill.transform` plugin tidak melihat skill direktori. Konsekuensi: skill hasil belajar tidak muncul sebagai slash command TUI |
| K6 | **Bangun sendiri versi ringan** (bukan opencode-mem) | opencode-mem (V2-compatible) butuh 0,5–2 GB RAM untuk embedding lokal; VPS 1,9 GiB dengan swap terpakai. Plugin in-process juga bisa dimanipulasi agen |
| K7 | Memori berjalan **di dalam proses bot** (user OS `aao-bot`), diekspos ke OpenCode via MCP HTTP di `127.0.0.1` | Hemat ~80 MB vs proses terpisah; store tidak bisa ditulis user agen |
| K8 | Store: **SQLite FTS5 tokenizer trigram** via `better-sqlite3` (sudah dependensi bot upstream) | Diuji: trigram cocok untuk teks Indonesia ("ubuntu 24", "bahasa indo"); tanpa dependensi tambahan |
| K9 | **Auto-capture** via `POST /api/session/{id}/generate` setelah event `session.execution.succeeded` | Diuji: model melihat konteks sesi penuh, riwayat sesi tidak berubah, dan tool call di dalam `generate` **tidak dieksekusi** (kontrol: prompt biasa mengeksekusi) |
| K10 | Injeksi memori via file di `instructions[]` | Diuji: masuk system prompt; perubahan terkirim ke sesi aktif sebagai `<system-update>` tanpa reload. Karena itu ukuran harus dibatasi ketat |
| K11 | Bahasa kanonik entri memori: **Bahasa Indonesia** | Pilihan pemilik; konsistensi untuk FTS5 |
| K12 | Riwayat & undo memori lewat **tabel audit SQLite**, bukan git | Fungsi sama (riwayat + undo), tanpa proses `git` per tulis |
| K13 | Repo: kerja di branch `v2-rewrite`, masuk `main` lewat PR; **tanpa force-push dan tanpa tag `v*`** sampai installer v2 siap | Installer lama mengikuti `main`/tag `v*` saat `otb update` |
| K14 | Provider model: **OpenCode Zen** | Pilihan pemilik |

## 5. Arsitektur

```
Telegram ──► aao-bot (fork grinev, user OS aao-bot)
               ├─ handler Telegram (+ /memory /forget /recall /skills_pending, tombol approval)
               ├─ packages/memory (in-process)
               │    ├─ SQLite: memories + FTS5 trigram + audit + skills     (0600, milik aao-bot)
               │    ├─ MCP HTTP 127.0.0.1 (bearer token) ── tool aman-untuk-agen saja
               │    └─ snapshot MEMORY.md (read-only untuk agen) ──┐
               └─ auto-capture: event SSE → /session/{id}/generate │
                    │ V2 API (password)                            │ instructions[]
                    ▼                                              ▼
             OpenCode V2 service (user OS aao-agent, systemd sandbox)
```

**Aturan batas keamanan**
- Permukaan MCP hanya berisi operasi yang aman bila dipanggil agen (atau penyerang yang menguasai agen): baca, cari, tulis/ganti/hapus memori (melalui dedup + pemindai rahasia), dan *mengusulkan* skill.
- **Approve/reject skill hanya lewat API in-process** yang dipanggil handler Telegram. Tidak ada endpoint HTTP untuk itu.
- Snapshot ditulis dengan header yang menegaskan isinya adalah data tentang pengguna, bukan instruksi.

## 6. Komponen fase 1 — `packages/memory`

| Modul | Fungsi |
|---|---|
| `store` | CRUD memori, FTS5 trigram, scope `global`/proyek, soft delete |
| `dedup` | Normalisasi (huruf kecil, spasi, tanda baca) → duplikat persis ditolak diam-diam; kemiripan trigram ≥ ambang → dikembalikan sebagai kandidat, agen memilih `memory_replace` atau `force` |
| `secrets` | Pola token umum (GitHub, OpenAI/Anthropic, Telegram bot, Google, AWS, Slack, JWT, private key, `password=`/`kata sandi:`), entropi tinggi; tulis ditolak utuh |
| `privacy` | `<private>…</private>` → `[REDACTED]` (gagal tertutup untuk tag tak tertutup) |
| `budget` | Batas per entri (300 karakter) dan total snapshot (4.000 karakter) |
| `audit` | Setiap perubahan dicatat (sebelum/sesudah, aktor: `tool`/`capture`/`telegram`); `undo` |
| `snapshot` | Render `MEMORY.md` secara atomik (tmp + rename) |
| `skills` | `propose` → pending (dengan penanda risiko: shell, URL, path di luar proyek); `approve`/`reject` in-process; indeks skill disetujui ikut di snapshot |
| `capture` | Prompt ekstraksi (Indonesia) → panggil `generate` → parse JSON tahan banting → tulis dengan sumber `capture` (dedup konservatif) |
| `mcp` | Handler Streamable HTTP (stateless) + bearer token: `memory_read`, `memory_search`, `memory_write`, `memory_replace`, `memory_delete`, `skill_list`, `skill_get`, `skill_propose` |

## 7. Fase

1. **Paket memori** + unit test + e2e terhadap OpenCode V2 dengan mock model. ← *sekarang*
2. **Integrasi bot**: fork grinev sebagai subtree, pasang paket memori, perintah Telegram, approval skill, pemicu auto-capture, digest harian, tunggu MCP `connected` sebelum meneruskan prompt.
3. **Recall sesi**: indexer FTS5 atas riwayat sesi (V2 Sessions API, cursor) + `/recall`.
4. **Installer & hardening**: port dari `legacy` ke V2, `doctor`, `update`, `verify.sh` versi V2.
5. **Uji lapangan** di VPS: ulang `zen-memory-test` (S2), uji serangan (S5), ukur RAM (S8). Setelah lulus → PR keluar dari draft → merge → tag `v2.0.0`.

## 8. Yang dibawa dari repo lama (`legacy`)

- Model **dua user OS** dan unit systemd berlapis (`ProtectSystem=strict`, `InaccessiblePaths`, `NoNewPrivileges`, `MemoryMax`, dst.) → diport, ganti `otb-*` menjadi `aao-*`.
- Pola `verify.sh` (uji serangan nyata) → diport ke V2.
- Wizard 3 pertanyaan, verifikasi SHA256 Node.js, mode non-interaktif.
- Preset izin → dikonversi ke format V2 (`permission` → `permissions[]`, `bash` → `shell`).
- Temuan V1: plugin di `.opencode/plugins/` repo dieksekusi otomatis tanpa izin. **Harus diuji ulang di V2** (V2 juga auto-discover `.opencode/plugins/`; perlu cek apakah `OPENCODE_DISABLE_PROJECT_CONFIG` masih ada). Jika bisa dimatikan, ini juga menutup serangan shadowing skill proyek (K5).

Belum diputuskan untuk dibawa: auto-share proyek, snapshot file/backup database, mode Docker.

## 9. Risiko

| Risiko | Mitigasi |
|---|---|
| Memori diracuni prompt injection (memori otomatis) | Header snapshot "data, bukan instruksi"; digest harian; `/forget`; undo |
| Skill native ditanam/dibayangi agen | K5 + allowlist aksi `skill`; uji ulang `OPENCODE_DISABLE_PROJECT_CONFIG` di V2 |
| MCP belum tersambung saat prompt pertama setelah restart (teramati: "Unknown tool") | Bot menunggu status MCP `connected` |
| Biaya token: perubahan memori disalin ke setiap sesi aktif | Batas 4.000 karakter + konsolidasi |
| `generate` mengembalikan teks kosong bila model memaksa tool call | Anggap "tidak ada fakta"; dicatat di log |
| RAM VPS tipis (swap sudah terpakai) | Ukur proses yang berjalan; `MemoryMax` untuk OpenCode |
| Upstream bot terus berubah | Patch tipis di titik integrasi; subtree dengan remote `upstream` |

## 10. Pertanyaan terbuka

1. Apa yang dirasa kurang cocok dari repo lama? (supaya tidak terulang di v2)
2. Proses apa yang sedang memakai RAM di VPS (`ps -eo rss,comm --sort=-rss | head`)?
3. Bawa atau tidak: auto-share proyek, snapshot/backup database, mode Docker.
