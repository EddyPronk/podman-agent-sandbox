#!/bin/bash
# nested.sh — a sandbox that runs podman and sandboxes of its own, end to end, with a given build of
# this package on both levels.
#
#   test/integration/nested.sh TARBALL [LOG_DIR]
#
# TARBALL is an `npm pack` of this repo, installed globally on the host beforehand (sandbox on PATH).
# Creates the sandbox `nested` (NESTED=NAME for another name) from the bundled template
# claude-containers in $SANDBOX_DIR (default ~/sandboxes), installs TARBALL inside it over the
# release the template installs, then checks, one line per test (PASS or FAIL):
#   T1-T6   podman inside: info, run, network, exec, build
#   T7-T12  the sandbox command inside: a nested `claude` sandbox made, entered, its home and USER
#   T13-T16 a mitm-proxy and a proxy-client sandbox inside: the client's only way out is the
#           proxy (proxy-network.sh, run inside)
#   T17-T18 those three are hardened (no capabilities, no new privileges) and still work
#   T19     sandbox inspect on the nested claude, recognised as a sandbox by its label
#   T20     sandbox rm refuses a container that isn't a sandbox, unless --force
# Each test's full output is in LOG_DIR (default ./nested-logs), and on a failure the end of it is
# printed, followed by the state of both levels (containers, their logs, disk).
# Exit status: the number of failed tests; 99 if `nested` couldn't be set up.
# Needs rootless podman and /dev/net/tun on the host. Takes a while: it builds four images.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd -P)
TARBALL=${1:?usage: nested.sh TARBALL [LOG_DIR]}
TARBALL=$(cd "$(dirname "$TARBALL")" && pwd -P)/$(basename "$TARBALL")
LOG=${2:-nested-logs}
mkdir -p "$LOG"
LOG=$(cd "$LOG" && pwd -P)
export SANDBOX_DIR=${SANDBOX_DIR:-$HOME/sandboxes}
N=${NESTED:-nested}
U=$(id -u)
VERSION=$(node -p "require('$here/../../package.json').version")

# The state of both levels, for a failure.
diagnose() {
    echo "--- host: podman ps -a"
    podman ps -a
    echo "--- host: podman logs $N (last 50 lines)"
    podman logs "$N" 2>&1 | tail -n 50
    echo "--- inside $N: podman ps -a, sandbox list, the nested claude's logs, enter log, disk"
    podman exec -u "$U" "$N" bash -lc \
        'podman ps -a; sandbox list; podman logs claude 2>&1 | tail -n 50; cat /tmp/enter.log; df -h / ~' 2>&1
    echo "--- host: df -h"
    df -h /
}

die() {   # MESSAGE LOGFILE: setting up failed
    echo "nested.sh: $1 (log: $2)"
    tail -n 40 "$2" | sed 's/^/      | /'
    diagnose >"$LOG/diagnostics.log" 2>&1
    cat "$LOG/diagnostics.log"
    exit 99
}

# Set up: the sandbox (`sandbox new` writes its seccomp profile), and the package inside.
command -v sandbox >/dev/null || { echo "nested.sh: no sandbox on PATH; npm install -g $TARBALL first"; exit 99; }
if [[ ! -d $SANDBOX_DIR/$N ]]; then
    mkdir -p "$SANDBOX_DIR"
    sandbox new "$N" --template claude-containers >"$LOG/new.log" 2>&1 || die "sandbox new failed" "$LOG/new.log"
fi
# enter with no input: builds and starts the container, the shell exits at once, the container stays.
# Its postCreateCommand installs the released sandbox of this version (if there is one).
sandbox enter "$N" </dev/null >"$LOG/up.log" 2>&1 || die "sandbox enter $N failed" "$LOG/up.log"
# The build under test, where install.sh puts it (npm's prefix, or ~/.local if that isn't writable),
# so it replaces the release instead of sitting next to it.
{ podman cp "$TARBALL" "$N:/tmp/podman-agent-sandbox.tgz" \
    && podman cp "$here/proxy-network.sh" "$N:/tmp/proxy-network.sh" \
    && podman exec -u "$U" "$N" bash -lc \
        'prefix=$(npm config get prefix); if [ ! -w "$prefix/lib/node_modules" ]; then
             npm config set prefix ~/.local --location=user; mkdir -p ~/.local/bin; fi
         npm install -g --no-fund --no-audit /tmp/podman-agent-sandbox.tgz'
} >"$LOG/install.log" 2>&1 || die "installing $TARBALL inside $N failed" "$LOG/install.log"

failed=0
run() {   # NAME COMMAND: run COMMAND inside, in a login shell like `sandbox enter`, and report
    local name=$1 file="$LOG/${1%% *}.log"; shift
    if podman exec -u "$U" "$N" bash -lc "$*" >"$file" 2>&1; then
        printf 'PASS  %s\n' "$name"
    else
        printf 'FAIL  %s\n' "$name"
        tail -n 30 "$file" | sed 's/^/      | /'
        failed=$((failed + 1))
    fi
}

