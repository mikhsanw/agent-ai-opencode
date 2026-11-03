# agent-ai-opencode

Agen coding [OpenCode V2](https://opencode.ai) yang dikendalikan lewat Telegram dan berjalan di VPS, dengan **memori jangka panjang** dan **skill hasil belajar** (terinspirasi Hermes Agent). OpenCode tetap menjadi agennya; repo ini menambahkan memori, approval skill lewat Telegram, dan (segera) pemasangan yang aman.

> 🚧 **Sedang dibangun ulang (v2). Installer satu perintah belum ada (fase 4).** Setup lama (OpenCode V1) tersimpan di branch [`legacy`](../../tree/legacy) dan **tidak lagi dirawat**. Jika VPS Anda masih menjalankan setup lama, **jangan jalankan `otb update`**.

## Status

| Fase | Isi | Status |
|---|---|---|
| 1 | Paket memori + skill hasil belajar ([`packages/memory`](packages/memory)) | ✅ |
| 2 | Integrasi bot Telegram ([`bot/`](bot), fork `grinev/opencode-telegram-bot` v0.26.5) | ✅ |
| 4 | Installer satu perintah, sandbox dua user OS, `doctor` | ⏳ berikutnya |
| 3 | Recall sesi lama (`/recall`) | ⏳ |
| 5 | Uji lapangan di VPS | ⏳ |

Rencana, keputusan, dan buktinya: [`docs/PRD.md`](docs/PRD.md).

## Yang sudah bisa dilakukan bot

| Di Telegram | Fungsi |
|---|---|
| obrolan biasa | Agen menyimpan fakta tentang Anda dengan `memory_write`; setelah setiap run, **auto-capture** mengekstrak fakta yang terlewat |
| `/memory` | Daftar memori, hapus per entri (🗑), batalkan perubahan terakhir |
| `/undo` | Batalkan perubahan memori terakhir |
| `/skills_pending` | Skill yang diusulkan agen: 👁 lihat penuh, ✅ aktifkan, ❌ tolak (beserta penanda risiko) |
| notifikasi | Muncul saat agen mengusulkan skill baru (tombolnya tetap bisa dipakai saat agen sibuk) |
| digest harian | Ringkasan perubahan memori 24 jam terakhir (default jam 20.00 waktu server) |

Semua perintah bawaan bot upstream tetap ada (lihat [`bot/README.md`](bot/README.md)).

## Menjalankan secara manual (sebelum installer ada)

Untuk mencoba di mesin pengembangan. **Belum disarankan untuk VPS produksi**: sandbox dan pemisahan user OS baru datang di fase 4.

```bash
git clone https://github.com/mikhsanw/agent-ai-opencode && cd agent-ai-opencode
npm ci --ignore-scripts          # npm 10 atau 11; --ignore-scripts: binary better-sqlite3 sudah prebuilt
npm run build
```

1. Jalankan OpenCode V2 dengan password tetap:
   ```bash
   OPENCODE_SERVER_PASSWORD=<password-panjang> opencode serve --hostname 127.0.0.1 --port 49374
   ```
2. Jalankan bot (config bot upstream + variabel `AAO_*` di bawah):
   ```bash
   TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USER_ID=... \
   OPENCODE_SERVER_VERSION=v2 OPENCODE_API_URL=http://127.0.0.1:49374 OPENCODE_SERVER_PASSWORD=<password-panjang> \
   OPENCODE_MODEL_PROVIDER=opencode OPENCODE_MODEL_ID=big-pickle BOT_LOCALE=id \
   node --max-old-space-size=128 --max-semi-space-size=2 bot/dist/index.js
   ```
3. Saat start, bot menulis `<home bot>/aao/opencode-memory.json` (lokasinya tercetak di log). Gabungkan isinya (`instructions`, `permissions`, `mcp`) ke config OpenCode Anda, lalu restart OpenCode sekali.

| Variabel | Default | Fungsi |
|---|---|---|
| `AAO_MEMORY_ENABLED` | `true` | Matikan seluruh fitur memori |
| `AAO_DATA_DIR` | `<home bot>/aao` | Database memori, token MCP, snippet config |
| `AAO_SNAPSHOT_PATH` | `<data>/export/MEMORY.md` | File yang didaftarkan di `instructions` OpenCode |
| `AAO_MCP_PORT` | `18090` | Port MCP memori (selalu `127.0.0.1`) |
| `AAO_MCP_TOKEN` | dibuat otomatis | Token bearer MCP (min. 16 karakter) |
| `AAO_CAPTURE_ENABLED` | `true` | Auto-capture setelah setiap run |
| `AAO_CAPTURE_DAILY_LIMIT` | `30` | Batas auto-capture per hari (biaya token) |
| `AAO_DIGEST_HOUR` | `20` | Jam digest harian; `-1` mematikan |

## Struktur

```
docs/PRD.md              rencana & keputusan desain (dengan bukti)
packages/memory/         memori, dedup, pemindai rahasia, skill, MCP HTTP, auto-capture
bot/                     opencode-telegram-bot (subtree upstream) + bot/src/aao (integrasi)
scripts/e2e-bot.mjs      e2e: bot + OpenCode V2 + model tiruan + Telegram tiruan
scripts/fake-telegram.mjs  server Bot API tiruan untuk e2e
```

## Pengembangan

```bash
npm ci --ignore-scripts && npm run build
npm test            # unit test paket memori + seluruh suite bot
npm run e2e         # butuh `opencode` V2 di PATH; semuanya lokal, terisolasi
```

Memperbarui bot dari upstream:

```bash
git subtree pull --prefix=bot https://github.com/grinev/opencode-telegram-bot <tag> --squash
```

Patch ke kode upstream sengaja kecil (6 file, +30/−8 baris); semua logika tambahan ada di `bot/src/aao/`.
