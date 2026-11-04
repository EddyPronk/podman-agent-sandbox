#!/bin/sh
# Runs as root in the image build, after its dependsOn (Node.js, Claude Code). Option trustWorkspace
# arrives as TRUSTWORKSPACE.
set -eu
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
echo "agent claude-code: trustWorkspace=${TRUSTWORKSPACE:-true}"
