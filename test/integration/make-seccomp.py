#!/usr/bin/env python3
"""make-seccomp.py SOURCE OUT — a seccomp profile for the nested-podman sandbox: podman's default
profile (SOURCE, e.g. /usr/share/containers/seccomp.json) plus sethostname and setdomainname
allowed without CAP_SYS_ADMIN.

Inner containers set their own host name; both calls only change the caller's own UTS namespace,
and each inner container gets its own, so nothing outside it changes. Everything else is the
host podman's default, unchanged.
"""
import json
import sys
from pathlib import Path

ALLOW = ["sethostname", "setdomainname"]
source, out = map(Path, sys.argv[1:3])

profile = json.loads(source.read_text())
for rule in profile["syscalls"]:
    rule["names"] = [n for n in rule["names"] if n not in ALLOW]
profile["syscalls"] = [r for r in profile["syscalls"] if r["names"]]
profile["syscalls"].append({
    "names": ALLOW,
    "action": "SCMP_ACT_ALLOW",
    "comment": "nested podman: inner containers set their own host name",
})
out.write_text(json.dumps(profile, indent=2) + "\n")
print(f"wrote {out} from {source}: {', '.join(ALLOW)} allowed without CAP_SYS_ADMIN")
