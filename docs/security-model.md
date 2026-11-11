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

**A root shell for installing packages: `sandbox enter --root NAME`** (0.12.0). Root without
capabilities can't run `apt-get`, so this needs the **`root-shell`** policy. Capabilities are fixed
when a container is made, so the policy can only apply then: run `enter --root` right after
`sandbox new`, or after `sandbox rm` (volumes are kept). It adds the policy to the sandbox's config,
says so, and makes the container. `sandbox inspect` shows `policies  root-shell`.
- **Root inside gets only what apt needs:** `chown`, `dac_override`, `fowner`, `setuid` and
  `setgid`, in the sandbox's user namespace: still not root on your machine, and no `sys_admin`.
  `sandbox` makes the container from a copy of the config with "all" taken out of `--cap-drop` and
  Podman's other defaults dropped; the config itself stays as written.
- **The agent doesn't get them.** The config must have `no-new-privileges` (`nested-containers`
  hasn't, so it's refused there): a program run as you, including a setuid one, gains nothing. Only
  a shell started with `enter --root` runs as root. (Tested: a setuid copy of `id` still runs as
  your UID; the processes show `NoNewPrivs: 1` and `CapEff` 0.) Not with `--cap-add`: Podman gives
  added capabilities to a non-root user too.
- **The shell is clean,** so nothing the agent wrote runs in it: it starts in `/root`, not the
  workspace, with only root's folders on `PATH`, and without startup files (`/etc/bash.bashrc` can
  load files the user owns, such as nvm's on some images) or the image's `BASH_ENV`.
- **What root installs, the agent can run,** and root can change any file in the container that
  isn't a read-only mount, also ones the agent's work depends on. Use it for setup, not as the
  shell you work in. Packages installed this way are gone after `sandbox rm`; put lasting ones in
  the Containerfile.
