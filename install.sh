#!/usr/bin/env bash
# Installer opencode-telegram-bot + OpenCode dengan sandbox.
#
#   sudo ./install.sh                     wizard interaktif (disarankan)
#   sudo ./install.sh --mode docker       pakai Docker (Mode B) alih-alih systemd (Mode A)
#   sudo ./install.sh --reconfigure       tanya ulang token, user ID, model, API key
#   sudo ./install.sh --harden-host       sekalian pasang ufw + SSH key-only
#   sudo ./install.sh --non-interactive   tanpa pertanyaan; nilai diambil dari env OTB_*
#
# Opsi lain: --no-harden-host  --skip-telegram-check  --no-deps  --yes
# Env (mode non-interaktif): OTB_TELEGRAM_BOT_TOKEN OTB_TELEGRAM_USER_ID OTB_PROVIDER
#   OTB_MODEL OTB_API_KEY OTB_API_KEY_ENV (provider lain)  OTB_NODE_MIRROR
# Aman dijalankan ulang: konfigurasi, user, dan workspace yang sudah ada tidak ditimpa.
set -euo pipefail
umask 022

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=""
HARDEN_HOST=""        # "", 1, 0
ASSUME_YES=0
INTERACTIVE=1
RECONFIGURE=0
SKIP_TG_CHECK=0
INSTALL_DEPS=1

ETC_DIR=/etc/otb
OPT_DIR=/opt/otb
WORKSPACE=/srv/workspace
MANAGED_CONFIG=/etc/opencode/opencode.json
INSTALL_CONF="$ETC_DIR/install.conf"
AGENT_UID=10001   # Mode B saja
MIN_NODE="22.14.0"

log()  { printf '\033[1;34m[otb]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m[otb]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[otb] PERINGATAN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[otb] GAGAL:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --harden-host) HARDEN_HOST=1; shift ;;
    --no-harden-host) HARDEN_HOST=0; shift ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    --skip-telegram-check) SKIP_TG_CHECK=1; shift ;;
    --no-deps) INSTALL_DEPS=0; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) warn "Opsi tidak dikenal: $1"; usage 1 ;;
  esac
done
[[ $EUID -eq 0 ]] || die "Jalankan sebagai root (sudo $0)"
if [[ $INTERACTIVE -eq 1 ]] && ! { : </dev/tty; } 2>/dev/null; then
  INTERACTIVE=0
  log "Tidak ada terminal; berjalan non-interaktif (nilai diambil dari env OTB_*)."
fi

# --------------------------------------------------------------------------- helpers
random_secret() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }

env_value() { # env_value <file> <KEY>  -> value, empty if unset or commented out
  sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n1
}

set_env() { # set_env <file> <KEY> <VALUE>  -> replaces KEY= or "# KEY=", else appends
  local f="$1" k="$2" v="$3" tmp
  [[ "$v" =~ ^[A-Za-z0-9_.:/@+=,-]*$ ]] || die "Nilai untuk $k mengandung karakter yang tidak didukung."
  tmp="$(mktemp "$f.XXXXXX")"
  awk -v k="$k" -v v="$v" '
    BEGIN { done = 0 }
    $0 ~ "^#? *" k "=" { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }' "$f" > "$tmp"
  chmod 0600 "$tmp"; chown root:root "$tmp"; mv "$tmp" "$f"
}

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

ask() { # ask <prompt> <default>  -> answer on stdout
  local reply
  if [[ -n "$2" ]]; then printf '%s [%s]: ' "$1" "$2" >/dev/tty; else printf '%s: ' "$1" >/dev/tty; fi
  IFS= read -r reply </dev/tty || true
  printf '%s' "${reply:-$2}"
}

ask_secret() { # ask_secret <prompt>  -> answer on stdout, input hidden
  local reply
  printf '%s: ' "$1" >/dev/tty
  IFS= read -rs reply </dev/tty || true
  printf '\n' >/dev/tty
  printf '%s' "$reply"
}

ask_yes_no() { # ask_yes_no <prompt> <default y|n>
  local d="$2" reply
  [[ $ASSUME_YES -eq 1 ]] && return 0
  [[ $INTERACTIVE -eq 1 ]] || { [[ "$d" == y ]]; return; }
  reply="$(ask "$1 (y/n)" "$d")"
  [[ "$reply" =~ ^[YyJj] ]]
}

