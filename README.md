# podman-agent-sandbox

A rootless Podman sandbox for running coding agents.

Let a coding agent such as Claude Code work on your project, without giving it the rest of your
machine. `sandbox` creates a container that can reach the project, but not other parts of your home
directory, your SSH keys or other credentials (unless you choose to). One command creates a sandbox,
one opens a shell in it.

**Features**

- **Rootless, and you inside:** rootless Podman, no daemon, no root. Inside, you are your own user,
  so files in the project keep your ownership.
- **Hardened by default:** no capabilities and no new privileges, so nothing inside can gain rights,
  not even with `sudo` (except the `claude-containers` template, which needs them). See [How a
  sandbox is isolated](docs/security-model.md).
- **Your project, not your home:** the project folder is all a sandbox gets from your machine; its
  home directory is a volume of its own. The project's git hooks and config are read-only, so the
  agent can't run code on your machine through git, and `--hide` keeps secrets out of sight.
- **Optional egress proxy:** a sandbox with no route out except through a proxy that allows only the
  hosts you list; refused hosts can be approved from a terminal.
- **Ready-made templates:** Claude Code on Debian or Ubuntu, a proxy and its client, and one that can
  run containers of its own.
- **Standard dev containers:** each sandbox is a folder with a `devcontainer.json`, so VS Code can
  connect to it.
- **`sandbox inspect`:** how a sandbox runs, as a `podman run` command line and a summary of its
  rights, with warnings about anything that weakens it.

**Quick links**

- [Install](INSTALL.md)
- [How a sandbox is isolated](docs/security-model.md): what it may and may not do, and what it
  doesn't protect
- [A sandbox around an existing project](docs/sandbox-around-an-existing-project.md)
- [Your project behind the egress proxy](docs/behind-the-proxy.md)
- [VS Code to connect to a sandbox](docs/vscode.md)
- [Containers inside a sandbox](docs/containers-inside-a-sandbox.md)
- [Contributing](CONTRIBUTING.md)

## Prerequisites

- Rootless Podman: `podman info --format '{{.Host.Security.Rootless}}'` prints `true`
- Node.js 20.12 or later, with npm
- git: `sandbox` uses it to check a project's own sandbox config (`--inplace`)

On Debian 13 (trixie):

```sh
sudo apt install podman nodejs npm git
```

