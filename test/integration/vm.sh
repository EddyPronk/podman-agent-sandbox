#!/bin/bash
# vm.sh — sandbox enter --vm end to end, with krun: every rule of enter --vm, the other commands on a VM
# sandbox, the lock, and the protection inside the VM.
#
#   test/integration/vm.sh [LOG_DIR]
#
# Run on a host with krun (crun built with libkrun) on PATH and /dev/kvm, not in a sandbox. Uses
# $SANDBOX (default: this checkout's bin/sandbox.js) and its own $SANDBOX_DIR (default
# ~/sandboxes-vm-test, made and removed). Attaching needs a terminal, so each session runs in a
# pseudo-terminal (script) fed its input. One line per test (PASS, FAIL or NOTE):
#   V1   first enter --vm of a never-started sandbox: container made and stopped, VM made; inside: the
#        guest kernel, your uid, /workspace; a file written there is yours; exit stops the VM
#   V2   a stopped VM is started; Ctrl-P Ctrl-Q detaches and the VM keeps running; the next enter --vm
#        attaches to the same shell
#   V3   plain enter and exec refuse for a VM sandbox, running and stopped, without starting anything
#   V4   stop kills the VM at once; stop again says nothing is running
#   V5   x and x-vm side by side: enter --vm x refuses the foreign x-vm; rm x leaves it alone; x's VM
#        isn't a sandbox x-vm (rm --force refuses)
#   V6   enter --vm refuses an existing container (running and stopped); --from-existing makes the VM
#        from it; after rm, enter --vm makes both afresh
#   V7   two enter --vm at once on a new sandbox: one waits for the other (the lock); one VM
#   V8   mitm-proxy refused, nothing made
#   V9   a --workspace sandbox (a git repo, --hide of a file and a folder) in a VM: .git/hooks and
#        .git/config read-only, hidden paths empty, as the user and as guest root if the image has sudo;
#        a repo added after the VM was made: enter --vm refuses
#   V10  a claude-template sandbox in a VM: Claude Code runs
#   V11  claude-containers (custom seccomp profile on the VM's host process): the VM starts, or the
#        failure removes it (R5); NOTE says which
#   V12  rm removes the VM and the container, the kept volume listed once
# Removes what it made at the end. Each test's output is in LOG_DIR (default ./vm-test-logs).
# Exit status: the number of failed tests.
set -uo pipefail

[ -e /run/.containerenv ] && { echo "vm.sh: run it on the host (it needs /dev/kvm), not in a container" >&2; exit 2; }
command -v krun > /dev/null && krun --version | grep -q LIBKRUN || { echo "vm.sh: needs krun with libkrun on PATH" >&2; exit 2; }
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "vm.sh: needs /dev/kvm" >&2; exit 2; }

REPO=$(cd "$(dirname "$0")/../.." && pwd -P)
export SB=${SANDBOX:-node $REPO/bin/sandbox.js}
export SANDBOX_DIR=${SANDBOX_DIR:-$HOME/sandboxes-vm-test}
export WS=$SANDBOX_DIR-project
LOG=${1:-$PWD/vm-test-logs}
mkdir -p "$LOG" "$SANDBOX_DIR"
export LOG=$(cd "$LOG" && pwd -P)
export HOST_KERNEL=$(uname -r)
NAMES=(v1 v6 v7 vp vw vc vcc vx vx-vm)
failed=0

run() {   # NAME COMMAND: run COMMAND, report
    local name=$1 file="$LOG/${1%% *}.log"; shift
    if timeout 1200 bash -c "$*" > "$file" 2>&1; then
        printf 'PASS  %s\n' "$name"
    else
        printf 'FAIL  %s\n' "$name"
        tail -n 25 "$file" | sed 's/^/      | /'
        failed=$((failed + 1))
    fi
}

# vm NAME INPUT [OPTIONS]: sandbox enter --vm [OPTIONS] NAME in a pseudo-terminal, fed INPUT (printf %b).
vm() { local name=$1 input=$2; shift 2; printf '%b' "$input" | script -qefc "$SB enter --vm $* $name" /dev/null; }
# state NAME: podman's state of container NAME, or "absent".
state() { podman container inspect --format '{{.State.Status}}' "$1" 2> /dev/null || echo absent; }
export -f vm state

cleanup() {
    for n in "${NAMES[@]}"; do
        $SB rm --force "$n" > /dev/null 2>&1
        podman rm -f "$n" "$n-vm" > /dev/null 2>&1
        podman volume rm "$n-home" > /dev/null 2>&1
    done
    rm -rf "$SANDBOX_DIR" "$WS"
}
cleanup
mkdir -p "$SANDBOX_DIR"