mask() { local s="$1"; [[ ${#s} -le 8 ]] && { printf '****'; return; }; printf '%s…%s' "${s:0:4}" "${s: -4}"; }

# Telegram calls pass the token through curl's stdin config, never on the command line,
# so it does not show up in `ps` for other users on the machine.
tg_api() { # tg_api <token> <method> [curl args...]
  local token="$1" method="$2"; shift 2
  printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$token" "$method" \
    | curl -sS --max-time 15 --config - "$@" 2>/dev/null
}

# --------------------------------------------------------------------------- providers
provider_key_env() {
  case "$1" in
    google) echo GOOGLE_GENERATIVE_AI_API_KEY ;;
    anthropic) echo ANTHROPIC_API_KEY ;;
    openai) echo OPENAI_API_KEY ;;
    openrouter) echo OPENROUTER_API_KEY ;;
    *) echo "" ;;
  esac
}
provider_default_model() {
  case "$1" in
    google) echo gemini-2.5-pro ;;
    anthropic) echo claude-sonnet-4-5 ;;
    openai) echo gpt-5 ;;
    openrouter) echo anthropic/claude-sonnet-4.5 ;;
    *) echo "" ;;
  esac
}

# --------------------------------------------------------------------------- mode
choose_mode() {
  local saved=""
  [[ -f "$INSTALL_CONF" ]] && saved="$(env_value "$INSTALL_CONF" MODE)"
  if [[ -z "$MODE" ]]; then
    if [[ -n "$saved" ]]; then
      MODE="$saved"
    elif [[ $INTERACTIVE -eq 1 ]]; then
      cat >/dev/tty <<'EOF'

Pilih mode sandbox:
  1) systemd  - tanpa tool tambahan, paling ringan (disarankan)
  2) docker   - isolasi penuh di container (Docker dipasang otomatis di Ubuntu)
EOF
      case "$(ask "Mode" 1)" in
        2|docker) MODE=docker ;;
        *) MODE=systemd ;;
      esac
    else
      MODE=systemd
    fi
  fi
  [[ "$MODE" == "systemd" || "$MODE" == "docker" ]] || die "--mode harus 'systemd' atau 'docker'"
  log "Mode: $MODE"
}

# --------------------------------------------------------------------------- dependencies
os_id() { ( . /etc/os-release 2>/dev/null; echo "${ID:-unknown}" ); }

