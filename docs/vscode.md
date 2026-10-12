# VS Code and sandboxes

## Connecting VS Code to a sandbox

A sandbox is an ordinary dev container, so VS Code's
[Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
extension can connect to it. You get the editor on your desktop, and the terminal, the language
servers and most extensions running inside the sandbox.

1. **Point the extension at Podman** (user settings):
   ```json
   "dev.containers.dockerPath": "podman"
   ```
2. **Start the sandbox:** `sandbox enter work`. You can exit the shell again; the container keeps
   running.
3. **Attach:** in VS Code, run **Dev Containers: Attach to Running Container…** and pick `work`. Open
   the folder `/workspace`.

```sh
sandbox new work --template claude
sandbox enter work            # starts it; exit the shell, the container keeps running
# VS Code: "Dev Containers: Attach to Running Container…" → work, open /workspace
```

VS Code downloads its server on your desktop and copies it in, with your extensions. So this also
works for a `proxy-client` sandbox, which has no route out. The Claude Code extension then needs
`api.anthropic.com:443` and `platform.claude.com:443` (sign-in) in the proxy's allowlist. Anything
else VS Code tries to reach (telemetry, the marketplace) is refused, and it works without it.

The sandbox stays the sandbox: VS Code runs inside it with its user, capabilities, network and mounts.
But VS Code also brings something from your desktop into it:

## Your credentials

When VS Code attaches to a sandbox ("Attach to Running Container", or "Reopen in Container"), it
brings two things from your desktop with it:
- **your SSH agent:** a socket `/tmp/vscode-ssh-auth-*.sock` relays to it;
- **your git credentials:** a `credential.helper` in `~/.gitconfig` asks VS Code for them.

While VS Code is attached, any process in the sandbox, including the agent you meant to contain, can
use your SSH keys and ask for your git credentials, such as a GitHub token. The proxy doesn't stop the
key from signing, only the connections it would be used for. Both stay after you close VS Code, and
work again on the next attach. `sandbox inspect NAME` shows them, with whether the agent answers right
now, and warns:

```
vscode          VS Code server running (18 processes); it forwards, while VS Code is attached:
                SSH agent  /tmp/vscode-ssh-auth-2fb5….sock (answers now: 1 key)
                git        credential.helper in /home/node/.gitconfig: VS Code's
```

**What you can do:**
- **Don't attach your desktop VS Code to a sandbox whose contents you don't trust.** VS Code has no
  setting yet that turns off SSH agent forwarding; see
  [vscode-remote-release#9466](https://github.com/microsoft/vscode-remote-release/issues/9466).
- **Not tested here yet:**
  - the Dev Containers setting `"dev.containers.gitCredentialHelperConfigLocation": "none"`, against the
    git helper;
  - starting VS Code without an agent (`SSH_AUTH_SOCK= code`), against the agent socket.
- **Recreate the sandbox:** `sandbox rm NAME` then `sandbox enter NAME` gives a fresh container,
  without the agent sockets and the running VS Code server. The credential helper line in
  `~/.gitconfig` stays, because the home directory is a volume that outlives the container; see
  below.

## Troubleshooting

**`Cannot find module '/tmp/vscode-remote-containers-….js'` when git needs a password or token**
(e.g. `git fetch` from a private repository).
`~/.gitconfig` still names VS Code's credential helper from an earlier container: the home directory
outlives it, the helper's script in `/tmp` didn't. Nothing leaks, but git can't use it.
Attach VS Code again (it rewrites the line), or remove it inside the sandbox:

```sh
git config --global --get-all credential.helper      # look
git config --global --unset-all credential.helper    # remove (also a helper you set yourself)
```
