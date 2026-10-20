#!/usr/bin/env bash
# Pemasang satu-perintah untuk VPS kosong (Ubuntu 24.04 / Debian 12):
#
#   curl -fsSL https://raw.githubusercontent.com/mikhsanw/agent-ai-opencode/main/bootstrap.sh | bash
#
# Opsi install.sh bisa diteruskan:  ... | bash -s -- --mode docker
# Mengunci versi tertentu:           ... | OTB_REF=v0.1.0 bash
#
# Skrip ini meng-clone rilis bertag terbaru (atau main jika belum ada rilis) ke /opt/otb/src,
# lalu menjalankan install.sh dari sana. Jika bukan root, skrip meminta sudo sendiri.
# Semua kode dibungkus dalam fungsi, jadi unduhan yang terputus di tengah jalan tidak akan
# menjalankan setengah skrip.
set -euo pipefail
umask 022

otb_bootstrap() {
  local repo_url="${OTB_REPO_URL:-https://github.com/mikhsanw/agent-ai-opencode.git}"
  local ref="${OTB_REF:-}"
  local dest=/opt/otb/src

  command -v systemctl >/dev/null || { echo "[otb] systemd dibutuhkan." >&2; exit 1; }

  if ! command -v git >/dev/null || ! command -v curl >/dev/null; then
    echo "[otb] Memasang git dan curl" >&2
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git curl ca-certificates >/dev/null
  fi

  if [[ -z "$ref" ]]; then
    ref="$(git ls-remote --tags --refs "$repo_url" 'v*' 2>/dev/null \
      | sed 's#.*refs/tags/##' | sort -V | tail -n1)"
    if [[ -z "$ref" ]]; then
      ref=main
      echo "[otb] PERINGATAN: belum ada rilis bertag; memakai branch main." >&2
    fi
  fi

  install -d -m 0755 /opt/otb
  if [[ -d "$dest/.git" ]]; then
    echo "[otb] Memperbarui $dest ke $ref" >&2
    git -C "$dest" remote set-url origin "$repo_url"
    git -C "$dest" fetch --tags --force --quiet origin
  else
    echo "[otb] Mengunduh $repo_url ($ref) ke $dest" >&2
    rm -rf "$dest"
    git clone --quiet "$repo_url" "$dest"
  fi
  if git -C "$dest" rev-parse -q --verify "refs/tags/$ref" >/dev/null; then
    git -C "$dest" -c advice.detachedHead=false checkout --quiet "refs/tags/$ref"
  elif git -C "$dest" rev-parse -q --verify "refs/remotes/origin/$ref" >/dev/null; then
    git -C "$dest" -c advice.detachedHead=false checkout --quiet --detach "origin/$ref"
  else
    git -C "$dest" -c advice.detachedHead=false checkout --quiet "$ref" \
      || { echo "[otb] Versi '$ref' tidak ditemukan di $repo_url" >&2; exit 1; }
  fi
  # This code later runs as root (install.sh, otb): nobody else may be able to modify it.
  chown -R root:root "$dest"
  chmod -R go-w "$dest"
  echo "[otb] Versi: $(git -C "$dest" describe --tags --always) ($(git -C "$dest" rev-parse --short HEAD))" >&2

  if { : </dev/tty; } 2>/dev/null; then
    exec bash "$dest/install.sh" "$@" </dev/tty
  else
    exec bash "$dest/install.sh" "$@"
  fi
}

main() {
  if [[ $EUID -ne 0 ]]; then
    command -v sudo >/dev/null || { echo "[otb] Jalankan sebagai root (sudo tidak tersedia)." >&2; exit 1; }
    echo "[otb] Butuh akses root; meminta sudo…" >&2
    # Re-run this same code as root. The script came through a pipe, so pass the
    # function definitions instead of a file, and carry the OTB_* settings across.
    local vars=() v
    while IFS= read -r v; do vars+=("$v"); done < <(env | grep '^OTB_' || true)
    # sudo drops SSH_CONNECTION; the installer uses it to keep this session's SSH port open.
    [[ -n "${SSH_CONNECTION:-}" ]] && vars+=("OTB_SSH_CONNECTION=$SSH_CONNECTION")
    exec sudo env "${vars[@]}" bash -c "set -euo pipefail; umask 022; $(declare -f otb_bootstrap); otb_bootstrap \"\$@\"" otb-bootstrap "$@"
  fi
  otb_bootstrap "$@"
}

main "$@"
