# otb-hardening

Setup aman untuk menjalankan [opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) dan [OpenCode](https://opencode.ai) di VPS, dengan model keamanan yang terinspirasi Hermes Agent: agen dikurung di sandbox, perintah berisiko meminta persetujuan lewat Telegram, dan perintah berbahaya diblokir.

Kode bot upstream **tidak diubah sama sekali**. Semua pengamanan dilakukan lewat sistem operasi (systemd atau Docker) dan konfigurasi bawaan OpenCode.

| Komponen | Versi (di-pin dengan lockfile) |
|---|---|
| `@grinev/opencode-telegram-bot` | 0.26.5 |
| `opencode-ai` (OpenCode V1) | 1.19.3 |

---

## Model ancaman

Asumsi dasarnya: **agen AI bisa disusupi.** Jalurnya bisa lewat prompt injection dari README, isu GitHub, dependensi, atau hasil web fetch, atau sekadar karena model membuat kesalahan. Tujuan setup ini adalah membatasi kerusakan yang bisa ditimbulkan agen yang sudah disusupi.

```
  Telegram  ──►  otb-bot  ──(HTTP + password, 127.0.0.1)──►  otb-agent  ──►  /srv/workspace
                 (user: otb-bot)                              (user: otb-agent)
                 pegang token Telegram                        pegang API key LLM
                 workspace: read-only                         workspace: read-write
                 tidak bisa jalankan OpenCode                 tidak bisa baca token bot
```

Bot dan agen sengaja dipisah menjadi dua user atau container. Akibatnya, agen yang disusupi **tidak bisa mencuri token Telegram**, sehingga tidak bisa mengambil alih bot Anda.

### Yang dijamin (dan diuji oleh `verify.sh`)

- Agen hanya bisa menulis di `/srv/workspace`.
- Agen tidak bisa membaca token bot, `/root`, atau home user lain.
- Agen tidak bisa menjadi root (tanpa capabilities, `NoNewPrivileges`).
- Agen tidak bisa mengubah binary OpenCode, kebijakan izin, atau menanam plugin global.
- **Plugin dari repo yang di-clone tidak dieksekusi** (lihat temuan penting di bawah).
- API OpenCode tidak terbuka ke jaringan dan wajib password.
- Ada limit proses, RAM, dan CPU untuk menahan build yang lepas kendali atau fork bomb.

### Yang TIDAK dijamin

- **Chat Telegram tidak end-to-end encrypted.** Kode dan output melewati server Telegram. Jangan pakai bot ini untuk repo berisi kredensial produksi.
- **Agen bisa membaca API key LLM-nya sendiri**, karena memang harus memakainya. Pasang batas pengeluaran (spending limit) di dashboard provider.
- **Tidak ada egress filter.** Agen yang disusupi bisa mengirim isi workspace ke internet. Jangan simpan secret di workspace.
- **Rule `deny` berbasis pola mudah diakali** (`bash -c`, `python -c`, base64). Rule tersebut hanyalah penghalang untuk kesalahan model. Batas keamanan yang sebenarnya adalah sandbox OS.

---

## Temuan penting: plugin di repo dieksekusi otomatis

Saat pengujian, ditemukan bahwa OpenCode **langsung menjalankan kode** dari `.opencode/plugins/*.ts` di sebuah repo begitu sesi dibuka di repo itu, **tanpa melewati sistem izin sama sekali**. Artinya, cukup dengan meng-clone repo jahat lalu membuka sesi, kode penyerang sudah berjalan.

Hal yang sama berlaku untuk `~/.opencode/plugins` di home agen. Agen yang sudah disusupi bisa menanam plugin di situ agar ikut berjalan setiap kali server di-restart.

Setup ini menutup kedua jalur tersebut:
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` mematikan semua config, agent, dan plugin dari repo.
- `~/.opencode` dan direktori config global di-mount read-only.

`verify.sh` menguji serangan ini secara nyata dengan membuat repo berisi plugin, membuka sesi, lalu memastikan plugin tidak berjalan. Konsekuensinya, `opencode.json` di dalam repo Anda **diabaikan**. Semua aturan izin diatur di `/etc/opencode/opencode.json`.

---

## Pilih mode

| | Mode A: systemd (default) | Mode B: Docker (opsional) |
|---|---|---|
| Tool tambahan | Tidak ada (cukup Node.js 22) | Docker + Compose plugin |
| Isolasi filesystem | Ya | Ya |
| Isolasi network/PID namespace | Sebagian | Penuh |
| Toolchain proyek (php, composer, dll.) | Pakai yang terpasang di VPS | Harus ditambahkan ke `docker/agent.Dockerfile` |
| Skor `systemd-analyze security` | 1.6 (OK) | n/a |

Kebijakan izin, file `.env`, dan `verify.sh` dipakai bersama oleh kedua mode. **Jangan jalankan keduanya sekaligus**, karena dua bot dengan token yang sama akan saling berebut update Telegram. Installer dan `verify.sh` akan menolak atau memperingatkan jika hal ini terjadi.

---

## Instalasi

Target: VPS **khusus** untuk bot ini (Ubuntu 24.04 atau Debian 12). Jangan jalankan di VPS yang sama dengan Dry24, E-AMI, atau trading bot.

### 0. Snapshot dan persiapan

Buat snapshot VPS dari panel provider sebelum mulai. Ini titik rollback Anda.

Khusus Mode A, pasang Node.js 22 secara system-wide. Paket `nodejs` bawaan Ubuntu terlalu lama.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v   # harus >= 22.14
```

Khusus Mode B, pasang Docker Engine dan Compose plugin sesuai dokumentasi resmi Docker.

### 1. Jalankan installer

```bash
git clone <URL-repo-Anda>/otb-hardening.git
cd otb-hardening
sudo ./install.sh                 # Mode A
# atau
sudo ./install.sh --mode docker   # Mode B
```

Jalankan pertama ini akan membuat user, folder, dan file konfigurasi, lalu **berhenti** dan meminta Anda mengisi data.

### 2. Isi konfigurasi

```bash
sudo nano /etc/otb/bot.env     # token Telegram, user ID, model
sudo nano /etc/otb/agent.env   # API key LLM (pilih satu)
```

Contoh untuk Gemini:
- di `bot.env`: `OPENCODE_MODEL_PROVIDER=google` dan `OPENCODE_MODEL_ID=gemini-2.5-pro`
- di `agent.env`: `GOOGLE_GENERATIVE_AI_API_KEY=...`

`OPENCODE_SERVER_PASSWORD` sudah dibuat otomatis dan sama di kedua file. Jangan diubah kecuali Anda mengubah keduanya.

### 3. Jalankan lagi installer (sekarang akan start)

```bash
sudo ./install.sh                         # atau --mode docker
sudo ./install.sh --harden-host           # opsional: ufw + SSH key-only (ada konfirmasi)
```

`--harden-host` akan menampilkan rencananya dan meminta Anda mengetik `yes`. Langkah SSH **otomatis dilewati** jika tidak ditemukan `authorized_keys`, supaya Anda tidak terkunci di luar. Tetap biarkan sesi SSH yang sedang aktif terbuka sampai Anda berhasil login di sesi baru.

### 4. Verifikasi

```bash
sudo ./verify.sh
```

Target: `0 failed`. Exit code non-zero menandakan ada yang gagal.

---

## Pemakaian sehari-hari

### Menaruh repo ke workspace

Clone repo **sebagai user agen**, bukan sebagai root:

```bash
# Mode A
sudo -u otb-agent git clone https://github.com/<anda>/<repo>.git /srv/workspace/<repo>
# Mode B
sudo docker exec otb-agent git clone https://github.com/<anda>/<repo>.git /srv/workspace/<repo>
```

Untuk repo privat, gunakan **deploy key read-only** (bukan SSH key akun GitHub Anda). Taruh di `/var/lib/otb-agent/.ssh/` untuk Mode A.

### Push hasil kerja agen (manual, oleh Anda)

Agen bisa commit, tapi `git push` diblokir dan agen memang tidak punya kredensial push. Alurnya adalah review dulu, lalu push dari clone milik Anda sendiri:

```bash
sudo usermod -aG otb-ws $USER          # sekali saja, lalu logout/login
git config --global --add safe.directory /srv/workspace/<repo>/.git
git clone /srv/workspace/<repo> ~/review/<repo>
cd ~/review/<repo>
git log -p                              # review dulu!
git remote add mine <URL-git-Anda>
git push mine <branch>
```

> **Jangan pernah menjalankan perintah git sebagai root di dalam `/srv/workspace`.** Agen bisa menyiapkan hook atau config git yang akan dieksekusi oleh siapa pun yang menjalankan git di sana.

### Persetujuan perintah

Kebijakan default di `config/opencode-managed.json` (terpasang di `/etc/opencode/opencode.json`):

| Aksi | Perilaku |
|---|---|
| Baca file, glob, grep | Langsung jalan (kecuali `.env`, yang di-deny) |
| Edit file di dalam proyek | Langsung jalan (kecuali `opencode.json`, `.opencode/`, `.git/`, `.env`) |
| `ls`, `pwd`, `git status/diff/log/branch` | Langsung jalan |
| Perintah bash lainnya (termasuk `npm test`, `composer`, `php artisan`) | **Minta persetujuan** lewat tombol di Telegram |
| `git push`, `git config`, `sudo`, `ssh`, `scp`, `nc`, `docker`, `systemctl`, `crontab` | **Diblokir** |
| Akses file di luar proyek | **Diblokir** |
| Web fetch / web search | **Minta persetujuan** |

Mengizinkan `npm test` atau `php artisan test` secara otomatis **sama saja dengan mengizinkan eksekusi kode bebas**, karena agen bisa mengedit `package.json` atau file test terlebih dahulu. Jika Anda tetap ingin menambahkannya ke allowlist, edit `/etc/opencode/opencode.json` lalu restart agen:

```bash
sudo systemctl restart otb-agent          # Mode A
sudo docker compose restart agent         # Mode B
```

---

## Upgrade versi

1. Ubah versi di `deploy/agent/package.json` atau `deploy/bot/package.json`.
2. Jalankan `npm install --package-lock-only` di folder itu untuk memperbarui lockfile.
3. Cek changelog dan advisory keamanan untuk versi baru tersebut.
4. Jalankan `sudo ./install.sh` (atau `--mode docker`), lalu `sudo ./verify.sh`.

Installer hanya memasang ulang paket jika lockfile berubah. Script install npm dijalankan sebagai user `otb-build` yang tidak punya hak istimewa, bukan sebagai root.

---

## Uninstall

```bash
# Mode A
sudo systemctl disable --now otb-bot otb-agent
sudo rm -f /etc/systemd/system/otb-{bot,agent}.service && sudo systemctl daemon-reload
sudo rm -rf /opt/otb /var/lib/otb-bot /var/lib/otb-agent
sudo userdel otb-bot; sudo userdel otb-agent; sudo userdel otb-build; sudo groupdel otb-ws

# Mode B
sudo docker compose down -v

# Keduanya (PERMANEN: menghapus konfigurasi dan workspace)
sudo rm -rf /etc/otb /etc/opencode
sudo rm -rf /srv/workspace
```

---

## Struktur

```
config/opencode-managed.json   kebijakan izin OpenCode (tidak bisa ditimpa repo)
config/*.env.example           template /etc/otb/*.env
deploy/{agent,bot}/            package.json + lockfile (versi di-pin)
systemd/                       unit Mode A
docker/ + docker-compose.yml   Mode B
install.sh                     installer (idempoten, aman dijalankan ulang)
verify.sh                      pengujian keamanan untuk kedua mode
```

## Batasan pengujian

Diuji pada Ubuntu 24.04 dengan systemd, serta Docker 29 dengan Compose v5: hasilnya 25/25 lulus untuk Mode A dan 21/21 lulus untuk Mode B, plus uji kontrol negatif untuk memastikan tes serangan plugin memang mendeteksi kegagalan. Langkah `--harden-host` diuji di VM dengan network terisolasi.

Yang **belum** diuji: koneksi ke Telegram asli dan panggilan ke LLM asli, karena keduanya tidak bisa diakses dari lingkungan pengujian. Dua hal ini adalah hal pertama yang perlu Anda cek di VPS sendiri. Image Docker juga dibangun di atas base pengganti saat pengujian, karena Docker Hub tidak bisa diakses; di VPS Anda, image akan dibangun dari `node:22-bookworm-slim` asli.
