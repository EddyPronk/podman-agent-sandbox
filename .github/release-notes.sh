#!/bin/sh
# release-notes.sh VERSION: prints CHANGELOG.md's section for VERSION (the lines under its
# "## VERSION (…)" heading, up to the next "## "), or fails if there is none or it's empty.
# CI checks every PR's package.json version with it, and the release uses it as the notes.
set -eu
version=$1
notes=$(awk -v head="## $version " '
    index($0, head) == 1 { on = 1; next }
    on && /^## / { exit }
    on' CHANGELOG.md)
if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
    echo "CHANGELOG.md has no section for $version (a heading \"## $version (Unreleased)\" or with its date)" >&2
    exit 1
fi
printf '%s\n' "$notes"
