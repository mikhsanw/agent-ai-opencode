# agent-ai-opencode

Agen coding [OpenCode](https://opencode.ai) yang dikendalikan lewat Telegram ([opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot)), dipasang di VPS dengan **satu perintah** dan dikurung dalam sandbox. Model keamanannya terinspirasi Hermes Agent: agen diisolasi, perintah berisiko meminta persetujuan lewat Telegram, dan perintah berbahaya diblokir.

Kode bot upstream **tidak diubah sama sekali**. Semua pengamanan dilakukan lewat sistem operasi (systemd atau Docker) dan konfigurasi bawaan OpenCode.

| Komponen | Versi (di-pin dengan lockfile) |
|---|---|
| `@grinev/opencode-telegram-bot` | 0.26.5 |
| `opencode-ai` (OpenCode V1) | 1.19.3 |

---

## Pasang cepat

Di VPS **khusus** untuk bot ini (Ubuntu 24.04 atau Debian 12), sebagai root atau user dengan sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/mikhsanw/agent-ai-opencode/main/bootstrap.sh | bash
```

Setelah GitHub Pages diaktifkan (lihat bagian maintainer), URL pendeknya:

```bash
curl -fsSL https://mikhsanw.github.io/agent-ai-opencode/install.sh | bash
```

Skrip ini meminta `sudo` sendiri bila perlu, lalu memasang **rilis bertag terbaru** (atau `main` jika belum ada rilis). Untuk mengunci versi tertentu: `curl ... | OTB_REF=v0.1.0 bash`.

Siapkan dulu:
- **Token bot** dari [@BotFather](https://t.me/BotFather) (`/newbot`).
- **User ID Telegram** Anda, dari [@userinfobot](https://t.me/userinfobot).
- **API key**. Paling praktis memakai **OpenCode Zen** dari https://opencode.ai/auth: satu key untuk banyak model (Claude, GPT, Gemini, DeepSeek, Kimi, GLM, dan lain-lain). Buat key khusus untuk VPS ini, dan pasang batas pemakaian di dashboard. Key dari provider lain (Gemini, Anthropic, OpenAI, DeepSeek, dan sebagainya) juga bisa dipakai.

Wizard akan menanyakan hal-hal berikut:

```
Mode [1]                      systemd (disarankan) atau docker
Token bot                     input disembunyikan, langsung dicek ke Telegram
User ID                       hanya akun ini yang bisa memakai bot
Provider                      daftar dari katalog OpenCode; default OpenCode Zen; bisa cari 230+ provider
API key                       nama env variable terisi otomatis; input disembunyikan
Model                         daftar bernomor dari katalog, model gratis diberi tanda [gratis]
Persetujuan                   otomatis (default) / seimbang / ketat
Pasang firewall? (y/n)        ufw + SSH key-only, rencananya ditampilkan dulu
```

Di setiap daftar, Anda bisa mengetik nomor, ID persis, atau kata kunci untuk menyaring (misalnya `claude`, `gemini`, `free`). ID yang belum ada di katalog tetap bisa dipakai setelah konfirmasi.

Installer lalu memasang semua dependensi, menjalankan layanan, menjalankan uji keamanan (`verify.sh`), dan mengirim pesan **"✅ Bot OpenCode aktif"** ke Telegram Anda. Jika pesan tidak masuk, buka bot Anda di Telegram, tekan **Start**, lalu kirim `/start`.

Untuk memakai Docker: `curl ... | bash -s -- --mode docker`

### Cara yang lebih hati-hati

`curl | bash` menjalankan kode dari internet sebagai root tanpa Anda baca. Jika ingin membaca kodenya dulu:

```bash
git clone https://github.com/mikhsanw/agent-ai-opencode.git
cd agent-ai-opencode
git checkout v0.1.0                   # atau rilis lain; lihat: git tag
less bootstrap.sh install.sh          # baca dulu
sudo ./install.sh
```

---

### Setelah instalasi: mulai dari Telegram

1. Clone proyek ke workspace: `otb clone https://github.com/<anda>/<repo>.git`
2. Di Telegram, pilih proyeknya dengan `/projects`, lalu kirim tugas.

Agen hanya bisa bekerja di dalam `/srv/workspace`; tugas yang menyangkut bagian lain dari VPS (misalnya "aplikasi apa saja yang terpasang") memang sengaja tidak bisa ia lihat.

### Melihat agen dari terminal (seperti OpenCode biasa)

OpenCode berjalan sebagai server di latar belakang, jadi perintah `opencode` biasa tidak dipakai di sini. Untuk melihat sesi yang sama dengan yang di Telegram:

```bash
otb attach
```

## Perintah `otb`

| Perintah | Fungsi |
|---|---|
| `otb status` | Status layanan dan versi |
| `otb logs bot` / `otb logs agent` (`-f` untuk mengikuti) | Log |
| `otb clone <url> [nama]` | Clone repo ke `/srv/workspace` sebagai user agen |
| `otb attach` | Buka TUI OpenCode yang terhubung ke agen (sesi yang sama dengan di Telegram) |
| `otb policy [nama]` | Lihat atau ganti preset persetujuan: `otomatis`, `seimbang`, `ketat`, `custom` |
| `otb verify` | Jalankan uji keamanan |
| `otb restart` | Restart bot dan agen |
| `otb reconfigure` | Ganti token, user ID, model, atau API key (Enter = tetap) |
| `otb update [tag]` | Perbarui ke rilis terbaru; perubahannya ditampilkan dan dikonfirmasi dulu |
| `otb uninstall [--purge]` | Hapus layanan; `--purge` ikut menghapus konfigurasi dan **semua proyek** |

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
- Kode installer yang dijalankan sebagai root tidak bisa diubah oleh user lain.
- Ada limit proses, RAM, dan CPU untuk menahan build yang lepas kendali atau fork bomb.

### Yang TIDAK dijamin

- **Chat Telegram tidak end-to-end encrypted.** Kode dan output melewati server Telegram. Jangan pakai bot ini untuk repo berisi kredensial produksi.
- **Agen bisa membaca API key LLM-nya sendiri**, karena memang harus memakainya. Pasang batas pengeluaran di dashboard provider.
- **Tidak ada egress filter.** Agen yang disusupi bisa mengirim isi workspace ke internet. Jangan simpan secret di workspace.
- **Rule `deny` berbasis pola mudah diakali** (`bash -c`, `python -c`, base64). Rule tersebut hanyalah penghalang untuk kesalahan model. Batas keamanan yang sebenarnya adalah sandbox OS.

### Temuan penting: plugin di repo dieksekusi otomatis

Saat pengujian, ditemukan bahwa OpenCode **langsung menjalankan kode** dari `.opencode/plugins/*.ts` di sebuah repo begitu sesi dibuka di repo itu, **tanpa melewati sistem izin sama sekali**. Artinya, cukup dengan meng-clone repo jahat lalu membuka sesi, kode penyerang sudah berjalan. Hal yang sama berlaku untuk `~/.opencode/plugins` di home agen, yang bisa dipakai agen yang sudah disusupi untuk menanam kode yang ikut berjalan setiap restart.

Setup ini menutup kedua jalur tersebut:
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` mematikan semua config, agent, dan plugin dari repo.
- `~/.opencode` dan direktori config global di-mount read-only.

`verify.sh` menguji serangan ini secara nyata. Konsekuensinya, `opencode.json` di dalam repo Anda **diabaikan**; semua aturan izin diatur di `/etc/opencode/opencode.json`.

---

## Mode sandbox

| | systemd (default) | Docker (opsional) |
|---|---|---|
| Dependensi yang dipasang otomatis | Node.js 22 (tarball resmi, dicek SHA256) | `docker.io` + `docker-compose-v2` dari repo Ubuntu |
| Isolasi filesystem | Ya | Ya |
| Isolasi network/PID namespace | Sebagian | Penuh |
| Toolchain proyek (php, composer, dll.) | Pakai yang terpasang di VPS | Harus ditambahkan ke `docker/agent.Dockerfile` |
| Sumber `otb clone` | URL atau path lokal | URL saja |

Pemasangan Docker otomatis hanya untuk Ubuntu. Di Debian, pasang Docker Engine sesuai [dokumentasi resmi](https://docs.docker.com/engine/install/) terlebih dahulu.

**Jangan jalankan kedua mode sekaligus**, karena dua bot dengan token yang sama akan saling berebut update Telegram. Installer menolak jika mode lain sedang berjalan.

### Tentang verifikasi Node.js

Installer mengunduh tarball resmi dari nodejs.org dan mencocokkannya dengan `SHASUMS256.txt`. Ini melindungi dari unduhan yang rusak atau diubah di tengah jalan. Namun karena daftar checksum diambil dari server yang sama, cara ini **tidak** melindungi jika server nodejs.org sendiri dibobol. Tidak ada repo apt pihak ketiga yang ditambahkan. Untuk jaringan yang memblokir nodejs.org, set `OTB_NODE_MIRROR` ke mirror lain.

---

## Pemakaian sehari-hari

### Menaruh repo ke workspace

```bash
otb clone https://github.com/<anda>/<repo>.git
```

Lalu pilih proyeknya di Telegram dengan `/projects`. Untuk repo privat, gunakan **deploy key read-only** (bukan SSH key akun GitHub Anda). Pada mode systemd, taruh di `/var/lib/otb-agent/.ssh/`.

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

Ada tiga preset, dipilih saat instalasi dan bisa diganti kapan saja tanpa install ulang:

```bash
otb policy            # lihat preset aktif
otb policy otomatis   # atau: seimbang, ketat, custom
```

| Preset | Jalan sendiri | Ditanya lewat tombol Telegram |
|---|---|---|
| **otomatis** (default) | hampir semua perintah: baca, edit, build, test, `git add/commit/checkout`, `npm`, `composer`, `php artisan migrate`, dll. | yang penting saja: hapus file (`rm`, `find -delete`), `git reset --hard/clean/rebase/restore`, jaringan (`curl`, `wget`, `rsync`), database (`mysql`, `psql`, `artisan migrate:fresh/rollback/db:wipe/db:seed`), `kill`, `chmod`, shell bersarang (`bash -c`), web fetch |
| **seimbang** | perintah baca dan build/test umum | semua yang lain |
| **ketat** | `ls`, `pwd`, `git status/diff/log` | semua yang lain |
| **custom** | sesuai `/etc/otb/policy-custom.json` | |

**Diblokir di semua preset:** `git push`, `git config`, `sudo`, `su`, `ssh`, `scp`, `nc`, `docker`, `systemctl`, `crontab`, akses file di luar proyek, serta edit `opencode.json`, `.opencode/`, `.git/`, dan `.env`.

Aturan preset **otomatis** diuji terhadap OpenCode sungguhan (dengan model AI tiruan yang menyuruh agen menjalankan perintah tertentu). Perintah berantai (`ls && rm -rf x`, `a; rm b`), subshell `$(rm …)`, pipe ke `xargs rm`, `bash -c '…'`, path lengkap (`/bin/rm`), `\rm`, dan pembungkus (`command`, `nice`, `timeout`, `env`) semuanya tetap ditanya.

**Batasan yang jujur:** aturan berbasis nama perintah tidak bisa menangkap semuanya. `node -e "fs.rmSync(…)"`, `python -c …`, atau skrip npm yang menghapus file tetap jalan tanpa ditanya di preset otomatis. Karena itu **batas keamanan yang sebenarnya adalah sandbox**: apa pun preset-nya, agen tetap tidak bisa menulis di luar `/srv/workspace`, membaca token bot, menjadi root, atau `git push`. Commit pekerjaan secara rutin supaya file yang terhapus bisa dikembalikan.

Preset **custom**: `otb policy custom` membuat `/etc/otb/policy-custom.json` dari preset aktif; edit file itu, lalu jalankan `otb policy custom` lagi. Format aturannya mengikuti [dokumentasi izin OpenCode](https://opencode.ai/docs/permissions/); aturan yang cocok paling akhir yang berlaku. Pilihan preset dan file custom disimpan di `/etc/otb`, jadi **tidak tertimpa saat `otb update`**.

---|---|
| Baca file, glob, grep | Langsung jalan (kecuali `.env`, yang di-deny) |
| Edit file di dalam proyek | Langsung jalan (kecuali `opencode.json`, `.opencode/`, `.git/`, `.env`) |
| `ls`, `pwd`, `git status/diff/log/branch` | Langsung jalan |
| Perintah bash lainnya (termasuk `npm test`, `composer`, `php artisan`) | **Minta persetujuan** lewat tombol di Telegram |
| `git push`, `git config`, `sudo`, `ssh`, `scp`, `nc`, `docker`, `systemctl`, `crontab` | **Diblokir** |
| Akses file di luar proyek | **Diblokir** |
| Web fetch / web search | **Minta persetujuan** |

Mengizinkan `npm test` atau `php artisan test` secara otomatis **sama saja dengan mengizinkan eksekusi kode bebas**, karena agen bisa mengedit `package.json` atau file test terlebih dahulu. Jika tetap ingin menambahkannya, edit `/etc/opencode/opencode.json` lalu jalankan `otb restart`. Perubahan ini tertimpa saat `otb update`, jadi simpan juga di fork Anda.

---

## Instalasi otomatis (non-interaktif)

Untuk cloud-init atau skrip provisioning, semua jawaban bisa diberikan lewat environment variable:

```bash
curl -fsSL https://raw.githubusercontent.com/mikhsanw/agent-ai-opencode/main/bootstrap.sh \
  | sudo OTB_TELEGRAM_BOT_TOKEN=... OTB_TELEGRAM_USER_ID=... \
         OTB_API_KEY=... bash -s -- --non-interactive --no-harden-host
```

| Variable | Isi |
|---|---|
| `OTB_TELEGRAM_BOT_TOKEN`, `OTB_TELEGRAM_USER_ID` | Wajib |
| `OTB_PROVIDER` | Opsional; default `opencode` (OpenCode Zen). Bisa ID provider OpenCode apa pun, mis. `google`, `deepseek` |
| `OTB_MODEL` | Opsional; default model bawaan provider di katalog OpenCode |
| `OTB_API_KEY` | Wajib |
| `OTB_API_KEY_ENV` | Opsional; nama env API key (otomatis dari katalog OpenCode) |
| `OTB_POLICY` | Opsional; `otomatis` (default), `seimbang`, `ketat`, `custom` |
| `OTB_NODE_MIRROR` | Opsional; mirror Node.js |
| `OTB_REF`, `OTB_REPO_URL` | Opsional; tag atau repo lain (misalnya fork Anda) |

Opsi lain untuk `install.sh`: `--mode docker`, `--harden-host`, `--no-harden-host`, `--skip-telegram-check` (jika Telegram hanya bisa diakses lewat proxy), `--no-deps`, `--reconfigure`, `--yes`.

---

## Struktur

```
bootstrap.sh                   pemasang satu-perintah (clone rilis ke /opt/otb/src -> install.sh)
docs/install.sh                salinan bootstrap.sh untuk GitHub Pages (URL pendek)
install.sh                     wizard + instalasi (idempoten, aman dijalankan ulang)
lib/catalog.mjs                membaca katalog provider/model dari OpenCode untuk wizard
otb                            perintah pengelolaan (terpasang di /usr/local/bin/otb)
verify.sh                      uji keamanan untuk kedua mode
config/policies/*.json         preset persetujuan (otomatis, seimbang, ketat); dipasang sebagai managed config OpenCode
config/*.env.example           template /etc/otb/*.env
deploy/{agent,bot}/            package.json + lockfile (versi di-pin)
systemd/                       unit mode systemd
docker/ + docker-compose.yml   mode Docker
```

Lokasi di VPS: konfigurasi dan secret di `/etc/otb/` (0600 root), proyek di `/srv/workspace/`, kode installer di `/opt/otb/src/`.

## Untuk maintainer

### URL pendek (GitHub Pages)

Settings → Pages → Source: **Deploy from a branch**, Branch: `main`, folder `/docs`. Setelah aktif, `https://mikhsanw.github.io/agent-ai-opencode/install.sh` berfungsi. `docs/install.sh` harus selalu identik dengan `bootstrap.sh`:

```bash
cp bootstrap.sh docs/install.sh
```

### Rilis

Installer memasang **tag `v*` terbaru**, dan `otb update` mengikuti tag yang sama. Tanpa tag, keduanya memakai `main`. Untuk merilis:

1. (Opsional) Ubah versi di `deploy/agent/package.json` atau `deploy/bot/package.json`, jalankan `npm install --package-lock-only` di folder itu, lalu cek changelog dan advisory keamanan versi baru tersebut.
2. Commit ke `main`.
3. Buat tag, misalnya `git tag v0.1.1 && git push origin v0.1.1`, atau lewat halaman Releases di GitHub.
4. Di VPS: `otb update`.

## Batasan pengujian

Rilis ini diuji di VM Ubuntu 24.04 dengan systemd, mulai dari kondisi **tanpa Node.js**:
- one-liner `bootstrap.sh` dari GitHub, sebagai root maupun sebagai user biasa yang diminta password sudo;
- tanpa tag rilis (otomatis memakai `main`);
- wizard interaktif lewat terminal sungguhan, termasuk daftar provider dan model dari katalog OpenCode;
- mode non-interaktif;
- menjalankan ulang (tidak ada pertanyaan ulang);
- checksum Node.js yang dimanipulasi (instalasi dibatalkan);
- `otb status/logs/clone/verify/reconfigure/update/uninstall`;
- model yang tidak dikenal (muncul peringatan).

Mode Docker diuji dengan Docker 29. `verify.sh` lulus tanpa FAIL di kedua mode, termasuk uji kontrol negatif untuk serangan plugin.

Yang **belum** diuji karena tidak bisa diakses dari lingkungan pengujian: koneksi ke Telegram asli, panggilan ke LLM asli, unduhan dari nodejs.org (diuji lewat mirror lokal dengan format yang sama), dan build image dari Docker Hub. Pesan "✅ Bot OpenCode aktif" di Telegram Anda adalah konfirmasi akhirnya.