apt_install() { # apt_install <pkg>...  (only the missing ones)
  local missing=() p
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [[ ${#missing[@]} -eq 0 ]] && return 0
  command -v apt-get >/dev/null || die "Paket berikut dibutuhkan: ${missing[*]} (apt-get tidak tersedia)."
  log "Memasang paket: ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
}

node_ok() {
  command -v node >/dev/null && command -v npm >/dev/null \
    && version_ge "$(node -p 'process.versions.node' 2>/dev/null || echo 0)" "$MIN_NODE"
}

# Node.js from the official release tarball, verified against the published SHA256 list.
# (No third-party apt repository and no piping a remote script into a shell.)
install_node() {
  node_ok && { log "Node.js $(node -v) sudah terpasang"; return 0; }
  [[ $INSTALL_DEPS -eq 1 ]] || die "Node.js >= $MIN_NODE dibutuhkan (dilewati karena --no-deps)."
  local arch mirror sums line file sha tmp version dest
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "Arsitektur $(uname -m) tidak didukung untuk instalasi Node otomatis." ;;
  esac
  mirror="${OTB_NODE_MIRROR:-https://nodejs.org/dist}"
  log "Mengunduh Node.js 22 LTS ($arch) dari $mirror"
  sums="$(curl -fsSL --max-time 60 "$mirror/latest-v22.x/SHASUMS256.txt")" || die "Gagal mengunduh daftar checksum Node.js."
  line="$(grep -E "  node-v22\.[0-9]+\.[0-9]+-linux-$arch\.tar\.xz$" <<<"$sums" | head -n1)"
  [[ -n "$line" ]] || die "Tarball Node.js untuk $arch tidak ditemukan di daftar checksum."
  sha="${line%%  *}"; file="${line##*  }"
  version="${file#node-}"; version="${version%-linux-*}"
  tmp="$(mktemp -d)"
  curl -fsSL --max-time 600 -o "$tmp/$file" "$mirror/latest-v22.x/$file" || { rm -rf "$tmp"; die "Gagal mengunduh $file"; }
  if ! (cd "$tmp" && printf '%s  %s\n' "$sha" "$file" | sha256sum -c --status); then
    rm -rf "$tmp"; die "Checksum $file TIDAK cocok. Instalasi dibatalkan."
  fi
  ok "Checksum Node.js $version cocok"
  dest="/usr/local/lib/nodejs/$version"
  install -d -m 0755 "$dest"
  tar -xJf "$tmp/$file" -C "$dest" --strip-components=1 --no-same-owner
  rm -rf "$tmp"
  ln -sfn "$dest" /usr/local/lib/nodejs/current
  for b in node npm npx; do ln -sfn "/usr/local/lib/nodejs/current/bin/$b" "/usr/local/bin/$b"; done
  hash -r
  node_ok || die "Node.js terpasang tapi tidak bisa dijalankan."
  ok "Node.js $(node -v) terpasang di $dest"
}

install_docker() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    log "Docker $(docker --version | awk '{print $3}' | tr -d ,) sudah terpasang"
    return 0
  fi
  [[ $INSTALL_DEPS -eq 1 ]] || die "Docker + Compose plugin dibutuhkan (dilewati karena --no-deps)."
  if [[ "$(os_id)" == "ubuntu" ]]; then
    apt_install docker.io docker-compose-v2
    systemctl enable --now docker >/dev/null 2>&1 || true
    docker compose version >/dev/null 2>&1 || die "Docker terpasang tapi 'docker compose' tidak tersedia."
    ok "Docker terpasang dari repositori resmi Ubuntu"
  else
    die "Pemasangan Docker otomatis hanya untuk Ubuntu. Pasang Docker Engine + Compose plugin sesuai https://docs.docker.com/engine/install/ lalu jalankan ulang."
  fi
}

install_dependencies() {
  [[ $INSTALL_DEPS -eq 1 ]] && apt_install curl ca-certificates git xz-utils
  if [[ "$MODE" == "systemd" ]]; then install_node; else install_docker; fi
}

# --------------------------------------------------------------------------- checks
preflight() {
  command -v systemctl >/dev/null || die "systemd dibutuhkan."
  case "$(os_id)" in
    ubuntu|debian) ;;
    *) warn "Hanya diuji di Ubuntu 24.04 / Debian 12 (terdeteksi: $(os_id))." ;;
  esac
  if [[ "$MODE" == "systemd" ]]; then
    if command -v docker >/dev/null && docker ps --format '{{.Names}}' 2>/dev/null | grep -qE '^otb-(bot|agent)$'; then
      die "Mode docker sedang berjalan. Hentikan dulu: otb uninstall, atau docker compose -f $REPO_DIR/docker-compose.yml down"
    fi
  elif systemctl is-active --quiet otb-bot.service 2>/dev/null || systemctl is-active --quiet otb-agent.service 2>/dev/null; then
    die "Mode systemd sedang berjalan. Hentikan dulu: systemctl disable --now otb-bot otb-agent"
  fi
}

# A root-owned dir mounted read-only for the agent. OpenCode writes a .gitignore into
# its config dirs on startup and fails on a read-only one unless the file already exists.
seed_readonly_opencode_dir() {
  install -d -m 0755 -o root -g root "$1"
  [[ -f "$1/.gitignore" ]] || printf 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n' > "$1/.gitignore"
  chown root:root "$1/.gitignore"; chmod 0644 "$1/.gitignore"
}

