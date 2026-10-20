#!/usr/bin/env bash
# Checks that the sandbox actually holds. Detects Mode A (systemd) or Mode B (Docker).
#   sudo ./verify.sh
# Exit code is non-zero if any check FAILs.
set -uo pipefail

ETC_DIR=/etc/otb
PASS=0; FAIL=0; WARN=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
warnc() { printf '  \033[33mWARN\033[0m %s\n' "$*"; WARN=$((WARN+1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo ./verify.sh)"; exit 2; }

env_value() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n1; }

# ---------------------------------------------------------------- detect mode
mode_a=0; mode_b=0
systemctl is-active --quiet otb-agent.service 2>/dev/null && mode_a=1
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx otb-agent; then mode_b=1; fi

section "Mode"
if [[ $mode_a -eq 1 && $mode_b -eq 1 ]]; then
  fail "Mode A and Mode B are both running. Two bots with one token fight over Telegram updates. Stop one."
elif [[ $mode_a -eq 1 ]]; then pass "Mode A (systemd) detected"
elif [[ $mode_b -eq 1 ]]; then pass "Mode B (Docker) detected"
else fail "Neither otb-agent.service nor the otb-agent container is running"; fi

# ---------------------------------------------------------------- run as agent / bot
# Runs a shell snippet with the agent's (or bot's) identity *and* its filesystem view.
as_agent() {
  if [[ $mode_a -eq 1 ]]; then
    local pid; pid="$(systemctl show -p MainPID --value otb-agent.service)"
    nsenter --target "$pid" --mount -- setpriv --reuid=otb-agent --regid=otb-agent --init-groups \
      --no-new-privs --bounding-set=-all sh -c "$1" 2>/dev/null
  else
    docker exec otb-agent sh -c "$1" 2>/dev/null
  fi
}
as_bot() {
  if [[ $mode_a -eq 1 ]]; then
    local pid; pid="$(systemctl show -p MainPID --value otb-bot.service)"
    [[ "$pid" != "0" ]] || return 99
    nsenter --target "$pid" --mount -- setpriv --reuid=otb-bot --regid=otb-bot --init-groups \
      --no-new-privs --bounding-set=-all sh -c "$1" 2>/dev/null
  else
    docker exec otb-bot sh -c "$1" 2>/dev/null
  fi
}
expect_denied() { # expect_denied <runner> <description> <cmd>
  if "$1" "$3"; then fail "$2 (was ALLOWED)"; else pass "$2"; fi
}
expect_allowed() {
  if "$1" "$3"; then pass "$2"; else fail "$2 (was DENIED)"; fi
}

if [[ $mode_a -eq 1 || $mode_b -eq 1 ]]; then
  section "Agent sandbox (what a hijacked AI could do)"
  expect_allowed as_agent "Agent can write in /srv/workspace" \
    't=/srv/workspace/.otb-verify-$$; echo ok > "$t" && rm -f "$t"'
  expect_denied as_agent "Agent cannot write system dirs (/etc, /usr)" \
    'touch /etc/otb-x || touch /usr/otb-x'
  expect_denied as_agent "Agent cannot modify its own OpenCode binary" \
    'touch /opt/otb/agent/node_modules/.otb-x'
  expect_denied as_agent "Agent cannot change the permission policy" \
    'echo {} > /etc/opencode/opencode.json'
  expect_denied as_agent "Agent cannot plant global OpenCode config/plugins" \
    'mkdir -p /etc/otb/agent-xdg/opencode/plugins && touch /etc/otb/agent-xdg/opencode/plugins/x.ts'
  expect_denied as_agent "Agent cannot plant plugins in ~/.opencode" \
    'h=/var/lib/otb-agent; [ -d /home/agent ] && h=/home/agent; mkdir -p "$h/.opencode/plugins" && touch "$h/.opencode/plugins/x.ts"'
  expect_denied as_agent "Agent cannot read the Telegram bot token" \
    'cat /etc/otb/bot.env || cat /data/.env || ls /var/lib/otb-bot'
  expect_denied as_agent "Agent cannot see anything in /root" 'ls -A /root 2>/dev/null | grep -q .'
  shares="$(awk '$1 ~ /^(ro|rw)$/ && $2 ~ /^\// {print $1, $2}' /etc/otb/shares.conf 2>/dev/null)"
  if [[ $mode_b -eq 1 ]]; then
    expect_denied as_agent "Agent cannot read other users' /home" 'ls /home | grep -vxq agent'
  else
    # Only the shared folders (and the directories leading to them) may be visible in /home.
    leak=""
    for h in /home/*/; do
      h="${h%/}"; [[ -d "$h" ]] || continue
      allowed="$(awk -v h="$h/" 'index($2, h) == 1 { s = substr($2, length(h) + 1); sub(/\/.*/, "", s); print s }' <<<"$shares" | sort -u)"
      seen="$(as_agent "ls -A '$h' 2>/dev/null" || true)"
      while IFS= read -r e; do
        [[ -z "$e" ]] && continue
        grep -qxF "$e" <<<"$allowed" || leak+=" $h/$e"
      done <<<"$seen"
    done
    if [[ -z "$leak" ]]; then pass "Agent sees nothing in /home except shared folders"
    else fail "Agent can see unshared files in /home:$leak"; fi
  fi
  while read -r smode spath; do
    [[ -z "$spath" ]] && continue
    t="$spath/.otb-verify-$$"
    if [[ "$smode" == rw ]]; then
      expect_allowed as_agent "Agent can write shared folder $spath (rw)" "touch '$t' && rm -f '$t'"
    else
      expect_allowed as_agent "Agent can read shared folder $spath (ro)" "ls '$spath' >/dev/null"
      expect_denied as_agent "Agent cannot write shared folder $spath (ro)" "touch '$t'"
    fi
  done <<<"$shares"
  expect_denied as_agent "Agent cannot become root (sudo/su)" \
    'sudo -n true || su -c true root </dev/null'
  if [[ $mode_a -eq 1 ]]; then
    agent_env="$(tr '\0' '\n' < "/proc/$(systemctl show -p MainPID --value otb-agent.service)/environ")"
  else
    agent_env="$(docker exec otb-agent env 2>/dev/null)"
  fi
  if grep -qx 'OPENCODE_DISABLE_PROJECT_CONFIG=1' <<<"$agent_env"; then
    pass "Repo-supplied OpenCode config/plugins are disabled"
  else
    fail "OPENCODE_DISABLE_PROJECT_CONFIG is not set: a cloned repo's .opencode/plugins would run code"
  fi

  section "Bot sandbox"
  expect_denied as_bot "Bot cannot write in /srv/workspace" \
    'touch /srv/workspace/.otb-bot-x'
  while read -r _ spath; do
    [[ -z "$spath" ]] && continue
    expect_denied as_bot "Bot cannot write shared folder $spath" "touch '$spath/.otb-bot-x'"
  done <<<"$shares"
  expect_denied as_bot "Bot cannot read the agent's provider API key" \
    'cat /etc/otb/agent.env'
  if [[ $mode_a -eq 1 ]]; then
    expect_denied as_bot "Bot cannot start its own unsandboxed OpenCode" \
      'ls /opt/otb/agent/node_modules/.bin/opencode'
  fi
