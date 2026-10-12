# How a sandbox is isolated

`sandbox` is a small, lxc-style front end for [dev containers](https://containers.dev/) on rootless
Podman. Each sandbox is a folder with a `.devcontainer/` config, and runs as a container made from it.
This page is what that container may and may not do, in the bundled templates. `sandbox inspect NAME`
shows it for a running sandbox: the `podman run` command line, the rights it runs with (measured
inside), its mounts, and warnings about anything that weakens it.

## You, not root

The container runs with `--userns=keep-id`: the user inside is your own user, with your UID, not
root. Files the agent creates in the project are yours. No part of it involves root on your machine:
rootless Podman runs everything as you, without a daemon.

## No way to gain rights

The templates run every sandbox with `--cap-drop=all` and `--security-opt=no-new-privileges`:
- **no capabilities,** not even for root inside the container;
- **no new privileges:** setuid programs and file capabilities give nothing. There's no `sudo`, and
  an image that brings one can't use it.

Podman's default seccomp profile limits the system calls on top of that.

**The exception is `claude-containers`.** Running Podman inside a sandbox needs some of these rights;
[Containers inside a sandbox](containers-inside-a-sandbox.md) lists what it gives up and why.

**Sandboxes made before 0.5.2** don't have the two flags. Add `"--cap-drop=all"` and
`"--security-opt=no-new-privileges"` to `runArgs` in the sandbox's `.devcontainer/devcontainer.json`,
then `sandbox rm NAME` and `sandbox enter NAME`. A template is copied when the sandbox is made, so
later template changes don't reach it otherwise. `sandbox inspect` warns about a sandbox that lacks
them.

## Files

- **The project** is all a sandbox gets from your machine. For a sandbox made with `--workspace`,
  that's your project folder, mounted at its own path. Otherwise it's the sandbox's own folder,
  `~/sandboxes/NAME`, mounted at `/workspace`.
- **The home directory** inside is a volume of the sandbox's own (`NAME-home`), so logins and history
  survive `sandbox rm`. It isn't your home directory.
- **Git hooks and config** of every repository in a `--workspace` project are read-only: git on your
  machine runs what they name.
- **`--hide`** keeps a file or folder of the project out of sight, and **`--readonly`** makes one
  read-only.

[A sandbox around an existing project](sandbox-around-an-existing-project.md) has the details.

## Network

- **`claude`** (and `claude-containers`): an ordinary rootless network (`pasta`). The Internet, your
  LAN and services on your machine are reachable.
- **`proxy-client`:** only the proxy's internal network, with no route out. All HTTP(S) goes through
  the `mitm-proxy` sandbox, which allows only the hosts in its allowlist; see [Your project behind
  the egress proxy](behind-the-proxy.md).

## What it doesn't protect

- **A sandbox's own config, without `--workspace`.** There, the sandbox folder is the workspace, so the
  agent can edit `/workspace/.devcontainer/`. The next time the container is created (`sandbox rm`
  then `sandbox enter`, or `sandbox build`), that config is used as it is then. That includes an
  `initializeCommand`, which runs on your machine, extra mounts, and the `runArgs` above. Until this is
  fixed: use `--workspace`, where the config stays outside the project and is read-only, or look at
  `.devcontainer/` (e.g. `git diff`, if it's in git) before you recreate the sandbox.
- **Secrets in the project:** the agent can read everything in it that isn't hidden with `--hide`.
- **What VS Code brings in:** attaching VS Code forwards your SSH agent and git credentials into the
  sandbox; see [VS Code and sandboxes](vscode.md).
- **The kernel:** a sandbox is a container, not a virtual machine. It shares your kernel, so a kernel
  bug reachable from inside is a way out.