run "V1 first enter --vm: container made and stopped, VM made; guest kernel, your uid; exit stops it" '
    set -e
    $SB new v1 --template offline
    out=$(vm v1 "echo K=\$(uname -r) U=\$(id -u) P=\$(pwd); echo from-vm > /workspace/m\nexit\n")
    echo "$out"
    echo "$out" | grep -q "K=[0-9]" && ! echo "$out" | grep -q "K=$HOST_KERNEL" || { echo "not the guest kernel"; exit 1; }
    echo "$out" | grep -q "U=$(id -u) P=/workspace" || { echo "uid or folder wrong"; exit 1; }
    [ "$(stat -c %u "$SANDBOX_DIR/v1/m")" = "$(id -u)" ] || { echo "the file is not yours"; exit 1; }
    [ "$(state v1)" = exited ] || { echo "container: $(state v1)"; exit 1; }
    [ "$(podman container inspect --format "{{index .Config.Labels \"podman-agent-sandbox.vm-of\"}}" v1-vm)" = v1 ]
    [ "$(state v1-vm)" = exited ] || { echo "VM: $(state v1-vm)"; exit 1; }'

run "V2 a stopped VM is started; Ctrl-P Ctrl-Q detaches; the next enter attaches to the same shell" '
    set -e
    vm v1 "export MARK=kept\necho PID=\$\$\n\x10\x11" > "$LOG/V2-first.log"
    [ "$(state v1-vm)" = running ] || { echo "VM after detach: $(state v1-vm)"; exit 1; }
    out=$(vm v1 "echo MARK=\$MARK PID=\$\$\n\x10\x11")
    echo "$out"
    echo "$out" | grep -q "MARK=kept" || { echo "not the same shell"; exit 1; }'

run "V3 plain enter and exec refuse for a VM sandbox, running and stopped" '
    for s in running stopped; do
        [ $s = stopped ] && $SB stop v1
        out=$($SB enter v1 < /dev/null 2>&1) && { echo "enter ran ($s)"; exit 1; }
        echo "$out" | grep -q "v1 is a VM" || { echo "$out"; exit 1; }
        out=$($SB exec v1 true 2>&1) && { echo "exec ran ($s)"; exit 1; }
        echo "$out" | grep -q "exec can.t run commands in it" || { echo "$out"; exit 1; }
        [ "$(state v1)" = exited ] || { echo "the container was started"; exit 1; }
    done'

run "V4 stop kills the VM at once; stop again says nothing is running" '
    set -e
    vm v1 "\x10\x11" > /dev/null
    [ "$(state v1-vm)" = running ]
    start=$(date +%s%N); $SB stop v1; took=$(( ($(date +%s%N) - start) / 1000000 ))
    echo "stop took $took ms"; [ "$took" -lt 3000 ]
    [ "$(state v1-vm)" = exited ]
    $SB stop v1 | grep -q "isn.t running: nothing to stop"'

run "V5 x and x-vm side by side: the foreign x-vm refused as a VM name, left alone by rm x" '
    set -e
    $SB new vx --template offline; $SB new vx-vm --template offline
    $SB exec vx-vm true
    out=$(vm vx "exit\n" 2>&1) && { echo "made a VM: $out"; exit 1; }
    echo "$out" | grep -q "the name vx-vm is taken by another container"
    $SB rm vx > /dev/null 2>&1 || true
    [ "$(state vx-vm)" = running ] || { echo "vx-vm: $(state vx-vm)"; exit 1; }
    $SB rm vx-vm; rm -rf "$SANDBOX_DIR/vx-vm"
    # Now x gets its VM, and that VM is no sandbox x-vm.
    vm vx "exit\n" > "$LOG/V5-vm.log" 2>&1
    [ "$(state vx-vm)" = exited ]
    out=$($SB rm --force vx-vm 2>&1) && { echo "rm --force vx-vm ran"; exit 1; }
    echo "$out" | grep -q "vx-vm is the VM of vx"
    [ "$(state vx-vm)" = exited ]'

run "V6 enter --vm refuses an existing container; --from-existing; after rm, afresh" '
    set -e
    $SB new v6 --template offline
    $SB exec v6 true
    out=$(vm v6 "exit\n" 2>&1) && { echo "ran while running"; exit 1; }
    echo "$out" | grep -q "runs as a normal container, not a VM"
    $SB stop v6
    out=$(vm v6 "exit\n" 2>&1) && { echo "ran on a stopped container"; exit 1; }
    echo "$out" | grep -q "already exists as a container, made"
    [ "$(state v6-vm)" = absent ]
    vm v6 "echo K=\$(uname -r)\nexit\n" --from-existing | grep -q "K=[0-9]"
    [ "$(state v6-vm)" = exited ]
    $SB rm v6
    vm v6 "exit\n" > "$LOG/V6-fresh.log" 2>&1
    [ "$(state v6)" = exited ] && [ "$(state v6-vm)" = exited ]'

run "V7 two enter --vm at once: one waits for the other; one VM" '
    set -e
    $SB new v7 --template offline
    (vm v7 "echo A\n\x10\x11" > "$LOG/V7-a.log" 2>&1) &
    (vm v7 "echo B\n\x10\x11" > "$LOG/V7-b.log" 2>&1) &
    wait
    cat "$LOG/V7-a.log" "$LOG/V7-b.log"
    grep -q "waiting for another sandbox command on v7" "$LOG/V7-a.log" "$LOG/V7-b.log"
    [ "$(podman ps -a --filter label=podman-agent-sandbox.vm-of=v7 --format "{{.ID}}" | wc -l)" = 1 ]
    $SB stop v7'

run "V8 mitm-proxy refused, nothing made" '
    $SB new vp --template mitm-proxy || exit 1
    out=$(vm vp "exit\n" 2>&1) && { echo "ran: $out"; exit 1; }
    echo "$out" | grep -q "vp can.t run as a VM" || { echo "$out"; exit 1; }
    [ "$(state vp)" = absent ] && [ "$(state vp-vm)" = absent ]'

run "V9 a --workspace sandbox in a VM: .git read-only, hidden paths empty; a repo added later refused" '
    set -e
    rm -rf "$WS"; mkdir -p "$WS/secrets"; git -C "$WS" init -q
    echo token > "$WS/.env"; echo key > "$WS/secrets/key"
    $SB new vw --template offline --workspace "$WS" --hide .env --hide secrets
    probe="cd $WS; touch .git/hooks/x 2>/dev/null && echo HOOKS-WRITABLE; echo x >> .git/config 2>/dev/null && echo CONFIG-WRITABLE"
    probe="$probe; echo ENV=[\$(cat .env)] SECRETS=[\$(ls secrets)]"
    probe="$probe; if command -v sudo >/dev/null; then sudo -n sh -c \"touch .git/hooks/y && echo ROOT-HOOKS-WRITABLE; cat .env\" 2>&1 | sed s/^/root:/; else echo NO-SUDO; fi"
    out=$(vm vw "$probe\nexit\n")
    echo "$out"
    ! echo "$out" | grep -q "WRITABLE"
    echo "$out" | grep -q "ENV=\[\] SECRETS=\[\]"
    [ "$(cat "$WS/.env")" = token ] && [ ! -e "$WS/.git/hooks/x" ]
    echo "$out" | grep -q NO-SUDO && echo "note: no sudo in the image; guest root not tried" || true
    mkdir -p "$WS/sub"; git -C "$WS/sub" init -q
    out=$(vm vw "exit\n" 2>&1) && { echo "ran with an unprotected repo"; exit 1; }
    echo "$out" | grep -q "would be writable inside vw"'

run "V10 a claude-template sandbox in a VM: Claude Code runs" '
    set -e
    $SB new vc --template claude
    out=$(vm vc "echo K=\$(uname -r); claude --version\nexit\n")
    echo "$out"
    echo "$out" | grep -q "K=[0-9]" && ! echo "$out" | grep -q "K=$HOST_KERNEL"
    echo "$out" | grep -qi "claude code"'

# V11 reports what happens rather than passing or failing on it: the docs claim neither yet.
$SB new vcc --template claude-containers > "$LOG/V11.log" 2>&1
if out=$(vm vcc "echo K=\$(uname -r)\nexit\n" 2>&1); then
    echo "$out" >> "$LOG/V11.log"
    printf 'NOTE  V11 claude-containers: the VM starts with the custom seccomp profile (%s)\n' "$(echo "$out" | grep -o "K=[^ ]*" | head -1)"
else
    echo "$out" >> "$LOG/V11.log"
    if [ "$(state vcc-vm)" = absent ]; then
        printf 'NOTE  V11 claude-containers: the VM fails; it was removed (R5): %s\n' "$(echo "$out" | grep -m1 "sandbox:")"
    else
        printf 'FAIL  V11 claude-containers: the VM failed and was left behind (%s)\n' "$(state vcc-vm)"
        failed=$((failed + 1))
    fi
fi

run "V12 rm removes the VM and the container, the kept volume listed once" '
    set -e
    out=$($SB rm v1); echo "$out"
    echo "$out" | grep -q "removed v1.s VM"; echo "$out" | grep -q "^removed v1$"
    [ "$(echo "$out" | grep -c "kept volume v1-home")" = 1 ]
    [ "$(state v1)" = absent ] && [ "$(state v1-vm)" = absent ]'

cleanup
echo "$failed failed"
exit "$failed"
