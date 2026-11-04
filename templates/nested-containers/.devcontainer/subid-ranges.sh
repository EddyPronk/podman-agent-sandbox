#!/bin/sh
# subid-ranges.sh ID MAPFILE — the user's subordinate ID ranges (/etc/subuid or /etc/subgid lines)
# for a sandbox, from the build's ID map (/proc/self/uid_map or gid_map). Run at image build time.
#
# The inner podman maps every ID of the sandbox but the user's own (ID) and 0. The kernel accepts
# a range only if it lies inside one extent of the sandbox's own map, so the ranges follow that
# map's extents. The build runs with the IDs the sandbox will have, laid out by podman's keep-id
# when it starts: ID → the build's 0 (the user outside), 0..ID-1 → the build's 1..ID, and above
# ID unchanged. So each build extent, moved that way and split at ID, is one extent at runtime.
#
# On a host with one subordinate range that gives ID:1:ID-1 and ID:ID+1:65536-ID; in a sandbox in
# a sandbox the outer user's own ID is a hole that splits the ranges further.
set -eu
id=$1
awk -v u="$id" '
function out(first, count) { if (count > 0) printf "%d:%d:%d\n", u, first, count }
{
    s = $1; e = $1 + $3                              # the build extent [s, e)
    a = (s > 1 ? s : 1); b = (e < u + 1 ? e : u + 1) # [1, u] moves down by one, to [0, u - 1]
    if (a < b) { f = a - 1; if (f == 0) f = 1; out(f, b - 1 - f) }  # leave 0 out
    a = (s > u + 1 ? s : u + 1)                      # above u: unchanged
    if (a < e) out(a, e - a)
}' "$2"
