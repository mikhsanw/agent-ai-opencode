# agent-ai-opencode

Agen coding [OpenCode V2](https://opencode.ai) yang dikendalikan lewat Telegram dan berjalan di VPS, dengan **memori jangka panjang** dan **skill hasil belajar** (terinspirasi Hermes Agent). OpenCode tetap menjadi agennya; repo ini menambahkan memori, approval skill lewat Telegram, dan sandbox dua user OS.

> Setup lama (OpenCode V1) tersimpan di branch [`legacy`](../../tree/legacy) dan **tidak lagi dirawat**.

## Status

| Fase | Isi | Status |
|---|---|---|
| 1 | Paket memori + skill hasil belajar ([`packages/memory`](packages/memory)) | ✅ |
| 2 | Integrasi bot Telegram ([`bot/`](bot), fork `grinev/opencode-telegram-bot` v0.26.5) | ✅ |
| 4 | Installer satu perintah, `doctor`, update otomatis teruji | ⏳ berikutnya (sementara: [instalasi manual](#instalasi-di-vps) di bawah) |
| 3 | Recall sesi lama (`/recall`) | ⏳ |
| 5 | Uji lapangan di VPS | ⏳ |

Rencana, keputusan, dan buktinya: [`docs/PRD.md`](docs/PRD.md).

## Yang bisa dilakukan bot

| Di Telegram | Fungsi |
|---|---|
| obrolan biasa | Agen menyimpan fakta tentang Anda dengan `memory_write`; setelah setiap run, **auto-capture** mengekstrak fakta yang terlewat |
| `/memory` | Daftar memori, hapus per entri (🗑), batalkan perubahan terakhir |
| `/undo` | Batalkan perubahan memori terakhir |
| `/skills_pending` | Skill yang diusulkan agen: 👁 lihat penuh, ✅ aktifkan, ❌ tolak (beserta penanda risiko) |
| notifikasi | Muncul saat agen mengusulkan skill baru (tombolnya tetap bisa dipakai saat agen sibuk) |
| digest harian | Ringkasan perubahan memori 24 jam terakhir (default jam 20.00 waktu server) |

Semua perintah bawaan bot upstream tetap ada: `/open`, `/new`, `/sessions`, `/abort`, `/model`, dan lainnya (lihat [`bot/README.md`](bot/README.md)).

---

## Instalasi di VPS

Panduan manual untuk Ubuntu 22.04/24.04, sampai installer satu perintah selesai (fase 4). Semua perintah dijalankan sebagai user dengan `sudo`.

### Gambaran

```
Telegram ──► aao-bot (user aao-bot)                 OpenCode V2 (user aao-agent, sandbox systemd)
             ├─ token Telegram, database memori      ├─ hanya bisa menulis di /srv/workspace
             └─ MCP memori 127.0.0.1:18090 ◄─────────┤  membaca /var/lib/aao-shared/MEMORY.md
                       │ API 127.0.0.1:49374 ───────►└─ /home, /root, token bot, database memori: tidak terlihat
```

| Lokasi | Isi | Pemilik |
|---|---|---|
| `/opt/aao/src` | kode repo ini (bot + memori) | root |
| `/opt/aao/opencode` | OpenCode V2 | root |
| `/etc/aao/` | `agent.env`, `bot.env` (rahasia, 0600), config OpenCode | root |
| `/srv/workspace` | proyek yang dikerjakan agen | aao-agent |
| `/var/lib/aao-bot` | database memori, log bot | aao-bot (0700) |
| `/var/lib/aao-shared` | `MEMORY.md` (dibaca agen, tidak bisa diubahnya) | aao-bot, grup aao-agent |

Tidak ada port yang dibuka ke internet; semuanya di `127.0.0.1`.

### 1. Prasyarat

```bash
node --version     # harus v22.14 atau lebih baru
command -v node    # harus /usr/bin/node atau /usr/local/bin/node
git --version && openssl version
```

Jika `node` belum ada, terlalu lama, atau terpasang di bawah `/home` (misalnya lewat nvm), pasang Node.js 22 untuk seluruh sistem. Service berjalan dengan `/home` disembunyikan, jadi Node di dalam `/home` tidak akan terlihat.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git openssl
```

### 2. Catat token, lalu hentikan bot lama

Bot lama (`grinev/opencode-telegram-bot`) dan bot baru **tidak boleh jalan bersamaan** dengan token yang sama, karena keduanya akan saling berebut pesan.

Ambil token dan user ID dari bot lama, untuk dipakai lagi di langkah 6:

```bash
grep -E "^TELEGRAM_(BOT_TOKEN|ALLOWED_USER_ID)=" ~/.config/opencode-telegram-bot/.env
```

Cari cara bot lama dijalankan, lalu hentikan **dengan cara yang sama**:

```bash
pm2 ls 2>/dev/null
systemctl list-units --type=service --all | grep -iE "opencode|telegram"
systemctl --user list-units --type=service 2>/dev/null | grep -iE "opencode|telegram"
```

| Bot lama dijalankan dengan | Hentikan dengan |
|---|---|
| PM2 | `pm2 stop <nama> && pm2 save` |
| service systemd | `sudo systemctl disable --now <nama>.service` |
| service systemd user | `systemctl --user disable --now <nama>.service` |
| `opencode-telegram start --daemon` | `opencode-telegram stop` |

Hentikan juga server OpenCode lama jika ada (`opencode service stop` untuk V2, atau hentikan proses/service `opencode serve`). Jangan dihapus dulu; penghapusan ada di [langkah 9](#9-hapus-instalasi-lama), setelah bot baru terbukti jalan.

### 3. User dan folder

```bash
for u in aao-agent aao-bot; do
  id "$u" >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/$u --create-home --shell /usr/sbin/nologin "$u"
done
sudo chmod 0700 /var/lib/aao-agent /var/lib/aao-bot
sudo usermod -aG aao-agent aao-bot                                       # bot boleh membaca workspace (/ls, /open)
sudo install -d -o aao-agent -g aao-agent -m 2770 /srv/workspace
sudo install -d -o aao-bot   -g aao-agent -m 2750 /var/lib/aao-shared    # snapshot memori: dibaca agen
sudo install -d -m 0755 /etc/aao /opt/aao
sudo install -d -o root -g aao-agent -m 0750 /etc/aao/opencode /etc/aao/opencode/opencode
```

### 4. Pasang OpenCode V2

```bash
sudo npm install --prefix /opt/aao/opencode --no-audit --no-fund @opencode/cli@latest
/opt/aao/opencode/node_modules/.bin/opencode --version
```

### 5. Pasang bot dan memori

```bash
sudo git clone https://github.com/mikhsanw/agent-ai-opencode /opt/aao/src
cd /opt/aao/src
sudo npm ci --ignore-scripts --no-audit --no-fund
sudo npm run build
sudo npm prune --omit=dev --ignore-scripts --no-audit --no-fund
```

`--ignore-scripts` wajib: `better-sqlite3` sudah membawa binary jadi, dan tanpa opsi ini npm 10 mencoba meng-compile ulang (butuh compiler). Sekaligus, tidak ada install script pihak ketiga yang dijalankan sebagai root.

### 6. Konfigurasi

Buat password OpenCode dan token MCP acak, lalu tulis ketiga file config dari template:

```bash
OCPW=$(openssl rand -hex 24); MCPT=$(openssl rand -hex 32)

sudo install -m 600 /opt/aao/src/deploy/agent.env.example /etc/aao/agent.env
sudo install -m 600 /opt/aao/src/deploy/bot.env.example   /etc/aao/bot.env
sudo install -o root -g aao-agent -m 640 /opt/aao/src/deploy/opencode.json.example /etc/aao/opencode/opencode/opencode.json

sudo sed -i "s/^OPENCODE_SERVER_PASSWORD=.*/OPENCODE_SERVER_PASSWORD=$OCPW/" /etc/aao/agent.env /etc/aao/bot.env
sudo sed -i "s/^AAO_MCP_TOKEN=.*/AAO_MCP_TOKEN=$MCPT/" /etc/aao/bot.env
sudo sed -i "s/SAMA_DENGAN_AAO_MCP_TOKEN/$MCPT/" /etc/aao/opencode/opencode/opencode.json
unset OCPW MCPT
```

Isi token bot dan user ID Telegram (dari langkah 2):

```bash
sudo nano /etc/aao/bot.env     # TELEGRAM_BOT_TOKEN dan TELEGRAM_ALLOWED_USER_ID
```

Opsional:
- **API key OpenCode Zen** untuk model berbayar: isi `OPENCODE_API_KEY` di `/etc/aao/agent.env`. Model gratis (default `big-pickle`) jalan tanpa key.
- **Jam digest** mengikuti zona waktu server: `sudo timedatectl set-timezone Asia/Jakarta`.

### 7. Jalankan

```bash
sudo cp /opt/aao/src/deploy/systemd/aao-agent.service /opt/aao/src/deploy/systemd/aao-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aao-agent aao-bot
systemctl status aao-agent aao-bot --no-pager
sudo journalctl -u aao-bot -n 30 --no-pager      # cari: "[AAO] Memory MCP listening"
```

### 8. Masukkan proyek dan coba dari Telegram

Agen hanya bisa bekerja di `/srv/workspace`. Masukkan proyek sebagai user agen:

```bash
sudo -u aao-agent git clone https://github.com/<anda>/<repo>.git /srv/workspace/<repo>
# atau salin proyek yang sudah ada:
sudo cp -r ~/proyek-saya /srv/workspace/ && sudo chown -R aao-agent:aao-agent /srv/workspace/proyek-saya
```

> Jangan memasukkan folder yang berisi rahasia penting (misalnya config freqtrade atau kunci exchange) ke `/srv/workspace`. Folder di luar workspace memang tidak terlihat oleh agen.

Lalu di Telegram:
1. `/open` → pilih folder proyek → **✅ Pilih folder ini**.
2. Kirim tugas, misalnya: *"Mulai sekarang ingat: saya memakai Laravel 11."*
3. `/memory` harus menampilkan fakta itu.

### 9. Hapus instalasi lama

Lakukan setelah bot baru terbukti jalan. **Tidak bisa dibatalkan**: config bot lama berisi token yang sama, dan riwayat sesi OpenCode lama ikut terhapus.

```bash
pm2 delete <nama> && pm2 save                      # jika dulu memakai PM2
sudo npm uninstall -g @grinev/opencode-telegram-bot
rm -rf ~/.config/opencode-telegram-bot
# OpenCode lama (pilih yang terpasang):
sudo npm uninstall -g opencode-ai                  # OpenCode V1
sudo npm uninstall -g @opencode/cli                # OpenCode V2 global (bukan yang di /opt/aao)
rm -rf ~/.local/share/opencode                     # riwayat sesi OpenCode lama
```

### Update

OpenCode (versi terbaru):

```bash
sudo npm install --prefix /opt/aao/opencode --no-audit --no-fund @opencode/cli@latest
sudo systemctl restart aao-agent
```

Bot dan memori:

```bash
cd /opt/aao/src && sudo git pull
sudo npm ci --ignore-scripts --no-audit --no-fund && sudo npm run build
sudo npm prune --omit=dev --ignore-scripts --no-audit --no-fund
sudo systemctl restart aao-bot
```

Update otomatis OpenCode yang diuji dulu sebelum dipakai (dan kembali ke versi lama jika gagal) direncanakan di fase 4. Sampai itu jadi, update dilakukan dengan perintah di atas.

### Uninstall

```bash
sudo systemctl disable --now aao-bot aao-agent
sudo rm /etc/systemd/system/aao-bot.service /etc/systemd/system/aao-agent.service && sudo systemctl daemon-reload
sudo rm -rf /opt/aao /etc/aao /var/lib/aao-shared
sudo userdel -r aao-bot; sudo userdel -r aao-agent   # -r ikut menghapus memori dan data agen
# /srv/workspace (proyek Anda) tidak dihapus
```

### Jika ada masalah

| Gejala | Periksa |
|---|---|
| Bot tidak membalas | `journalctl -u aao-bot -n 50`; token/user ID di `/etc/aao/bot.env`; bot lama masih jalan? |
| "OpenCode server is not available" | `systemctl status aao-agent`; password di `agent.env` dan `bot.env` harus sama |
| `/memory` selalu kosong | `journalctl -u aao-bot \| grep AAO`; `AAO_MCP_TOKEN` harus sama dengan token di `opencode.json`; lalu `sudo systemctl restart aao-agent` |
| `status=203/EXEC` pada aao-bot | `node` tidak ada di `/usr/bin` atau `/usr/local/bin` (lihat langkah 1) |
| Agen kehabisan RAM | `MemoryMax` di `aao-agent.service` (default 800M); naikkan jika VPS lega, lalu `daemon-reload` + restart |

### Yang sudah dan belum diuji

Diuji di Ubuntu 24.04 dengan user dan izin file sungguhan, lewat langkah 3–6 di atas, OpenCode 2.2.6, dan Telegram serta model tiruan:
- `/open` memilih proyek, prompt dari Telegram sampai ke agen, agen menyimpan memori lewat MCP, agen membaca `MEMORY.md`, dan balasan kembali ke Telegram.
- User agen **tidak bisa** membaca `bot.env` maupun database memori, tidak bisa mengubah `MEMORY.md` atau config OpenCode, dan tidak bisa `sudo`.
- Sintaks kedua unit systemd lolos `systemd-analyze verify`.

Belum diuji: efek sandbox systemd yang sebenarnya (`ProtectHome`, `MemoryMax`, dan seterusnya; lingkungan uji tidak menjalankan systemd sebagai PID 1), Telegram asli, dan model Zen sungguhan. Itu bagian fase 5 di VPS Anda.

---

## Konfigurasi memori

| Variabel (`/etc/aao/bot.env`) | Default | Fungsi |
|---|---|---|
| `AAO_MEMORY_ENABLED` | `true` | Matikan seluruh fitur memori |
| `AAO_DATA_DIR` | `<home bot>/aao` | Database memori, token MCP, snippet config |
| `AAO_SNAPSHOT_PATH` | `<data>/export/MEMORY.md` | File yang didaftarkan di `instructions` OpenCode (VPS: `/var/lib/aao-shared/MEMORY.md`) |
| `AAO_MCP_PORT` | `18090` | Port MCP memori (selalu `127.0.0.1`) |
| `AAO_MCP_TOKEN` | dibuat otomatis | Token bearer MCP (min. 16 karakter); harus sama dengan di `opencode.json` |
| `AAO_CAPTURE_ENABLED` | `true` | Auto-capture setelah setiap run |
| `AAO_CAPTURE_DAILY_LIMIT` | `30` | Batas auto-capture per hari (biaya token) |
| `AAO_DIGEST_HOUR` | `20` | Jam digest harian; `-1` mematikan |

## Struktur

```
docs/PRD.md                rencana & keputusan desain (dengan bukti)
packages/memory/           memori, dedup, pemindai rahasia, skill, MCP HTTP, auto-capture
bot/                       opencode-telegram-bot (subtree upstream) + bot/src/aao (integrasi)
deploy/                    unit systemd dan template config untuk instalasi di VPS
scripts/e2e-bot.mjs        e2e: bot + OpenCode V2 + model tiruan + Telegram tiruan
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
