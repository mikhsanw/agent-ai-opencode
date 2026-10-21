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
curl -fsSL https://mikhsanw.github.io/agent-ai-opencode/install.sh | bash
```

(Alternatif tanpa GitHub Pages: `curl -fsSL https://raw.githubusercontent.com/mikhsanw/agent-ai-opencode/main/bootstrap.sh | bash`.)

Skrip ini meminta `sudo` sendiri bila perlu, lalu memasang **rilis bertag terbaru** (atau `main` jika belum ada rilis). Untuk mengunci versi tertentu: `curl ... | OTB_REF=v0.1.0 bash`.

Siapkan dulu:
- **Token bot** dari [@BotFather](https://t.me/BotFather) (`/newbot`).
- **API key OpenCode Zen** dari https://opencode.ai/auth (satu key untuk banyak model). Buat key khusus untuk VPS ini dan pasang batas pemakaian di dashboard.

Wizard hanya menanyakan **3 hal** (saat update/instal ulang: tidak ada pertanyaan sama sekali):

```
Token bot                     input disembunyikan, langsung dicek ke Telegram
Kirim pesan ke bot            user ID Anda terdeteksi otomatis, cukup konfirmasi namanya (y)
API key OpenCode Zen          input disembunyikan; ketik "lain" untuk provider lain (Gemini, DeepSeek, ...)
```

Sisanya dipilih otomatis:

| Hal | Pilihan otomatis | Mengubahnya |
|---|---|---|
| Mode | systemd | `--mode docker` |
| Model | `opencode/space-bunny-free` (gratis). Rekomendasi: `deepseek-v4.1-flash-free` | `otb reconfigure` |
| Proyek | **semua proyek yang terdeteksi** dibuka untuk agen (baca-tulis) | `.otb-ignore` / `otb unshare` |
| Persetujuan | **penuh** jika ada proyek (pengamannya snapshot + backup), selain itu **otomatis** | `otb policy` |
| Firewall (ufw + SSH key-only) | tidak dipasang | `--harden-host` |

Installer lalu memasang dependensi, menjalankan layanan, menjalankan uji keamanan (`verify.sh`), dan mengirim pesan **"✅ Bot OpenCode aktif"** ke Telegram.

### Memilih proyek dari Telegram

Semua proyek di server dibuka untuk agen secara otomatis: folder berisi `.git`, `artisan`, `composer.json`, atau `package.json` di `/home/<user>/…` dan `/var/www/…`. Di Telegram cukup:

| Perintah | Fungsi |
|---|---|
| `/open` | Pilih proyek (tombol), lalu kirim tugas |
| `/open` → `workspace` → "clone https://github.com/…" | Repo baru: agen meng-clone ke `/srv/workspace`, lalu pilih dengan `/open` |
| `/model` | Ganti model AI |

- Setiap jam server mencari proyek baru. Proyek baru langsung dibuka, dan Anda mendapat **satu pesan** di Telegram. Jika agen sedang mengerjakan tugas, pemeriksaan ditunda ke jam berikutnya, karena membuka proyek me-restart agen.
- **Mengecualikan folder:** buat file `.otb-ignore` di dalamnya (sebelum terdeteksi), atau `otb unshare <path>`. Folder yang di-unshare tidak akan dibuka otomatis lagi; buka lagi dengan `otb share <path> --write`.
- Setiap proyek otomatis mendapat snapshot file (tiap 5 menit) dan backup database (tiap jam). Database di atas 2 GB tidak di-backup otomatis (Anda diberi tahu di Telegram); backup manual: `otb backup <proyek>`. Batasnya diatur di `/etc/otb/safety.conf` (`BACKUP_MAX_MB`).
- Repo privat untuk clone: jalankan dulu `otb github-key` di server.

> ⚠️ Karena semua proyek terbuka, agen yang terkena prompt injection dari satu proyek bisa mengubah proyek lain. Pengamannya adalah snapshot dan backup (lihat [Pengaman otomatis](#pengaman-otomatis-untuk-folder---write)), bukan pembatasan akses. Kecualikan proyek yang tidak perlu disentuh agen.

Untuk memakai Docker: `curl ... | bash -s -- --mode docker` (akses otomatis ke proyek di luar workspace hanya di mode systemd).

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

1. `/open`, pilih proyek, lalu kirim tugas.
2. Repo baru: `/open` → `workspace`, lalu kirim "clone https://github.com/<anda>/<repo>.git". Setelah selesai, pilih repo itu dengan `/open`. (Dari terminal juga bisa: `otb clone <url>`.)

Agen hanya bisa bekerja di `/srv/workspace` dan proyek yang terdeteksi; bagian lain dari VPS (konfigurasi sistem, `.ssh`, folder home lain) sengaja tidak bisa ia lihat.

### Melihat agen dari terminal (seperti OpenCode biasa)

OpenCode berjalan sebagai server di latar belakang, jadi perintah `opencode` biasa tidak dipakai di sini. Untuk melihat sesi yang sama dengan yang di Telegram:

```bash
otb attach
```

## Perintah `otb`

| Perintah | Fungsi |
|---|---|
| `otb` | Ringkasan: status layanan, model, proyek dan aksesnya |
| `otb status` | Status layanan dan versi |
| `otb logs bot` / `otb logs agent` (`-f` untuk mengikuti) | Log |
| `otb clone <url> [nama]` | Clone repo ke `/srv/workspace` sebagai user agen |
| `otb attach` | Buka TUI OpenCode yang terhubung ke agen (sesi yang sama dengan di Telegram) |
| `otb policy [nama]` | Lihat atau ganti preset persetujuan: `penuh`, `otomatis`, `seimbang`, `ketat`, `custom` |
| `otb shares` / `otb share <path> [--write]` / `otb unshare <path>` | Folder di luar workspace yang boleh diakses agen |
| `otb detect` | Cari proyek baru sekarang dan buka untuk agen (otomatis tiap jam) |
| `otb snapshots` / `otb restore` / `otb restore-git` | Snapshot file dan riwayat git folder `--write` |
| `otb backups` / `otb backup` / `otb restore-db` | Backup database folder `--write` |
| `otb github-key [test\|off]` | Beri agen akses `git push` ke GitHub (setiap push tetap ditanya; force push diblokir) |
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

Lalu pilih proyeknya di Telegram dengan `/open`. Bisa juga dari Telegram: `/open` → `workspace`, lalu minta agen "clone <url>". Untuk repo privat, gunakan **deploy key read-only** (bukan SSH key akun GitHub Anda). Pada mode systemd, taruh di `/var/lib/otb-agent/.ssh/`.

### Folder di luar workspace (mis. website produksi)

Secara default agen hanya bisa bekerja di `/srv/workspace`. Proyek yang terdeteksi sudah dibuka otomatis (lihat [Memilih proyek dari Telegram](#memilih-proyek-dari-telegram)). Folder lain, akses baca saja, atau mengecualikan proyek diatur dari terminal:

```bash
otb share /home/ubuntu/web-sekolah            # baca saja
otb share /home/ubuntu/web-sekolah --write    # baca-tulis, termasuk .env dan database
otb shares                                    # daftar
otb unshare /home/ubuntu/web-sekolah          # cabut
```

Lalu buka di Telegram dengan `/open`. Hanya untuk mode systemd.

| | baca saja | `--write` |
|---|---|---|
| Baca kode | ✓ | ✓ |
| Ubah kode, `composer`, `php artisan`, `git commit` di folder itu | ✗ | ✓ |
| Baca/edit `.env` | ✗ | ✓, setelah disetujui lewat Telegram (tool baca/edit OpenCode) |
| Database | ✗ | ✓, memakai kredensial dari `.env` |

Cara kerjanya:
- Folder itu muncul di sandbox pada **path aslinya**; isi lain dari `/home` (termasuk `.ssh`) tetap tersembunyi. `verify.sh` mengujinya.
- Akses diberikan lewat **ACL**, sehingga pemilik file dan izin website tidak diubah. File yang dibuat agen tetap bisa dibaca website dan diedit pemilik folder.
- Untuk aplikasi Laravel, user PHP-FPM (mis. `www-data`) diberi akses tulis di `storage/` dan `bootstrap/cache/`, supaya website tidak error setelah agen menjalankan `php artisan`.
- `otb unshare` dan `otb uninstall` mencabut ACL dan mengembalikan kepemilikan file buatan agen ke pemilik folder.
- Folder sistem, seluruh home (`/home/ubuntu`), dan folder yang berisi `.ssh` tidak bisa dibagikan.

#### Pengaman otomatis untuk folder `--write`

Untuk folder baca-tulis, pengamannya adalah **snapshot dan backup otomatis**, bukan tombol persetujuan. Begitu ada folder baca-tulis, installer memakai preset **penuh**: agen tidak ditanya apa pun kecuali `git push`. Yang tetap diblokir: `sudo`, `docker`, `systemctl`, `ssh`, force push.

| Pengaman | Jadwal | Disimpan | Isi |
|---|---|---|---|
| Snapshot file | tiap 5 menit (hanya jika ada perubahan) | 7 hari | semua file, termasuk `.env` dan file yang belum di-commit; kecuali `vendor/`, `node_modules/`, log, cache |
| Salinan riwayat git (`.git`) | bersama snapshot | sampai `.git` dihapus pemiliknya | commit tidak pernah dibuang, meskipun agen menjalankan `reset --hard`, hapus branch, `gc`, atau `rm -rf .git` |
| Backup database | tiap jam | semua dari 48 jam terakhir, lalu 1 per hari selama 14 hari | dump dari kredensial di `.env` (MySQL/MariaDB, PostgreSQL, SQLite) |

Semuanya disimpan di `/var/lib/otb` dan `/var/backups/otb`, yang **tidak bisa dilihat atau diubah agen** (diuji `verify.sh`). Git proyek Anda sendiri tidak disentuh. Lama penyimpanan bisa diubah di `/etc/otb/safety.conf`.

```bash
otb snapshots web-sekolah            # daftar snapshot file
otb restore web-sekolah <id>         # kembalikan file (dan .git jika terhapus); tampilkan perubahan dulu, minta "yes"
otb restore-git web-sekolah          # kembalikan commit yang dibuang (reset/hapus branch/gc) dan daftarkan
otb backups web-sekolah              # daftar backup database
otb backup web-sekolah               # backup sekarang, mis. sebelum meminta perubahan besar
otb restore-db web-sekolah <file>    # pulihkan database (menimpa); minta "yes"
```

Setiap restore lebih dulu menyimpan kondisi saat ini (snapshot atau backup baru), sehingga restore pun bisa dibatalkan.

Diuji dengan skenario terburuk: dari dalam sandbox, agen menghapus `.git` dan folder `app/`, merusak `.env` dan halaman, lalu `DROP TABLE siswa`. Dengan `otb restore` dan `otb restore-db`, semuanya kembali: website, file, `.env`, data siswa, dan riwayat git.

> ⚠️ **Batasannya:** perubahan dalam **5 menit terakhir** (file) dan **1 jam terakhir** (database) bisa hilang; jalankan `otb backup` sebelum pekerjaan berisiko. Snapshot dan backup berada **di VPS yang sama**, jadi kalau VPS-nya rusak keduanya ikut hilang; tetap aktifkan snapshot VPS dari panel provider. Isi `.env` dan data database (mis. data siswa) bisa terkirim ke penyedia model AI dan tampil di Telegram; gunakan model yang tidak memakai data untuk training.

### Mengizinkan agen `git push` (opsional)

Secara default `git push` diblokir dan agen tidak punya kredensial. Untuk mengizinkannya:

```bash
otb github-key
```

Perintah ini membuat SSH key khusus agen di VPS, memverifikasi host key GitHub (lewat api.github.com, atau dicocokkan dengan fingerprint resmi GitHub, sehingga koneksi yang disadap ditolak), mengatur koneksi lewat `ssh.github.com:443` (tetap jalan walau port 22 diblokir provider), lalu menampilkan public key untuk ditempel di GitHub:

- **Satu repo saja (disarankan):** Settings repo → Deploy keys → Add deploy key, centang **Allow write access**. Satu key hanya bisa dipakai di satu repo.
- **Semua repo:** https://github.com/settings/ssh/new. ⚠️ Agen lalu bisa push ke **semua** repo di akun Anda; kalau agen terkena prompt injection dari satu repo, semua repo ikut terancam.

Lalu uji: `otb github-key test`.

Setelah aktif:
- setiap `git push` **tetap minta persetujuan** lewat tombol Telegram, di preset apa pun;
- **force push, `--force-with-lease`, `+branch`, hapus branch, dan `--mirror` tetap diblokir**, jadi riwayat commit tidak bisa ditimpa;
- repo yang di-clone lewat HTTPS (`otb clone https://github.com/…`) otomatis push lewat SSH; remote tidak perlu diubah;
- pengaturan ini bertahan saat `otb update` dan saat `otb policy` diganti.

> **Penting:** "ditanya" dan "diblokir" di atas adalah aturan OpenCode berbasis nama perintah. Setelah agen memegang key, perintah tidak langsung seperti `node -e "…execSync('git push --force')…"` bisa melewatinya. Pengaman yang benar-benar kuat ada di sisi GitHub: buat **ruleset/branch protection** untuk `main` (Settings → Rules → Rulesets → *Block force pushes*, dan opsional *Restrict deletions*). Dengan itu force push ditolak GitHub, siapa pun pengirimnya.

Mematikan lagi: `otb github-key off` (hapus juga key-nya di GitHub).

### Push manual (tanpa memberi agen akses)

Kalau tidak ingin agen bisa push, review dan push sendiri dari clone milik Anda:

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

Preset dipilih otomatis saat instalasi (**penuh** jika ada proyek yang dibuka, selain itu **otomatis**) dan bisa diganti kapan saja tanpa install ulang:

```bash
otb policy            # lihat preset aktif
otb policy otomatis   # atau: seimbang, ketat, custom
```

| Preset | Jalan sendiri | Ditanya lewat tombol Telegram |
|---|---|---|
| **otomatis** (default tanpa proyek) | hampir semua perintah: baca, edit, build, test, `git add/commit/checkout`, `npm`, `composer`, `php artisan migrate`, dll. | yang penting saja: hapus file (`rm`, `find -delete`), `git reset --hard/clean/rebase/restore`, jaringan (`curl`, `wget`, `rsync`), database (`mysql`, `psql`, `artisan migrate:fresh/rollback/db:wipe/db:seed`), `kill`, `chmod`, shell bersarang (`bash -c`), web fetch |
| **seimbang** | perintah baca dan build/test umum | semua yang lain |
| **ketat** | `ls`, `pwd`, `git status/diff/log` | semua yang lain |
| **penuh** (default jika ada folder `--write`) | semua | hanya `git push` (setelah `otb github-key`); pengamannya snapshot dan backup otomatis |
| **custom** | sesuai `/etc/otb/policy-custom.json` | |

**Diblokir di semua preset:** `git push` (kecuali setelah `otb github-key`: ditanya, force push tetap diblokir), `git config`, `sudo`, `su`, `ssh`, `scp`, `nc`, `docker`, `systemctl`, `crontab`, akses file di luar proyek, serta edit `opencode.json`, `.opencode/`, `.git/`, dan `.env`.

Aturan preset **otomatis** diuji terhadap OpenCode sungguhan (dengan model AI tiruan yang menyuruh agen menjalankan perintah tertentu). Perintah berantai (`ls && rm -rf x`, `a; rm b`), subshell `$(rm …)`, pipe ke `xargs rm`, `bash -c '…'`, path lengkap (`/bin/rm`), `\rm`, dan pembungkus (`command`, `nice`, `timeout`, `env`) semuanya tetap ditanya.

**Batasan yang jujur:** aturan berbasis nama perintah tidak bisa menangkap semuanya. `node -e "fs.rmSync(…)"`, `python -c …`, atau skrip npm yang menghapus file tetap jalan tanpa ditanya di preset otomatis. Karena itu **batas keamanan yang sebenarnya adalah sandbox**: apa pun preset-nya, agen tetap tidak bisa menulis di luar `/srv/workspace`, membaca token bot, atau menjadi root, dan tanpa `otb github-key` juga tidak bisa `git push`. Commit pekerjaan secara rutin supaya file yang terhapus bisa dikembalikan.

Preset **custom**: `otb policy custom` membuat `/etc/otb/policy-custom.json` dari preset aktif; edit file itu, lalu jalankan `otb policy custom` lagi. Format aturannya mengikuti [dokumentasi izin OpenCode](https://opencode.ai/docs/permissions/); aturan yang cocok paling akhir yang berlaku. Pilihan preset dan file custom disimpan di `/etc/otb`, jadi **tidak tertimpa saat `otb update`**.

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
| `OTB_TELEGRAM_BOT_TOKEN`, `OTB_TELEGRAM_USER_ID` | Wajib (mode interaktif mendeteksi user ID sendiri) |
| `OTB_PROVIDER` | Opsional; default `opencode` (OpenCode Zen). Bisa ID provider OpenCode apa pun, mis. `google`, `deepseek` |
| `OTB_MODEL` | Opsional; default `space-bunny-free` untuk OpenCode Zen, atau model bawaan provider di katalog OpenCode |
| `OTB_API_KEY` | Wajib |
| `OTB_API_KEY_ENV` | Opsional; nama env API key (otomatis dari katalog OpenCode) |
| `OTB_POLICY` | Opsional; `otomatis` (default), `seimbang`, `ketat`, `penuh` (default jika ada share rw), `custom` |
| `OTB_SHARES` | Opsional; folder tambahan, mis. `rw:/srv/lain ro:/var/www/lain` |
| `OTB_AUTO_SHARE` | Opsional; `0` = jangan buka proyek terdeteksi secara otomatis |
| `OTB_CLONE` | Opsional; URL repo dipisah spasi, langsung di-clone ke workspace |
| `OTB_NODE_MIRROR` | Opsional; mirror Node.js |
| `OTB_TELEGRAM_API_ROOT` | Opsional; URL Bot API Telegram lain (mis. server Bot API sendiri atau proxy) |
| `OTB_REF`, `OTB_REPO_URL` | Opsional; tag atau repo lain (misalnya fork Anda) |

Proyek yang terdeteksi dibuka otomatis juga di mode non-interaktif; `OTB_SHARES` menambah folder lain, dan `OTB_AUTO_SHARE=0` mematikan pembukaan otomatis. Opsi lain untuk `install.sh`: `--mode docker`, `--harden-host` (ufw + SSH key-only; tidak dipasang tanpa opsi ini), `--no-harden-host`, `--skip-telegram-check` (jika Telegram hanya bisa diakses lewat proxy), `--no-deps`, `--reconfigure`, `--yes`.

---

## Struktur

```
bootstrap.sh                   pemasang satu-perintah (clone rilis ke /opt/otb/src -> install.sh)
docs/install.sh                salinan bootstrap.sh untuk GitHub Pages (URL pendek)
install.sh                     wizard + instalasi (idempoten, aman dijalankan ulang)
lib/catalog.mjs                membaca katalog provider/model dari OpenCode untuk wizard
lib/shares.sh                  berbagi folder di luar workspace (ACL + drop-in systemd)
lib/safety.sh                  snapshot file, salinan .git, dan backup database untuk folder --write
lib/projects.sh                deteksi proyek, dibuka otomatis untuk agen (+ timer tiap jam)
otb                            perintah pengelolaan (terpasang di /usr/local/bin/otb)
verify.sh                      uji keamanan untuk kedua mode
config/policies/*.json         preset persetujuan (penuh, otomatis, seimbang, ketat, dan varian -push); dipasang sebagai managed config OpenCode
tools/gen-push-policies.py     membuat varian -push dari preset dasar
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
