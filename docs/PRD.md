# PRD — agent-ai-opencode v2

Status: **v1.4, disetujui** (23 Okt 2026) · Pemilik: Muhammad Ikhsan Wibowo
Menggantikan seluruh isi repo lama (V1). Kode V1 disimpan di branch `legacy` dan **tidak dipakai ulang** (keputusan pemilik: tidak ada bagian yang cocok).

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
- Installer, sandbox, `doctor`, `update` untuk OpenCode V2 (ditulis baru).

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
| K15 | Kesiapan MCP sebelum prompt pertama per lokasi: **picu lokasi (`GET /api/mcp?directory=…`) → tunggu request `tools/list` di server MCP kita → margin 1 detik** | Diukur di 2.1.2: status `connected` muncul sebelum katalog Code Mode berisi tool kita (prompt pertama mendapat "Unknown tool"); lokasi dimuat malas dan `tools/list` baru datang setelah dipicu; setelah `tools/list` katalog butuh ≤ 250 ms (0 ms: gagal 3/3, 250 ms: lulus 3/3). E2E dengan prosedur ini: 10/10 lulus |
| K16 | Proses Node dijalankan dengan batas heap (`--max-old-space-size`, `--max-semi-space-size=2`) | Server memori mandiri: 85 MB idle → 169 MB setelah 1.600 request tanpa batas (GC malas); dengan heap 48 MB tertahan 93–96 MB selama 3.600 request, tanpa crash (bukan kebocoran) |

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

1. **Paket memori** + unit test + e2e terhadap OpenCode V2 dengan mock model. ✅ (88 unit test; e2e 15 pemeriksaan, 10/10 run lulus; lihat `packages/memory/README.md`)
2. **Integrasi bot**: fork grinev sebagai subtree, pasang paket memori, perintah Telegram, approval skill, pemicu auto-capture, digest harian, prosedur kesiapan K15 sebelum meneruskan prompt pertama per lokasi. Ukur RSS bot + memori (S8).
3. **Recall sesi**: indexer FTS5 atas riwayat sesi (V2 Sessions API, cursor) + `/recall`.
4. **Installer & sandbox**: ditulis baru untuk V2 (bukan port dari `legacy`): installer satu perintah, dua user OS dengan sandbox systemd, batas memori, `doctor`, `update`, uji serangan.
5. **Uji lapangan** di VPS: ulang `zen-memory-test` (S2), uji serangan (S5), ukur RAM (S8). Setelah lulus → PR keluar dari draft → merge → tag `v2.0.0`.

## 8. Repo lama dan kondisi VPS

**Repo lama (`legacy`)**: tidak ada yang dibawa (keputusan pemilik, 23 Okt). Tidak di-port: preset izin, auto-share proyek, snapshot file/backup database, mode Docker, perintah `otb`. Satu temuan V1 tetap dicatat sebagai hal yang **wajib diuji ulang** di V2 karena menyangkut keamanan: plugin di `.opencode/plugins/` repo yang di-clone dieksekusi otomatis tanpa izin. V2 juga auto-discover direktori itu; perlu dicek apakah bisa dimatikan (dulu `OPENCODE_DISABLE_PROJECT_CONFIG`). Jika bisa, ini sekaligus menutup serangan shadowing skill proyek (K5).

**VPS bersama** (`ps`, 23 Okt): VPS ini juga menjalankan **freqtrade** (bot trading, ~534 MB, terbesar), OpenCode lama (~198 MB), PM2 (~48 MB), dan agen monitoring penyedia. RAM total 1,9 GiB, swap 1,3 GiB sudah terpakai.

Konsekuensi yang menjadi syarat v2 (ditulis baru, bukan warisan V1):
- **Agen tidak boleh bisa membaca konfigurasi/kunci API freqtrade atau mengganggu prosesnya.** Agen punya shell; tanpa sandbox, prompt injection dari satu README bisa mencuri kunci exchange. Karena itu dua user OS + sandbox systemd (`InaccessiblePaths` untuk direktori freqtrade, `ProtectHome`, `NoNewPrivileges`) tetap wajib.
- **OpenCode tidak boleh memicu OOM yang membunuh freqtrade.** OOM killer kernel memilih proses dengan RSS terbesar, yaitu freqtrade. Mitigasi: `MemoryMax` untuk service agen (OOM terjadi di dalam cgroup agen), `OOMScoreAdjust` positif untuk agen, batas heap Node (K16).
- Anggaran RAM v2: OpenCode V2 ~150–330 MB (terukur) + bot dan memori (target ≤ 150 MB, S8). OpenCode V1 dimatikan saat v2 terpasang.

## 9. Risiko

| Risiko | Mitigasi |
|---|---|
| Memori diracuni prompt injection (memori otomatis) | Header snapshot "data, bukan instruksi"; digest harian; `/forget`; undo |
| Skill native ditanam/dibayangi agen | K5 + allowlist aksi `skill`; uji ulang penonaktifan config/plugin proyek di V2 |
| Tool memori belum ada di katalog saat prompt pertama setelah restart (teramati: "Unknown tool") | Prosedur kesiapan K15; auto-capture sebagai jaring pengaman; pesan error OpenCode sendiri menyuruh model mencari tool lalu mencoba lagi |
| Perubahan memori terlambat sampai ke sesi baru | Diukur: OpenCode mendeteksi perubahan file instruksi dalam ~50–100 ms; sesi yang dibuat dalam jendela itu mendapat isi lama. Dampak praktis nihil (jeda antar pesan Telegram = detik); sesi yang sedang berjalan menerima pembaruan lewat `<system-update>` |
| Biaya token: perubahan memori disalin ke setiap sesi aktif | Batas 4.000 karakter + konsolidasi |
| `generate` mengembalikan teks kosong bila model memaksa tool call | Anggap "tidak ada fakta"; dicatat di log |
| RAM VPS tipis dan dipakai bersama freqtrade (bot trading) | `MemoryMax` + `OOMScoreAdjust` untuk agen, batas heap Node, matikan OpenCode V1; opsi terbaik tetap VPS terpisah untuk agen |
| Agen yang disusupi membaca kunci exchange freqtrade | Dua user OS + `InaccessiblePaths`/`ProtectHome`; diuji di fase 4 |
| Upstream bot terus berubah | Patch tipis di titik integrasi; subtree dengan remote `upstream` |

## 10. Pertanyaan terbuka

1. Agen tetap di VPS yang sama dengan freqtrade, atau VPS terpisah? (lihat §8)
2. Lokasi instalasi freqtrade (path dan user), untuk diblokir dari sandbox agen.
