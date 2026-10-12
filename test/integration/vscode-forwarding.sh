#!/bin/bash
# vscode-forwarding.sh — sandbox inspect reports what VS Code forwards into a sandbox it is attached to.
#
#   VSCODE_SANDBOX=NAME [CLEAN_SANDBOX=NAME] [SANDBOX_CMD=sandbox] test/integration/vscode-forwarding.sh
#
# NOT RUN IN CI: it needs a real VS Code (Dev Containers: "Attach to Running Container") attached to
# the running sandbox NAME, with an SSH agent on the host that holds at least one key. No workflow runs
# it, and it skips (exit 0) when CI is set or VSCODE_SANDBOX isn't. Run it by hand, e.g. against a
# proxy-client sandbox with the desktop VS Code attached. Checks, one line each (PASS or FAIL):
#   V1  inspect: a VS Code server, and an SSH agent socket that answers now
#   V2  inspect: warnings for the SSH agent and the git credential helper
#   V3  the answering socket is real: asked inside, as inspect does, it gives the same key count
#   V4  (with CLEAN_SANDBOX: a running sandbox VS Code never attached to) no VS Code row, no such warning
# Exit status: the number of failed checks.
set -uo pipefail

if [[ -n ${CI:-} ]]; then echo "SKIP  vscode-forwarding.sh: needs a desktop VS Code attached (not in CI)"; exit 0; fi
if [[ -z ${VSCODE_SANDBOX:-} ]]; then
    echo "SKIP  vscode-forwarding.sh: set VSCODE_SANDBOX to a running sandbox with VS Code attached"; exit 0
fi
S=$VSCODE_SANDBOX
read -ra SANDBOX <<<"${SANDBOX_CMD:-sandbox}"
failed=0
check() {   # NAME CONDITION-RESULT(0/1) DETAILS
    if [[ $2 == 0 ]]; then printf 'PASS  %s\n' "$1"; else printf 'FAIL  %s\n' "$1"; sed 's/^/      | /' <<<"$3"; failed=$((failed + 1)); fi
}

out=$("${SANDBOX[@]}" inspect "$S" 2>&1)
vscode=$(sed -n '/^vscode /,/^[a-z]/p' <<<"$out" | sed '$d')

grep -q '^vscode  *VS Code server running' <<<"$vscode" && grep -q 'SSH agent .*(answers now: [1-9][0-9]* key' <<<"$vscode"
check "V1 inspect $S: a VS Code server, and an SSH agent socket that answers now" $? "$out"

grep -q '^warning: VS Code forwards your SSH agent into this container while attached (it answers now)' <<<"$out" \
    && grep -q "^warning: VS Code's git credential helper is set" <<<"$out"
check "V2 inspect $S: warnings for the SSH agent and the git credential helper" $? "$out"

sock=$(grep -o '/tmp/vscode-ssh-auth-[^ ]*\.sock (answers now: [0-9]*' <<<"$vscode" | head -n 1)
path=${sock%% *} want=${sock##*: }
got=$(podman exec "$S" sh -c 'node=$(ls /root/.vscode-server/bin/*/node /home/*/.vscode-server/bin/*/node 2>/dev/null | head -n 1)
    if command -v ssh-add >/dev/null; then SSH_AUTH_SOCK=$1 ssh-add -l | wc -l
    else "$node" -e "const s=require(\"net\").connect(process.argv[1]);s.on(\"connect\",()=>s.write(Buffer.from([0,0,0,1,11])));s.on(\"data\",(d)=>{console.log(d.readUInt32BE(5));s.destroy();});" "$1"; fi' \
    sh "$path" 2>&1)
[[ -n $path && $got == "$want" ]]
check "V3 the answering socket gives the same key count inside ($want)" $? "socket: [$path] inspect: [$want] inside: [$got]"

if [[ -n ${CLEAN_SANDBOX:-} ]]; then
    clean=$("${SANDBOX[@]}" inspect "$CLEAN_SANDBOX" 2>&1)
    ! grep -qE '^vscode |^warning: VS Code' <<<"$clean"
    check "V4 inspect $CLEAN_SANDBOX (never attached): no VS Code row, no such warning" $? "$clean"
fi

echo "failed: $failed"
exit "$failed"
