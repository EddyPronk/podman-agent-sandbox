#!/bin/bash
# git-protection.sh — sandbox new --workspace's git protection, end to end, with --policy
# git-readonly --agent-policy and without it (the default), in a sandbox that runs containers of its
# own (nested-containers).
#
#   test/integration/git-protection.sh [LOG_DIR]
#
# Run INSIDE that sandbox (nested.sh copies it in and runs it there), with `sandbox` on PATH (SB=...
# for another command, e.g. SB="node ~/podman-agent-sandbox/bin/sandbox.js"). Makes the sandbox
# `gro` (git-readonly) and `gdf` (the default) in $SANDBOX_DIR (default ~/sandboxes), each around a
# new project in the home folder with a repo at its top and one in libs/nested, then checks, one line
# per test (PASS or FAIL):
#   T30  new: the config lists the policy; every .git read-only, the folders above the nested one
#        (libs, libs/nested) bound onto themselves; the agent's managed policy at /etc/claude-code
#   T31  inside: git status and log work, commit and branch are refused; mv .git, mv libs/nested and
#        mv libs are refused (a mount point can't be renamed), writing in libs/nested works
#   T32  this side replaces libs/nested/.git while it runs: inside it's writable, inspect warns,
#        exec refuses it as lost; put back and restarted, exec works
#   T33  a repo made later (added/.git): exec refuses it, and says why each path is listed
#   T35  new without a policy: each .git's hooks and config read-only, each .git and the folders above
#        the nested one bound onto themselves (read-write)
#   T36  inside: git commits and branches; mv .git (both), mv libs/nested and mv libs are refused; a
#        hook or git config can't be written
#   T37  the agent leaves a rebase in progress with an exec line: exec and inspect warn about it,
#        with the line; gone, they don't
# Removes what it made at the end. Each test's output is in LOG_DIR (default ~/git-readonly-logs); a
# failure prints its end. Exit status: the number of failed tests.
set -uo pipefail

export SB=${SB:-sandbox} D=${SANDBOX_DIR:-$HOME/sandboxes} WS=$HOME/git-readonly-project POLICY=$HOME/git-readonly-policy
export N=gro N2=gdf WS2=$HOME/git-default-project
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
    $SB rm "$N2" >/dev/null 2>&1
    podman volume rm "$N2-home" >/dev/null 2>&1
    rm -rf "${D:?}/$N" "${D:?}/$N2" "$WS" "$WS2" "$POLICY"
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

mkdir -p "$WS2/libs/nested"
git -C "$WS2" init -q && git -C "$WS2" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$WS2/libs/nested" init -q && git -C "$WS2/libs/nested" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init

run "T35 new without a policy: hooks and config read-only, each .git and the folders above bound onto themselves" '
    set -e
    $SB new $N2 --template claude --workspace "$WS2"
    c=$D/$N2/.devcontainer/devcontainer.json
    jq -e "(.customizations[\"podman-agent-sandbox\"].policies // []) == []" "$c"
    for r in "$WS2" "$WS2/libs/nested"; do
        for m in "$r/.git/hooks,target=$r/.git/hooks,readonly" "$r/.git/config,target=$r/.git/config,readonly" "$r/.git,target=$r/.git\""; do
            grep -qF "source=$m" "$c" || { echo "no mount source=$m"; exit 1; }
        done
    done
    for m in "$WS2/libs,target=$WS2/libs\"" "$WS2/libs/nested,target=$WS2/libs/nested\""; do
        grep -qF "source=$m" "$c" || { echo "no mount source=$m"; exit 1; }
    done
    $SB enter $N2 </dev/null >"$LOG/enter-gdf.log" 2>&1 || { tail -n 40 "$LOG/enter-gdf.log"; exit 1; }'

run "T36 inside: git commits and branches; .git and the folders above it can't be moved; hooks and config can't be written" '
    set -e
    $SB exec $N2 bash -c "set -e; cd \"$WS2\"; G=\"git -c user.name=t -c user.email=t@t\"
        echo a > a && git add a && \$G commit -q -m a && git branch b1 && git switch -q -c b2 && git checkout -q -
        (cd libs/nested && echo n > n && git add n && \$G commit -q -m n)
        for p in .git libs/nested/.git libs/nested libs; do out=\$(mv \$p \$p.old 2>&1) && exit 1; echo \"\$out\"; echo \"\$out\" | grep -q busy; done
        (echo x > .git/hooks/pre-commit) 2>/dev/null && exit 1
        git config core.fsmonitor x 2>/dev/null && exit 1
        test -d .git && test -d libs/nested/.git && ! test -e libs.old && ! test -e .git.old"
    [ "$(git -C "$WS2" log --oneline | wc -l)" -eq 2 ]'

run "T37 a rebase left in progress with an exec line: exec and inspect warn, with the line" '
    s=0
    $SB exec $N2 bash -c "mkdir \"$WS2/.git/rebase-merge\" && printf \"pick 0000000 a\\nexec touch /tmp/pwned\\n\" > \"$WS2/.git/rebase-merge/git-rebase-todo\"" || exit 1
    out=$($SB exec $N2 true 2>&1) || s=1
    echo "$out"
    echo "$out" | grep -qF "$WS2 has a rebase in progress" && echo "$out" | grep -qF "    exec touch /tmp/pwned" || s=1
    $SB inspect $N2 | grep -F "has a rebase in progress" || { echo "inspect gives no warning"; s=1; }
    rm -r "$WS2/.git/rebase-merge"
    out=$($SB exec $N2 true 2>&1) || s=1
    echo "$out" | grep -q "rebase in progress" && s=1
    exit $s'

clean
echo "failed: $failed"
exit "$failed"
