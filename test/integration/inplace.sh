#!/bin/bash
# inplace.sh — sandboxes that use their project's own config (sandbox new --inplace, sandbox export),
# end to end, in a sandbox that runs containers of its own (claude-containers).
#
#   test/integration/inplace.sh [LOG_DIR]
#
# Run INSIDE that sandbox (nested.sh copies it in and runs it there), with `sandbox` on PATH. Makes
# the sandboxes `ip` and `ex` in $SANDBOX_DIR (default ~/sandboxes) around two new git projects in
# the home folder, then checks, one line per test (PASS or FAIL):
#   T24  new --inplace --template claude: the config is written into the project, with the marker;
#        inside, the project's .devcontainer and git hooks are read-only, the workspace writable,
#        and inspect has no warnings
#   T25  the agent commits a changed config through git (the read-only mount doesn't stop that),
#        and `git reset --hard` outside brings it into the project: exec refuses, and so does
#        enter after rm, without making a container; the trusted copy is unchanged
#   T26  trust --yes takes the change; the container made after it has it
#   T27  export: a --workspace claude sandbox edited by hand, exported into its project: no paths of
#        this machine in it; made again from it, the edit is there and the config is read-only
# Removes what it made at the end. Each test's output is in LOG_DIR (default ~/inplace-logs); a
# failure prints its end. Exit status: the number of failed tests.
set -uo pipefail

export D=${SANDBOX_DIR:-$HOME/sandboxes} IP=$HOME/inplace-project EX=$HOME/export-project
LOG=${1:-$HOME/inplace-logs}
mkdir -p "$LOG"
export LOG=$(cd "$LOG" && pwd -P)
failed=0
run() {   # NAME COMMAND: run COMMAND, report
    local name=$1 file="$LOG/${1%% *}.log"; shift
    if bash -c "$*" >"$file" 2>&1; then
        printf 'PASS  %s\n' "$name"
    else
        printf 'FAIL  %s\n' "$name"
        tail -n 20 "$file" | sed 's/^/      | /'
        failed=$((failed + 1))
    fi
}

# Inside a nested sandbox, as this user.
inside() { local c=$1; shift; podman exec -u "$(id -u)" "$c" bash -c "$*"; }
export -f inside

run "T24 new --inplace --template claude: written into the project; config and hooks read-only inside" '
    set -e
    rm -rf "$IP"; mkdir -p "$IP"; git -C "$IP" init -q
    sandbox new ip --workspace "$IP" --inplace --template claude
    grep -q "\"podman-agent-sandbox\"" "$IP/.devcontainer/devcontainer.json"
    sandbox enter ip </dev/null >"$LOG/T24-enter.log" 2>&1 || { tail -n 30 "$LOG/T24-enter.log"; exit 1; }
    inside ip "cd $IP; touch .devcontainer/x 2>/dev/null && { echo config writable; exit 1; }
        touch .git/hooks/x 2>/dev/null && { echo hooks writable; exit 1; }
        touch w && rm w && echo inside-ok"
    out=$(sandbox inspect ip); ! echo "$out" | grep "^warning:"'

run "T25 an agent's git commit of a changed config, reset in outside: exec and enter refuse" '
    f=.devcontainer/devcontainer.json
    # Inside, the agent writes the changed file into git objects and commits it (the file itself is read-only).
    blob=$(sed "s/\"NVM_SYMLINK_CURRENT\": \"false\"/\"NVM_SYMLINK_CURRENT\": \"false\", \"AGENT\": \"was-here\"/" "$IP/$f" \
        | podman exec -i -u "$(id -u)" ip git -C "$IP" hash-object -w --stdin) || exit 1
    inside ip "cd $IP && git update-index --add --cacheinfo 100644,$blob,$f \
        && git -c user.name=agent -c user.email=agent@example.invalid commit -q -m agent-config && echo committed" || exit 1
    git -C "$IP" reset -q --hard
    grep -q was-here "$IP/.devcontainer/devcontainer.json" || { echo "the reset did not bring it in"; exit 1; }
    out=$(sandbox exec ip true 2>&1) && { echo "exec ran: $out"; exit 1; }
    echo "$out" | grep -q "changed since you trusted it" || { echo "$out"; exit 1; }
    sandbox rm ip >/dev/null
    out=$(sandbox enter ip </dev/null 2>&1) && { echo "enter ran"; exit 1; }
    echo "$out" | grep -q "sandbox trust ip" || { echo "$out"; exit 1; }
    ! podman container exists ip || { echo "a container was made"; exit 1; }
    ! grep -q was-here "$D/ip/.devcontainer/devcontainer.json" "$D/ip/trusted/devcontainer.json"'

run "T26 trust --yes takes the change; the container made after it has it" '
    sandbox trust ip --yes || exit 1
    sandbox enter ip </dev/null >"$LOG/T26-enter.log" 2>&1 || { tail -n 30 "$LOG/T26-enter.log"; exit 1; }
    [ "$(podman exec ip printenv AGENT)" = was-here ]'

run "T27 export: an edited --workspace sandbox into its project; made again from it" '
    set -e
    rm -rf "$EX"; mkdir -p "$EX"; git -C "$EX" init -q
    sandbox new ex --template claude --workspace "$EX"
    node -e "const fs = require(\"fs\"); const f = process.argv[1]; const c = JSON.parse(fs.readFileSync(f, \"utf8\"));
        c.containerEnv.EDIT = \"kept\"; fs.writeFileSync(f, JSON.stringify(c, null, 2))" "$D/ex/.devcontainer/devcontainer.json"
    sandbox export ex
    if grep -n "$HOME" "$EX/.devcontainer/devcontainer.json"; then echo "paths of this machine"; exit 1; fi
    sandbox enter ex </dev/null >"$LOG/T27-enter.log" 2>&1 || { tail -n 30 "$LOG/T27-enter.log"; exit 1; }
    [ "$(podman exec ex printenv EDIT)" = kept ]
    inside ex "touch $EX/.devcontainer/x 2>/dev/null && { echo config writable; exit 1; }; echo read-only"
    out=$(sandbox inspect ex); ! echo "$out" | grep "^warning:"'

for c in ip ex; do
    sandbox rm "$c" >/dev/null 2>&1; podman volume rm "$c-home" >/dev/null 2>&1; rm -rf "${D:?}/$c"
done
rm -rf "$IP" "$EX"
echo "failed: $failed"
exit "$failed"