fi

# ---------------------------------------------------------------- OpenCode server
section "OpenCode server"
pw="$(env_value "$ETC_DIR/agent.env" OPENCODE_SERVER_PASSWORD)"

# api <METHOD> <PATH> [JSON] [noauth] -> response body; "STATUS:<code>" for noauth
api() {
  if [[ $mode_a -eq 1 ]]; then
    local auth=(-u "opencode:$pw"); [[ "${4:-}" == noauth ]] && auth=()
    if [[ "${4:-}" == noauth ]]; then
      printf 'STATUS:%s' "$(curl -s -o /dev/null -w '%{http_code}' -X "$1" "http://127.0.0.1:4096$2")"
    else
      curl -s "${auth[@]}" -X "$1" -H 'content-type: application/json' ${3:+-d "$3"} "http://127.0.0.1:4096$2"
    fi
  else
    docker exec -e M="$1" -e P="$2" -e B="${3:-}" -e NA="${4:-}" otb-bot node -e '
      const h = {"content-type": "application/json"};
      if (!process.env.NA) h.authorization = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
      fetch("http://agent:4096" + process.env.P, {method: process.env.M, headers: h, body: process.env.B || undefined})
        .then(async r => process.stdout.write(process.env.NA ? "STATUS:" + r.status : await r.text()));' 2>/dev/null
  fi
}

