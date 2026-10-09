# podman-agent-sandbox

A rootless Podman sandbox for running coding agents.

`sandbox` is a small, lxc-style front end for [dev containers](https://containers.dev/) on
rootless Podman. Each sandbox is a folder with a `.devcontainer/` config; the container runs
with `--userns=keep-id`, so the user inside *is* your host user, and keeps its home directory
on a per-sandbox volume. The bundled templates drop all capabilities (`--cap-drop=all`) and set
`no-new-privileges`, so nothing inside can gain rights through setuid or file capabilities (no
`sudo`); only `claude-containers` can't, see [Containers inside a
sandbox](#containers-inside-a-sandbox).

## Prerequisites

- Rootless Podman: `podman info --format '{{.Host.Security.Rootless}}'` prints `true`
- Node.js 20.12 or later, with npm

On Debian 13 (trixie):

```sh
sudo apt install podman nodejs npm
```

Debian 12 and Ubuntu 24.04 ship Node.js 18, which is too old; get Node.js from
[nodejs.org](https://nodejs.org/) there.

The [Dev Containers CLI](https://github.com/devcontainers/cli) comes with `sandbox` as a
pinned dependency; you don't need to install it yourself.

## Install

Once the prerequisites are in place:

```sh
curl -fsSL https://raw.githubusercontent.com/EddyPronk/podman-agent-sandbox/main/install.sh | sh
```

[`install.sh`](install.sh) checks the prerequisites, points npm at `~/.local` if it can't write to
npm's global folder (see below), and installs the release tarball (built by CI with `npm pack`) with
`npm install -g`. It installs the latest release; `PAS_VERSION=x.y.z` pins a release, and
`PAS_REF=<branch or tag>` installs any other ref from source. Run it again to update.

### Manual install

`npm install -g` writes to the folder that `npm config get prefix` prints. With Debian's npm
that is `/usr/local`, which needs root. Point npm at your home folder instead (once; it is saved
in `~/.npmrc`):

```sh
npm config set prefix "$HOME/.local" --location=user
```

Then:

```sh
git clone https://github.com/EddyPronk/podman-agent-sandbox
cd podman-agent-sandbox
npm pack
npm install -g ./podman-agent-sandbox-*.tgz
```

This installs the command as `~/.local/bin/sandbox`. If `~/.local/bin` didn't exist before,
log out and back in: Debian's `~/.profile` only adds it to `PATH` when it exists at login.

`npm install -g .` also works, but links the global command to this folder instead of copying it.

## Usage

```sh
sandbox templates                        # list the templates
sandbox new work --template claude       # create ~/sandboxes/work
sandbox new --template claude --workspace ~/src/app   # around an existing folder (below)
sandbox enter work                       # build and start if needed, open a shell
sandbox list
sandbox stop work
sandbox rm work                          # removes the container; the home volume is kept
sandbox build work [--no-cache]          # rebuild the image, showing the full log
```

Sandboxes live in `~/sandboxes`; set `SANDBOX_DIR` to use another folder. A sandbox that
already has a container is found through the container's `devcontainer.local_folder` label,
wherever its folder is.

### Templates

Templates use the [Dev Container Template](https://containers.dev/implementors/templates/)
format: a `devcontainer-template.json` plus a `.devcontainer/` folder. `sandbox new` copies the
template and replaces `${templateOption:KEY}` with the values from `--option KEY=VALUE` or the
defaults. A template is copied once: later changes to it don't reach existing sandboxes. (For
example, sandboxes made before 0.5.2 don't have `--cap-drop=all` and
`--security-opt=no-new-privileges`: add them to `runArgs` in the sandbox's
`.devcontainer/devcontainer.json`, then `sandbox rm NAME` and `sandbox enter NAME`.)

| Template | What you get |
|---|---|
| `claude` | Debian trixie, Node.js and Claude Code (Dev Container Features); unrestricted network |
| `claude-containers` | Like `claude`, plus rootless Podman and `sandbox` inside, for an agent that needs containers of its own. Weakens the sandbox: see [Containers inside a sandbox](#containers-inside-a-sandbox) |
| `mitm-proxy` | [agent-mitm-proxy](https://github.com/EddyPronk/agent-mitm-proxy): an egress proxy with TLS interception and an allowlist (`allowlist.txt` in the sandbox folder; changes apply without a restart). Option `ref`: the agent-mitm-proxy commit to build |
| `proxy-client` | Like `claude`, but with no route out: only the proxy's internal network, all HTTP(S) through `http://proxy:8899`, trusting the proxy's CA |

To run Claude Code behind the proxy, create and start the proxy first; it publishes its CA certificate
for the client:

```sh
sandbox new proxy --template mitm-proxy
sandbox enter proxy                    # starts the proxy; exit again, it keeps running
sandbox new work --template proxy-client
sandbox enter work
```

The proxy's private data (CA keys, the decrypted-traffic log, refusals) stays in its home volume,
`proxy-home`. Only one proxy can run at a time: it takes the network name `proxy`.

Your own templates don't need to be bundled: give `--template` a path to a template folder
(anything with a `/` in it is a path), e.g. one kept in your project:

```sh
sandbox new work --template ./templates/mine     # templates/mine/devcontainer-template.json
```

### A sandbox around an existing project

`sandbox new` normally makes a new folder that is the workspace. To work on a project you already
have, give `--workspace`:

```sh
sandbox new myproject --template claude --workspace ~/workspace/myproject \
    --hide .env --hide secrets --readonly ci
sandbox enter myproject
```

- The project is mounted at **its own path**, which is the working folder inside: git output,
  error messages and caches mean the same inside and out. NAME defaults to the folder's name.
- **Nothing is written into the project.** The sandbox's config stays in `~/sandboxes/myproject`,
  outside the project, so the agent can't change how its own container is made. If the config
  folder is inside the project anyway (a `SANDBOX_DIR` in it), it is mounted read-only.
- **Every git repo in the project** (any `.git` folder, also nested ones; not in `node_modules` or
  `.venv`) gets `.git/hooks` and `.git/config` read-only: git on the host runs what they name
  (hooks, `core.hooksPath`, `core.fsmonitor`, aliases), so a writable one would let the agent run
  code outside the sandbox. A `.git` *file* (a worktree or submodule, whose git folder is elsewhere)
  is refused for now.
- **`sandbox enter` checks this again** before it starts: a repo added since `sandbox new` is
  reported, and the sandbox has to be made again (`sandbox rm`, remove its folder, `sandbox new`).
- **What isn't protected: your secrets.** The agent can read and change everything else in the
  project. `--hide PATH` (relative to the project) hides a file (it reads as empty) or a folder (an
  empty one in its place); `--readonly PATH` makes a path read-only. Neither can be added later:
  make the sandbox again. A hidden file that git tracks shows up as modified inside (it reads as
  empty there); committing it from inside would record it empty, not reveal it.
- Templates that refer to `/workspace` themselves (like `mitm-proxy`'s `allowlist.txt`) need it to be
  the workspace; use them without `--workspace`. The template's `devcontainer.json` must be plain
  JSON (no comments), since `sandbox new` rewrites it.

`sandbox rm` removes only the container: the project is untouched.

`--hide` and `--readonly` can't be changed later, and the list is easy to get wrong by hand: keep it
in a small script **outside the project** (or read-only inside it), so the agent can't edit its own
protections for the next time the sandbox is made.

### Containers inside a sandbox

Some work needs containers: building images, running a project's integration tests, or trying out
sandboxes themselves. The `claude-containers` template is `claude` plus rootless Podman and the
`sandbox` command inside, so the agent can do that itself:

```sh
sandbox new myproject --template claude-containers --workspace ~/workspace/myproject --hide .env
sandbox enter myproject
# inside: podman build/run, and sandbox new/enter for sandboxes of its own
```

Inside gets the same `sandbox` version as outside (the release of that version, installed when the
sandbox is made). Containers inside can't get more rights than the sandbox itself has, and the
`mitm-proxy` and `proxy-client` templates work inside as they do outside, on networks of their own.
A `claude-containers` sandbox can be made inside another one, e.g. to test a project that itself
makes sandboxes.

**What it costs.** Rootless Podman inside a rootless container needs four rights the `claude`
template doesn't give:

| Right | Why | What it weakens |
|---|---|---|
| `--device=/dev/net/tun` | `pasta`, the network for rootless containers, builds it with a TUN device | network interfaces in the sandbox's own network namespace; on its own this doesn't reach the host's network |
| `--security-opt=unmask=/proc/*` | a container's new `/proc` can only be mounted where `/proc` isn't partly covered | the sandbox's `/proc` loses Podman's covers; host-wide files (`kcore`, `sysrq-trigger`) still need privileges a rootless container never has, so what opens up is mostly the sandbox's own view |
| its own seccomp profile | containers inside set their own host name | your Podman's default profile, plus `sethostname` and `setdomainname` without `CAP_SYS_ADMIN`; both change only the caller's own UTS namespace |
| no `--cap-drop=all`, no `no-new-privileges` | `newuidmap`/`newgidmap` map the user's subordinate IDs with their file capabilities (`cap_setuid`, `cap_setgid`; the image has them instead of setuid); without these rights inner containers fail with `operation not permitted` | a program with file capabilities or setuid can gain rights up to Podman's default set (still no `CAP_SYS_ADMIN`), inside the sandbox's user namespace |

Kept as with `claude`: `--userns=keep-id` (you, not root), the rest of the seccomp profile.

**Use `claude` unless the agent needs containers.** This template is for your own projects and an
agent you'd let run containers on your machine anyway; not for untrusted code. Its network is as
open as `claude`'s: only *inner* `proxy-client` sandboxes are behind a proxy.

- **The seccomp profile** is written at `sandbox new` into the sandbox's
  `.devcontainer/seccomp.json`, from your Podman's default (`podman info` →
  `SECCOMPProfilePath`). If your Podman has no profile file, a copy of Podman 5.4's default that
  comes with the template is used, with a warning.
- **Host:** `/dev/net/tun` must exist (`ls -l /dev/net/tun`). If you log out and the sandbox stops,
  so does everything inside it: turn on lingering (`loginctl enable-linger`) on machines you use
  over SSH.
- **Disk:** each level keeps its own images and volumes, inside the sandbox's home volume: a
  `claude` sandbox inside is about 1.3 GB more. Clean up inside with `podman image prune` and
  `sandbox rm`.

## Uninstall

```sh
npm uninstall -g podman-agent-sandbox
```

This removes `sandbox` and its copy of the Dev Containers CLI. It does not touch what your
sandboxes created; remove those yourself if you no longer need them:

```sh
podman ps -a --filter label=devcontainer.local_folder    # containers
podman rm -f NAME
podman volume rm NAME-home                               # home directories
podman images --filter reference='vsc-*'                 # images built by the CLI
podman rmi IMAGE
podman image prune                                       # their build layers (all dangling images)
rm -r ~/sandboxes/NAME                                   # sandbox folders
```

The templates' base image (`debian:trixie-slim`) stays too; `podman rmi debian:trixie-slim`
removes it.

## Development

```sh
npm install
npm test
```

## License

Apache-2.0