run "T1 podman is installed"                 'podman --version'
run "T2 podman info works (rootless setup)"  'podman info --format "{{.Host.Security.Rootless}} {{.Store.GraphDriverName}}" | tee /dev/stderr | grep -q ^true'
run "T3 run a container"                     'podman run --rm docker.io/library/alpine:latest echo hello-from-inner'
run "T4 the inner container has network"    'podman run --rm docker.io/library/alpine:latest wget -q -O /dev/null http://example.com'
run "T5 exec into a running container"      'podman rm -f t5 >/dev/null 2>&1; podman run -d --name t5 docker.io/library/alpine:latest sleep 60 >/dev/null && podman exec t5 echo exec-ok; s=$?; podman rm -f t5 >/dev/null; exit $s'
run "T6 build an image"                      'd=$(mktemp -d) && printf "FROM docker.io/library/alpine:latest\nRUN echo built > /built\n" > $d/Containerfile && podman build -q -t t6 $d && podman run --rm t6 cat /built; s=$?; rm -r $d; podman rmi -f t6 >/dev/null 2>&1; exit $s'
run "T7 node and npm are installed"          'node --version && npm --version'
run "T8 sandbox is this build ($VERSION)"     "sandbox --version | grep '^sandbox $VERSION ' || exit 1
    pkg=\$(dirname \$(readlink -f \$(command -v sandbox)))/..; t=\$(mktemp -d); tar -xzf /tmp/podman-agent-sandbox.tgz -C \$t
    diff -r \$t/package/src \$pkg/src && diff -r \$t/package/templates \$pkg/templates && echo \"same code as the tarball (\$(readlink -f \$pkg))\""
run "T9 sandbox new + enter a claude"        '[ -d "${SANDBOX_DIR:-$HOME/sandboxes}/claude" ] || sandbox new claude --template claude; sandbox enter claude </dev/null >/tmp/enter.log 2>&1 || { tail -n 40 /tmp/enter.log; exit 1; }; podman ps --format "{{.Names}} {{.State}}" | grep "^claude running"'
run "T10 claude runs in the nested claude"   'podman exec claude bash -lc "claude --version"'
run "T11 nested claude's home is its volume" 'u=$(id -un); d=$(podman container inspect claude --format "{{range .Mounts}}{{if eq .Name \"claude-home\"}}{{.Destination}}{{end}}{{end}}"); echo "home volume at [$d], expected /home/$u"; [ "$d" = "/home/$u" ]'
run "T12 USER, LOGNAME in a sandbox enter shell" 'got=$(echo "echo \"[\$USER][\$LOGNAME]\"" | sandbox enter claude 2>/dev/null | tail -n 1); u=$(id -un); echo "got $got, expected [$u][$u]"; [ "$got" = "[$u][$u]" ]'

# T13-T16 run inside, as one script: their PASS/FAIL lines are printed as they are.
podman exec -u "$U" "$N" bash -lc 'bash /tmp/proxy-network.sh ~/proxy-network-logs' >"$LOG/proxy-network.log" 2>&1
pn=$?
grep -E '^(PASS|FAIL|      \|)' "$LOG/proxy-network.log"
if ((pn >= 99)) || ! grep -q '^failed: ' "$LOG/proxy-network.log"; then
    echo "FAIL  T13-T16 did not run (exit $pn)"; tail -n 30 "$LOG/proxy-network.log" | sed 's/^/      | /'; pn=1
fi
failed=$((failed + pn))

# The hardened templates (claude, mitm-proxy, proxy-client), on the containers made above.
run "T17 claude, proxy, work: no capabilities, no new privileges" 'f=; for c in claude proxy work; do s=$(podman exec $c grep -E "^(CapBnd|NoNewPrivs):" /proc/self/status | tr -s "\t\n" "  "); echo "$c: [$s]"; [ "$s" = "CapBnd: 0000000000000000 NoNewPrivs: 1 " ] || f=1; done; [ -z "$f" ]'
run "T18 everyday work in the hardened claude" 'podman exec claude bash -lc "set -e; touch ~/.p /workspace/.p; rm ~/.p /workspace/.p; test -f ~/.bashrc; d=\$(mktemp -d); cd \$d; git init -q; git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x; npm install --silent --no-audit --no-fund is-number >/dev/null; echo everyday-ok"'
run "T19 sandbox inspect: the podman run command, and no warnings for the claude" 'out=$(sandbox inspect claude) || exit 1; echo "$out"; echo "$out" | grep -q "^# claude is a sandbox (label podman-agent-sandbox=" && echo "$out" | grep -q "^podman run" && echo "$out" | grep -q "^capabilities  *none" && ! echo "$out" | grep -q "^warning:"'
run "T20 sandbox rm refuses a container that isn't a sandbox; --force removes it" 'podman rm -f t20 >/dev/null 2>&1; podman create --name t20 docker.io/library/alpine:latest true >/dev/null || exit 1; sandbox rm t20; s=$?; podman container exists t20 || { echo "t20 was removed without --force"; exit 1; }; [ $s -ne 0 ] && sandbox rm --force t20 && ! podman container exists t20'

echo "failed: $failed"
if ((failed)); then
    diagnose >"$LOG/diagnostics.log" 2>&1
    cat "$LOG/diagnostics.log"
fi
exit "$failed"
