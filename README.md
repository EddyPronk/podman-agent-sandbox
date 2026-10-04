# podman-agent-sandbox

A rootless Podman sandbox for running coding agents.

`sandbox` is a small, lxc-style front end for [dev containers](https://containers.dev/) on
rootless Podman. Each sandbox is a folder with a `.devcontainer/` config; the container runs
with `--userns=keep-id`, so the user inside *is* your host user, and keeps its home directory
on a per-sandbox volume.

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
defaults. A template is copied once: later changes to it don't reach existing sandboxes.

| Template | What you get |
|---|---|
| `claude` | Debian trixie, Node.js and Claude Code (Dev Container Features); unrestricted network |

Your own templates don't need to be bundled: give `--template` a path to a template folder
(anything with a `/` in it is a path), e.g. one kept in your project:

```sh
sandbox new work --template ./templates/mine     # templates/mine/devcontainer-template.json
```

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
