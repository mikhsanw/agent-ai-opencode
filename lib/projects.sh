# shellcheck shell=bash
# shellcheck disable=SC2034  # CMDS_CHANGED / DECLINED_PROJECTS are read by the caller
# Projects on this server that the agent may be given access to, managed from Telegram.
# Sourced by install.sh and otb; needs log/warn, share_validate/shares_list (lib/shares.sh).
#
# /etc/otb/projects.conf   "<slug> <state> <path>" per line; state: new | offered | shared | closed
#   new      detected, not yet offered in Telegram
#   offered  offered once (or declined in the wizard); not offered again
#   shared   agent has read-write access (listed in shares.conf)
#   closed   access was closed by the user; not offered again
#
# Telegram: the bot's "local commands" (/akses_<slug>, /tutup_<slug>, /daftar_akses) only drop a
# request file into /var/lib/otb-bot/requests. A root service (otb-requests.path) picks it up and
# only acts on slugs listed in projects.conf, so a hijacked bot can open detected projects but
# never arbitrary paths. The agent cannot reach /var/lib/otb-bot at all.

PROJECTS_CONF="${ETC_DIR:-/etc/otb}/projects.conf"
BOT_HOME=/var/lib/otb-bot
LOCAL_CMDS="$BOT_HOME/local-commands"
REQUESTS="$BOT_HOME/requests"
MAX_PROJECTS=30   # the bot allows 100 commands in total; each project uses two

project_markers() { # is <dir> a project? (git repo, Laravel/PHP, Node)
  [[ -d "$1/.git" || -f "$1/artisan" || -f "$1/composer.json" || -f "$1/package.json" ]]
}

detect_projects() { # prints project paths: /home/<user>/<p>, /home/<user>/<group>/<p>, /var/www/<p>
  local d g
  for d in /home/*/[!.]* /var/www/[!.]*; do
    [[ -d "$d" && ! -L "$d" ]] || continue
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

project_slug() { # telegram-safe, <=26 chars, unique against projects.conf
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

# Merge detection results into projects.conf and keep states in line with shares.conf.
projects_sync() {
  local path slug state tmp shared
  touch "$PROJECTS_CONF"; chmod 0644 "$PROJECTS_CONF"
  shared="$(shares_list | awk '$1 == "rw" { print $2 }')"
  tmp="$(mktemp)"
  {
    # keep known projects that still exist
    while read -r slug state path; do
      [[ -d "$path" ]] || continue
      if grep -qxF "$path" <<<"$shared"; then state=shared
      elif [[ "$state" == shared ]]; then state=closed; fi
      echo "$slug $state $path"
    done < <(projects_list)
  } > "$tmp"
  chmod 0644 "$tmp"; mv "$tmp" "$PROJECTS_CONF"
  while read -r path; do
    [[ -n "$path" ]] || continue
    awk -v p="$path" '$3 == p { f = 1 } END { exit !f }' "$PROJECTS_CONF" && continue
    slug="$(project_slug "$path")"
    if grep -qxF "$path" <<<"$shared"; then state=shared; else state=new; fi
    echo "$slug $state $path" >> "$PROJECTS_CONF"
  done < <(detect_projects)
  # shares added by hand (otb share) also get Telegram commands
  while read -r path; do
    [[ -n "$path" ]] || continue
    awk -v p="$path" '$3 == p { f = 1 } END { exit !f }' "$PROJECTS_CONF" && continue
    echo "$(project_slug "$path") shared $path" >> "$PROJECTS_CONF"
  done <<<"$shared"
}

json_str() { # minimal JSON string escaping for our own generated text
  local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"
}

write_cmd() { # write_cmd <name> <description> <shell command>
  printf '{\n  "description": %s,\n  "exec": %s,\n  "allowWhenBusy": true\n}\n' \
    "$(json_str "$2")" "$(json_str "$3")" > "$LOCAL_CMDS/$1.json.new"
  if cmp -s "$LOCAL_CMDS/$1.json.new" "$LOCAL_CMDS/$1.json"; then rm -f "$LOCAL_CMDS/$1.json.new"
  else mv "$LOCAL_CMDS/$1.json.new" "$LOCAL_CMDS/$1.json"; CMDS_CHANGED=1; fi
}

# Generate the Telegram commands; sets CMDS_CHANGED=1 when the bot must restart to see them.
write_project_commands() {
  local slug state path name want f
  CMDS_CHANGED=0
  id -u otb-bot >/dev/null 2>&1 || return 0
  # The bot's StateDirectory may not exist yet on a first install (systemd creates it on start).
  [[ -d "$BOT_HOME" ]] || install -d -m 0700 -o otb-bot -g otb-bot "$BOT_HOME"
  install -d -m 0755 -o root -g root "$LOCAL_CMDS"
  install -d -m 0700 -o otb-bot -g otb-bot "$REQUESTS"
  want=" daftar_akses "
  write_cmd daftar_akses "Daftar proyek & akses agen" \
    "awk 'BEGIN{n=0} NF>=3{n++; nm=\$3; sub(/.*\\//,\"\",nm); if(\$2==\"shared\") print \"✅ \" nm \" — terbuka (tutup: /tutup_\" \$1 \")\"; else print \"⬜ \" nm \" — tertutup (buka: /akses_\" \$1 \")\"} END{if(n==0) print \"Belum ada proyek terdeteksi.\"}' /etc/otb/projects.conf"
  while read -r slug state path; do
    name="$(basename "$path")"
    write_cmd "akses_$slug" "Beri agen akses penuh ke $name" \
      "umask 077; printf 'akses $slug\\n' > requests/\$(date +%s%N).req && echo '⏳ Membuka akses agen ke $name (±1 menit)…'"
    write_cmd "tutup_$slug" "Cabut akses agen dari $name" \
      "umask 077; printf 'tutup $slug\\n' > requests/\$(date +%s%N).req && echo '⏳ Menutup akses agen ke $name…'"
    want+="akses_$slug tutup_$slug "
  done < <(projects_list)
  for f in "$LOCAL_CMDS"/*.json; do
    [[ -e "$f" ]] || continue
    name="$(basename "$f" .json)"
    if [[ "$want" != *" $name "* ]]; then rm -f "$f"; CMDS_CHANGED=1; fi
  done
  chmod 0644 "$LOCAL_CMDS"/*.json 2>/dev/null || true
}

install_project_units() { # request handler (path unit) + hourly detection
  cat > /etc/systemd/system/otb-requests.path <<EOF
[Unit]
Description=otb: Telegram access requests
[Path]
PathExistsGlob=$REQUESTS/*.req
MakeDirectory=no
[Install]
WantedBy=paths.target
EOF
  cat > /etc/systemd/system/otb-requests.service <<'EOF'
[Unit]
Description=otb: handle Telegram access requests
[Service]
Type=oneshot
ExecStart=/usr/local/bin/otb handle-requests
EOF
  cat > /etc/systemd/system/otb-detect.service <<'EOF'
[Unit]
Description=otb: detect new projects and offer them in Telegram
[Service]
Type=oneshot
Nice=10
ExecStart=/usr/local/bin/otb detect --notify
EOF
  cat > /etc/systemd/system/otb-detect.timer <<'EOF'
[Unit]
Description=otb: detect new projects every hour
[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now otb-requests.path otb-detect.timer >/dev/null 2>&1
}

remove_project_units() {
  systemctl disable --now otb-requests.path otb-detect.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/otb-requests.{path,service} /etc/systemd/system/otb-detect.{service,timer}
  systemctl daemon-reload
}
