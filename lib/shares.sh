# shellcheck shell=bash
# shellcheck disable=SC2034  # CMDS_CHANGED / DECLINED_PROJECTS are read by the caller
# Folders outside /srv/workspace that the agent may use (e.g. a production Laravel app).
# Sourced by install.sh; relies on its helpers: log, ok, warn, die, ask, apt_install,
# env_value, set_env, ETC_DIR, MODE, INTERACTIVE, RECONFIGURE.
#
# /etc/otb/shares.conf    one share per line: "ro <path>" or "rw <path>"
# /etc/otb/shares.applied what was applied last time (to revoke removed shares)
#
# Mode A (systemd) only. A share is mounted at its real path inside the sandbox; the rest of
# /home stays hidden (ProtectHome=tmpfs). Access is granted with ACLs, so file ownership and
# the site's own permissions are left as they are.

SHARES_CONF="$ETC_DIR/shares.conf"
SHARES_APPLIED="$ETC_DIR/shares.applied"
SHARES_DROPIN_AGENT=/etc/systemd/system/otb-agent.service.d/10-shares.conf
SHARES_DROPIN_BOT=/etc/systemd/system/otb-bot.service.d/10-shares.conf

shares_list() { # prints "mode path" lines from a shares file (default: current config)
  local f="${1:-$SHARES_CONF}"
  [[ -f "$f" ]] || return 0
  awk '$1 ~ /^(ro|rw)$/ && $2 ~ /^\// { print $1, $2 }' "$f"
}

shares_has_rw() { shares_list | grep -q '^rw '; }

