#!/bin/bash
# krun-check.sh — whether the krun on PATH fits this host, beyond "a container starts": for crun and
# the libraries it loads at run time (libkrun.so.1, which loads libkrunfw.so.5; ldd can't follow a
# dlopen), every library they need is here with the symbol versions they need (ldd -r), and the two
# are in the loader cache. Matters when krun was built elsewhere, e.g. podman-krun-debian's release
# for Debian 13 on an Ubuntu runner (.github/workflows/podman.yml): a missing library or symbol
# version fails here, not later in a VM.
#
#   test/integration/krun-check.sh
#
# Prints what it checked. Exit status 1 when something is missing.
set -uo pipefail

fail=0
krun=$(command -v krun) || { echo "FAIL: no krun on PATH"; exit 1; }
crun=$(readlink -f "$krun")
echo "host: $(. /etc/os-release && echo "$PRETTY_NAME"), $(getconf GNU_LIBC_VERSION), kernel $(uname -r)"
echo "krun: $krun -> $crun: $("$crun" --version | tail -n 1)"
"$crun" --version | grep -q '+LIBKRUN' || { echo "FAIL: $crun is built without libkrun"; fail=1; }

files=("$crun")
for soname in libkrun.so.1 libkrunfw.so.5; do
    path=$(/sbin/ldconfig -p | awk -v s="$soname" '$1 == s { print $NF; exit }')
    if [ -z "$path" ]; then
        echo "FAIL: $soname is not in the loader cache"
        fail=1
    else
        files+=("$(readlink -f "$path")")
    fi
done

for f in "${files[@]}"; do
    # The newest glibc symbol version it needs (objdump's Version References), against the host's.
    need=$(objdump -p "$f" | awk '/^Version References:/ { on = 1; next } on && NF == 4 { print $4 }' \
        | grep '^GLIBC_' | sort -V | tail -n 1)
    echo "== $f: needs ${need:-no versioned glibc symbol}"
    out=$(LC_ALL=C ldd -r "$f" 2>&1)
    sed 's/^/   /' <<<"$out"
    if grep -qE 'not found|undefined symbol' <<<"$out"; then
        echo "FAIL: $f: a library, symbol version or symbol is missing"
        fail=1
    fi
done
[ "$fail" = 0 ] && echo "ok: every library and symbol version krun needs is here"
exit "$fail"
