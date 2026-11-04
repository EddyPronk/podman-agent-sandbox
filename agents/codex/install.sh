#!/bin/sh
# Runs as root in the image build. Options arrive as VERSION, SHA256AMD64, SHA256ARM64 and
# TRUSTWORKSPACE. The static release binary, checked against the SHA-256 of the given version.
set -eu
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl ripgrep
rm -rf /var/lib/apt/lists/*

case "$(dpkg --print-architecture)" in
  amd64) target=x86_64-unknown-linux-musl; sha=$SHA256AMD64 ;;
  arm64) target=aarch64-unknown-linux-musl; sha=$SHA256ARM64 ;;
  *) echo "agent codex: no Linux release for $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/codex.tar.gz" \
  "https://github.com/openai/codex/releases/download/rust-v${VERSION}/codex-${target}.tar.gz"
echo "$sha  $tmp/codex.tar.gz" | sha256sum -c -
tar -xzf "$tmp/codex.tar.gz" -C "$tmp"
install -m 755 "$tmp/codex-${target}" /usr/local/bin/codex
rm -rf "$tmp"
codex --version

dir=/usr/local/share/sandbox-agent
mkdir -p "$dir"
install -m 755 "$(dirname "$0")/trust-workspace" /usr/local/bin/trust-workspace
if [ "${TRUSTWORKSPACE:-true}" = true ]; then
  # postCreateCommand runs in the workspace folder.
  printf '#!/bin/sh\nexec trust-workspace "$PWD"\n' > "$dir/post-create"
else
  printf '#!/bin/sh\n' > "$dir/post-create"
fi
chmod 755 "$dir/post-create"
echo "agent codex: trustWorkspace=${TRUSTWORKSPACE:-true}"