if [[ $mode_a -eq 1 || $mode_b -eq 1 ]]; then
  [[ "$(api GET /config '' noauth)" == "STATUS:401" ]] \
    && pass "API rejects requests without the password" || fail "API answers without the password"
  cfg="$(api GET /config)"
  if [[ $mode_a -eq 1 ]]; then
    bot_code="$(as_bot "curl -s -o /dev/null -w '%{http_code}' -u 'opencode:$pw' http://127.0.0.1:4096/config")"
    [[ "$bot_code" == "200" ]] && pass "Bot can reach the OpenCode API from inside its sandbox" || fail "Bot cannot reach the OpenCode API (got '$bot_code')"
  elif [[ "$cfg" == \{* ]]; then
    pass "Bot can reach the OpenCode API over the private network"
  fi
fi
if [[ -n "${cfg:-}" ]]; then
  policy_name="$(sed -n 's/^POLICY=//p' /etc/otb/policy.conf 2>/dev/null)"
  push_flag="$(sed -n 's/^PUSH=//p' /etc/otb/policy.conf 2>/dev/null)"
  OTB_PUSH="$push_flag" python3 - "$cfg" <<'PY' && pass "Approval policy '${policy_name:-?}' active; hard blocks in place ($([[ "$push_flag" == 1 ]] && echo "git push asks, force push" || echo "git push"), sudo, ssh, docker, outside project)" || fail "Managed permission policy NOT active or hard blocks missing"
import json, sys
p = json.loads(sys.argv[1]).get("permission", {})
b = p.get("bash", {})
import os
push = os.environ.get("OTB_PUSH") == "1"
must_deny = ["sudo *", "ssh *", "scp *", "docker *", "systemctl *", "crontab *", "git config *"]
if push:   # otb github-key: pushing asks, history-destroying pushes stay blocked
    must_deny += ["git push *--force*", "git push -f *", "git push *--delete*"]
    push_ok = b.get("git push *") == "ask"
else:
    must_deny += ["git push *", "git push"]
    push_ok = True
ok = isinstance(b, dict) and push_ok and all(b.get(k) == "deny" for k in must_deny) and p.get("external_directory") == "deny" \
     and isinstance(p.get("edit"), dict) and p["edit"].get("*opencode.json") == "deny"
sys.exit(0 if ok else 1)
PY
fi

# ---------------------------------------------------------------- hostile repository
# Simulates cloning a repo that ships an OpenCode plugin. Without the hardening, opening
# a session in it runs the plugin's code immediately, with no approval prompt.
if [[ $mode_a -eq 1 || $mode_b -eq 1 ]]; then
  section "Hostile repository test"
  repo=/srv/workspace/.otb-verify-evil-repo
  marker=/srv/workspace/.otb-verify-marker
  plugin_src="import { appendFileSync } from \"fs\";
export const P = async () => { appendFileSync(\"$marker\", \"ran\\n\"); return {}; };"
  b64="$(printf '%s' "$plugin_src" | base64 -w0)"
  # No `git init`: a git repo without commits would become OpenCode's "global" project and
  # leave that project pointing at this deleted folder (the bot then picks it up).
  as_agent "rm -rf $repo $marker; mkdir -p $repo/.opencode/plugins && echo $b64 | base64 -d > $repo/.opencode/plugins/p.ts"
  sid="$(api POST "/session?directory=$repo" '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)"
  sleep 6
  if [[ -z "$sid" ]]; then
    warnc "Could not open a test session; hostile repo test skipped"
  elif as_agent "test -e $marker"; then
    fail "A repo's .opencode plugin EXECUTED when a session was opened"
  else
    pass "A repo's .opencode plugin did not execute"
  fi
  [[ -n "$sid" ]] && api DELETE "/session/$sid?directory=$repo" >/dev/null
  as_agent "rm -rf $repo $marker"
fi

# ---------------------------------------------------------------- network exposure
section "Network exposure"
if command -v ss >/dev/null; then
  public="$(ss -Hltn | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' || true)"
  if echo "$public" | grep -qE ':4096$'; then fail "OpenCode port 4096 is listening on a public interface"
  else pass "OpenCode port 4096 is not exposed"; fi
  others="$(echo "$public" | grep -vE ':(22)$' | sort -u | tr '\n' ' ')"
  [[ -z "${others// /}" ]] && pass "No public listeners besides SSH" || warnc "Other public listeners: $others"
fi
if [[ $mode_b -eq 1 ]]; then
  ports="$(docker ps --filter name=otb- --format '{{.Ports}}' | grep -E '0\.0\.0\.0|::' || true)"
  [[ -z "$ports" ]] && pass "No container ports published to the host" || fail "Container ports published: $ports"
fi
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  pass "ufw firewall is active"
else
  warnc "ufw is not active (run: sudo ./install.sh --harden-host)"
fi

# ---------------------------------------------------------------- hardening settings
section "Hardening settings"
# Code that root runs (install.sh, otb, verify.sh) must not be writable by anyone else.
repo_dir="$(sed -n 's/^REPO_DIR=//p' /etc/otb/install.conf 2>/dev/null)"
if [[ -n "$repo_dir" && -d "$repo_dir" ]]; then
  writable="$(find "$repo_dir" -xdev ! -type l \( -perm -o+w -o \( -perm -g+w ! -group root \) \) 2>/dev/null | head -n 3)"
  owner="$(stat -c '%U' "$repo_dir")"
  if [[ -z "$writable" && ( "$owner" == root || "$repo_dir" != /opt/* ) ]]; then
    pass "Installer code in $repo_dir is not writable by other users"
  else
    fail "Installer code is writable by others (root runs it): ${writable:-owner $owner}"
  fi
fi
if [[ $mode_a -eq 1 ]]; then
  for u in otb-agent otb-bot; do
    nnp="$(systemctl show -p NoNewPrivileges --value $u.service)"
    caps="$(systemctl show -p CapabilityBoundingSet --value $u.service)"
    [[ "$nnp" == "yes" && -z "$caps" ]] && pass "$u: no capabilities, NoNewPrivileges" || fail "$u: NoNewPrivileges=$nnp caps='$caps'"
    score="$(systemd-analyze security $u.service 2>/dev/null | sed -n 's/.*Overall exposure level for [^:]*: *//p')"
    [[ -n "$score" ]] && pass "$u systemd exposure score: $score (0 = most locked down, 10 = unprotected)"
  done
  for f in "$ETC_DIR/agent.env" "$ETC_DIR/bot.env"; do
    perm="$(stat -c '%a %U' "$f")"; [[ "$perm" == "600 root" ]] && pass "$f is 0600 root" || fail "$f is $perm (want 600 root)"
  done
elif [[ $mode_b -eq 1 ]]; then
  for c in otb-agent otb-bot; do
    IFS="|" read -r ro caps sec _user pids < <(docker inspect "$c" --format \
      '{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.CapDrop}}|{{.HostConfig.SecurityOpt}}|{{.Config.User}}|{{.HostConfig.PidsLimit}}')
    uid="$(docker exec "$c" id -u 2>/dev/null)"
    if [[ "$ro" == "true" && "$caps" == *ALL* && "$sec" == *no-new-privileges* && -n "$uid" && "$uid" != "0" && "${pids:-0}" -gt 0 ]]; then
      pass "$c: read-only rootfs, no capabilities, no-new-privileges, uid $uid, pids limit $pids"
    else
      fail "$c: readonly=$ro capdrop=$caps secopt=$sec uid=$uid pids=$pids"
    fi
  done
  docker inspect otb-agent otb-bot --format '{{range .Mounts}}{{.Source}} {{end}}' | grep -q docker.sock \
    && fail "docker.sock is mounted into a container" || pass "docker.sock is not mounted into any container"
fi

printf '\n\033[1mResult:\033[0m %d passed, %d failed, %d warnings\n' "$PASS" "$FAIL" "$WARN"
[[ $FAIL -eq 0 ]]
