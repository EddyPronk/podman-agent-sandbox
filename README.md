# podman-agent-sandbox

A rootless Podman sandbox for running coding agents.

`sandbox` is a small, lxc-style front end for [dev containers](https://containers.dev/) on
rootless Podman. Each sandbox is a folder with a `.devcontainer/` config; the container runs
with `--userns=keep-id`, so the user inside *is* your host user, and keeps its home directory
on a per-sandbox volume.

## Prerequisites

- Rootless Podman: `podman info --format '{{.Host.Security.Rootless}}'` prints `true`
- Node.js 20.12 or later

The [Dev Containers CLI](https://github.com/devcontainers/cli) comes with `sandbox` as a
pinned dependency; you don't need to install it yourself.

## Install

```sh
git clone https://github.com/<you>/podman-agent-sandbox
cd podman-agent-sandbox
npm pack
npm install -g ./podman-agent-sandbox-*.tgz
```

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
rm -r ~/sandboxes/NAME                                   # sandbox folders
```

## Development

```sh
npm install
npm test
```

## License

Apache-2.0
