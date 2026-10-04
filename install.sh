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

case ":$PATH:" in
  *":$prefix/bin:"*) echo "Done. Run: sandbox templates" ;;
  *) echo "Done. $prefix/bin is not on your PATH yet: log out and back in (or add it to PATH), then run: sandbox templates" ;;
esac
