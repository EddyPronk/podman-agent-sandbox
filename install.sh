#!/bin/sh
# Install podman-agent-sandbox for the current user:
#   curl -fsSL https://raw.githubusercontent.com/EddyPronk/podman-agent-sandbox/main/install.sh | sh
# PAS_VERSION picks a release (default below); PAS_REF installs a branch or tag instead.
set -eu

VERSION="${PAS_VERSION:-0.2.0}"
REPO=https://github.com/EddyPronk/podman-agent-sandbox
if [ -n "${PAS_REF:-}" ]; then
  WHAT=$PAS_REF
  URL="$REPO/archive/${PAS_REF}.tar.gz"   # source archive of a branch or tag
else
  WHAT=v$VERSION
  URL="$REPO/releases/download/v${VERSION}/podman-agent-sandbox-${VERSION}.tgz"   # made by npm pack in CI
fi

die() { echo "install: $*" >&2; exit 1; }

command -v podman >/dev/null 2>&1 \
  || die "podman not found. On Debian 13: sudo apt install podman"
[ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" = true ] \
  || die "podman is not running rootless (podman info --format '{{.Host.Security.Rootless}}' should print true)"
command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
  || die "node and npm not found. On Debian 13: sudo apt install nodejs npm"
node -e 'const [a, b] = process.versions.node.split(".").map(Number);
         process.exit(a > 20 || (a === 20 && b >= 12) ? 0 : 1)' \
  || die "Node.js $(node --version) is too old; 20.12 or later is needed"

# npm install -g writes to $prefix/lib/node_modules and $prefix/bin. Debian's npm uses
# /usr/local, which needs root; switch to ~/.local then, rather than using sudo.
prefix=$(npm config get prefix)
dir=$prefix/lib/node_modules
while [ ! -e "$dir" ]; do dir=$(dirname "$dir"); done
if [ ! -w "$dir" ]; then
  echo "npm installs global packages in $prefix, which you can't write to; using ~/.local instead"
  npm config set prefix "$HOME/.local" --location=user
  prefix=$HOME/.local
fi

echo "Installing podman-agent-sandbox ${WHAT} ..."
npm install -g --no-fund --no-audit "$URL"

# Compare resolved paths: PATH can reach $prefix/bin through a symlink, e.g. ~/.local/opt/node/bin
# when npm reports ~/.local/opt/node-v24.15.0.
realdir() { (CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P); }
on_path() {
  target=$(realdir "$1") || return 1
  old_ifs=$IFS; IFS=:
  set -f
  for d in $PATH; do
    if [ -n "$d" ] && [ "$(realdir "$d")" = "$target" ]; then
      IFS=$old_ifs; set +f; return 0
    fi
  done
  IFS=$old_ifs; set +f
  return 1
}

# Which sandbox will the shell run? One earlier on PATH shadows the one just installed. It isn't
# ours to remove, so only say which it is.
shadow=
first=$(command -v sandbox 2>/dev/null || true)
if [ -n "$first" ] && [ "$(realdir "$(dirname "$first")")" != "$(realdir "$prefix/bin")" ]; then
  shadow=$first
  if [ -L "$first" ]; then shadow="$first -> $(ls -l "$first" | sed 's/.* -> //')"; fi
fi

if [ -n "$shadow" ]; then
  echo "Done, but another sandbox comes first on your PATH and runs instead:"
  echo "  $shadow"
  echo "Remove it (or put $prefix/bin before it in PATH), then run: sandbox templates"
elif on_path "$prefix/bin"; then
  echo "Done. Run: sandbox templates"
else
  echo "Done. $prefix/bin is not on your PATH yet: log out and back in (or add it to PATH), then run: sandbox templates"
fi
