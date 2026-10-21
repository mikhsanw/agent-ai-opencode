# shellcheck shell=bash
# Safety nets for writable shared folders (option C): automatic file snapshots and database
# backups, stored where the agent cannot reach them (/var/lib/otb, /var/backups/otb are
# inaccessible inside its sandbox). Sourced by install.sh and otb; needs log/warn/die and
# shares_list (lib/shares.sh).

SAFETY_CONF="${ETC_DIR:-/etc/otb}/safety.conf"
SNAP_ROOT=/var/lib/otb/snapshots
BACKUP_ROOT=/var/backups/otb

# Not snapshotted: reinstallable dependencies, logs and caches.
SNAP_EXCLUDES=(vendor node_modules storage/logs storage/framework bootstrap/cache .phpunit.cache)

safety_load() {
  SNAPSHOT_KEEP_DAYS=7 BACKUP_KEEP_HOURS=48 BACKUP_KEEP_DAYS=14 BACKUP_MAX_MB=2048
  if [[ -f "$SAFETY_CONF" ]]; then
    # shellcheck disable=SC1090
    . "$SAFETY_CONF"
  fi
  return 0
}

share_slug() { # stable, readable id for a share path: <basename>-<8 hex of path hash>
  local p="$1"
  printf '%s-%s' "$(basename "$p" | tr -c 'A-Za-z0-9._-' '_')" "$(printf '%s' "$p" | sha256sum | cut -c1-8)"
}

rw_shares() { shares_list | awk '$1 == "rw" { print $2 }'; }

resolve_share() { # resolve_share <path-or-name>  -> share path (rw only)
  local q="$1" p
  while read -r p; do
    if [[ "$p" == "$(readlink -f -- "$q" 2>/dev/null)" || "$(basename "$p")" == "$q" || "$(share_slug "$p")" == "$q" ]]; then
      printf '%s' "$p"; return 0
    fi
  done < <(rw_shares)
  die "Bukan folder baca-tulis yang dibagikan: $q (lihat: otb shares)"
}

# ---------------------------------------------------------------- file snapshots
snap_git() { # snap_git <share> <git args...>   (separate git dir; the project's own .git is untouched)
  local p="$1"; shift
  git -C "$p" -c safe.directory='*' -c core.hooksPath=/dev/null -c user.name=otb-snapshot -c user.email=otb@localhost \
    --git-dir="$SNAP_ROOT/$(share_slug "$p").git" --work-tree="$p" "$@"
}

snap_pathspec() { # all files, ignoring the project's .gitignore, minus SNAP_EXCLUDES
  local e; printf '%s\n' "."
  for e in "${SNAP_EXCLUDES[@]}"; do printf ':(exclude)%s\n' "$e"; done
}

snapshot_one() { # snapshot_one <share> [message]  -> prints the new commit id ("" if unchanged)
  local p="$1" msg="${2:-otomatis}" repo branch parent tree commit
  repo="$SNAP_ROOT/$(share_slug "$p").git"
  install -d -m 0700 -o root -g root "$SNAP_ROOT"
  if [[ ! -d "$repo" ]]; then
    git init -q --bare "$repo"; chmod 0700 "$repo"
    printf '%s\n' "$p" > "$repo/description"
  fi
  snapshot_dotgit "$p"
  mapfile -t spec < <(snap_pathspec)
  snap_git "$p" add -A -f -- "${spec[@]}" 2>/dev/null
  tree="$(snap_git "$p" write-tree)"
  # One branch per day; each day starts from a root commit, so old days can simply be dropped.
  branch="refs/heads/$(date +%F)"
  parent="$(snap_git "$p" rev-parse -q --verify "$branch" 2>/dev/null || true)"
  if [[ -n "$parent" && "$(snap_git "$p" rev-parse "$parent^{tree}")" == "$tree" ]]; then return 0; fi
  if [[ -z "$parent" ]]; then
    local last; last="$(snap_git "$p" for-each-ref --sort=-refname --count=1 --format='%(objectname)' refs/heads/ 2>/dev/null)"
    [[ -n "$last" && "$(snap_git "$p" rev-parse "$last^{tree}")" == "$tree" ]] && return 0
    commit="$(snap_git "$p" commit-tree "$tree" -m "$msg")"
  else
    commit="$(snap_git "$p" commit-tree "$tree" -p "$parent" -m "$msg")"
  fi
  snap_git "$p" update-ref "$branch" "$commit"
  printf '%s' "$commit"
}

