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

**The exception is `nested-containers`.** Running Podman inside a sandbox needs some of these rights;
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
- **The sandbox's own config** (`.devcontainer/`) is read-only inside: the next container creation
  uses it, and its `initializeCommand` runs on your machine. Without `--workspace` it's mounted
  read-only over `/workspace/.devcontainer`; with `--workspace` it stays outside the project.
  **Sandboxes made before 0.6.0** don't have that mount, and `sandbox inspect` warns about them. Add
  `"type=bind,source=${localWorkspaceFolder}/.devcontainer,target=/workspace/.devcontainer,readonly"`
  to `mounts` in the sandbox's `.devcontainer/devcontainer.json` (on the host), then `sandbox rm NAME`
  and `sandbox enter NAME`. Look at the config before you do: the agent could have changed it.
- **A project's own config** (`--inplace`) is read-only inside too. `sandbox` runs only the copy you
  confirmed, kept in `~/sandboxes/NAME`. When the project's config changes, including through a git
  commit the agent made, `enter`, `exec` and `build` refuse until you confirm the change with
  `sandbox trust NAME`. See [A project's own sandbox config](project-config.md).
- **Git hooks and config** of every repository in a `--workspace` project are read-only: git on your
  machine runs what they name. That isn't all git reads, and the mounts have limits: see [Where a
  mount's protection ends](#where-a-mounts-protection-ends). **`--policy git-readonly`** makes every
  repository's whole `.git` read-only instead, which closes most of that, but git inside can then only
  read.
- **`--hide`** keeps a file or folder of the project out of sight, and **`--readonly`** makes one
  read-only. The same limits apply.

[A sandbox around an existing project](sandbox-around-an-existing-project.md) has the details.

## Network

- **`claude`** (and `nested-containers`): an ordinary rootless network (`pasta`). The Internet, your
  LAN and services on your machine are reachable.
- **`proxy-client`:** only the proxy's internal network, with no route out. All HTTP(S) goes through
  the `mitm-proxy` sandbox, which allows only the hosts in its allowlist; see [Your project behind
  the egress proxy](behind-the-proxy.md).

## What it doesn't protect

- **Secrets in the project:** the agent can read everything in it that isn't hidden with `--hide`.
- **What VS Code brings in:** attaching VS Code forwards your SSH agent and git credentials into the
  sandbox; see [VS Code and sandboxes](vscode.md).
- **The read-only and hidden paths, in every case:** git's hooks and config, `--readonly` and `--hide`
  can be got around, from inside or by what you do outside; see below.
- **The kernel:** a sandbox is a container, not a virtual machine. It shares your kernel, so a kernel
  bug reachable from inside is a way out. With krun installed, `sandbox enter --vm` runs it in a microVM
  with its own kernel instead: see [A sandbox in a microVM](microvm.md), also for what that changes.

### Where a mount's protection ends

The project is mounted read-write. Git's hooks and config, `--readonly` and `--hide` are more mounts,
each laid over **one path** in the sandbox's own view of the files. Such a mount protects that path
while nothing replaces what's under it and nothing moves the folder around it. That's less than "this
file can't change while the sandbox runs":

1. **Something on your machine replaces a protected file: the sandbox loses that mount.** Many
   programs save by writing a new file and renaming it over the old one: editors, `git config`,
   `git branch`, `git push -u` (all three rewrite `.git/config`), tools that regenerate a key. The
   kernel then drops the mount in the sandbox, without an error. Inside, the path is now your new
   file, **writable** (for git's config or a `--readonly` file) or **readable** (for a `--hide` file).
   - Writing a file in place keeps the mount.
   - A hidden *folder* keeps its mount when files in it change; it's lost only if the folder itself
     is replaced.
   - **`sandbox inspect` doesn't show it:** it lists the mounts the container was made with, and so
     does `podman inspect`. The `enter` and `exec` check doesn't see it either. Only
     `/proc/self/mountinfo` inside lists the mounts that are really there.
   - `podman restart NAME` (or `sandbox stop` and `enter`) puts the mounts back, **on the files as
     they are then**. If the agent changed one in between, the change stays. Look at it first.
2. **From inside, a protected path can't be moved or removed, but the folder around it can.**
   `mv .git .git.old` works, and the read-only `config` and `hooks` go along with `.git.old`. The
   agent then makes a new `.git` at the old path. It's writable, and **git on your machine uses
   it**, with whatever `core.fsmonitor` or hook the agent put there. The same works for
   `--readonly a/b` when `a` is writable. Moving the folder around a *hidden* path is harmless: the
   hiding goes with it.
3. **Git reads more than `config` and `hooks`.** Inside, the agent can also write:
   - `.git/commondir`, which makes git read its config, hooks and refs from another folder;
   - an interrupted rebase's to-do list, whose `exec` lines `git rebase --continue` runs;
   - a `.git` *file* (`gitdir: PATH`) in place of the folder, if it got the folder out of the way.

   With hooks and config read-only and unchanged, git on your machine can still run the agent's
   commands.
4. **Repositories made after `sandbox new` aren't protected.** The agent can make a new repository
   anywhere in the project, such as `docs/.git`. Git on your machine uses it as soon as it runs in
   that folder: your shell prompt's git status, your editor, a `git -C`. `sandbox enter` and `exec`
   refuse to run with a repository that isn't covered. But they check only when you run them, so
   one made during a session goes unnoticed until the next `enter` or `exec`.

**What helps:**

- **`--policy git-readonly`** makes each repository's whole `.git` read-only, as one mount. `.git`
  is then the mount point: it can't be moved (2), `commondir` and rebase state can't be written (3),
  and files git replaces *inside* `.git` keep the protection (1). The price is that git inside can
  only read. `status`, `log` and `diff` work. `add`, `commit`, `branch` and `checkout` fail
  ("Unable to create '.git/index.lock': Read-only file system"). It doesn't help with 4, or with a
  `.git` you replace as a whole (say, by cloning again).
- **While a sandbox is running, treat its project's git as the agent's.** Don't run git on your
  machine in a repository the agent can write, including in folders it may have added. If you must,
  look at `.git` first as files (`commondir`, a `.git` file, the hooks, the keys in `config`), not
  with git: git runs the payload itself.
- **After something on your machine has replaced a protected or hidden file,** restart the sandbox,
  then check that file.
