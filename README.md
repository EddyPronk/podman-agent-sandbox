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
  not even with `sudo` (except the `nested-containers` template, which needs them). See [How a
  sandbox is isolated](docs/security-model.md).
- **Your project, not your home:** the project folder is all a sandbox gets from your machine; its
  home directory is a volume of its own. The project's git hooks and config are read-only, so the
  agent can't run code on your machine through git, and `--hide` keeps secrets out of sight.
- **Optional egress proxy:** a sandbox with no route out except through a proxy that allows only the
  hosts you list; refused hosts can be approved from a terminal.
- **Ready-made templates:** Claude Code on Debian or Ubuntu, a proxy and its client, one that can
  run containers of its own, and one with no network for code you don't trust.
- **Standard dev containers:** each sandbox is a folder with a `devcontainer.json`, so VS Code can
  connect to it.
- **A project's own sandbox config:** commit it in `.devcontainer/`, and whoever clones the project
  gets the same sandbox. `sandbox` runs only the version you confirmed; a change, for example by the
  agent through git, has to be confirmed again.
- **`sandbox inspect`:** how a sandbox runs, as a `podman run` command line and a summary of its
  rights, with warnings about anything that weakens it.

**Quick links**

- [Install](INSTALL.md)
- [How a sandbox is isolated](docs/security-model.md): what it may and may not do, and what it
  doesn't protect
