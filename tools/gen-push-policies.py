#!/usr/bin/env python3
"""Generates config/policies/<preset>-push.json from each base preset.

The -push variants are used after `otb github-key`: `git push` asks for approval instead of
being blocked, while history-destroying pushes (force, mirror, delete) stay blocked.
OpenCode applies the LAST matching rule, so the force/delete denies are appended after the
ask rules.

Run after editing a base preset:  python3 tools/gen-push-policies.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "config" / "policies"

PUSH_ASK = ["git push", "git push *", "*/git push *"]
PUSH_DENY = [
    "git push -f", "git push -f *", "git push * -f", "git push * -f *",
    "git push *--force*", "git push *--force-with-lease*", "git push *--mirror*",
    "git push *--delete*", "git push * -d *", "git push * :*", "git push * +*",
    "*/git push *--force*", "*/git push * -f*",
]

for base in ("otomatis", "seimbang", "ketat"):
    policy = json.loads((ROOT / f"{base}.json").read_text())
    bash = policy["permission"]["bash"]
    rules = {k: v for k, v in bash.items() if k not in PUSH_ASK + PUSH_DENY}
    rules.update({k: "ask" for k in PUSH_ASK})
    rules.update({k: "deny" for k in PUSH_DENY})
    policy["permission"]["bash"] = rules
    out = ROOT / f"{base}-push.json"
    out.write_text(json.dumps(policy, indent=2) + "\n")
    print(f"wrote {out.name}: {len(rules)} bash rules")