# --------------------------------------------------------------------------- shared config
install_shared_config() {
  log "Memasang kebijakan izin OpenCode -> $MANAGED_CONFIG"
  install -d -m 0755 -o root -g root /etc/opencode
  install -m 0644 -o root -g root "$REPO_DIR/config/opencode-managed.json" "$MANAGED_CONFIG"
  install -d -m 0755 -o root -g root "$ETC_DIR"

  local secret=""
  if [[ ! -f "$ETC_DIR/agent.env" || ! -f "$ETC_DIR/bot.env" ]]; then
    secret="$(random_secret)"
  fi
  for name in agent bot; do
    local target="$ETC_DIR/$name.env"
    if [[ ! -f "$target" ]]; then
      [[ -n "$secret" ]] || die "Hanya satu dari agent.env / bot.env yang ada; pulihkan yang lain atau hapus keduanya."
      sed "s/__GENERATED__/$secret/" "$REPO_DIR/config/$name.env.example" > "$target"
      chmod 0600 "$target"; chown root:root "$target"
    fi
  done
  local pa pb
  pa="$(env_value "$ETC_DIR/agent.env" OPENCODE_SERVER_PASSWORD)"
  pb="$(env_value "$ETC_DIR/bot.env" OPENCODE_SERVER_PASSWORD)"
  [[ -n "$pa" && "$pa" == "$pb" ]] || die "OPENCODE_SERVER_PASSWORD berbeda antara agent.env dan bot.env."

  # Git identity for commits made by the agent (it has no push credentials).
  install -d -m 0755 -o root -g root "$ETC_DIR/agent-xdg" "$ETC_DIR/agent-xdg/git" "$ETC_DIR/agent-xdg/opencode"
  if [[ ! -f "$ETC_DIR/agent-xdg/git/config" ]]; then
    cat > "$ETC_DIR/agent-xdg/git/config" <<'EOF'
[user]
	name = OpenCode Agent
	email = agent@localhost
[push]
	default = nothing
[core]
	hooksPath = /dev/null
EOF
    chmod 0644 "$ETC_DIR/agent-xdg/git/config"
  fi
  # The agent's global OpenCode config dir is read-only (no planted global plugins).
  # OpenCode only writes these files when they are missing, so pre-create them.
  seed_readonly_opencode_dir "$ETC_DIR/agent-xdg/opencode"
  [[ -f "$ETC_DIR/agent-xdg/opencode/opencode.jsonc" ]] \
    || printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$ETC_DIR/agent-xdg/opencode/opencode.jsonc"
  chmod 0644 "$ETC_DIR/agent-xdg/opencode/opencode.jsonc"
}