- [A sandbox around an existing project](docs/sandbox-around-an-existing-project.md)
- [A project's own sandbox config](docs/project-config.md)
- [`sandbox` and the Dev Container CLI](docs/sandbox-vs-devcontainer-cli.md): what `sandbox` adds,
  and what it isn't
- [Your project behind the egress proxy](docs/behind-the-proxy.md)
- [VS Code to connect to a sandbox](docs/vscode.md)
- [Containers inside a sandbox](docs/containers-inside-a-sandbox.md)
- [A sandbox in a microVM](docs/microvm.md): `sandbox enter --vm`, with its own kernel (krun)
- [Contributing](CONTRIBUTING.md)

## Prerequisites

- Rootless Podman: `podman info --format '{{.Host.Security.Rootless}}'` prints `true`
- Node.js 20.12 or later, with npm
- git: `sandbox` uses it to check a project's own sandbox config (`--inplace`)
- `flock`, from util-linux (part of every Debian and Ubuntu install): `sandbox` uses it so that two
  commands on one sandbox don't race
- For `sandbox enter --vm` only: krun and `/dev/kvm` ([A sandbox in a microVM](docs/microvm.md))

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

Or run code you don't trust, such as a project's tests, with no network at all:

```sh
sandbox new --template offline --workspace ~/src/app --image docker.io/library/python:3.13-slim-trixie
sandbox exec app make test      # the first time builds the image; only the build has a network
```

Use `sandbox exec`, not `podman exec`: it runs in the project folder and checks the sandbox first
(see [Usage](#usage)).

## Usage

```sh
sandbox templates                                   # list the templates
sandbox new sandbox_with_claude --template claude   # create ~/sandboxes/sandbox_with_claude
sandbox new sandbox_with_ubuntu --template claude --image docker.io/library/ubuntu:26.04   # on another base image
sandbox new --template claude --workspace ~/src/app # around an existing folder
sandbox new --workspace ~/src/app --inplace         # from the project's own .devcontainer
sandbox new aws --template offline --feature ghcr.io/devcontainers/features/aws-cli:1   # with a Dev Container Feature
sandbox trust app                                   # confirm a change in the project's config
sandbox export app                                  # write a --workspace sandbox's config into its project
sandbox enter sandbox_with_claude                   # build and start if needed, open a shell
sandbox enter --vm sandbox_with_claude              # the same in a KVM microVM, with its own kernel (krun)
sandbox exec sandbox_with_claude git status         # run one command in it (start it if needed), like ssh
sandbox help sandbox_with_claude                    # what this sandbox offers (from its template)
sandbox inspect sandbox_with_claude                 # the podman run command that made it, and what it runs with
sandbox list                                        # the sandboxes that have a container, running or not
sandbox list --all                                  # also those without one: not entered yet, or removed
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

Like `enter`, it starts a stopped sandbox first, and checks it before running anything. It refuses a
git repository in the workspace whose hooks or config would be writable, and a project config
(`--inplace`) that changed since you confirmed it. `podman exec NAME COMMAND` also works on a
running sandbox, also as you, but it runs in `/`, with the image's PATH (without, e.g., `~/.local/bin`),
and without those checks. Use `sandbox exec`.

Sandboxes live in `~/sandboxes`; set `SANDBOX_DIR` to use another folder. A sandbox that
already has a container is found through the container's `devcontainer.local_folder` label,
wherever its folder is.

`sandbox list` shows the sandboxes that have a container (or a VM), whatever its state: running,
exited or created. A sandbox is in two places, its config folder and its container, and `list` goes by
the container. So it doesn't show one that has only its config folder: one you made with
`sandbox new` and haven't entered yet (`new` only copies the template; the first `enter` or `exec`
builds the image and creates the container), or one removed with `sandbox rm`. `sandbox list --all`
shows those too, in a second table, with the volumes they keep; it finds them in `$SANDBOX_DIR`
only.

`stop` and `rm` only act on sandboxes, so they can't remove a container made with `podman` or other
tools by mistake. A sandbox's container has the label `podman-agent-sandbox` (the templates add
it, since 0.6.0), and only the label counts: a config folder in `$SANDBOX_DIR` doesn't, since
other tools (VS Code) put containers' configs there too. For anything else, `--force`
(`sandbox rm --force NAME`), or use `podman` directly. A sandbox made before 0.6.0 has no label:
use `--force`, or make it again with `sandbox new` to get the label.

`sandbox inspect NAME` shows a sandbox's container in two parts. First the `podman run` command
that created it, as Podman recorded it, quoted for the shell with one option per line. Then what it
runs with: user and user namespace, capabilities, new privileges, seccomp, devices, `/proc`,
network (internal or routed), limits, and every mount (read-only, writable or hidden). While the
sandbox runs, capabilities, new privileges and seccomp are read inside, from `/proc/1/status`.
It also lists host sockets mounted into it (an SSH agent, Podman's or Docker's API, X11, D-Bus),
and, for a sandbox that runs Podman inside, how much its images and containers take and whether
`sandbox rm` keeps them (it does when they're in the home volume, as with `nested-containers`).
Warnings follow, e.g. for a sandbox made before 0.5.2 that still has capabilities, or a git repo in a
`--workspace` whose hooks or config would be writable. It works on any container, e.g. one VS Code
made, and says first whether it is a sandbox. Podman records the command line only for containers
made with the `podman` command, not through its API socket (as VS Code does). Of a VM sandbox it shows
the VM, as Podman set it up (nothing can be read inside a VM), then the container it was made from
([A sandbox in a microVM](docs/microvm.md)).

After `sandbox rm`, the container is gone but its config folder and volumes stay: `sandbox inspect
NAME` then shows what's left (the workspace, an `--inplace` config's trust, each volume with its
size and how to remove it), and `sandbox list --all` lists every such sandbox in
`$SANDBOX_DIR`.

### The agent: `--agent`

The `claude`, `nested-containers` and `proxy-client` templates come with Claude Code. It isn't part
of the template itself but an agent added to it, so another agent can take its place:

```sh
sandbox new work --template claude                   # Claude Code (the default)
sandbox new work --template claude --agent codex     # OpenAI's Codex CLI instead
sandbox new work --template claude --agent none      # no agent
```

An agent is a Dev Container Feature the package ships (`agents/claude-code`, `agents/codex`):
`sandbox new` copies it into `.devcontainer/agent/NAME`, read-only inside the sandbox, and adds it at
every build. It brings what the agent needs in a sandbox: Claude Code with its auto-updater off; Codex
as its release binary, checked against a pinned SHA-256; and for both, the workspace folder trusted
from the start (`--option trustWorkspace=0` keeps the agent's question). To switch the agent of a
sandbox, replace the folder in `.devcontainer/agent/` with another from the package, then `sandbox rm
NAME` and `sandbox enter NAME`.

With `--inplace --template`, the agent goes into the project's own `devcontainer.json`
(`"./agent/claude-code"` under `features`, its folder next to it), so the config you commit names it;
`sandbox export` does the same.

Codex runs the commands it executes in a sandbox of its own (bubblewrap, which the agent installs).
That works in `nested-containers`, which unmasks `/proc` for Podman. In `claude` and `proxy-client`,
`/proc` stays masked and bubblewrap can't start (`bwrap: Can't mount proc on /proc: Operation not
permitted`), so Codex can't run commands with its default settings there. Use `nested-containers`,
or turn Codex's own sandbox off in the sandbox (`sandbox_mode = "danger-full-access"` in
`~/.codex/config.toml`, or `codex --sandbox danger-full-access`): the container is then what
contains it, as for Claude Code. Behind the egress proxy Codex also needs its hosts allowed, and its
sign-in isn't in the proxy's credential vault, which holds Claude Code's.

### Adding tools: `--feature`

`sandbox new NAME --template TEMPLATE --feature REF` adds a published
[Dev Container Feature](https://containers.dev/features) to the sandbox, by its reference, without
changing the template. Repeat it for more, and give options as JSON after `=`:

```sh
sandbox new py --template claude \
  --feature 'ghcr.io/devcontainers/features/python:1={"version": "os-provided"}' \
  --feature ghcr.io/devcontainers/features/aws-cli:1
```

The Features are kept next to the config, in `.devcontainer/sandbox-features.json` (read-only inside
the sandbox, so what runs there can't change them), and added to every build. Edit that file to
add or remove one later, then `sandbox rm NAME` and `sandbox enter NAME` to build it again. It
doesn't go with `--inplace` yet: add the Feature to the project's `devcontainer.json` instead.

Things to know:

- **A Feature runs as root while the image is built**, with the network of the machine (not the
  sandbox's), and `:1` follows its latest 1.x release: it's code you choose to trust, like the base
  image. Pin it (`python:1.7.1`) to change it only when you do.
- **A Feature can ask for rights the sandbox drops**, such as `privileged` or extra capabilities
  (`docker-in-docker` does). Run `sandbox inspect NAME` after the first build and check its
  capabilities, new privileges and mounts. `sandbox` doesn't check a Feature's requests itself yet.
  Plain install scripts (language runtimes, CLIs, `apt-packages`) ask for none of this.
- **On Podman, Features are installed again at every build**, also when nothing changed
  ([buildah#5243](https://github.com/containers/buildah/issues/5243)): `sandbox enter` after
  `sandbox rm` takes as long as the first build. A Feature that compiles (`python:1` with a version
  such as `3.13`) makes that slow; one that installs packages (`"version": "os-provided"`) is quick.
  `sandbox stop` and a later `enter` don't build.
- **Downloads at run time go through the sandbox's network**: none for `offline`, the proxy's
  allowlist for `proxy-client`.

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
| `nested-containers` | Like `claude`, plus rootless Podman and `sandbox` inside, for an agent that needs containers of its own, and Python 3 with uv for Python projects. Weakens the sandbox: see [Containers inside a sandbox](docs/containers-inside-a-sandbox.md) |
| `mitm-proxy` | [agent-mitm-proxy](https://github.com/EddyPronk/agent-mitm-proxy): an egress proxy with TLS interception and an allowlist (`allowlist.txt` in the sandbox folder; changes apply without a restart). Option `ref`: the agent-mitm-proxy commit to build; `credentialVault` (default `1`): Claude Code's OAuth tokens stay in the proxy's vault, clients hold phantom tokens ([more](docs/behind-the-proxy.md#4-keep-claude-codes-tokens-out-of-the-sandbox)); `clientAuth=1`: each client needs a name and token of its own ([more](docs/behind-the-proxy.md#5-a-name-and-token-per-client)). Its gatekeeper lets an agent ask for a host, and you approve it on Buzz ([more](docs/behind-the-proxy.md#6-approve-hosts-from-your-phone)) |
| `proxy-client` | Like `claude` (also `--image`), but with no route out: only the proxy's internal network, all HTTP(S) through `http://proxy:8899`, trusting the proxy's CA. With a vault in the proxy, it fetches its credentials file (phantom tokens) when made, so it needs no sign-in. With the proxy's gatekeeper running, Claude Code gets it as an MCP server, to ask for blocked hosts. Option `clientAuth=1`, for a proxy made with it: it enrols itself with the proxy |
| `offline` | No network at all, only loopback; for running code you don't trust. Debian trixie with `git` and `make`, or another base image with `--image`. No agent: it couldn't reach its API. Tools your code needs come from the image, since nothing can be downloaded later |

`mitm-proxy` and `proxy-client` work as a pair: [Your project behind the egress
proxy](docs/behind-the-proxy.md).

In `claude`, `nested-containers` and `proxy-client`, Claude Code trusts the workspace folder from
the start (`/workspace`, or with `--workspace` the project's own path): it doesn't ask "Do you trust
this folder?", which a session started without a terminal (such as `claude --remote-control`)
can't answer. The sandbox is what contains what Claude Code runs there. `--option trustWorkspace=0`
keeps the question. Since 0.9.0; in a sandbox made earlier, answer it once, or run
`trust-workspace DIR` in a sandbox that has it.

`claude`, `offline` and `proxy-client` are built on `debian:trixie-slim` unless you choose another base image with
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

To share a sandbox config with everyone who works on a project, commit it as the project's
`.devcontainer/` instead: [A project's own sandbox config](docs/project-config.md).

## Uninstall

```sh
npm uninstall -g podman-agent-sandbox
```

This removes `sandbox` and its copy of the Dev Container CLI. It does not touch what your
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
