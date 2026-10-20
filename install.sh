#!/usr/bin/env bash
# Hardened installer for opencode-telegram-bot + OpenCode.
#
#   sudo ./install.sh                      # Mode A: systemd sandbox (default, no extra tools)
#   sudo ./install.sh --mode docker        # Mode B: Docker sandbox (optional)
#   sudo ./install.sh --harden-host        # also configure ufw + SSH (asks first)
#
# Safe to re-run: existing env files, users and workspace are never overwritten.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="systemd"
HARDEN_HOST=0
ASSUME_YES=0

ETC_DIR=/etc/otb
OPT_DIR=/opt/otb
WORKSPACE=/srv/workspace
MANAGED_CONFIG=/etc/opencode/opencode.json
AGENT_UID=10001   # Docker mode only
MIN_NODE="22.14.0"

log()  { printf '\033[1;34m[otb]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[otb] WARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[otb] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --harden-host) HARDEN_HOST=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) warn "Unknown option: $1"; usage 1 ;;
  esac
done
[[ "$MODE" == "systemd" || "$MODE" == "docker" ]] || die "--mode must be 'systemd' or 'docker'"
[[ $EUID -eq 0 ]] || die "Run as root (sudo ./install.sh)"

confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  local reply
  read -r -p "$1 Type 'yes' to continue: " reply
  [[ "$reply" == "yes" ]]
}

random_secret() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }

env_value() { # env_value <file> <KEY>  -> prints value (empty if unset/commented)
  sed -n "s/^$2=//p" "$1" | tail -n1
}