Debian 12 and Ubuntu 24.04 ship Node.js 18, which is too old; get Node.js from
[nodejs.org](https://nodejs.org/) there.

## Install

Once the prerequisites are in place:

```sh
curl -fsSL https://raw.githubusercontent.com/EddyPronk/podman-agent-sandbox/main/install.sh | sh
```

Run it again to update. The [install script](INSTALL.md#install-script) section says what it does
and how to pin a release. Alternatively you can do a [manual installation](INSTALL.md#manual-install).

## Getting started

Put Claude Code to work on one of your projects, inside a sandbox:

```sh
cd ~/development
git clone <your-project-url> your-project
sandbox new --template claude --workspace ~/development/your-project
sandbox enter your-project      # the first time builds the image: a few minutes
claude                          # inside the sandbox: sign in once, then work on the project
```

The project is the working folder inside, at the same path. The agent can change its files, but not
its git hooks and config. Your SSH keys, your other files and the rest of your home directory stay
outside. The sandbox's own config is in `~/sandboxes/your-project`. Leave the shell with `exit`; the
sandbox keeps running until `sandbox stop your-project`. More in
[A sandbox around an existing project](docs/sandbox-around-an-existing-project.md), and
[Your project behind the egress proxy](docs/behind-the-proxy.md) as the next step.

## Usage

```sh
sandbox templates                                   # list the templates
sandbox new sandbox_with_claude --template claude   # create ~/sandboxes/sandbox_with_claude
sandbox new sandbox_with_ubuntu --template claude --image docker.io/library/ubuntu:26.04   # on another base image
sandbox new --template claude --workspace ~/src/app # around an existing folder
sandbox enter sandbox_with_claude                   # build and start if needed, open a shell
sandbox exec sandbox_with_claude git status         # run one command in it (start it if needed), like ssh
sandbox help sandbox_with_claude                    # what this sandbox offers (from its template)
sandbox inspect sandbox_with_claude                 # the podman run command that made it, and what it runs with
sandbox list
sandbox stop sandbox_with_claude
sandbox rm sandbox_with_claude                      # removes the container; the home volume is kept
sandbox build sandbox_with_claude [--no-cache]      # rebuild the image, showing the full log
```

`sandbox exec NAME COMMAND [ARG ...]` runs COMMAND as you, in the workspace folder, with the same
environment as `enter`, and returns its exit status. Everything after NAME is the command, so
`sandbox exec sandbox_with_claude ls -la` passes `-la` to `ls`; a `--` after NAME is allowed. Unlike
`ssh`, the arguments arrive as they are: they aren't joined into one string for a shell to split
again. It gets a terminal when you run it at one, so interactive tools work, and none in a pipe or a
script.

Sandboxes live in `~/sandboxes`; set `SANDBOX_DIR` to use another folder. A sandbox that
already has a container is found through the container's `devcontainer.local_folder` label,
wherever its folder is.

`stop` and `rm` only act on sandboxes, so they can't remove a container made with `podman` or other
tools by mistake. A sandbox's container has the label `podman-agent-sandbox` (the templates add
it, since 0.6.0); older ones count when their config folder is in `$SANDBOX_DIR` or has a
`sandbox.json` (`--workspace`). For anything else, `--force` (`sandbox rm --force NAME`), or use
`podman` directly.

`sandbox inspect NAME` shows a sandbox's container in two parts. First the `podman run` command
that created it, as Podman recorded it, quoted for the shell with one option per line. Then what it
runs with: user and user namespace, capabilities, new privileges, seccomp, devices, `/proc`,
network (internal or routed), limits, and every mount (read-only, writable or hidden). While the
sandbox runs, capabilities, new privileges and seccomp are read inside, from `/proc/1/status`.
It also lists host sockets mounted into it (an SSH agent, Podman's or Docker's API, X11, D-Bus).
Warnings follow, e.g. for a sandbox made before 0.5.2 that still has capabilities, or a git repo in a
`--workspace` whose hooks or config would be writable. It works on any container, e.g. one VS Code
made, and says first whether it is a sandbox. Podman records the command line only for containers
made with the `podman` command, not through its API socket (as VS Code does).

### Templates

Templates use the [Dev Container Template](https://containers.dev/implementors/templates/)
format: a `devcontainer-template.json` plus a `.devcontainer/` folder. `sandbox new` copies the
template and replaces `${templateOption:KEY}` with the values from `--option KEY=VALUE` or the
defaults. A template is copied once: later changes to it don't reach existing sandboxes. For
example, sandboxes made before 0.5.2 lack the hardening flags; [How a sandbox is
isolated](docs/security-model.md#no-way-to-gain-rights) says how to add them.

| Template | What you get |
|---|---|
| `claude` | Debian trixie (or another base image: `--image`, below), Node.js and Claude Code (Dev Container Features); unrestricted network |
| `claude-containers` | Like `claude`, plus rootless Podman and `sandbox` inside, for an agent that needs containers of its own. Weakens the sandbox: see [Containers inside a sandbox](docs/containers-inside-a-sandbox.md) |
| `mitm-proxy` | [agent-mitm-proxy](https://github.com/EddyPronk/agent-mitm-proxy): an egress proxy with TLS interception and an allowlist (`allowlist.txt` in the sandbox folder; changes apply without a restart). Option `ref`: the agent-mitm-proxy commit to build |
| `proxy-client` | Like `claude` (also `--image`), but with no route out: only the proxy's internal network, all HTTP(S) through `http://proxy:8899`, trusting the proxy's CA |

`mitm-proxy` and `proxy-client` work as a pair: [Your project behind the egress
proxy](docs/behind-the-proxy.md).

`claude` and `proxy-client` are built on `debian:trixie-slim` unless you choose another base image with
`--image` (`sandbox templates` lists some):

```sh
sandbox new sandbox_with_ubuntu --template claude --image docker.io/library/ubuntu:26.04
```

Only Ubuntu 26.04 (and the default) is tested. Any other image is **experimental**: `sandbox new` warns,
and once it runs, check it with `sandbox inspect NAME`, which may show warnings about weaknesses. The
image must be Debian or Ubuntu based (the build uses `apt-get`). Node.js and Claude Code are
installed on top as usual, and the sandbox gets the same hardening. If the image already has a user with
your UID (Ubuntu's `ubuntu`, `node` or `vscode` in Microsoft's dev container images), the build renames
it to you, with its home, so that `--userns=keep-id` finds you. It keeps that user's groups: on Ubuntu
you are also in `adm`, `sudo` and a few others, which give nothing inside a sandbox without capabilities
and with no new privileges (and Ubuntu's image has no `sudo`).

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

The templates' base image (`debian:trixie-slim`, or the one given with `--image`) stays too;
`podman rmi IMAGE` removes it.

## Development

```sh
npm install
npm test
```

Running a development version next to the installed one, the tests and pull requests:
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0