- `--inplace`: the project's config is its own, so `enter --root` doesn't change it. List
  `"root-shell"` in its `"policies"` and `sandbox trust NAME`.

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
  read. [Default or git-readonly](#default-or-git-readonly) compares the two.
- **`--hide`** keeps a file or folder of the project out of sight, and **`--readonly`** makes one
  read-only. The same limits apply.

[A sandbox around an existing project](sandbox-around-an-existing-project.md) has the details.

## Network

- **`open-network`** (and `nested-containers`): an ordinary rootless network (`pasta`), with
  nothing filtered. Reachable: the Internet; your LAN (the router, and whatever other machines
  serve without a login); and services on your machine that listen on all addresses, such as
  `sshd`, as `host.containers.internal`. Services that listen only on 127.0.0.1 aren't reachable.
  Your machine's own LAN address doesn't lead to it: inside, the container has a copy of it.
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
   - **`podman inspect` doesn't show it:** it lists the mounts the container was made with. Only
     `/proc/self/mountinfo` inside lists the mounts that are really there. While the sandbox runs,
     `sandbox inspect` reads it too. It warns about a mount podman lists that isn't there.
     `enter` and `exec` read it too, and refuse to run while a protected path has lost its mount
     (since 0.10.0). They check only when you run them, so a mount lost during a session goes
     unnoticed until then.
   - `podman restart NAME` (or `sandbox stop` and `enter`) puts the mounts back, **on the files as
     they are then**. If the agent changed one in between, the change stays. Look at it first.
2. **From inside, a protected path can't be moved or removed, but the folder around it can.**
   `mv .git .git.old` works, and the read-only `config` and `hooks` go along with `.git.old`. The
   agent then makes a new `.git` at the old path. It's writable, and **git on your machine uses
   it**, with whatever `core.fsmonitor` or hook the agent put there. The same works for
   `--readonly a/b` when `a` is writable. A read-only `.git` as a whole is no exception: `mv libs
   libs.old` takes `libs/.git`'s mount along, and a copy (`cp -a libs.old libs`) puts a writable
   `.git` back where git on your machine looks. Only the project folder itself can't be moved, so
   only a repository at its top is safe from this. Moving the folder around a *hidden* path is
   harmless: the hiding goes with it. **Since 0.11.0, `sandbox new --workspace` stops this for git**
   (below, in both modes); for `--readonly`, it still applies.
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

- **Without a policy (since 0.11.0),** each `.git` is bound onto itself, read-write, under its
  read-only `hooks` and `config`, and so is each folder between the project folder and a nested
  `.git`. They can't be renamed or removed from inside, so (2) no longer works for git, and git
  inside still commits, branches and checks out. `.git` stays writable, so (3) still works: `enter`,
  `exec` and `inspect` warn when a repository has a `commondir`, or a rebase in progress, and show
  the to-do list's `exec` lines. They can't stop git on your machine from running one first.

- **`--policy git-readonly`** makes each repository's whole `.git` read-only, as one mount. `.git`
  is then the mount point: it can't be moved, `commondir` and rebase state can't be written (3),
  and files git replaces *inside* `.git` keep the protection (1).
  - Against moving the folders around it (2), each folder between the project folder and a `.git`
    is mounted onto itself, read-write. For `lab/30/tool/.git` that's `lab`, `lab/30` and
    `lab/30/tool`. A mount point can't be renamed or removed from inside ("Resource busy"), and
    files in those folders are written as usual. Moving a file *between* them becomes a copy and a
    delete, which `mv` does by itself.
  - The agent can't undo these mounts: in a namespace of its own, or in a container it starts
    inside, they're locked. It can't unmount them, remount them writable, or bind the folder
    without them.
  - The price is that git inside can only read. `status`, `log` and `diff` work. `add`, `commit`,
    `branch` and `checkout` fail ("Unable to create '.git/index.lock': Read-only file system").
  - It doesn't help with 4, or with a `.git` or a folder around it that you replace or move on your
    machine (say, by cloning again). The mount is then lost, as in 1.
  - Tested in containers and in VMs (`enter --vm`).
- **Once the agent has run, treat its project's git as the agent's,** also after `sandbox stop`:
  what it planted in a `.git` stays there. Without `git-readonly`, don't run git on your machine in
  a repository the agent could write, including in folders it may have added, until you've looked
  at its `.git` as files (`commondir`, a `.git` file, the hooks, the keys in `config`, a
  `rebase-merge` or `rebase-apply` folder), not with git: git runs the payload itself.
- **After something on your machine has replaced a protected or hidden file,** restart the sandbox,
  then check that file.

### Default or git-readonly

By default, each repository's `.git/hooks` and `.git/config` are read-only. That stops the agent
writing a hook, `core.hooksPath` or `core.fsmonitor` directly: by mistake, or because an injected
instruction told it to. Since 0.11.0, each `.git`, and each folder between the project folder and
a nested one, is also bound onto itself (read-write), as `git-readonly` does for the folders above:
`.git` can't be moved away with its read-only parts, and git inside still commits.

**It still doesn't stop an agent that sets out to get around it:** `.git` is writable, so the agent
can write a `commondir` or leave a rebase's to-do list with `exec` lines. `enter`, `exec` and
`inspect` warn about both, and show the `exec` lines. `--policy git-readonly` blocks them, at the
cost of commits inside. The numbers are the limits above.

| What happens | Default | `--policy git-readonly` |
|---|---|---|
| The agent writes a hook, or `core.fsmonitor` in `.git/config` | blocked | blocked |
| The agent moves `.git`, or a folder above it, and puts a writable `.git` in its place (2) | blocked ("Resource busy")\* | blocked ("Resource busy") |
| The agent writes `.git/commondir` (3) | works; `enter`, `exec` and `inspect` warn | blocked |
| The agent leaves a rebase to-do list with `exec` lines (3) | works; `enter`, `exec` and `inspect` warn, with the lines | blocked |
| Git on your machine rewrites `.git/config` (`git branch`, `git config`, `git push -u`) (1) | the config is writable inside; the next `enter` or `exec` refuses | stays read-only |
| Something on your machine replaces or moves a `.git`, or a folder above it (1) | the mounts are lost; the next `enter` or `exec` refuses | the same |
| The agent makes a new repository (4) | not protected; the next `enter` or `exec` refuses | the same |
| Git inside | reads, commits, branches | only reads |

\* In a sandbox made with 0.11.0 or later. One made before works on as it is, without these mounts:
there moving `.git` works, and the next `enter` or `exec` refuses, unless the sandbox was restarted
in between. Make it again (`sandbox rm NAME`, remove its folder, `sandbox new` with the same
options) to get them.

A refusal or a warning at the next `enter` or `exec` comes after the fact: by then git on your machine may
already have run what the agent put there, through your shell prompt or your editor. Use
`git-readonly` when the commits are made outside the sandbox. With the default, follow the rule
above before you run git on your machine in the project.