version_ge() { # version_ge A B  -> true if A >= B
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

# --------------------------------------------------------------------------- checks
preflight() {
  command -v systemctl >/dev/null || die "systemd is required."
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    [[ "${ID:-} ${ID_LIKE:-}" == *debian* || "${ID:-}" == "ubuntu" ]] \
      || warn "Tested on Ubuntu 24.04 / Debian 12 only (found: ${PRETTY_NAME:-unknown})."
  fi

  if [[ "$MODE" == "systemd" ]]; then
    command -v node >/dev/null || die "Node.js >= $MIN_NODE is required. Install Node 22 LTS first (see README)."
    command -v npm >/dev/null || die "npm is required."
    local nv; nv="$(node -p 'process.versions.node')"
    version_ge "$nv" "$MIN_NODE" || die "Node.js $nv is too old; need >= $MIN_NODE."
    if command -v docker >/dev/null && docker ps --format '{{.Names}}' 2>/dev/null | grep -qE '^otb-(bot|agent)'; then
      die "Mode B (Docker) is running. Stop it first: docker compose -f $REPO_DIR/docker-compose.yml down"
    fi
  else
    command -v docker >/dev/null || die "Docker is required for --mode docker."
    docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is required."
    if systemctl is-active --quiet otb-bot.service || systemctl is-active --quiet otb-agent.service; then
      die "Mode A (systemd) is running. Stop it first: systemctl disable --now otb-bot otb-agent"
    fi
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
  log "Installing OpenCode managed permission policy -> $MANAGED_CONFIG"
  install -d -m 0755 -o root -g root /etc/opencode
  install -m 0644 -o root -g root "$REPO_DIR/config/opencode-managed.json" "$MANAGED_CONFIG"

  install -d -m 0755 -o root -g root "$ETC_DIR"

  local secret=""
  if [[ ! -f "$ETC_DIR/agent.env" || ! -f "$ETC_DIR/bot.env" ]]; then
    secret="$(random_secret)"
  fi
  for name in agent bot; do
    local target="$ETC_DIR/$name.env"
    if [[ -f "$target" ]]; then
      log "Keeping existing $target"
    else
      [[ -n "$secret" ]] || die "Only one of agent.env / bot.env exists; restore the other or delete both."
      log "Creating $target (0600, generated server password)"
      sed "s/__GENERATED__/$secret/" "$REPO_DIR/config/$name.env.example" > "$target"
      chmod 0600 "$target"; chown root:root "$target"
    fi
  done

  local pa pb
  pa="$(env_value "$ETC_DIR/agent.env" OPENCODE_SERVER_PASSWORD)"
  pb="$(env_value "$ETC_DIR/bot.env" OPENCODE_SERVER_PASSWORD)"
  [[ -n "$pa" && "$pa" == "$pb" ]] || die "OPENCODE_SERVER_PASSWORD differs between agent.env and bot.env."

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
  # OpenCode's global config dir is read-only for the agent (so it cannot plant global
  # plugins). OpenCode only writes these files when they are missing, so pre-create them.
  seed_readonly_opencode_dir "$ETC_DIR/agent-xdg/opencode"
  [[ -f "$ETC_DIR/agent-xdg/opencode/opencode.jsonc" ]] \
    || printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$ETC_DIR/agent-xdg/opencode/opencode.jsonc"
  chmod 0644 "$ETC_DIR/agent-xdg/opencode/opencode.jsonc"
}

# --------------------------------------------------------------------------- Mode A
ensure_user() { # ensure_user <name> <home>
  if ! id -u "$1" >/dev/null 2>&1; then
    log "Creating system user $1"
    useradd --system --user-group --home-dir "$2" --no-create-home --shell /usr/sbin/nologin "$1"
  fi
}

npm_install_unprivileged() { # npm_install_unprivileged <src-dir> <dest-dir>
  local src="$1" dest="$2" tmp_home
  if [[ -d "$dest/node_modules" ]] && cmp -s "$src/package-lock.json" "$dest/package-lock.json"; then
    log "Pinned packages in $dest are up to date"
    return 0
  fi
  log "Installing pinned packages into $dest (install scripts run as unprivileged user)"
  rm -rf "$dest.new"
  install -d -m 0755 -o otb-build -g otb-build "$dest.new"
  install -m 0644 -o otb-build -g otb-build "$src/package.json" "$src/package-lock.json" "$dest.new/"
  tmp_home="$(mktemp -d)"; chown otb-build:otb-build "$tmp_home"
  if ! runuser -u otb-build -- env HOME="$tmp_home" npm_config_cache="$tmp_home/.npm" \
      npm ci --omit=dev --no-audit --no-fund --prefix "$dest.new" > "$tmp_home/npm.log" 2>&1; then
    tail -n 20 "$tmp_home/npm.log" >&2
    rm -rf "$tmp_home" "$dest.new"
    die "npm install failed for $dest (log above). Check access to registry.npmjs.org. The bot's SQLite module also downloads a prebuilt binary from github.com; if that is blocked, install build-essential and python3 so it can compile."
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
    log "Creating workspace $WORKSPACE (agent: read-write, bot: read-only)"
    install -d -m 2750 -o otb-agent -g otb-ws "$WORKSPACE"
  fi
  # Mount point that the agent unit makes read-only (blocks ~/.opencode/plugins).
  install -d -m 0700 -o otb-agent -g otb-agent /var/lib/otb-agent
  seed_readonly_opencode_dir /var/lib/otb-agent/.opencode

  install -d -m 0755 -o root -g root "$OPT_DIR"
  npm_install_unprivileged "$REPO_DIR/deploy/agent" "$OPT_DIR/agent"
  npm_install_unprivileged "$REPO_DIR/deploy/bot" "$OPT_DIR/bot"
  install -m 0644 "$REPO_DIR/README.md" "$OPT_DIR/README.md"

  log "Installing systemd units"
  install -m 0644 "$REPO_DIR/systemd/otb-agent.service" /etc/systemd/system/otb-agent.service
  install -m 0644 "$REPO_DIR/systemd/otb-bot.service" /etc/systemd/system/otb-bot.service
  systemctl daemon-reload
}

# --------------------------------------------------------------------------- Mode B
install_docker_mode() {
  # Empty, read-only dir mounted over ~/.opencode in the agent container (blocks plugins).
  seed_readonly_opencode_dir "$ETC_DIR/agent-dot-opencode"
  # Named host group for the container workspace gid, so you can add your own user to it.
  getent group "$AGENT_UID" >/dev/null || getent group otb-ws >/dev/null || groupadd --system --gid "$AGENT_UID" otb-ws
  if [[ ! -d "$WORKSPACE" ]]; then
    log "Creating workspace $WORKSPACE for containers (uid $AGENT_UID rw, bot read-only)"
    install -d -m 2750 -o "$AGENT_UID" -g "$AGENT_UID" "$WORKSPACE"
  else
    local owner; owner="$(stat -c '%u' "$WORKSPACE")"
    [[ "$owner" == "$AGENT_UID" ]] || warn "$WORKSPACE is owned by uid $owner, not $AGENT_UID. Fix with: chown -R $AGENT_UID:$AGENT_UID $WORKSPACE && chmod 2750 $WORKSPACE"
  fi
  log "Building images"
  docker compose -f "$REPO_DIR/docker-compose.yml" build
}

# --------------------------------------------------------------------------- start
config_complete() {
  local missing=()
  [[ -n "$(env_value "$ETC_DIR/bot.env" TELEGRAM_BOT_TOKEN)" ]] || missing+=("TELEGRAM_BOT_TOKEN in $ETC_DIR/bot.env")
  [[ -n "$(env_value "$ETC_DIR/bot.env" TELEGRAM_ALLOWED_USER_ID)" ]] || missing+=("TELEGRAM_ALLOWED_USER_ID in $ETC_DIR/bot.env")
  [[ -n "$(env_value "$ETC_DIR/bot.env" OPENCODE_MODEL_PROVIDER)" ]] || missing+=("OPENCODE_MODEL_PROVIDER in $ETC_DIR/bot.env")
  [[ -n "$(env_value "$ETC_DIR/bot.env" OPENCODE_MODEL_ID)" ]] || missing+=("OPENCODE_MODEL_ID in $ETC_DIR/bot.env")
  grep -qE '^[A-Z_]*API_KEY=.+' "$ETC_DIR/agent.env" || missing+=("one provider API key in $ETC_DIR/agent.env")
  if [[ ${#missing[@]} -gt 0 ]]; then
    warn "Not starting yet. Fill in:"
    printf '   - %s\n' "${missing[@]}" >&2
    warn "Then run this installer again with the same options."
    return 1
  fi
}

start_services() {
  config_complete || return 0
  if [[ "$MODE" == "systemd" ]]; then
    systemctl enable --now otb-agent.service
    systemctl enable --now otb-bot.service
    systemctl restart otb-agent.service otb-bot.service
  else
    docker compose -f "$REPO_DIR/docker-compose.yml" up -d
  fi
  log "Started. Check with: sudo $REPO_DIR/verify.sh"
}

# --------------------------------------------------------------------------- host hardening (opt-in)
harden_host() {
  local ssh_port has_keys=0
  ssh_port="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
  ssh_port="${ssh_port:-22}"
  if compgen -G "/root/.ssh/authorized_keys" >/dev/null && [[ -s /root/.ssh/authorized_keys ]]; then has_keys=1; fi
  for f in /home/*/.ssh/authorized_keys; do [[ -s "$f" ]] && has_keys=1; done

  cat <<EOF

Host hardening plan:
  1. ufw: deny all incoming, allow outgoing, rate-limit SSH on port $ssh_port/tcp, enable ufw.
  2. SSH: disable password login, root may log in with keys only.
     $( [[ $has_keys -eq 1 ]] && echo "(authorized_keys found -> will apply)" || echo "(NO authorized_keys found -> SKIPPED to avoid locking you out)")
  Keep your current SSH session open until you have tested a new login.
EOF
  confirm "Apply host hardening?" || { warn "Host hardening skipped."; return 0; }

  if command -v ufw >/dev/null; then
    ufw default deny incoming
    ufw default allow outgoing
    ufw limit "$ssh_port/tcp"
    ufw --force enable
  else
    warn "ufw not installed (apt install ufw); firewall step skipped."
  fi

  if [[ $has_keys -eq 1 ]]; then
    install -d -m 0755 /etc/ssh/sshd_config.d
    cat > /etc/ssh/sshd_config.d/10-otb-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
    if sshd -t; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd
      log "SSH hardened. Test a new login before closing this session."
    else
      rm -f /etc/ssh/sshd_config.d/10-otb-hardening.conf
      warn "sshd config test failed; SSH change reverted."
    fi
  fi
}

# --------------------------------------------------------------------------- main
preflight
install_shared_config
if [[ "$MODE" == "systemd" ]]; then install_systemd_mode; else install_docker_mode; fi
[[ $HARDEN_HOST -eq 1 ]] && harden_host
start_services
