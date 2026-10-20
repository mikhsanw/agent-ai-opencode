#!/usr/bin/env bash
# Pemasang satu-perintah untuk VPS kosong (Ubuntu 24.04 / Debian 12):
#
#   curl -fsSL https://raw.githubusercontent.com/mikhsanw/agent-ai-opencode/v0.1.0/bootstrap.sh | sudo bash
#
# Opsi install.sh bisa diteruskan:  ... | sudo bash -s -- --mode docker
#
# Skrip ini hanya meng-clone rilis bertag ke /opt/otb/src lalu menjalankan install.sh dari sana.
# Semua kode dibungkus dalam fungsi, jadi unduhan yang terputus di tengah jalan tidak akan
# menjalankan setengah skrip.
set -euo pipefail
umask 022

main() {
  local repo_url="${OTB_REPO_URL:-https://github.com/mikhsanw/agent-ai-opencode.git}"
  local ref="${OTB_REF:-v0.1.0}"
  local dest=/opt/otb/src

  [[ $EUID -eq 0 ]] || { echo "Jalankan dengan sudo: curl ... | sudo bash" >&2; exit 1; }
  command -v systemctl >/dev/null || { echo "systemd dibutuhkan." >&2; exit 1; }

  if ! command -v git >/dev/null || ! command -v curl >/dev/null; then
    echo "[otb] Memasang git dan curl" >&2
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git curl ca-certificates >/dev/null
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
  git -C "$dest" -c advice.detachedHead=false checkout --quiet "$ref"
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

main "$@"
