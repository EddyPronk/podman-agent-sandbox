#!/bin/bash
# git-readonly.sh — sandbox new --workspace --policy git-readonly --agent-policy, end to end, in a
# sandbox that runs containers of its own (nested-containers).
#
#   test/integration/git-readonly.sh [LOG_DIR]
#
# Run INSIDE that sandbox (nested.sh copies it in and runs it there), with `sandbox` on PATH (SB=...
# for another command, e.g. SB="node ~/podman-agent-sandbox/bin/sandbox.js"). Makes the sandbox
# `gro` in $SANDBOX_DIR (default ~/sandboxes) around a new project in the home folder, with a repo
# at its top and one in libs/nested, then checks, one line per test (PASS or FAIL):
#   T30  new: the config lists the policy; every .git read-only, the folders above the nested one
#        (libs, libs/nested) bound onto themselves; the agent's managed policy at /etc/claude-code
#   T31  inside: git status and log work, commit and branch are refused; mv .git, mv libs/nested and
#        mv libs are refused (a mount point can't be renamed), writing in libs/nested works
#   T32  this side replaces libs/nested/.git while it runs: inside it's writable, inspect warns,
#        exec refuses it as lost; put back and restarted, exec works
#   T33  a repo made later (added/.git): exec refuses it, and says why each path is listed
# Removes what it made at the end. Each test's output is in LOG_DIR (default ~/git-readonly-logs); a
# failure prints its end. Exit status: the number of failed tests.
set -uo pipefail

export SB=${SB:-sandbox} D=${SANDBOX_DIR:-$HOME/sandboxes} WS=$HOME/git-readonly-project POLICY=$HOME/git-readonly-policy
export N=gro
LOG=${1:-$HOME/git-readonly-logs}
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
clean() {
    $SB rm "$N" >/dev/null 2>&1
    podman volume rm "$N-home" >/dev/null 2>&1
    rm -rf "${D:?}/$N" "$WS" "$POLICY"
}

clean
mkdir -p "$WS/libs/nested" "$POLICY"
git -C "$WS" init -q && git -C "$WS" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$WS/libs/nested" init -q
echo "A policy for the test." > "$POLICY/CLAUDE.md"
echo '{"permissions": {"deny": ["Bash(git push:*)"]}}' > "$POLICY/managed-settings.json"

run "T30 new --policy git-readonly --agent-policy: every .git read-only, the folders above bound onto themselves" '
    set -e
    $SB new $N --template claude --workspace "$WS" --policy git-readonly --agent-policy "$POLICY" | tee /dev/stderr \
        | grep -q "2 git repos'"'"' .git (policy git-readonly)"
    c=$D/$N/.devcontainer/devcontainer.json
    jq -e ".customizations[\"podman-agent-sandbox\"].policies == [\"git-readonly\"]" "$c"
    for m in "$WS/.git,target=$WS/.git,readonly" "$WS/libs/nested/.git,target=$WS/libs/nested/.git,readonly" \
        "$WS/libs,target=$WS/libs\"" "$WS/libs/nested,target=$WS/libs/nested\""; do
        grep -qF "source=$m" "$c" || { echo "no mount source=$m"; exit 1; }
    done
    $SB enter $N </dev/null >"$LOG/enter.log" 2>&1 || { tail -n 40 "$LOG/enter.log"; exit 1; }
    $SB exec $N bash -c "test -f /etc/claude-code/CLAUDE.md && test -f /etc/claude-code/managed-settings.json"'

run "T31 inside: git only reads; .git and the folders above it can't be moved; writing works" '
    set -e
    $SB exec $N bash -c "set -e; cd \"$WS\"
        git status --short; git log --oneline
        git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x && exit 1
        git branch b2 && exit 1
        touch .git/x && exit 1; touch libs/nested/.git/x && exit 1; (echo /tmp > .git/commondir) && exit 1
        for p in .git libs/nested libs; do out=\$(mv \$p \$p.old 2>&1) && exit 1; echo \"\$out\"; echo \"\$out\" | grep -q busy; done
        echo x > libs/nested/f && rm libs/nested/f
        test -d libs/nested/.git && ! test -e libs.old && ! test -e libs/nested.old"'

run "T32 this side replaces libs/nested/.git while it runs: inspect warns, exec refuses it as lost; put back, it runs" '
    g=$WS/libs/nested/.git
    mv "$g" "$g.this-side" && cp -a "$g.this-side" "$g" || exit 1
    podman exec "$N" bash -c "touch $g/probe && rm $g/probe" || { echo "the new .git is not writable inside: nothing lost?"; s=1; }
    $SB inspect $N | grep -F "mount at $g, but it isn'"'"'t there inside" || { echo "inspect gives no warning"; s=1; }
    out=$($SB exec $N true 2>&1) && { echo "exec ran"; s=1; }
    echo "$out"
    echo "$out" | grep -qF "$g (writable)" && echo "$out" | grep -q "Lost while $N ran" \
        && ! echo "$out" | grep -q "Make the sandbox again" || s=1
    rm -rf "$g" && mv "$g.this-side" "$g"
    podman restart $N >/dev/null && $SB exec $N true && exit ${s:-0}'

run "T33 a repo made later is refused, with why each path is listed" '
    git -C "$WS" init -q added
    out=$($SB exec $N true 2>&1) && { echo "exec ran"; exit 1; }
    echo "$out"
    echo "$out" | grep -qF "$WS/added/.git (writable)" && echo "$out" | grep -qF "$WS/added (could be moved away with the .git in it)" \
        && echo "$out" | grep -q "Make the sandbox again"'

clean
echo "failed: $failed"
exit "$failed"
