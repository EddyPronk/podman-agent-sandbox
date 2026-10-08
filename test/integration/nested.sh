#!/bin/bash
# nested.sh — a sandbox that runs podman and sandboxes of its own, end to end, with a given build of
# this package on both levels.
#
#   test/integration/nested.sh TARBALL [LOG_DIR]
#
# TARBALL is an `npm pack` of this repo, installed globally on the host beforehand (sandbox on PATH).
# Creates the sandbox `nested` (NESTED=NAME for another name) from test/integration/nested-podman in
# $SANDBOX_DIR (default ~/sandboxes), with a seccomp profile made from the host podman's default,
# installs TARBALL inside it, then checks, one line per test (PASS or FAIL):
#   T1-T6   podman inside: info, run, network, exec, build
#   T7-T12  the sandbox command inside: a nested `claude` sandbox made, entered, its home and USER
# Each test's full output is in LOG_DIR (default ./nested-logs), and on a failure the end of it is
# printed, followed by the state of both levels (containers, their logs, disk).
# Exit status: the number of failed tests; 99 if `nested` couldn't be set up.
# Needs rootless podman, /dev/net/tun and python3 on the host. Takes a while: it builds two images.
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

# Set up: the sandbox, its seccomp profile, and the package inside.
command -v sandbox >/dev/null || { echo "nested.sh: no sandbox on PATH; npm install -g $TARBALL first"; exit 99; }
if [[ ! -d $SANDBOX_DIR/$N ]]; then
    mkdir -p "$SANDBOX_DIR"
    sandbox new "$N" --template "$here/nested-podman" >"$LOG/new.log" 2>&1 || die "sandbox new failed" "$LOG/new.log"
fi
profile=$(podman info --format '{{.Host.Security.SECCOMPProfilePath}}' 2>"$LOG/seccomp.log")
[[ -f $profile ]] || die "no default seccomp profile found ([$profile])" "$LOG/seccomp.log"
python3 "$here/make-seccomp.py" "$profile" "$SANDBOX_DIR/$N/.devcontainer/seccomp.json" >"$LOG/seccomp.log" 2>&1 \
    || die "no seccomp profile from $profile" "$LOG/seccomp.log"
# enter with no input: builds and starts the container, the shell exits at once, the container stays.
sandbox enter "$N" </dev/null >"$LOG/up.log" 2>&1 || die "sandbox enter $N failed" "$LOG/up.log"
{ podman cp "$TARBALL" "$N:/tmp/podman-agent-sandbox.tgz" \
    && podman exec -u "$U" "$N" bash -lc \
        'npm config set prefix ~/.local --location=user && mkdir -p ~/.local/bin \
         && npm install -g --no-fund --no-audit /tmp/podman-agent-sandbox.tgz'
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
run "T8 sandbox is this build ($VERSION)"     "sandbox --version; sandbox --version | grep -q '^sandbox $VERSION '"
run "T9 sandbox new + enter a claude"        '[ -d ~/sandboxes/claude ] || sandbox new claude --template claude; sandbox enter claude </dev/null >/tmp/enter.log 2>&1 || { tail -n 40 /tmp/enter.log; exit 1; }; podman ps --format "{{.Names}} {{.State}}" | grep "^claude running"'
run "T10 claude runs in the nested claude"   'podman exec claude bash -lc "claude --version"'
run "T11 nested claude's home is its volume" 'u=$(id -un); d=$(podman container inspect claude --format "{{range .Mounts}}{{if eq .Name \"claude-home\"}}{{.Destination}}{{end}}{{end}}"); echo "home volume at [$d], expected /home/$u"; [ "$d" = "/home/$u" ]'
run "T12 USER, LOGNAME in a sandbox enter shell" 'got=$(echo "echo \"[\$USER][\$LOGNAME]\"" | sandbox enter claude 2>/dev/null | tail -n 1); u=$(id -un); echo "got $got, expected [$u][$u]"; [ "$got" = "[$u][$u]" ]'

echo "failed: $failed"
if ((failed)); then
    diagnose >"$LOG/diagnostics.log" 2>&1
    cat "$LOG/diagnostics.log"
fi
exit "$failed"