# Refuses paths that would hand the agent the system, the bot's secrets or a whole home.
share_validate() { # share_validate <path>  -> prints the canonical path
  local p="$1" real h
  [[ "$p" == /* ]] || die "Path harus absolut: $p"
  [[ -d "$p" ]] || die "Folder tidak ditemukan: $p"
  real="$(readlink -f -- "$p")"
  [[ "$real" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "Path hanya boleh berisi huruf, angka, . _ - dan /: $real"
  case "$real" in
    /|/home|/root|/root/*|/etc|/etc/*|/usr|/usr/*|/bin|/sbin|/lib|/lib*|/boot|/boot/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*|/run|/run/*|/var|/var/lib|/var/lib/otb-*|/opt|/opt/otb|/opt/otb/*|/srv|/srv/workspace|/srv/workspace/*|/tmp|/tmp/*)
      die "Folder ini tidak boleh dibagikan: $real" ;;
  esac
  while IFS=: read -r _ _ _ _ _ h _; do
    [[ -n "$h" && "$h" != / && "$real" == "$h" ]] && die "Jangan bagikan seluruh home ($real); pilih subfolder proyeknya, mis. $real/<nama-proyek>."
  done < /etc/passwd
  [[ -e "$real/.ssh" ]] && die "$real berisi .ssh; tidak boleh dibagikan."
  printf '%s' "$real"
}

php_fpm_users() { # users PHP-FPM pools run as (Laravel writes storage/ and bootstrap/cache/ as them)
  grep -hsE '^\s*user\s*=' /etc/php/*/fpm/pool.d/*.conf 2>/dev/null | sed 's/.*=\s*//' | sort -u
}

share_grant() { # share_grant <mode> <path>
  local mode="$1" p="$2" owner perms u d
  owner="$(stat -c %U "$p")"
  if [[ "$mode" == rw ]]; then perms=rwX; else perms=rX; fi
  # Agent: read or read-write. Bot: read only (for /open and /ls). Owner keeps full access to
  # files the agent creates (default ACL), and new files stay readable like the folder.
  setfacl -R -m "u:otb-agent:$perms,d:u:otb-agent:$perms,u:otb-bot:rX,d:u:otb-bot:rX" "$p"
  [[ "$owner" != root ]] && setfacl -R -m "d:u:$owner:rwX" "$p"
  if [[ "$mode" == rw ]]; then
    for d in storage bootstrap/cache; do
      [[ -d "$p/$d" ]] || continue
      for u in $(php_fpm_users); do
        id -u "$u" >/dev/null 2>&1 && setfacl -R -m "u:$u:rwX,d:u:$u:rwX" "$p/$d"
      done
    done
  fi
}

share_revoke() { # share_revoke <path>  -> remove our ACLs; give agent-created files to the owner
  local p="$1" owner group
  [[ -d "$p" ]] || return 0
  owner="$(stat -c %U "$p")"; group="$(stat -c %G "$p")"
  setfacl -R -x "u:otb-agent,d:u:otb-agent,u:otb-bot,d:u:otb-bot" "$p" 2>/dev/null || true
  if id -u otb-agent >/dev/null 2>&1; then
    find "$p" -xdev -user otb-agent -exec chown -h "$owner:$group" {} + 2>/dev/null || true
  fi
  log "Akses agen ke $p dicabut."
}

configure_shares() {
  local input mode p real lines=""
  [[ "$MODE" == systemd ]] || {
    [[ -s "$SHARES_CONF" ]] && warn "Berbagi folder hanya didukung di mode systemd; $SHARES_CONF diabaikan."
    return 0
  }
  # Non-interactive: OTB_SHARES="rw:/home/ubuntu/web-sekolah ro:/var/www/lain"
  if [[ -n "${OTB_SHARES:-}" ]]; then
    for input in $OTB_SHARES; do
      mode="${input%%:*}"; p="${input#*:}"
      [[ "$mode" == ro || "$mode" == rw ]] || die "OTB_SHARES: pakai format ro:/path atau rw:/path"
      real="$(share_validate "$p")"
      lines+="$mode $real"$'\n'
    done
    printf '%s' "$lines" > "$SHARES_CONF"; chmod 0644 "$SHARES_CONF"
    return 0
  fi
  [[ $INTERACTIVE -eq 1 ]] || return 0
  [[ -f "$SHARES_CONF" && $RECONFIGURE -eq 0 ]] && return 0
  touch "$SHARES_CONF"; chmod 0644 "$SHARES_CONF"
  # Ask once about the projects found on this server; later ones are offered in Telegram.
  local found=() p kind
  mapfile -t found < <(detect_projects | while read -r p; do shares_list | grep -q " $p\$" || echo "$p"; done)
  [[ ${#found[@]} -gt 0 ]] || return 0
  printf '\n\033[1m4. Proyek di server ini\033[0m\n' >/dev/tty
  for p in "${found[@]}"; do
    kind=""; [[ -f "$p/artisan" ]] && kind="Laravel"; [[ -z "$kind" && -f "$p/package.json" ]] && kind="Node"
    db_info "$p" 2>/dev/null && [[ -f "$p/.env" ]] && kind+="${kind:+, }${DB_CONNECTION}"
    printf '  %s%s\n' "$p" "${kind:+  ($kind)}" >/dev/tty
  done
  printf '  Akses penuh = agen bisa mengubah file, .env, dan database. Pengaman: snapshot file tiap\n  5 menit dan backup database tiap jam. Bisa dibuka/ditutup kapan saja dari Telegram.\n' >/dev/tty
  if [[ "$(ask "  Beri agen akses penuh ke proyek di atas? (y/n)" y)" =~ ^[YyJj] ]]; then
    for p in "${found[@]}"; do echo "rw $p" >> "$SHARES_CONF"; done
  else
    printf '  Baik. Buka nanti dari Telegram: /daftar_akses\n' >/dev/tty
    DECLINED_PROJECTS="${found[*]}"
  fi
}

# Applies shares.conf: ACLs, systemd drop-ins, bot browse roots, git safe.directory.
apply_shares() {
  local mode p bind_agent="" ro_agent="" ro_bot="" roots="$WORKSPACE"
  [[ "$MODE" == systemd ]] || return 0

  # Revoke shares that were removed since the last run.
  if [[ -f "$SHARES_APPLIED" ]]; then
    while read -r mode p; do
      shares_list | grep -qxF "$mode $p" || shares_list | grep -q " $p\$" || share_revoke "$p"
    done < <(shares_list "$SHARES_APPLIED")
  fi

  if [[ -z "$(shares_list)" ]]; then
    rm -f "$SHARES_DROPIN_AGENT" "$SHARES_DROPIN_BOT" "$SHARES_APPLIED"
  else
    apt_install acl
    while read -r mode p; do
      [[ -d "$p" ]] || { warn "Folder $p tidak ada lagi; dilewati."; continue; }
      share_grant "$mode" "$p"
      if [[ "$mode" == rw ]]; then bind_agent+=" $p"; else ro_agent+=" $p"; fi
      ro_bot+=" $p"; roots+=",$p"
      log "Folder dibagikan ($mode): $p"
    done < <(shares_list)
    install -d -m 0755 "$(dirname "$SHARES_DROPIN_AGENT")" "$(dirname "$SHARES_DROPIN_BOT")"
    {
      echo "# Generated by install.sh from $SHARES_CONF. Edit that file, not this one."
      echo "[Service]"
      echo "ProtectHome=tmpfs"
      [[ -n "$bind_agent" ]] && { echo "BindPaths=${bind_agent# }"; echo "ReadWritePaths=${bind_agent# }"; }
      [[ -n "$ro_agent" ]] && echo "BindReadOnlyPaths=${ro_agent# }"
    } > "$SHARES_DROPIN_AGENT"
    {
      echo "# Generated by install.sh from $SHARES_CONF. Edit that file, not this one."
      echo "[Service]"
      echo "ProtectHome=tmpfs"
      echo "BindReadOnlyPaths=${ro_bot# }"
    } > "$SHARES_DROPIN_BOT"
    shares_list > "$SHARES_APPLIED"
  fi
  set_env "$ETC_DIR/bot.env" OPEN_BROWSER_ROOTS "$roots"
  systemctl daemon-reload
}
