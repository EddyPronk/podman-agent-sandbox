#!/bin/bash
# proxy-network.sh — the bundled mitm-proxy and proxy-client templates in a sandbox that runs
# containers of its own (claude-containers): the client's only way out is the proxy.
#
#   test/integration/proxy-network.sh [LOG_DIR]
#
# Run INSIDE that sandbox (nested.sh copies it in and runs it there), with `sandbox` on PATH. Makes
# the sandboxes `proxy` (mitm-proxy) and `work` (proxy-client) unless they exist (PROXY=NAME and
# CLIENT=NAME for other names), then checks, one line per test (PASS or FAIL):
#   T13     the proxy runs and listens on 8899
#   T14     the client runs, on agent-proxy-net only
#   T15a/b  an allowlisted host is answered by the upstream; another is refused with 403 at CONNECT
#   T16a-c  the client has no default route, other names don't resolve, no direct connection
# Each test's output is in LOG_DIR (default ~/proxy-network-logs); a failure prints its end.
# Exit status: the number of failed tests. Needs the network: the proxy image builds from GitHub,
# and T15a reaches api.anthropic.com.
set -uo pipefail

export P=${PROXY:-proxy} W=${CLIENT:-work}
LOG=${1:-$HOME/proxy-network-logs}
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

# In the client, as this user, with the container's environment (proxy variables, CA bundle).
inw() { podman exec -u "$(id -u)" "$W" bash -c "$*"; }
export -f inw
# The client tests check its network; without a running client every check below would "pass"
# (podman exec fails, which looks like no route and no name), so they first insist on one.
client_up() {
    [ "$(podman container inspect -f '{{.State.Running}}' "$W" 2>/dev/null)" = true ] \
        || { echo "client $W is not running"; return 1; }
}
export -f client_up

run "T13 mitm-proxy sandbox runs, listening on 8899" '
    [ -d ~/sandboxes/$P ] || sandbox new $P --template mitm-proxy || exit 1
    sandbox enter $P </dev/null >$LOG/$P-enter.log 2>&1 || { tail -n 40 $LOG/$P-enter.log; exit 1; }
    podman ps --format "{{.Names}} {{.State}}" | grep -x "$P running" || exit 1
    for i in $(seq 20); do
        podman exec $P bash -c "exec 3<>/dev/tcp/127.0.0.1/8899" 2>/dev/null && exit 0
        sleep 1
    done
    echo "nothing listening on 8899 in $P after 20 s"; exit 1'

run "T14 proxy-client sandbox runs, on agent-proxy-net only" '
    [ -d ~/sandboxes/$W ] || sandbox new $W --template proxy-client || exit 1
    sandbox enter $W </dev/null >$LOG/$W-enter.log 2>&1 || { tail -n 40 $LOG/$W-enter.log; exit 1; }
    podman ps --format "{{.Names}} {{.State}}" | grep -x "$W running" || exit 1
    nets=$(podman container inspect $W --format "{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}} {{end}}")
    echo "networks: [$nets]"; [ "$nets" = "agent-proxy-net " ]'

run "T15a allowlisted host answered by the upstream" '
    client_up || exit 1
    code=$(inw "curl -s -o /dev/null -w %{http_code} --max-time 20 https://api.anthropic.com/")
    echo "api.anthropic.com: $code"; [[ $code =~ ^[0-9]{3}$ ]] && [ "$code" != 000 ] && [ "$code" != 403 ]'

run "T15b unlisted host refused at CONNECT with 403" '
    client_up || exit 1
    out=$(inw "curl -sv -o /dev/null --max-time 20 https://example.com/ 2>&1"); s=$?
    echo "$out" | tail -n 8; echo "curl exit $s"
    grep -qi "< HTTP/1.[01] 403" <<<"$out"'

run "T16a the client has no default route" '
    client_up || exit 1
    r=$(inw "tail -n +2 /proc/net/route | cut -f1,2 | grep 00000000")
    r6=$(inw "cat /proc/net/ipv6_route" | grep -E "^0{32} 00 " | grep -vw lo)
    echo "v4 default: [$r] v6 default: [$r6]"; [ -z "$r" ] && [ -z "$r6" ]'

run "T16b other names do not resolve" '
    client_up || exit 1
    out=$(inw "getent hosts example.com"); s=$?
    echo "getent: [$out] exit $s (2: not found)"; [ $s -eq 2 ]'

run "T16c no direct connection without the proxy" '
    client_up || exit 1
    code=$(inw "curl -s -o /dev/null -w %{http_code} --noproxy \"*\" --max-time 10 https://1.1.1.1/"); s=$?
    echo "direct to 1.1.1.1: $code, curl exit $s"; [ "$code" = 000 ]'

echo "failed: $failed"
exit "$failed"
