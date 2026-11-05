# Claude Code's managed policy in this sandbox

This folder is mounted read-only at `/etc/claude-code`, where Claude Code reads its managed policy,
above every other settings level: `CLAUDE.md` (instructions) and `managed-settings.json` (settings,
e.g. permission rules that the workspace's own `.claude/` can't loosen). See
https://code.claude.com/docs/en/settings#settings-files.

`sandbox new … --agent-policy DIR` copies DIR's files here. To change the policy of an existing sandbox,
edit the files here, in its config folder on the host, and restart it (`podman restart NAME`). The
sandbox can't change them: they're read-only inside. Claude Code ignores this README.
