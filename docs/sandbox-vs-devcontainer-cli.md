# `sandbox` and the Dev Container CLI

A sandbox is an ordinary dev container. `sandbox` builds and starts it with the
[Dev Container CLI](https://github.com/devcontainers/cli) (`@devcontainers/cli`, a pinned version
installed with `sandbox`), always with `--docker-path podman`. So why not use that CLI directly?
This page says what `sandbox` adds, where the two differ, and what `sandbox` doesn't try to be.

## Who does what

| Step | Done by |
|---|---|
| building the image, Features, lifecycle commands (`postCreateCommand`, …) | the Dev Container CLI (`devcontainer build`, `up`) |
| a shell or a command inside (`sandbox enter`, `exec`) | the Dev Container CLI (`devcontainer exec`) |
| listing, stopping, removing (`sandbox list`, `stop`, `rm`) | Podman directly (`podman ps`, `stop`, `rm`) |
| looking at a running sandbox (`sandbox inspect`) | Podman directly (`podman container inspect`, and `podman exec` to read `/proc` inside) |
| what goes into the config before the CLI sees it | `sandbox` |

**`sandbox` doesn't run Podman to create containers itself.** The CLI does that, from
`devcontainer.json`. Podman's options (`--userns=keep-id`, `--cap-drop=all`, mounts, networks,
seccomp) are written in the config, as `runArgs` and `mounts`. The bundled templates are where they
are chosen once, and `sandbox` adds the ones that depend on your machine. That's the abstraction:
not a new way to call Podman, but configs that call it well, and checks that they still do.

The CLI's own subcommands are all still there; `sandbox` uses `up`, `build` and `exec`. The
specification stays the same, so the same config works with VS Code and other tools that follow it.

## What `sandbox` adds

**Before the CLI starts a container:**
- **The config is a copy.** `sandbox new` copies a template to `~/sandboxes/NAME`, and the container
  is made from that copy. A project's own config (`--inplace`) is copied too, and only the copy you
  confirmed runs: a change, by you or by an agent through git, is refused until `sandbox trust`
  ([A project's own sandbox config](project-config.md)).
- **The project at its own path,** with its git repositories' hooks and config read-only, and
  `--hide` and `--readonly` for secrets and other files
  ([A sandbox around an existing project](sandbox-around-an-existing-project.md)).
- **Your user inside:** `--userns=keep-id`, your UID and GID passed to the build, and an image user with
  your UID renamed to you.
- **A seccomp profile made from your Podman's own,** when the config asks for more system calls
  (`seccompAllow`; see below).
- **Values the config can use:** `SANDBOX_VERSION` (the label on the container, and the same
  `sandbox` installed inside), `SANDBOX_UID`, `SANDBOX_GID`, `USER`.

**While and after it runs:**
- **`sandbox inspect`:** the `podman run` command that made the container, what it runs with as
  measured inside (capabilities, new privileges, seccomp), its network and mounts, and warnings: a
  writable git hook, a forwarded SSH agent, a host socket.
- **`stop` and `rm` act only on sandboxes,** recognised by their label, so a container made by VS Code
  or by hand isn't removed by mistake.
- **`exec` behaves like `ssh host COMMAND`,** and `help NAME` says what a template offers.

## The same config without `sandbox`

A sandbox config is a valid dev container config, so `devcontainer up --workspace-folder .
--docker-path podman`, or VS Code's "Reopen in Container", start it too. What's different:

| | with `sandbox` | the Dev Container CLI on its own |
|---|---|---|
| the config that runs | the copy you confirmed | the project's files as they are now |
| the workspace | the project at its own path | `/workspace`, as the config says |
| git hooks and config | read-only | writable |
| seccomp | Podman's default plus `seccompAllow` | Podman's default |
| containers inside (`claude-containers`) | work | fail: `crun: sethostname: Operation not permitted` |
| the `podman-agent-sandbox` label | `sandbox`'s version | empty: `sandbox list` doesn't count it |
| `devcontainer-lock.json` | written next to the copy, in `~/sandboxes/NAME` | written into the project's `.devcontainer/` |

### Why containers inside need `sandbox`

1. **Podman inside gives every container its own hostname,** so the runtime (crun) calls
   `sethostname`.
2. **Podman's default seccomp profile allows `sethostname` only to a container with the
   `CAP_SYS_ADMIN` capability.** A sandbox doesn't have it, not even `claude-containers`.
3. **A seccomp filter applies to everything started inside the container, and can't be loosened
   from inside.** The inner runtime has the capability in its own user namespace, but the outer
   filter still refuses the call.
4. **`sandbox` makes a profile from your Podman's default with `sethostname` and `setdomainname`
   allowed,** because the config lists them in `seccompAllow`. It passes the profile with
   `--security-opt=seccomp=…`. The CLI on its own doesn't know `seccompAllow`, and uses Podman's
   default.

The profile isn't committed with a config: it's generated from the Podman on each machine, so it
matches that version.

### Mounting more than the project

Without a `workspaceMount` in the config, the CLI mounts the root of the git repository the folder is
in, not just the folder. With a folder reached through a symlink, at a different depth than its real
path, that root came out one level too high: a whole home directory was mounted, read-write. The
bundled templates always set `workspaceMount`, and `--workspace` sets it to the project's own path.

## Is `sandbox` a more powerful CLI than the Dev Container CLI?

No. It's narrower, on purpose:
- **One engine:** rootless Podman. The CLI also drives Docker.
- **One purpose:** running code you don't fully trust, such as a coding agent, on your own machine.
- **What it doesn't do:**
  - Docker Compose configs;
  - publishing Features or templates;
  - `devcontainer templates apply`, `features test`, `outdated` or `upgrade`;
  - VS Code's integration;
  - config files with comments, wherever `sandbox` rewrites the config (`--workspace`, `--inplace`).

For those, use the CLI or VS Code.

What it adds isn't capability but **policy**. The CLI runs whatever a config says. `sandbox` decides
what a config gets on your machine, and checks it:
- the hardening of the bundled templates, and `inspect`'s check that it's in place;
- the git hooks and config protected;
- a project's config confirmed before it runs, and again after every change;
- `stop` and `rm` limited to sandboxes.

## Does it handle the general case better?

For general dev container work, no. The CLI and VS Code handle more configs, and `sandbox` would only
get in the way: it asks you to confirm a config, refuses JSONC, and mounts the project at its own path.

For the case it's made for, yes. Things the CLI leaves to whoever writes the config become
guarantees:
- the hardening is checked;
- the git hooks are protected;
- the workspace mount is explicit;
- a changed config doesn't run unseen;
- the seccomp profile matches your Podman.

A few of the differences above may be worth raising with the Dev Container CLI itself:
- the git root mount through a symlink;
- whether the lock file belongs next to the config the CLI was given.
