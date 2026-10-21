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
#   OTB_MODEL OTB_API_KEY OTB_API_KEY_ENV (provider lain)  OTB_POLICY  OTB_NODE_MIRROR
#   OTB_CLONE="url ..."  OTB_SHARES="rw:/path ro:/path"
# Aman dijalankan ulang: konfigurasi, user, dan workspace yang sudah ada tidak ditimpa.
set -Eeuo pipefail
umask 022
trap 'printf "\033[1;31m[otb] GAGAL:\033[0m perintah tak terduga gagal (baris %s, exit %s): %s\n" "$LINENO" "$?" "$BASH_COMMAND" >&2' ERR

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Work from / so helpers running as unprivileged users never inherit an unreadable cwd.
cd /
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
# shellcheck source=lib/shares.sh
source "$REPO_DIR/lib/shares.sh"
# shellcheck source=lib/safety.sh
source "$REPO_DIR/lib/safety.sh"
# shellcheck source=lib/projects.sh
source "$REPO_DIR/lib/projects.sh"
random_secret() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }

env_value() { # env_value <file> <KEY>  -> value, empty if unset or commented out
  sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n1
}

set_env() { # set_env <file> <KEY> <VALUE>  -> replaces KEY= or "# KEY=", else appends
  local f="$1" k="$2" v="$3" tmp
  [[ "$v" =~ ^[A-Za-z0-9_.:/@+=,~-]*$ ]] || die "Nilai untuk $k mengandung karakter yang tidak didukung."
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
# Telegram API root: OTB_TELEGRAM_API_ROOT (e.g. a reverse proxy where api.telegram.org is
# blocked) is stored as the bot's TELEGRAM_API_ROOT so the bot and otb use it too.
TG_API_ROOT="${OTB_TELEGRAM_API_ROOT:-$(env_value "$ETC_DIR/bot.env" TELEGRAM_API_ROOT)}"
TG_API_ROOT="${TG_API_ROOT:-https://api.telegram.org}"
tg_api() { # tg_api <token> <method> [curl args...]
  local token="$1" method="$2"; shift 2
  printf 'url = "%s/bot%s/%s"\n' "$TG_API_ROOT" "$token" "$method" \
    | curl -sS --max-time 15 --config - "$@" 2>/dev/null
}

# --------------------------------------------------------------------------- providers
provider_key_env() {
  case "$1" in
    google) echo GOOGLE_GENERATIVE_AI_API_KEY ;;
    anthropic) echo ANTHROPIC_API_KEY ;;
    openai) echo OPENAI_API_KEY ;;
    openrouter) echo OPENROUTER_API_KEY ;;
    opencode|opencode-go) echo OPENCODE_API_KEY ;;
    deepseek) echo DEEPSEEK_API_KEY ;;
    *) echo "" ;;
  esac
}
provider_default_model() {
  case "$1" in
    google) echo gemini-2.5-pro ;;
    anthropic) echo claude-sonnet-4-5 ;;
    openai) echo gpt-5 ;;
    openrouter) echo anthropic/claude-sonnet-4.5 ;;
    opencode) echo space-bunny-free ;;
    deepseek) echo deepseek-v4-pro ;;
    *) echo "" ;;
  esac
}