# The project's own .git cannot go into a git snapshot, so it is copied next to it. Objects
# are content-addressed and never overwritten or deleted in the copy, so commits survive
# `git reset --hard`, deleted branches, `git gc` and `rm -rf .git` in the shared folder.
snapshot_dotgit() { # snapshot_dotgit <share>
  local p="$1" copy e
  [[ -d "$p/.git" ]] || return 0
  copy="$SNAP_ROOT/$(share_slug "$p").dotgit"
  install -d -m 0700 -o root -g root "$copy" "$copy/objects"
  [[ -f "$copy/.stamp" && -z "$(find "$p/.git" -newer "$copy/.stamp" -print -quit 2>/dev/null)" ]] && return 0
  cp -a -n "$p/.git/objects/." "$copy/objects/" 2>/dev/null || true
  for e in "$p/.git"/* "$p/.git"/.[!.]*; do
    [[ -e "$e" && "$(basename "$e")" != objects && "$(basename "$e")" != refs ]] || continue
    cp -a "$e" "$copy/" 2>/dev/null || true
  done
  # Refs mirror the current state exactly (stale loose refs would override packed-refs);
  # commits that left every branch stay in objects/ and are listed by `otb restore-git`.
  rm -rf "$copy/refs"; cp -a "$p/.git/refs" "$copy/refs" 2>/dev/null || true
  [[ -f "$p/.git/packed-refs" ]] || rm -f "$copy/packed-refs"
  touch "$copy/.stamp"
}

snapshot_restore_dotgit() { # put the saved .git back if the shared folder has lost its own
  local p="$1" copy owner group
  copy="$SNAP_ROOT/$(share_slug "$p").dotgit"
  [[ ! -d "$p/.git" && -d "$copy/objects" ]] || return 0
  owner="$(stat -c %U "$p")"; group="$(stat -c %G "$p")"
  cp -a "$copy" "$p/.git"; rm -f "$p/.git/.stamp"
  mkdir -p "$p/.git/info"
  grep -qxF '/.git.sebelum-restore-*' "$p/.git/info/exclude" 2>/dev/null || echo '/.git.sebelum-restore-*' >> "$p/.git/info/exclude"
  chown -R -h "$owner:$group" "$p/.git"
  share_regrant "$p" "$p/.git"
  log "Riwayat git ($p/.git) dipulihkan. Commit yang hilang karena reset/hapus branch bisa dicari dengan: git reflog"
}

snapshot_replace_dotgit() { # swap the folder's .git for the saved copy (current one kept aside)
  local p="$1" copy aside
  copy="$SNAP_ROOT/$(share_slug "$p").dotgit"
  [[ -d "$copy/objects" ]] || die "Belum ada salinan .git untuk $p."
  if [[ -d "$p/.git" ]]; then
    snapshot_dotgit "$p"            # merge the latest refs/objects into the copy first
    aside="$p/.git.sebelum-restore-$(date +%Y%m%d-%H%M%S)"
    mv "$p/.git" "$aside"
    log "Riwayat git saat ini dipindah ke $aside"
  fi
  snapshot_restore_dotgit "$p"
  # Show commits that exist but are on no branch or tag: usually the ones that were discarded.
  local g=(git -c safe.directory='*' -C "$p") lost
  lost="$(comm -23 \
    <("${g[@]}" cat-file --batch-all-objects --batch-check='%(objecttype) %(objectname)' 2>/dev/null | awk '$1 == "commit" { print $2 }' | sort) \
    <("${g[@]}" rev-list --branches --tags 2>/dev/null | sort))"
  if [[ -n "$lost" ]]; then
    echo "Commit yang tidak ada di branch mana pun (kembalikan dengan: git branch pulih <id>):"
    while read -r c; do "${g[@]}" log -1 --date=format:'%Y-%m-%d %H:%M' --format='  %h  %ad  %s' "$c"; done <<<"$lost" \
      | sort -k2,3 -r | head -n 20
  fi
}

share_regrant() { # share_regrant <share> <subpath>  -> restored files get the share's ACLs again
  local p="$1" sub="$2" mode
  mode="$(shares_list | awk -v p="$p" '$2 == p { print $1 }')"
  [[ -n "$mode" ]] || return 0
  if [[ "$sub" == "$p" ]]; then share_grant "$mode" "$p"; return 0; fi
  local perms=rX; [[ "$mode" == rw ]] && perms=rwX
  setfacl -R -m "u:otb-agent:$perms,d:u:otb-agent:$perms,u:otb-bot:rX,d:u:otb-bot:rX" "$sub"
}

snapshot_prune() { # drop days older than SNAPSHOT_KEEP_DAYS
  local p="$1" ref day cutoff
  cutoff="$(date -d "-${SNAPSHOT_KEEP_DAYS} days" +%F)"
  while read -r ref; do
    day="${ref#refs/heads/}"
    [[ "$day" < "$cutoff" ]] && snap_git "$p" update-ref -d "$ref"
  done < <(snap_git "$p" for-each-ref --format='%(refname)' refs/heads/ 2>/dev/null)
  snap_git "$p" gc -q --prune=now 2>/dev/null || true
}

snapshot_list() { # snapshot_list <share>  -> "<commit> <date time> <message>" newest first
  local p="$1"
  snap_git "$p" log --all --date=format:'%Y-%m-%d %H:%M' --format='%h  %ad  %s' 2>/dev/null
}

snapshot_restore() { # snapshot_restore <share> <commit>   (caller confirms)
  local p="$1" target="$2" before owner group f
  snap_git "$p" rev-parse -q --verify "$target^{commit}" >/dev/null || die "Snapshot tidak ditemukan: $target"
  before="$(snapshot_one "$p" "sebelum restore ke $target")"
  [[ -n "$before" ]] || before="$(snap_git "$p" for-each-ref --sort=-committerdate --count=1 --format='%(objectname)' refs/heads/)"
  owner="$(stat -c %U "$p")"; group="$(stat -c %G "$p")"
  # Make the index match the current files, then switch it (and the files) to the target;
  # files that exist now but not in the snapshot are removed. Excluded paths are untouched.
  snap_git "$p" read-tree "$before"
  snap_git "$p" read-tree -u --reset "$target"
  while IFS= read -r f; do
    [[ -e "$p/$f" ]] && chown -h "$owner:$group" "$p/$f"
  done < <(snap_git "$p" diff --name-only "$before" "$target")
  share_regrant "$p" "$p"
  snapshot_restore_dotgit "$p"
  log "Dikembalikan ke snapshot $target. Kondisi sebelum restore tersimpan sebagai snapshot ${before:0:7}."
}

# ---------------------------------------------------------------- database backups
env_get() { # env_get <.env> <KEY>  -> value without surrounding quotes
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | tail -n1 | sed -E "s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/; s/[[:space:]]+#.*\$//"
}

db_info() { # db_info <share>  -> sets DB_* variables from <share>/.env
  local env="$1/.env"
  DB_CONNECTION="" DB_HOST="" DB_PORT="" DB_DATABASE="" DB_USERNAME="" DB_PASSWORD=""
  [[ -f "$env" ]] || return 1
  DB_CONNECTION="$(env_get "$env" DB_CONNECTION)"; DB_HOST="$(env_get "$env" DB_HOST)"
  DB_PORT="$(env_get "$env" DB_PORT)"; DB_DATABASE="$(env_get "$env" DB_DATABASE)"
  DB_USERNAME="$(env_get "$env" DB_USERNAME)"; DB_PASSWORD="$(env_get "$env" DB_PASSWORD)"
  [[ -n "$DB_CONNECTION" ]] || DB_CONNECTION=sqlite
  if [[ "$DB_CONNECTION" == sqlite ]]; then
    [[ -n "$DB_DATABASE" && "$DB_DATABASE" != :memory: ]] || DB_DATABASE=database/database.sqlite
    [[ "$DB_DATABASE" == /* ]] || DB_DATABASE="$1/$DB_DATABASE"
  fi
}

ensure_db_tools() {
  case "$1" in
    mysql|mariadb) command -v mysqldump >/dev/null || apt_install default-mysql-client ;;
    pgsql) command -v pg_dump >/dev/null || apt_install postgresql-client ;;
    sqlite) command -v sqlite3 >/dev/null || apt_install sqlite3 ;;
  esac
}

db_size_mb() { # db_size_mb <share>  -> database size in MB ("" if unknown); needs db_info first
  local tmpcnf
  case "$DB_CONNECTION" in
    mysql|mariadb)
      [[ "$DB_DATABASE" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
      tmpcnf="$(mktemp)"; chmod 0600 "$tmpcnf"
      printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n' "$DB_USERNAME" "$DB_PASSWORD" "${DB_HOST:-127.0.0.1}" "${DB_PORT:-3306}" > "$tmpcnf"
      mysql --defaults-extra-file="$tmpcnf" -N -B -e \
        "SELECT COALESCE(ROUND(SUM(data_length + index_length) / 1048576), 0) FROM information_schema.tables WHERE table_schema = '$DB_DATABASE'" 2>/dev/null || true
      rm -f "$tmpcnf" ;;
    pgsql)
      PGPASSWORD="$DB_PASSWORD" psql -tA -h "${DB_HOST:-127.0.0.1}" -p "${DB_PORT:-5432}" -U "$DB_USERNAME" -d "$DB_DATABASE" \
        -c "SELECT pg_database_size(current_database()) / 1048576" 2>/dev/null || true ;;
    sqlite)
      [[ -f "$DB_DATABASE" ]] && echo $(( $(stat -c %s "$DB_DATABASE") / 1048576 )) ;;
  esac
  return 0
}

backup_one() { # backup_one <share>  -> prints the backup file path
  local p="$1" dir out tmpcnf rc=0 size
  db_info "$p" || { warn "Tidak ada $p/.env; backup database dilewati."; return 0; }
  # Very large databases are not dumped automatically (disk); OTB_BACKUP_FORCE=1 overrides.
  if [[ "${OTB_BACKUP_FORCE:-0}" != 1 && "${BACKUP_MAX_MB:-0}" -gt 0 ]]; then
    ensure_db_tools "$DB_CONNECTION" >/dev/null 2>&1 || true
    size="$(db_size_mb "$p" | tr -dc '0-9')"
    if [[ -n "$size" ]] && (( size > BACKUP_MAX_MB )); then
      warn "Database $p ${size} MB > batas ${BACKUP_MAX_MB} MB; backup otomatis dilewati (paksa: otb backup $(basename "$p"))."
      return 2
    fi
  fi
  dir="$BACKUP_ROOT/$(share_slug "$p")"
  install -d -m 0700 -o root -g root "$BACKUP_ROOT" "$dir"
  out="$dir/$(date +%Y%m%d-%H%M%S)"
  ensure_db_tools "$DB_CONNECTION" >/dev/null 2>&1 || true
  case "$DB_CONNECTION" in
    mysql|mariadb)
      out+=".sql.gz"; tmpcnf="$(mktemp)"; chmod 0600 "$tmpcnf"
      printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n' "$DB_USERNAME" "$DB_PASSWORD" "${DB_HOST:-127.0.0.1}" "${DB_PORT:-3306}" > "$tmpcnf"
      if ! mysqldump --defaults-extra-file="$tmpcnf" --single-transaction --routines --triggers --no-tablespaces \
          --databases "$DB_DATABASE" 2>"$dir/.last-error" | gzip > "$out"; then rc=1; fi
      rm -f "$tmpcnf" ;;
    pgsql)
      out+=".dump"
      PGPASSWORD="$DB_PASSWORD" pg_dump -Fc -h "${DB_HOST:-127.0.0.1}" -p "${DB_PORT:-5432}" -U "$DB_USERNAME" \
        -f "$out" "$DB_DATABASE" 2>"$dir/.last-error" || rc=$? ;;
    sqlite)
      out+=".sqlite"
      [[ -f "$DB_DATABASE" ]] || { warn "Database SQLite $DB_DATABASE tidak ada; dilewati."; return 0; }
      sqlite3 "$DB_DATABASE" ".backup '$out'" 2>"$dir/.last-error" || rc=$? ;;
    *) warn "DB_CONNECTION=$DB_CONNECTION belum didukung untuk backup otomatis."; return 0 ;;
  esac
  if [[ $rc -ne 0 ]]; then
    rm -f "$out"; warn "Backup database $p GAGAL: $(head -c 300 "$dir/.last-error")"; return 1
  fi
  chmod 0600 "$out"; rm -f "$dir/.last-error"
  printf '%s' "$out"
}

backup_prune() { # keep everything from the last BACKUP_KEEP_HOURS, then the newest per day for BACKUP_KEEP_DAYS
  local dir f day now age seen=" "
  dir="$BACKUP_ROOT/$(share_slug "$1")"
  [[ -d "$dir" ]] || return 0
  now="$(date +%s)"
  while IFS= read -r f; do
    age=$(( (now - $(stat -c %Y "$f")) / 3600 ))
    (( age < BACKUP_KEEP_HOURS )) && continue
    day="$(basename "$f" | cut -c1-8)"
    if (( age < BACKUP_KEEP_DAYS * 24 )) && [[ "$seen" != *" $day "* ]]; then seen+="$day "; continue; fi
    rm -f "$f"
  done < <(find "$dir" -maxdepth 1 -type f ! -name '.*' -printf '%f\n' | sort -r | sed "s#^#$dir/#")
}

backup_list() { # newest first
  local dir
  dir="$BACKUP_ROOT/$(share_slug "$1")"
  [[ -d "$dir" ]] || return 0
  find "$dir" -maxdepth 1 -type f ! -name '.*' -printf '%f  %s\n' | sort -r \
    | awk '{ printf "%s  %.1f MB\n", $1, $2/1048576 }'
}

backup_restore() { # backup_restore <share> <file>   (caller confirms; a fresh backup is taken first)
  local p="$1" f="$2" pre tmpcnf
  [[ "$f" == /* ]] || f="$BACKUP_ROOT/$(share_slug "$p")/$f"
  [[ -f "$f" ]] || die "File backup tidak ditemukan: $f"
  db_info "$p" || die "Tidak ada $p/.env."
  pre="$(OTB_BACKUP_FORCE=1 backup_one "$p")" || die "Backup sebelum restore gagal; restore dibatalkan."
  case "$DB_CONNECTION" in
    mysql|mariadb)
      tmpcnf="$(mktemp)"; chmod 0600 "$tmpcnf"
      printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n' "$DB_USERNAME" "$DB_PASSWORD" "${DB_HOST:-127.0.0.1}" "${DB_PORT:-3306}" > "$tmpcnf"
      gunzip -c "$f" | mysql --defaults-extra-file="$tmpcnf" || { rm -f "$tmpcnf"; die "Restore gagal."; }
      rm -f "$tmpcnf" ;;
    pgsql)
      PGPASSWORD="$DB_PASSWORD" pg_restore --clean --if-exists -h "${DB_HOST:-127.0.0.1}" -p "${DB_PORT:-5432}" \
        -U "$DB_USERNAME" -d "$DB_DATABASE" "$f" || die "Restore gagal." ;;
    sqlite)
      sqlite3 "$DB_DATABASE" ".restore '$f'" || die "Restore gagal." ;;
  esac
  log "Database dipulihkan dari $(basename "$f"). Kondisi sebelum restore tersimpan di $(basename "$pre")."
}

# ---------------------------------------------------------------- timers
install_safety_timers() { # enabled only while at least one rw share exists
  local u
  if [[ -z "$(rw_shares)" ]]; then
    for u in otb-snapshot otb-backup; do
      systemctl disable --now "$u.timer" >/dev/null 2>&1 || true
      rm -f "/etc/systemd/system/$u.timer" "/etc/systemd/system/$u.service"
    done
    systemctl daemon-reload
    return 0
  fi
  [[ -f "$SAFETY_CONF" ]] || cat > "$SAFETY_CONF" <<'EOF'
# Safety nets for writable shared folders (otb share --write). Applied on the next run.
SNAPSHOT_KEEP_DAYS=7      # file snapshots (every 5 minutes) are kept this many days
BACKUP_KEEP_HOURS=48      # every hourly database backup from the last N hours is kept
BACKUP_KEEP_DAYS=14       # after that, one backup per day for this many days
EOF
  grep -q '^BACKUP_MAX_MB=' "$SAFETY_CONF" \
    || echo 'BACKUP_MAX_MB=2048        # larger databases are not backed up automatically (0 = no limit)' >> "$SAFETY_CONF"
  chmod 0644 "$SAFETY_CONF"
  cat > /etc/systemd/system/otb-snapshot.service <<'EOF'
[Unit]
Description=otb: snapshot shared folders
[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/usr/local/bin/otb snapshot --all --quiet
EOF
  cat > /etc/systemd/system/otb-snapshot.timer <<'EOF'
[Unit]
Description=otb: snapshot shared folders every 5 minutes
[Timer]
OnCalendar=*:0/5
Persistent=true
[Install]
WantedBy=timers.target
EOF
  cat > /etc/systemd/system/otb-backup.service <<'EOF'
[Unit]
Description=otb: back up databases of shared folders
[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/usr/local/bin/otb backup --all --quiet
EOF
  cat > /etc/systemd/system/otb-backup.timer <<'EOF'
[Unit]
Description=otb: back up databases of shared folders every hour
[Timer]
OnCalendar=hourly
RandomizedDelaySec=120
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now otb-snapshot.timer otb-backup.timer >/dev/null 2>&1
}
