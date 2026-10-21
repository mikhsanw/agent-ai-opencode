# shellcheck shell=bash
# shellcheck disable=SC2034  # AUTOSHARED is read by the caller
# Projects on this server. Every detected project is shared read-write with the agent
# automatically (safety nets: snapshots + DB backups) and picked in Telegram with /open.
# Sourced by install.sh and otb; needs share_validate/shares_list (lib/shares.sh).
#
# /etc/otb/projects.conf   "<slug> <state> <path>" per line; state: shared | closed
#   shared   agent has access (listed in shares.conf)
#   closed   excluded by the user (otb unshare); never shared again automatically
# A folder containing a file named .otb-ignore is never shared automatically.

PROJECTS_CONF="${ETC_DIR:-/etc/otb}/projects.conf"
BOT_HOME=/var/lib/otb-bot
LOCAL_CMDS="$BOT_HOME/local-commands"   # used by an earlier version (/akses_ commands); cleaned up
MAX_PROJECTS=50

project_markers() { # is <dir> a project? (git repo, Laravel/PHP, Node)
  [[ -e "$1/.otb-ignore" ]] && return 1
  [[ -d "$1/.git" || -f "$1/artisan" || -f "$1/composer.json" || -f "$1/package.json" ]]
}

detect_projects() { # prints project paths: /home/<user>/<p>, /home/<user>/<group>/<p>, /var/www/<p>
  local d g
  for d in /home/*/[!.]* /var/www/[!.]*; do
    [[ -d "$d" && ! -L "$d" ]] || continue
    [[ -e "$d/.otb-ignore" ]] && continue
    if project_markers "$d"; then
      (share_validate "$d") >/dev/null 2>&1 && readlink -f -- "$d"
      continue
    fi
    [[ "$d" == /home/* ]] || continue
    for g in "$d"/[!.]*; do
      [[ -d "$g" && ! -L "$g" ]] && project_markers "$g" && (share_validate "$g") >/dev/null 2>&1 && readlink -f -- "$g"
    done
  done | sort -u | head -n "$MAX_PROJECTS"
}

project_slug() { # short readable id, unique against projects.conf
  local base s n=2
  base="$(basename "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '_' | sed 's/__*/_/g; s/^_//; s/_$//' | cut -c1-24)"
  [[ -n "$base" ]] || base=proyek
  s="$base"
  while awk -v s="$s" -v p="$1" '$1 == s && $3 != p { f = 1 } END { exit !f }' "$PROJECTS_CONF" 2>/dev/null; do
    s="${base:0:22}_$n"; n=$((n + 1))
  done
  printf '%s' "$s"
}

projects_list() { [[ -f "$PROJECTS_CONF" ]] && awk 'NF >= 3' "$PROJECTS_CONF"; return 0; }

project_path() { awk -v s="$1" '$1 == s { print $3; exit }' "$PROJECTS_CONF" 2>/dev/null; }

project_set_state() { # project_set_state <slug> <state>
  local tmp; tmp="$(mktemp)"
  awk -v s="$1" -v st="$2" '$1 == s { $2 = st } { print }' "$PROJECTS_CONF" > "$tmp"
  chmod 0644 "$tmp"; mv "$tmp" "$PROJECTS_CONF"
}

# Keep projects.conf in line with shares.conf and share every newly detected project.
# Sets AUTOSHARED to the newly shared paths (newline separated). Caller applies shares.conf.
projects_autoshare() {
  local path slug state tmp shared listed
  AUTOSHARED=""
  touch "$PROJECTS_CONF" "$SHARES_CONF"; chmod 0644 "$PROJECTS_CONF" "$SHARES_CONF"
  listed="$(shares_list | awk '{ print $2 }')"
  tmp="$(mktemp)"
  while read -r slug state path; do
    [[ -d "$path" ]] || continue
    if grep -qxF "$path" <<<"$listed"; then state=shared
    elif [[ "$state" == shared || "$state" == closed ]]; then state=closed   # removed by the user
    else state=pending; fi                                                # new/offered (older version)
    echo "$slug $state $path"
  done < <(projects_list) > "$tmp"
  chmod 0644 "$tmp"; mv "$tmp" "$PROJECTS_CONF"
  while read -r path; do
    [[ -n "$path" ]] || continue
    awk -v p="$path" '$3 == p { f = 1 } END { exit !f }' "$PROJECTS_CONF" && continue
    echo "$(project_slug "$path") pending $path" >> "$PROJECTS_CONF"
  done < <(detect_projects)
  # pending -> share read-write, unless the folder opted out or is listed (e.g. read-only) already
  while read -r slug state path; do
    [[ "$state" == pending ]] || continue
    if grep -qxF "$path" <<<"$listed"; then project_set_state "$slug" shared; continue; fi
    if [[ -e "$path/.otb-ignore" ]] || ! (share_validate "$path") >/dev/null 2>&1; then
      project_set_state "$slug" closed; continue
    fi
    echo "rw $path" >> "$SHARES_CONF"
    project_set_state "$slug" shared
    AUTOSHARED+="$path"$'\n'
  done < <(projects_list)
  # shares added by hand (otb share) are registered too
  while read -r path; do
    [[ -n "$path" ]] || continue
    awk -v p="$path" '$3 == p { f = 1 } END { exit !f }' "$PROJECTS_CONF" && continue
    echo "$(project_slug "$path") shared $path" >> "$PROJECTS_CONF"
  done <<<"$listed"
  return 0
}

project_mark() { # project_mark <path> <shared|closed>   (closed = never auto-share again)
  local slug
  touch "$PROJECTS_CONF"; chmod 0644 "$PROJECTS_CONF"
  slug="$(awk -v p="$1" '$3 == p { print $1; exit }' "$PROJECTS_CONF")"
  if [[ -n "$slug" ]]; then project_set_state "$slug" "$2"
  else echo "$(project_slug "$1") $2 $1" >> "$PROJECTS_CONF"; fi
}

install_project_units() { # hourly detection of new projects
  cat > /etc/systemd/system/otb-detect.service <<'UNIT'
[Unit]
Description=otb: share newly detected projects with the agent
[Service]
Type=oneshot
Nice=10
ExecStart=/usr/local/bin/otb detect --notify
UNIT
  cat > /etc/systemd/system/otb-detect.timer <<'UNIT'
[Unit]
Description=otb: detect new projects every hour
[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  remove_legacy_project_bits
  systemctl daemon-reload
  systemctl enable --now otb-detect.timer >/dev/null 2>&1
}

# Earlier version: /akses_ /tutup_ /daftar_akses bot commands, request spool, path unit.
remove_legacy_project_bits() {
  local f
  if [[ -e /etc/systemd/system/otb-requests.path ]]; then
    systemctl disable --now otb-requests.path >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/otb-requests.path /etc/systemd/system/otb-requests.service
  fi
  for f in "$LOCAL_CMDS"/daftar_akses.json "$LOCAL_CMDS"/akses_*.json "$LOCAL_CMDS"/tutup_*.json; do
    [[ -e "$f" ]] && rm -f "$f"
  done
  [[ -d "$LOCAL_CMDS" ]] && rmdir "$LOCAL_CMDS" 2>/dev/null
  [[ -d "$BOT_HOME/requests" ]] && rm -rf "${BOT_HOME:?}/requests"
  return 0
}

remove_project_units() {
  systemctl disable --now otb-detect.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/otb-detect.service /etc/systemd/system/otb-detect.timer
  remove_legacy_project_bits
  systemctl daemon-reload
}