# --------------------------------------------------------------------------- mode
choose_mode() {
  # systemd unless asked otherwise (--mode docker) or already installed in another mode.
  if [[ -z "$MODE" ]]; then
    [[ -f "$INSTALL_CONF" ]] && MODE="$(env_value "$INSTALL_CONF" MODE)"
    MODE="${MODE:-systemd}"
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

# Git config for the agent (read-only to it). Without push access, pushing has no default;
# with it (otb github-key), HTTPS GitHub remotes push over SSH with the agent's key.
write_agent_gitconfig() {
  local f="$ETC_DIR/agent-xdg/git/config" push_default=nothing push_url=""
  if [[ -f "$ETC_DIR/policy.conf" ]] && grep -q '^PUSH=1' "$ETC_DIR/policy.conf"; then
    push_default=simple
    push_url=$'[url "git@github.com:"]\n\tpushInsteadOf = https://github.com/\n'
  fi
  install -d -m 0755 -o root -g root "$ETC_DIR/agent-xdg/git"
  {
    printf '[user]\n\tname = OpenCode Agent\n\temail = agent@localhost\n'
    printf '[push]\n\tdefault = %s\n' "$push_default"
    printf '[core]\n\thooksPath = /dev/null\n'
    printf '%s' "$push_url"
    # Shared folders belong to another user; without this git refuses them ("dubious ownership").
    local sp
    while read -r _ sp; do printf '[safe]\n\tdirectory = %s\n' "$sp"; done < <(shares_list)
  } > "$f"
  chmod 0644 "$f"
}

# --------------------------------------------------------------------------- shared config
install_shared_config() {
  install -d -m 0755 -o root -g root /etc/opencode
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
  write_agent_gitconfig
  # The agent's global OpenCode config dir is read-only (no planted global plugins).
  # OpenCode only writes these files when they are missing, so pre-create them.
  seed_readonly_opencode_dir "$ETC_DIR/agent-xdg/opencode"
  [[ -f "$ETC_DIR/agent-xdg/opencode/opencode.jsonc" ]] \
    || printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$ETC_DIR/agent-xdg/opencode/opencode.jsonc"
  chmod 0644 "$ETC_DIR/agent-xdg/opencode/opencode.jsonc"
}

# --------------------------------------------------------------------------- wizard
# The person who sends the next message to the bot becomes its only allowed user (after they
# confirm the name). Old pending updates are skipped and the used ones are acknowledged, so the
# bot does not later treat this message as a prompt.
detect_telegram_user() { # detect_telegram_user <token>  -> prints the user id, or nothing
  local token="$1" botname offset=0 resp parsed id first user t0
  command -v node >/dev/null || return 0
  systemctl is-active --quiet otb-bot.service 2>/dev/null && systemctl stop otb-bot.service
  botname="$(tg_api "$token" getMe | tr -d ' ' | sed -n 's/.*"username":"\([^"]*\)".*/\1/p' || true)"
  resp="$(tg_api "$token" getUpdates --data "offset=-1" --data "timeout=0" || true)"
  offset="$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(0,"utf8")).result||[];console.log(r.length?r[r.length-1].update_id+1:0)}catch{console.log(0)}' <<<"$resp")"
  printf '\n\033[1m2. Akun Anda\033[0m\n  Kirim pesan apa saja ke @%s sekarang dari akun Telegram Anda…\n' "${botname:-bot-anda}" >/dev/tty
  t0=$(date +%s)
  while (( $(date +%s) - t0 < 180 )); do
    resp="$(printf 'url = "%s/bot%s/getUpdates"\n' "$TG_API_ROOT" "$token" \
      | curl -sS --max-time 30 --config - --data "offset=$offset" --data "timeout=20" 2>/dev/null || true)"
    parsed="$(node -e '
      try { const r = JSON.parse(require("fs").readFileSync(0, "utf8")).result || [];
        let next = Number(process.argv[1]), hit = "";
        for (const u of r) { next = u.update_id + 1; const m = u.message || u.edited_message;
          if (!hit && m && m.from && !m.from.is_bot) hit = [m.from.id, m.from.first_name || "", m.from.last_name || "", m.from.username || ""].join("\t"); }
        console.log(next + "\t" + hit);
      } catch { console.log(process.argv[1] + "\t"); }' "$offset" <<<"$resp")"
    offset="${parsed%%$'\t'*}"; parsed="${parsed#*$'\t'}"
    [[ -n "$parsed" ]] || continue
    IFS=$'\t' read -r id first last user <<<"$parsed"
    tg_api "$token" getUpdates --data "offset=$offset" --data "timeout=0" >/dev/null || true   # acknowledge
    if [[ "$(ask "  Terdeteksi: $first ${last:+$last }${user:+(@$user) }— ID $id. Ini Anda? (y/n)" y)" =~ ^[YyJj] ]]; then
      tg_api "$token" sendMessage --data-urlencode "chat_id=$id" \
        --data-urlencode "text=👋 Akun Anda terdaftar sebagai satu-satunya pengguna bot ini. Lanjutkan instalasi di terminal." >/dev/null || true
      printf '%s' "$id"; return 0
    fi
    printf '  Baik, kirim pesan lagi dari akun yang benar…\n' >/dev/tty
  done
  printf '  Tidak ada pesan masuk dalam 3 menit.\n' >/dev/tty
}

configure_telegram() {
  local bot="$ETC_DIR/bot.env" token uid resp username
  token="$(env_value "$bot" TELEGRAM_BOT_TOKEN)"
  uid="$(env_value "$bot" TELEGRAM_ALLOWED_USER_ID)"
  [[ -n "${OTB_TELEGRAM_BOT_TOKEN:-}" ]] && token="$OTB_TELEGRAM_BOT_TOKEN"
  [[ -n "${OTB_TELEGRAM_USER_ID:-}" ]] && uid="$OTB_TELEGRAM_USER_ID"

  if [[ -z "$token" || $RECONFIGURE -eq 1 ]] && [[ $INTERACTIVE -eq 1 ]]; then
    printf '\n\033[1m1. Bot Telegram\033[0m\n  Buat bot di @BotFather (/newbot), lalu salin tokennya.\n' >/dev/tty
    [[ -n "$token" ]] && printf '  Token saat ini: %s (Enter untuk tetap)\n' "$(mask "$token")" >/dev/tty
    while :; do
      local input; input="$(ask_secret "  Token bot")"
      [[ -z "$input" && -n "$token" ]] && break
      if [[ ! "$input" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then
        printf '  Format token tidak valid (contoh: 123456789:AA...).\n' >/dev/tty; continue
      fi
      if [[ $SKIP_TG_CHECK -eq 0 ]]; then
        resp="$(tg_api "$input" getMe | tr -d ' ' || true)"
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
    local detected=""
    if [[ $SKIP_TG_CHECK -eq 0 ]]; then
      if [[ -n "$uid" ]]; then
        [[ "$(ask "  Akun Telegram yang diizinkan: ID $uid. Ganti? (y/n)" n)" =~ ^[YyJj] ]] && detected="$(detect_telegram_user "$token")"
        [[ -z "$detected" ]] || uid="$detected"
      else
        detected="$(detect_telegram_user "$token")"; [[ -n "$detected" ]] && uid="$detected"
      fi
    fi
    while [[ ! "$uid" =~ ^[0-9]{3,}$ ]]; do
      printf '  Isi manual: kirim pesan ke @userinfobot untuk melihat user ID Anda.\n' >/dev/tty
      uid="$(ask "  User ID" "")"
    done
  fi

  [[ -n "$token" ]] || die "Token bot Telegram belum diisi (set OTB_TELEGRAM_BOT_TOKEN untuk mode non-interaktif)."
  [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || die "Format token bot Telegram tidak valid."
  [[ "$uid" =~ ^[0-9]{3,}$ ]] || die "User ID Telegram belum diisi atau bukan angka (OTB_TELEGRAM_USER_ID)."
  if [[ $INTERACTIVE -eq 0 && $SKIP_TG_CHECK -eq 0 ]]; then
    resp="$(tg_api "$token" getMe | tr -d ' ' || true)"
    [[ "$resp" == *'"ok":false'* ]] && die "Telegram menolak token bot."
  fi
  set_env "$bot" TELEGRAM_BOT_TOKEN "$token"
  set_env "$bot" TELEGRAM_ALLOWED_USER_ID "$uid"
  [[ -n "${OTB_TELEGRAM_API_ROOT:-}" ]] && set_env "$bot" TELEGRAM_API_ROOT "$OTB_TELEGRAM_API_ROOT"
  return 0
}

# Interactive picker over tab-separated rows. Prints the chosen first column.
# pick_from <title> <rows> <default-id> <label-fn>
#   Accepts a number, an exact ID, or a keyword that filters the list.
pick_from() {
  local title="$1" rows="$2" default_id="$3" fmt="$4" filter="" input shown ids=() i=0 line id def_n=""
  while :; do
    ids=(); i=0; def_n=""
    local view="$rows"
    [[ -n "$filter" ]] && view="$(grep -iF -- "$filter" <<<"$rows" || true)"
    if [[ -z "$view" ]]; then
      printf '  Tidak ada yang cocok dengan "%s".\n' "$filter" >/dev/tty; filter=""; continue
    fi
    shown=0
    printf '%s\n' "$title" >/dev/tty
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      id="${line%%$'\t'*}"; i=$((i+1)); ids+=("$id")
      [[ "$id" == "$default_id" ]] && def_n="$i"
      if (( shown < 30 )); then printf '  %3d) %s\n' "$i" "$("$fmt" "$line")" >/dev/tty; shown=$((shown+1)); fi
    done <<<"$view"
    (( i > shown )) && printf '       … %d lainnya. Ketik kata kunci untuk menyaring.\n' $((i - shown)) >/dev/tty
    input="$(ask "  Pilih nomor, ID, atau kata kunci" "${def_n:-}")"
    if [[ "$input" =~ ^[0-9]+$ ]] && (( input >= 1 && input <= i )); then
      printf '%s' "${ids[$((input-1))]}"; return 0
    fi
    for id in "${ids[@]}"; do [[ "$id" == "$input" ]] && { printf '%s' "$id"; return 0; }; done
    if [[ -n "$input" ]] && awk -F'\t' -v x="$input" '$1 == x { f = 1 } END { exit !f }' <<<"$rows"; then
      printf '%s' "$input"; return 0
    fi
    # Not in the list and matches nothing: the catalog may lag behind new models.
    if [[ -n "$input" && "$input" =~ ^[A-Za-z0-9_.:/@~-]+$ ]] && ! grep -qiF -- "$input" <<<"$rows"; then
      if [[ "$(ask "  \"$input\" tidak ada di daftar. Pakai apa adanya? (y/n)" n)" =~ ^[YyJj] ]]; then
        printf '%s' "$input"; return 0
      fi
      continue
    fi
    filter="$input"
  done
}

fmt_provider() { local id name _env n free; IFS=$'\t' read -r id name _env n free <<<"$1"
  if [[ "$id" == opencode ]]; then printf '%-22s %s' "$id" "OpenCode Zen: satu key untuk Claude, GPT, Gemini, DeepSeek, dll."; return; fi
  printf '%-22s %s (%s model%s)' "$id" "$name" "$n" "$( ((free > 0)) && printf ', %s gratis' "$free")"; }
fmt_model() { local id name free def; IFS=$'\t' read -r id name free def <<<"$1"
  printf '%-34s %s%s%s' "$id" "$name" "$( ((free)) && printf ' [gratis]')" "$( ((def)) && printf ' (default)')"; }

# Runs lib/catalog.mjs against the installed OpenCode. Exported provider keys are passed
# through so OpenCode can also list models that need a key (e.g. paid Zen models).
catalog() { # catalog providers | models <provider>   (retries: OpenCode startup is occasionally slow)
  local attempt out
  for attempt in 1 2 3; do
    out="$(catalog_once "$@" || true)"
    [[ -n "$out" ]] && { printf '%s\n' "$out"; return 0; }
    [[ $attempt -lt 3 && $INTERACTIVE -eq 1 ]] && printf '  …mencoba lagi\n' >/dev/tty
  done
  return 1
}

catalog_once() {
  local key_env="${CATALOG_KEY_ENV:-}"
  export OTB_CATALOG_TIMEOUT_MS="${OTB_CATALOG_TIMEOUT_MS:-30000}"
  if [[ "$MODE" == "systemd" ]]; then
    # cd: the caller's working directory (e.g. a home dir) may be unreadable for otb-build.
    (cd / && runuser -u otb-build -- env ${key_env:+"$key_env"="${!key_env:-}"} \
      node "$OPT_DIR/catalog.mjs" "$OPT_DIR/agent/node_modules/.bin/opencode" "$@" 2>/dev/null)
  else
    docker run --rm ${key_env:+-e "$key_env"} -e OTB_CATALOG_TIMEOUT_MS -v "$OPT_DIR/catalog.mjs:/catalog.mjs:ro" \
      --entrypoint node otb-agent:local /catalog.mjs /opt/otb/agent/node_modules/.bin/opencode "$@" 2>/dev/null
  fi
}

install_catalog_helper() {
  install -d -m 0755 -o root -g root "$OPT_DIR"
  install -m 0644 -o root -g root "$REPO_DIR/lib/catalog.mjs" "$OPT_DIR/catalog.mjs"
}

# Default Zen model: space-bunny-free (zero retention, no training, per OpenCode's Zen docs);
# falls back to the catalog's default if it ever disappears.
ZEN_DEFAULT_MODEL="${OTB_ZEN_DEFAULT_MODEL:-space-bunny-free}"
zen_default_model() { # zen_default_model <api-key>
  local models
  models="$(export OPENCODE_API_KEY="$1"; CATALOG_KEY_ENV=OPENCODE_API_KEY catalog models opencode || true)"
  if [[ -z "$models" ]] || awk -F'\t' -v m="$ZEN_DEFAULT_MODEL" '$1 == m { f = 1 } END { exit !f }' <<<"$models"; then
    printf '%s' "$ZEN_DEFAULT_MODEL"; return 0
  fi
  warn "Model $ZEN_DEFAULT_MODEL tidak ada lagi di katalog Zen; memakai default katalog."
  awk -F'\t' '$4 == 1 { print $1; exit }' <<<"$models"
}

configure_model() {
  local bot="$ETC_DIR/bot.env" agent="$ETC_DIR/agent.env"
  local provider model key_env key cur_provider providers="" models="" envs pick
  cur_provider="$(env_value "$bot" OPENCODE_MODEL_PROVIDER)"
  provider="${OTB_PROVIDER:-$cur_provider}"
  model="${OTB_MODEL:-$(env_value "$bot" OPENCODE_MODEL_ID)}"
  local ask_all=0
  [[ $INTERACTIVE -eq 1 && ( -z "$provider" || -z "$model" || $RECONFIGURE -eq 1 ) ]] && ask_all=1
  [[ -z "${OTB_PROVIDER:-}" && $ask_all -eq 0 && -z "$provider" ]] && provider=opencode

  install_catalog_helper
  # Simple path: OpenCode Zen with its key only; the model can be changed later with /model.
  if [[ $ask_all -eq 1 && ( -z "$cur_provider" || "$cur_provider" == opencode ) && -z "${OTB_PROVIDER:-}" ]]; then
    local zkey cur_key; cur_key="$(env_value "$agent" OPENCODE_API_KEY)"
    printf '\n\033[1m3. Model AI\033[0m — OpenCode Zen: satu API key untuk banyak model (Claude, GPT, Gemini, DeepSeek…)\n' >/dev/tty
    printf '  Buat key di https://opencode.ai/auth (key khusus VPS ini, pasang batas pemakaian).\n' >/dev/tty
    if [[ -n "$cur_key" ]]; then
      zkey="$(ask_secret "  API key ($(mask "$cur_key"); Enter = tetap, ketik lain = provider lain)")"
      [[ -z "$zkey" ]] && zkey="$cur_key"
    else
      zkey="$(ask_secret "  API key (ketik lain = provider lain)")"
    fi
    if [[ -n "$zkey" && "$zkey" != lain ]]; then
      provider=opencode key_env=OPENCODE_API_KEY key="$zkey"
      if [[ "$cur_provider" != opencode || -z "$model" ]]; then
        model="$(zen_default_model "$key")"
      fi
      set_env "$bot" OPENCODE_MODEL_PROVIDER "$provider"
      set_env "$bot" OPENCODE_MODEL_ID "$model"
      set_env "$agent" "$key_env" "$key"
      log "Model: $provider/$model (ganti kapan saja di Telegram: /model)"
      printf '  Rekomendasi lain: deepseek-v4.1-flash-free (gratis, lebih cepat; kebijakan datanya belum jelas,\n  cek https://opencode.ai/docs/zen sebelum dipakai untuk data sekolah).\n' >/dev/tty
      return 0
    fi
    provider=""
  fi
  if [[ $ask_all -eq 1 ]]; then
    printf '\n\033[1mModel AI\033[0m\n  Membaca katalog provider dari OpenCode…\n' >/dev/tty
    providers="$(catalog providers || true)"
    local quick="" q
    for q in opencode google anthropic openai openrouter deepseek groq mistral xai; do
      quick+="$(awk -F'\t' -v x="$q" '$1 == x { print; exit }' <<<"$providers")"$'\n'
    done
    quick="$(sed '/^$/d' <<<"$quick")"
    if [[ -n "$providers" ]]; then
      printf '  OpenCode Zen (opencode) = satu API key dari opencode.ai/auth untuk banyak model.\n' >/dev/tty
      quick+=$'\n'"cari"$'\t'"Cari provider lain ($(wc -l <<<"$providers") tersedia)"$'\t\t0\t0'
      pick="$(pick_from "  Provider:" "$quick" "${provider:-opencode}" fmt_provider_menu)"
      if [[ "$pick" == "cari" ]]; then
        pick="$(pick_from "  Semua provider (ketik kata kunci, mis. deep, kimi, zai):" "$providers" "" fmt_provider)"
      fi
      provider="$pick"
    else
      printf '  Katalog tidak bisa dibaca; isi manual.\n' >/dev/tty
      provider="$(ask "  ID provider OpenCode" "${provider:-opencode}")"
    fi
  fi
  [[ -n "$provider" ]] || die "Provider belum diisi (OTB_PROVIDER)."

  # Which env variable holds the key: catalog first, then built-in map, then ask.
  if [[ -z "$providers" && -z "${OTB_API_KEY_ENV:-}" && -z "$(provider_key_env "$provider")" ]]; then
    providers="$(catalog providers || true)"
  fi
  envs="$(awk -F'\t' -v p="$provider" '$1 == p { print $3 }' <<<"$providers")"
  key_env="${OTB_API_KEY_ENV:-}"
  if [[ -z "$key_env" && -n "$envs" ]]; then
    key_env="$(tr ',' '\n' <<<"$envs" | grep -m1 '_API_KEY$' || true)"
    [[ -n "$key_env" ]] || key_env="${envs%%,*}"
  fi
  [[ -n "$key_env" ]] || key_env="$(provider_key_env "$provider")"
  if [[ -z "$key_env" && $INTERACTIVE -eq 1 ]]; then
    key_env="$(ask "  Nama env variable API key untuk $provider" "")"
  fi
  [[ "$key_env" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "Nama env API key untuk $provider tidak diketahui (set OTB_API_KEY_ENV)."
  if [[ "$envs" == *,* && "$envs" != *_API_KEY* ]]; then
    warn "Provider $provider butuh beberapa variable ($envs). Lengkapi manual di $agent lalu jalankan: otb restart"
  fi

  key="${OTB_API_KEY:-$(env_value "$agent" "$key_env")}"
  if [[ $INTERACTIVE -eq 1 && ( -z "$key" || $ask_all -eq 1 ) ]]; then
    [[ "$provider" == opencode* ]] && printf '  Buat key di https://opencode.ai/auth (gunakan key terpisah khusus VPS ini).\n' >/dev/tty
    printf '  Tips: pasang batas pengeluaran di dashboard provider.\n' >/dev/tty
    [[ -n "$key" ]] && printf '  API key saat ini: %s (Enter untuk tetap)\n' "$(mask "$key")" >/dev/tty
    local input; input="$(ask_secret "  API key ($key_env)")"
    [[ -n "$input" ]] && key="$input"
  fi
  [[ -n "$key" ]] || die "API key belum diisi (OTB_API_KEY)."

  if [[ $ask_all -eq 1 || -z "$model" ]]; then
    [[ $ask_all -eq 1 ]] && printf '  Membaca daftar model %s…\n' "$provider" >/dev/tty
    models="$(export "$key_env=$key"; CATALOG_KEY_ENV="$key_env" catalog models "$provider" || true)"
    [[ -n "$models" ]] || models="$(catalog models "$provider" || true)"
  fi
  if [[ $ask_all -eq 1 ]]; then
    local def_model; def_model="$(awk -F'\t' '$4 == 1 { print $1; exit }' <<<"$models")"
    [[ "$cur_provider" == "$provider" && -n "$model" ]] && def_model="$model"
    if [[ -n "$models" ]]; then
      model="$(pick_from "  Model $provider:" "$models" "$def_model" fmt_model)"
      if awk -F'\t' -v m="$model" '$1 == m && $3 == 1 { f = 1 } END { exit !f }' <<<"$models"; then
        printf '  \033[33mCatatan:\033[0m sebagian model gratis memakai data Anda untuk training.\n  Cek https://opencode.ai/docs/zen sebelum dipakai untuk repo sensitif.\n' >/dev/tty
      fi
    else
      model="$(ask "  ID model" "${def_model:-$(provider_default_model "$provider")}")"
    fi
  elif [[ -z "$model" ]]; then
    if [[ "$provider" == opencode ]]; then model="$(zen_default_model "$key")"
    else
      model="$(awk -F'\t' '$4 == 1 { print $1; exit }' <<<"$models")"
      [[ -n "$model" ]] || model="$(provider_default_model "$provider")"
    fi
  fi
  [[ -n "$model" ]] || die "Model belum diisi (OTB_MODEL)."

  set_env "$bot" OPENCODE_MODEL_PROVIDER "$provider"
  set_env "$bot" OPENCODE_MODEL_ID "$model"
  set_env "$agent" "$key_env" "$key"
  log "Model: $provider/$model"
}

fmt_provider_menu() { local id name _rest; IFS=$'\t' read -r id name _rest <<<"$1"
  if [[ "$id" == cari ]]; then printf '%s' "$name"; else fmt_provider "$1"; fi; }

# Approval policy. The choice lives in /etc/otb/policy.conf so updates keep it;
# /etc/otb/policy-custom.json (if present) is used verbatim as the "custom" preset.
POLICY_CONF="$ETC_DIR/policy.conf"
POLICY_CUSTOM="$ETC_DIR/policy-custom.json"

choose_policy() {
  local current=""
  [[ -f "$POLICY_CONF" ]] && current="$(env_value "$POLICY_CONF" POLICY)"
  # No question: "penuh" when the agent works on production folders (safety nets cover it),
  # "otomatis" otherwise. Change any time with: otb policy <name>
  local fallback=otomatis
  [[ -n "$(rw_shares)" ]] && fallback=penuh
  current="${OTB_POLICY:-${current:-$fallback}}"
  case "$current" in otomatis|seimbang|ketat|penuh) ;; custom) [[ -f "$POLICY_CUSTOM" ]] || die "Preset custom butuh $POLICY_CUSTOM" ;;
    *) die "Kebijakan tidak dikenal: $current (otomatis|seimbang|ketat|penuh|custom)" ;; esac
  conf_set "$POLICY_CONF" POLICY "$current"
}

conf_set() { # conf_set <file> <KEY> <VALUE>  -> world-readable key=value file, other keys kept
  local f="$1" k="$2" v="$3"
  touch "$f"
  { grep -v "^$k=" "$f" || true; printf '%s=%s\n' "$k" "$v"; } > "$f.tmp"
  chmod 0644 "$f.tmp"; mv "$f.tmp" "$f"
}

apply_policy() {
  local name src
  name="$(env_value "$POLICY_CONF" POLICY)"
  # After `otb github-key` (PUSH=1) the -push variant lets git push ask instead of deny.
  local suffix=""
  [[ "$(env_value "$POLICY_CONF" PUSH)" == 1 ]] && suffix="-push"
  if [[ "$name" == custom ]]; then src="$POLICY_CUSTOM"; else src="$REPO_DIR/config/policies/$name$suffix.json"; fi
  [[ -f "$src" ]] || die "File kebijakan tidak ditemukan: $src"
  node_or_python_json_ok "$src" || die "$src bukan JSON yang valid."
  # Write in place (same inode): Docker mode bind-mounts this single file.
  [[ -f "$MANAGED_CONFIG" ]] || install -m 0644 -o root -g root /dev/null "$MANAGED_CONFIG"
  cat "$src" > "$MANAGED_CONFIG"
  # With a writable share (option C) the agent may read/edit .env files, after approval.
  if shares_has_rw && command -v node >/dev/null; then
    node -e '
      const fs = require("fs"); const f = process.argv[1];
      const c = JSON.parse(fs.readFileSync(f, "utf8")); const p = c.permission;
      for (const tool of ["read", "edit"]) {
        if (p[tool] && typeof p[tool] === "object") for (const k of ["*.env", "*.env.*"]) if (p[tool][k] === "deny") p[tool][k] = "ask";
      }
      fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");' "$MANAGED_CONFIG"
    if [[ "$name" == penuh ]]; then log "Kebijakan persetujuan: $name"
    else log "Kebijakan persetujuan: $name (+ .env boleh dibaca/diedit setelah disetujui)"; fi
  else
    log "Kebijakan persetujuan: $name"
  fi
}

node_or_python_json_ok() {
  if command -v python3 >/dev/null; then python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null
  elif command -v node >/dev/null; then node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1" 2>/dev/null
  else return 0; fi
}

choose_harden_host() { # only on request (--harden-host); a hint is printed at the end otherwise
  [[ -n "$HARDEN_HOST" ]] || HARDEN_HOST=0
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

# Earlier versions of verify.sh left OpenCode's "global" project pointing at a deleted test
# folder, so the bot opened sessions there and failed with "FileSystem.realPath ... ENOENT".
# Point it back to "/" (OpenCode's own default) with OpenCode's database tool. Idempotent.
repair_stale_test_project() {
  # One statement per call: `opencode db` only runs the first statement it is given.
  # FKs are enforced and cascade, so deleting a project or session removes its messages too.
  local p="'/srv/workspace/.otb-verify-%'"
  local stmts=(
    "DELETE FROM session WHERE directory LIKE $p"
    "DELETE FROM project_directory WHERE directory LIKE $p"
    "DELETE FROM workspace WHERE directory LIKE $p"
    "DELETE FROM project WHERE id <> 'global' AND worktree LIKE $p"
    "UPDATE project SET worktree='/', vcs=NULL WHERE id='global' AND worktree LIKE $p"
  )
  # The bot also remembers the project/session it last used (settings.json); drop entries
  # that point into the deleted test folder so it stops reattaching to it on startup.
  local js='
    const fs = require("fs");
    for (const f of process.argv.slice(1)) {
      let s; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
      const bad = (p) => typeof p === "string" && p.startsWith("/srv/workspace/.otb-verify-");
      let changed = false;
      if (bad(s.currentProject?.worktree)) { delete s.currentProject; changed = true; }
      if (bad(s.currentSession?.directory)) { delete s.currentSession; changed = true; }
      if (changed) { fs.writeFileSync(f, JSON.stringify(s, null, 2)); console.log("repaired " + f); }
    }'
  local q
  if [[ "$MODE" == "systemd" ]]; then
    systemctl stop otb-bot.service otb-agent.service 2>/dev/null || true
    if [[ -f /var/lib/otb-agent/.local/share/opencode/opencode.db ]]; then
      for q in "${stmts[@]}"; do
        (cd / && runuser -u otb-agent -- env HOME=/var/lib/otb-agent XDG_CONFIG_HOME="$ETC_DIR/agent-xdg" \
          XDG_DATA_HOME=/var/lib/otb-agent/.local/share OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
          "$OPT_DIR/agent/node_modules/.bin/opencode" db "$q" >/dev/null 2>&1) || true
      done
    fi
    if [[ -d /var/lib/otb-bot ]]; then
      (cd / && runuser -u otb-bot -- node -e "$js" /var/lib/otb-bot/settings.json /var/lib/otb-bot/settings.json.bak) || true
    fi
  else
    local compose=(docker compose -f "$REPO_DIR/docker-compose.yml")
    "${compose[@]}" stop bot agent >/dev/null 2>&1 || true
    if docker volume inspect otb_agent-home >/dev/null 2>&1; then
      for q in "${stmts[@]}"; do
        "${compose[@]}" run --rm --no-deps -T -e OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
          --entrypoint /opt/otb/agent/node_modules/.bin/opencode agent db "$q" >/dev/null 2>&1 || true
      done
    fi
    if docker volume inspect otb_bot-data >/dev/null 2>&1; then
      "${compose[@]}" run --rm --no-deps -T --entrypoint node bot -e "$js" /data/settings.json /data/settings.json.bak || true
    fi
  fi
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
  username="$(tg_api "$token" getMe | tr -d ' ' | sed -n 's/.*"username":"\([^"]*\)".*/\1/p' || true)"
  resp="$(tg_api "$token" sendMessage --data-urlencode "chat_id=$uid" \
    --data-urlencode "text=✅ Bot OpenCode aktif di $(hostname) (mode $MODE). Kirim /start untuk mulai." | tr -d ' ' || true)"
  if [[ "$resp" == *'"ok":true'* ]]; then
    ok "Pesan uji terkirim ke Telegram Anda."
  elif [[ "$resp" == *"initiate"* || "$resp" == *"chatnotfound"* ]]; then
    warn "Buka t.me/${username:-bot-anda} dan tekan Start; bot belum boleh mengirim pesan pertama."
  else
    warn "Pesan uji ke Telegram gagal dikirim. Cek: otb logs bot"
  fi
}

# --------------------------------------------------------------------------- host hardening (opt-in)
# SSH ports to keep open. Several sources, because on Ubuntu 24.04 ssh is socket-activated:
# `sshd -T` then fails until /run/sshd exists, and the real listener is ssh.socket.
detect_ssh_ports() {
  local ports=() p conn
  install -d -m 0755 /run/sshd 2>/dev/null || true   # what ssh.service itself creates on start
  while read -r p; do ports+=("$p"); done < <( (sshd -T 2>/dev/null || true) | awk '/^port /{print $2}')
  while read -r p; do ports+=("$p"); done < <( (systemctl show ssh.socket -p Listen --value 2>/dev/null || true) \
    | grep -oE ':[0-9]+ ' | tr -d ': ')
  # The port this very session came in on: never lock out the person running the installer.
  conn="${OTB_SSH_CONNECTION:-${SSH_CONNECTION:-}}"
  [[ -n "$conn" ]] && ports+=("$(awk '{print $4}' <<<"$conn")")
  [[ ${#ports[@]} -gt 0 ]] || ports=(22)
  printf '%s\n' "${ports[@]}" | grep -E '^[0-9]+$' | sort -un | tr '\n' ' '
}

harden_host() {
  local ssh_ports has_keys=0 f p
  ssh_ports="$(detect_ssh_ports)"
  [[ -s /root/.ssh/authorized_keys ]] && has_keys=1
  for f in /home/*/.ssh/authorized_keys; do [[ -s "$f" ]] && has_keys=1; done

  cat >&2 <<EOF

Rencana hardening host:
  1. ufw: tolak semua koneksi masuk, izinkan keluar, rate-limit SSH port: ${ssh_ports% }.
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
  for p in $ssh_ports; do ufw limit "$p/tcp" >/dev/null; done
  ufw --force enable >/dev/null
  ok "ufw aktif (SSH port ${ssh_ports% } diizinkan)"
  if [[ $has_keys -eq 1 ]]; then
    install -d -m 0755 /etc/ssh/sshd_config.d
    # 10- sorts before cloud images' 50-cloud-init.conf; sshd uses the first value it reads.
    cat > /etc/ssh/sshd_config.d/10-otb-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
    if sshd -t 2>/dev/null; then
      # Socket-activated ssh reads the config on every new connection; reload if a daemon runs.
      systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
      ok "SSH hanya menerima key. Uji login baru sebelum menutup sesi ini."
    else
      rm -f /etc/ssh/sshd_config.d/10-otb-hardening.conf
      warn "Tes konfigurasi sshd gagal; perubahan SSH dibatalkan."
    fi
  fi
  return 0
}

save_install_conf() {
  # Code under /opt/otb is run by root later (otb, update): keep it root-only writable.
  if [[ "$REPO_DIR" == /opt/otb/* ]]; then chown -R root:root "$REPO_DIR"; chmod -R go-w "$REPO_DIR"; fi
  printf 'MODE=%s\nREPO_DIR=%s\nHARDEN_ASKED=1\n' "$MODE" "$REPO_DIR" > "$INSTALL_CONF"
  chmod 0644 "$INSTALL_CONF"
  ln -sfn "$REPO_DIR/otb" /usr/local/bin/otb
}

# Snapshots + database backups for writable shares (lib/safety.sh); first run happens now.
setup_safety_nets() {
  local p snap bk
  [[ "$MODE" == systemd ]] || return 0
  safety_load
  while read -r p; do db_info "$p" && ensure_db_tools "$DB_CONNECTION"; done < <(rw_shares)
  # otb must be on PATH for the timers before they first fire.
  ln -sfn "$REPO_DIR/otb" /usr/local/bin/otb
  install_safety_timers
  while read -r p; do
    snap="$(snapshot_one "$p" "awal (instalasi)")"
    ok "Snapshot file $p: ${snap:0:7}${snap:+ }(tiap 5 menit, disimpan $SNAPSHOT_KEEP_DAYS hari)"
    if bk="$(backup_one "$p")" && [[ -n "$bk" ]]; then
      ok "Backup database $p: $(basename "$bk") (tiap jam)"
    else
      warn "Backup database $p belum berhasil; cek: otb backup $p"
    fi
  done < <(rw_shares)
}

# Telegram-managed projects (lib/projects.sh): registry, /akses_ /tutup_ commands, units.
setup_projects() {
  local p slug
  [[ "$MODE" == systemd ]] || return 0
  projects_sync
  for p in ${DECLINED_PROJECTS:-}; do
    slug="$(awk -v p="$p" '$3 == p { print $1 }' "$PROJECTS_CONF")"
    [[ -n "$slug" ]] && project_set_state "$slug" offered
  done
  write_project_commands
  install_project_units
}

# Option A: repositories to clone into the workspace right away (more later: otb clone <url>).
clone_repos() {
  local urls="${OTB_CLONE:-}" u name
  for u in $urls; do
    name="$(basename "$u")"; name="${name%.git}"
    if [[ -d "$WORKSPACE/$name" ]]; then log "$WORKSPACE/$name sudah ada; dilewati."; continue; fi
    "$REPO_DIR/otb" clone "$u" >/dev/null 2>&1 && ok "Di-clone: $WORKSPACE/$name" \
      || warn "Gagal clone $u (repo privat? jalankan dulu: otb github-key, lalu otb clone $u)"
  done
}

print_summary() {
  local shared offered
  shared="$(awk '$2 == "shared" { n++ } END { print n + 0 }' "$PROJECTS_CONF" 2>/dev/null || echo 0)"
  offered="$(awk '$2 != "shared" { n++ } END { print n + 0 }' "$PROJECTS_CONF" 2>/dev/null || echo 0)"
  cat >&2 <<EOF

$(printf '\033[1;32m')Selesai.$(printf '\033[0m') Lanjutkan dari Telegram:
  /open            pilih proyek, lalu kirim tugas
  /daftar_akses    proyek yang bisa diakses agen ($shared terbuka, $offered tertutup)
  /model           ganti model AI
Di server:  otb  (ringkasan & perintah penting)
EOF
  [[ "$HARDEN_HOST" == 1 ]] || ufw status 2>/dev/null | grep -q "Status: active" \
    || printf '  Saran: aktifkan firewall & SSH key-only dengan: sudo %s/install.sh --harden-host\n' "$REPO_DIR" >&2
}

# --------------------------------------------------------------------------- main
main() {
  [[ $INTERACTIVE -eq 1 ]] && printf '\n\033[1mOpenCode Telegram Bot — instalasi aman\033[0m\n' >/dev/tty
  choose_mode
  preflight
  install_dependencies
  install_shared_config
  configure_telegram
  if [[ "$MODE" == "systemd" ]]; then install_systemd_mode; else install_docker_mode; fi
  configure_model
  configure_shares
  apply_shares
  setup_safety_nets
  setup_projects
  write_agent_gitconfig
  choose_policy
  apply_policy
  choose_harden_host
  save_install_conf
  [[ "$HARDEN_HOST" == 1 ]] && harden_host

  log "Menjalankan layanan"
  repair_stale_test_project
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
  clone_repos
  notify_telegram
  # Projects not decided yet (e.g. after an update) are offered in Telegram right away.
  [[ "$MODE" == systemd && $SKIP_TG_CHECK -eq 0 ]] && "$REPO_DIR/otb" detect --notify >/dev/null 2>&1 || true
  print_summary
}

main
