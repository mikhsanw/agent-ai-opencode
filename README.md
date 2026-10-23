# agent-ai-opencode

Agen coding [OpenCode V2](https://opencode.ai) yang dikendalikan lewat Telegram dan berjalan di VPS, dengan **memori jangka panjang** dan **skill hasil belajar** (terinspirasi Hermes Agent). OpenCode tetap menjadi agennya; repo ini menambahkan memori, approval skill lewat Telegram, dan pemasangan yang aman.

> 🚧 **Sedang dibangun ulang (v2).** Belum ada installer. Setup lama (OpenCode V1) tersimpan di branch [`legacy`](../../tree/legacy) dan **tidak lagi dirawat**. Jika VPS Anda masih menjalankan setup lama, **jangan jalankan `otb update`**: perintah itu mengambil isi `main`, yang sekarang berisi v2 tanpa installer.

## Status

| Fase | Isi | Status |
|---|---|---|
| 1 | Paket memori + skill hasil belajar ([`packages/memory`](packages/memory)) | ✅ selesai, teruji |
| 2 | Integrasi bot Telegram (fork `grinev/opencode-telegram-bot`) | ⏳ |
| 3 | Recall sesi lama (`/recall`) | ⏳ |
| 4 | Installer satu perintah, sandbox, `doctor` | ⏳ |
| 5 | Uji lapangan di VPS | ⏳ |

Rencana lengkap, keputusan, dan buktinya: [`docs/PRD.md`](docs/PRD.md).

## Struktur

```
docs/PRD.md          rencana & keputusan desain
packages/memory/     memori jangka panjang, skill hasil belajar, MCP HTTP, auto-capture
```