# --------------------------------------------------------------------------- wizard
configure_telegram() {
  local bot="$ETC_DIR/bot.env" token uid resp username
  token="$(env_value "$bot" TELEGRAM_BOT_TOKEN)"
  uid="$(env_value "$bot" TELEGRAM_ALLOWED_USER_ID)"
  [[ -n "${OTB_TELEGRAM_BOT_TOKEN:-}" ]] && token="$OTB_TELEGRAM_BOT_TOKEN"
  [[ -n "${OTB_TELEGRAM_USER_ID:-}" ]] && uid="$OTB_TELEGRAM_USER_ID"

  if [[ -z "$token" || $RECONFIGURE -eq 1 ]] && [[ $INTERACTIVE -eq 1 ]]; then
    printf '\n\033[1mTelegram\033[0m\n  Buat bot di @BotFather (/newbot), lalu salin tokennya.\n' >/dev/tty
    [[ -n "$token" ]] && printf '  Token saat ini: %s (Enter untuk tetap)\n' "$(mask "$token")" >/dev/tty
    while :; do
      local input; input="$(ask_secret "  Token bot")"
      [[ -z "$input" && -n "$token" ]] && break
      if [[ ! "$input" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then
        printf '  Format token tidak valid (contoh: 123456789:AA...).\n' >/dev/tty; continue
      fi
      if [[ $SKIP_TG_CHECK -eq 0 ]]; then
        resp="$(tg_api "$input" getMe || true)"
        if [[ "$resp" == *'"ok":true'* ]]; then
          username="$(sed -n 's/.*"username":"\([^"]*\)".*/\1/p' <<<"$resp")"
          printf '  \033[32m✓\033[0m Terhubung ke @%s\n' "$username" >/dev/tty
        elif [[ "$resp" == *'"ok":false'* ]]; then
          printf '  \033[31m✗\033[0m Telegram menolak token ini. Coba lagi.\n' >/dev/tty; continue
        else
          printf '  \033[33m!\033[0m Tidak bisa menghubungi api.telegram.org; token belum bisa dicek.\n' >/dev/tty
        fi
      fi
      token="$input"; break
    done
  fi

  if [[ -z "$uid" || $RECONFIGURE -eq 1 ]] && [[ $INTERACTIVE -eq 1 ]]; then
    printf '  User ID Telegram Anda: kirim pesan ke @userinfobot untuk melihatnya.\n' >/dev/tty
    while :; do
      local input; input="$(ask "  User ID" "$uid")"
      [[ "$input" =~ ^[0-9]{3,}$ ]] && { uid="$input"; break; }
      printf '  User ID harus berupa angka.\n' >/dev/tty
    done
  fi

  [[ -n "$token" ]] || die "Token bot Telegram belum diisi (set OTB_TELEGRAM_BOT_TOKEN untuk mode non-interaktif)."
  [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || die "Format token bot Telegram tidak valid."
  [[ "$uid" =~ ^[0-9]{3,}$ ]] || die "User ID Telegram belum diisi atau bukan angka (OTB_TELEGRAM_USER_ID)."
  if [[ $INTERACTIVE -eq 0 && $SKIP_TG_CHECK -eq 0 ]]; then
    resp="$(tg_api "$token" getMe || true)"
    [[ "$resp" == *'"ok":false'* ]] && die "Telegram menolak token bot."
  fi
  set_env "$bot" TELEGRAM_BOT_TOKEN "$token"
  set_env "$bot" TELEGRAM_ALLOWED_USER_ID "$uid"
}

configure_model() {
  local bot="$ETC_DIR/bot.env" agent="$ETC_DIR/agent.env"
  local provider model key_env key choice
  provider="$(env_value "$bot" OPENCODE_MODEL_PROVIDER)"
  model="$(env_value "$bot" OPENCODE_MODEL_ID)"
  [[ -n "${OTB_PROVIDER:-}" ]] && provider="$OTB_PROVIDER"
  [[ -n "${OTB_MODEL:-}" ]] && model="$OTB_MODEL"

  if [[ -z "$provider" || -z "$model" || $RECONFIGURE -eq 1 ]] && [[ $INTERACTIVE -eq 1 ]]; then
    cat >/dev/tty <<'EOF'

Model AI
  1) Google Gemini   2) Anthropic Claude   3) OpenAI   4) OpenRouter   5) Lainnya
EOF
    local def=1
    case "$provider" in anthropic) def=2 ;; openai) def=3 ;; openrouter) def=4 ;; google|"") def=1 ;; *) def=5 ;; esac
    choice="$(ask "  Provider" "$def")"
    case "$choice" in
      1) provider=google ;; 2) provider=anthropic ;; 3) provider=openai ;; 4) provider=openrouter ;;
      *) provider="$(ask "  ID provider OpenCode (mis. groq, mistral)" "$provider")" ;;
    esac
    local dm; dm="$(provider_default_model "$provider")"
    [[ -n "$model" && "$(env_value "$bot" OPENCODE_MODEL_PROVIDER)" == "$provider" ]] && dm="$model"
    model="$(ask "  ID model" "$dm")"
  fi
  [[ -z "$model" && -n "$provider" ]] && model="$(provider_default_model "$provider")"
  [[ -n "$provider" && -n "$model" ]] || die "Provider/model belum diisi (OTB_PROVIDER, OTB_MODEL)."

  key_env="$(provider_key_env "$provider")"
  [[ -n "$key_env" ]] || key_env="${OTB_API_KEY_ENV:-}"
  if [[ -z "$key_env" && $INTERACTIVE -eq 1 ]]; then
    key_env="$(ask "  Nama env variable API key untuk $provider (mis. GROQ_API_KEY)" "")"
  fi
  [[ "$key_env" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "Nama env API key tidak valid (OTB_API_KEY_ENV)."

  key="$(env_value "$agent" "$key_env")"
  [[ -n "${OTB_API_KEY:-}" ]] && key="$OTB_API_KEY"
  if [[ -z "$key" || $RECONFIGURE -eq 1 ]] && [[ $INTERACTIVE -eq 1 ]]; then
    printf '  Tips: pasang batas pengeluaran (spending limit) di dashboard provider.\n' >/dev/tty
    [[ -n "$key" ]] && printf '  API key saat ini: %s (Enter untuk tetap)\n' "$(mask "$key")" >/dev/tty
    local input; input="$(ask_secret "  API key ($key_env)")"
    [[ -n "$input" ]] && key="$input"
  fi
  [[ -n "$key" ]] || die "API key belum diisi (OTB_API_KEY)."

  set_env "$bot" OPENCODE_MODEL_PROVIDER "$provider"
  set_env "$bot" OPENCODE_MODEL_ID "$model"
  set_env "$agent" "$key_env" "$key"
}

choose_harden_host() {
  [[ -n "$HARDEN_HOST" ]] && return 0
  # Only ask once; later runs keep the earlier answer (use --harden-host to apply later).
  if [[ -f "$INSTALL_CONF" ]] && grep -q '^HARDEN_ASKED=1' "$INSTALL_CONF"; then HARDEN_HOST=0; return 0; fi
  if [[ $INTERACTIVE -eq 1 ]] && ! [[ -f /etc/ssh/sshd_config.d/10-otb-hardening.conf ]]; then
    printf '\n' >/dev/tty
    if ask_yes_no "Pasang firewall (ufw) dan SSH key-only? Rencananya ditampilkan dulu" n; then HARDEN_HOST=1; else HARDEN_HOST=0; fi
  else
    HARDEN_HOST=0
  fi
}

# --------------------------------------------------------------------------- Mode A
ensure_user() { # ensure_user <name> <home>
  id -u "$1" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$2" --no-create-home --shell /usr/sbin/nologin "$1"
}

npm_install_unprivileged() { # npm_install_unprivileged <src-dir> <dest-dir>
  local src="$1" dest="$2" tmp_home
  if [[ -d "$dest/node_modules" ]] && cmp -s "$src/package-lock.json" "$dest/package-lock.json"; then
    log "Paket di $dest sudah sesuai versi"
    return 0
  fi
  log "Memasang paket versi terkunci ke $dest (script npm berjalan sebagai user tanpa hak istimewa)"
  rm -rf "$dest.new"
  install -d -m 0755 -o otb-build -g otb-build "$dest.new"
  install -m 0644 -o otb-build -g otb-build "$src/package.json" "$src/package-lock.json" "$dest.new/"
  tmp_home="$(mktemp -d)"; chown otb-build:otb-build "$tmp_home"
  if ! runuser -u otb-build -- env HOME="$tmp_home" npm_config_cache="$tmp_home/.npm" PATH="$PATH" \
      npm ci --omit=dev --no-audit --no-fund --prefix "$dest.new" > "$tmp_home/npm.log" 2>&1; then
    tail -n 20 "$tmp_home/npm.log" >&2
    rm -rf "$tmp_home" "$dest.new"
    die "npm install gagal untuk $dest (log di atas). Cek akses ke registry.npmjs.org dan github.com (modul SQLite mengunduh binary dari sana; jika diblokir, pasang build-essential dan python3)."
  fi
  rm -rf "$tmp_home"
  chown -R root:root "$dest.new"
  chmod -R go-w "$dest.new"
  rm -rf "$dest"; mv "$dest.new" "$dest"
}

install_systemd_mode() {
  getent group otb-ws >/dev/null || groupadd --system otb-ws
  ensure_user otb-agent /var/lib/otb-agent
  ensure_user otb-bot /var/lib/otb-bot
  ensure_user otb-build /nonexistent
  if [[ ! -d "$WORKSPACE" ]]; then
    log "Membuat workspace $WORKSPACE (agen: baca-tulis, bot: baca saja)"
    install -d -m 2750 -o otb-agent -g otb-ws "$WORKSPACE"
  fi
  # Mount point that the agent unit makes read-only (blocks ~/.opencode/plugins).
  install -d -m 0700 -o otb-agent -g otb-agent /var/lib/otb-agent
  seed_readonly_opencode_dir /var/lib/otb-agent/.opencode

  install -d -m 0755 -o root -g root "$OPT_DIR"
  npm_install_unprivileged "$REPO_DIR/deploy/agent" "$OPT_DIR/agent"
  npm_install_unprivileged "$REPO_DIR/deploy/bot" "$OPT_DIR/bot"
  install -m 0644 "$REPO_DIR/README.md" "$OPT_DIR/README.md"

  install -m 0644 "$REPO_DIR/systemd/otb-agent.service" /etc/systemd/system/otb-agent.service
  install -m 0644 "$REPO_DIR/systemd/otb-bot.service" /etc/systemd/system/otb-bot.service
  systemctl daemon-reload
}

# --------------------------------------------------------------------------- Mode B
install_docker_mode() {
  seed_readonly_opencode_dir "$ETC_DIR/agent-dot-opencode"
  getent group "$AGENT_UID" >/dev/null || getent group otb-ws >/dev/null || groupadd --system --gid "$AGENT_UID" otb-ws
  if [[ ! -d "$WORKSPACE" ]]; then
    log "Membuat workspace $WORKSPACE untuk container"
    install -d -m 2750 -o "$AGENT_UID" -g "$AGENT_UID" "$WORKSPACE"
  else
    local owner; owner="$(stat -c '%u' "$WORKSPACE")"
    [[ "$owner" == "$AGENT_UID" ]] || warn "$WORKSPACE dimiliki uid $owner, bukan $AGENT_UID. Perbaiki: chown -R $AGENT_UID:$AGENT_UID $WORKSPACE && chmod 2750 $WORKSPACE"
  fi
  log "Membangun image Docker (beberapa menit pada instalasi pertama)"
  docker compose -f "$REPO_DIR/docker-compose.yml" build --quiet
}

# --------------------------------------------------------------------------- start
start_services() {
  if [[ "$MODE" == "systemd" ]]; then
    systemctl enable --quiet otb-agent.service otb-bot.service
    systemctl restart otb-agent.service
    systemctl restart otb-bot.service
  else
    docker compose -f "$REPO_DIR/docker-compose.yml" up -d --force-recreate --remove-orphans >/dev/null
  fi
}

opencode_api() { # opencode_api <path>  -> body (authenticated)
  local pw; pw="$(env_value "$ETC_DIR/agent.env" OPENCODE_SERVER_PASSWORD)"
  if [[ "$MODE" == "systemd" ]]; then
    printf 'user = "opencode:%s"\n' "$pw" | curl -sS --max-time 10 --config - "http://127.0.0.1:4096$1" 2>/dev/null
  else
    docker exec -e P="$1" otb-bot node -e '
      fetch("http://agent:4096" + process.env.P, {headers: {authorization: "Basic " +
        Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64")}})
        .then(r => r.text()).then(t => process.stdout.write(t)).catch(() => {});' 2>/dev/null
  fi
}

wait_for_agent() {
  for _ in $(seq 1 45); do
    [[ "$(opencode_api /config)" == \{* ]] && return 0
    sleep 2
  done
  return 1
}

check_model() { # soft check: is the configured model known to OpenCode?
  local provider model body
  provider="$(env_value "$ETC_DIR/bot.env" OPENCODE_MODEL_PROVIDER)"
  model="$(env_value "$ETC_DIR/bot.env" OPENCODE_MODEL_ID)"
  body="$(opencode_api /config/providers)"
  [[ "$body" == \{* ]] || return 0
  if command -v python3 >/dev/null; then
    python3 - "$body" "$provider" "$model" <<'PY' || warn "Model $provider/$model tidak dikenali OpenCode. Ubah dengan: otb reconfigure"
import json, sys
data, provider, model = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
providers = data.get("providers", data if isinstance(data, list) else [])
for p in providers:
    if p.get("id") == provider:
        models = p.get("models", {})
        if model in models:
            sys.exit(0)
        sample = ", ".join(sorted(models)[:8])
        print(f"  Model yang tersedia untuk {provider} (sebagian): {sample}", file=sys.stderr)
        sys.exit(1)
print(f"  Provider '{provider}' tidak aktif. Pastikan API key-nya benar.", file=sys.stderr)
sys.exit(1)
PY
  fi
}

notify_telegram() {
  [[ $SKIP_TG_CHECK -eq 1 ]] && return 0
  local token uid resp username
  token="$(env_value "$ETC_DIR/bot.env" TELEGRAM_BOT_TOKEN)"
  uid="$(env_value "$ETC_DIR/bot.env" TELEGRAM_ALLOWED_USER_ID)"
  username="$(tg_api "$token" getMe | sed -n 's/.*"username":"\([^"]*\)".*/\1/p' || true)"
  resp="$(tg_api "$token" sendMessage --data-urlencode "chat_id=$uid" \
    --data-urlencode "text=✅ Bot OpenCode aktif di $(hostname) (mode $MODE). Kirim /start untuk mulai." || true)"
  if [[ "$resp" == *'"ok":true'* ]]; then
    ok "Pesan uji terkirim ke Telegram Anda."
  elif [[ "$resp" == *"initiate"* || "$resp" == *"chat not found"* ]]; then
    warn "Buka t.me/${username:-bot-anda} dan tekan Start; bot belum boleh mengirim pesan pertama."
  else
    warn "Pesan uji ke Telegram gagal dikirim. Cek: otb logs bot"
  fi
}

# --------------------------------------------------------------------------- host hardening (opt-in)
harden_host() {
  local ssh_port has_keys=0 f
  ssh_port="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
  ssh_port="${ssh_port:-22}"
  [[ -s /root/.ssh/authorized_keys ]] && has_keys=1
  for f in /home/*/.ssh/authorized_keys; do [[ -s "$f" ]] && has_keys=1; done

  cat >&2 <<EOF

Rencana hardening host:
  1. ufw: tolak semua koneksi masuk, izinkan keluar, rate-limit SSH port $ssh_port/tcp.
  2. SSH: matikan login password; root hanya boleh login dengan key.
     $( [[ $has_keys -eq 1 ]] && echo "(authorized_keys ditemukan -> akan diterapkan)" || echo "(TIDAK ada authorized_keys -> DILEWATI agar Anda tidak terkunci)")
  Biarkan sesi SSH ini tetap terbuka sampai login baru berhasil diuji.
EOF
  if [[ $INTERACTIVE -eq 1 && $ASSUME_YES -eq 0 ]]; then
    [[ "$(ask "Ketik 'yes' untuk menerapkan" "")" == "yes" ]] || { warn "Hardening host dilewati."; return 0; }
  fi
  apt_install ufw
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw limit "$ssh_port/tcp" >/dev/null
  ufw --force enable >/dev/null
  ok "ufw aktif (SSH port $ssh_port diizinkan)"
  if [[ $has_keys -eq 1 ]]; then
    install -d -m 0755 /etc/ssh/sshd_config.d
    cat > /etc/ssh/sshd_config.d/10-otb-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
    if sshd -t 2>/dev/null; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd
      ok "SSH hanya menerima key. Uji login baru sebelum menutup sesi ini."
    else
      rm -f /etc/ssh/sshd_config.d/10-otb-hardening.conf
      warn "Tes konfigurasi sshd gagal; perubahan SSH dibatalkan."
    fi
  fi
}

save_install_conf() {
  printf 'MODE=%s\nREPO_DIR=%s\nHARDEN_ASKED=1\n' "$MODE" "$REPO_DIR" > "$INSTALL_CONF"
  chmod 0644 "$INSTALL_CONF"
  ln -sfn "$REPO_DIR/otb" /usr/local/bin/otb
}

# --------------------------------------------------------------------------- main
main() {
  [[ $INTERACTIVE -eq 1 ]] && printf '\n\033[1mOpenCode Telegram Bot — instalasi aman\033[0m\n' >/dev/tty
  choose_mode
  preflight
  install_dependencies
  install_shared_config
  configure_telegram
  configure_model
  choose_harden_host
  if [[ "$MODE" == "systemd" ]]; then install_systemd_mode; else install_docker_mode; fi
  save_install_conf
  [[ "$HARDEN_HOST" == 1 ]] && harden_host

  log "Menjalankan layanan"
  start_services
  wait_for_agent || die "OpenCode tidak merespons. Cek: otb logs agent"
  check_model
  log "Menjalankan uji keamanan (verify.sh)"
  local vlog; vlog="$(mktemp)"
  if "$REPO_DIR/verify.sh" >"$vlog" 2>&1; then
    ok "$(grep -a 'Result:' "$vlog" | sed 's/\x1b\[[0-9;]*m//g')"
    rm -f "$vlog"
  else
    sed 's/\x1b\[[0-9;]*m//g' "$vlog" | grep -aE 'FAIL' >&2 || true
    rm -f "$vlog"
    die "Ada uji keamanan yang gagal (detail: otb verify). Bot tetap berjalan; periksa sebelum dipakai."
  fi
  notify_telegram
  cat >&2 <<EOF

$(printf '\033[1;32m')Selesai.$(printf '\033[0m') Perintah berguna:
  otb status        status layanan
  otb logs bot      log bot (atau: otb logs agent)
  otb verify        uji keamanan
  otb reconfigure   ganti token / model / API key
  otb update        perbarui ke rilis terbaru
Workspace proyek: $WORKSPACE  (clone repo: otb clone <url>)
EOF
}

main
