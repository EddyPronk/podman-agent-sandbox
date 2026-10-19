# A sandbox in a microVM

A VM sandbox runs in a small KVM virtual machine instead of a plain container, so the agent no longer
shares your kernel ([How a sandbox is isolated](security-model.md#what-it-doesnt-protect)). It uses
krun: crun built with libkrun, which runs a container's processes in a microVM with their own Linux
kernel (libkrunfw). The rest stays as it is: the template, the image build, the lifecycle commands, the
mounts.

```sh
sandbox new work --template claude --vm     # a VM sandbox from the start
sandbox enter work                          # makes its VM, and attaches to its shell
sandbox enter --vm other                    # makes an existing sandbox a VM sandbox
```

## Requirements

- **krun on `PATH`**, built with libkrun: `krun --version` lists `+LIBKRUN`. Debian doesn't package it;
  [podman-krun-debian](https://github.com/EddyPronk/podman-krun-debian) builds it (crun 1.30.1, libkrun
  1.19.6, libkrunfw 5.6.2, guest kernel 6.12.109).
- **`/dev/kvm`**, readable and writable for you (usually through the `kvm` group).
- **util-linux `flock`**, which every `sandbox enter`, `exec`, `stop` and `rm` now uses to keep two
  commands on one sandbox apart.

Without them, `sandbox new --vm` and `sandbox enter` of a VM sandbox refuse and say what's missing.

## How it works

The VM is made from the sandbox's normal container: the same `podman run` command, as Podman recorded
it, run with `--runtime krun`. So the normal container comes first: it builds the image and runs the
lifecycle commands (`postCreateCommand`, for example) as usual. The VM gets the same image (the one the
container was made from, by ID), mounts, user, network, capabilities, security options and environment.
`sandbox` leaves out only what made it a Dev Containers CLI container: its attach options, name,
entrypoint and keep-alive command, and its `devcontainer.*` and `podman-agent-sandbox` labels. It adds
krun, the name `NAME-vm`, a label that says whose VM it is (`podman-agent-sandbox.vm-of=NAME`), and a
login shell as the main process. Then it checks that every option of the container, apart from those it
left out, is in the VM's command, in the same order. If it can't copy the command faithfully (an option it
doesn't know, a Feature's entrypoint, `overrideCommand: false`), it refuses rather than make a weaker
VM.

There's no `podman exec` into a krun VM: its processes run in the guest's kernel, where the host has
nothing to join. So the VM's main process is a login shell, and `sandbox enter --vm` attaches to it
(`podman attach`).

`sandbox enter NAME` of a VM sandbox, or `sandbox enter --vm NAME`, in this order:

1. **The VM runs:** attach to its shell.
2. **The normal container runs:** refuse; `sandbox stop NAME` first. `--vm` never opens the normal
   container.
3. **The VM exists, stopped:** start it, attach.
4. **No VM, but the normal container exists** (a container sandbox, made a VM sandbox with `--vm`):
   refuse, saying when it was made. A VM would copy its image, mounts and settings as they were then. For
   a fresh sandbox, `sandbox rm NAME` (volumes are kept), then `sandbox enter --vm NAME`. To make the VM
   from that container anyway: `sandbox enter --vm --from-existing NAME`.
5. **Nothing exists** (new, or after `sandbox rm`): make the normal container, stop it, make the VM,
   attach.

On every path it runs the same checks as `sandbox enter`: an `--inplace` project's config must be the one
you trusted, and with `--workspace`, every git repository's hooks and config must be read-only. That is
checked against the VM's own mounts once it exists, so a repository added to the workspace after the VM
was made is caught.

Refused first, before any of these: no usable krun or `/dev/kvm`; a config with the `no-vm` policy
([A project's own sandbox config](project-config.md)); a config with a `postStartCommand` or
`postAttachCommand`, since the VM runs neither (they run in a container at each start and each attach).
The `mitm-proxy` template is refused for both reasons (below). These are read from the config as the
Dev Containers CLI merges it, Features included, again once the image exists. `sandbox new --vm` makes
the same checks on the config before it makes anything (Features can still add a command; `enter`
checks again).

### Why the proxy can't run as a VM

The `mitm-proxy` sandbox runs the egress proxy that every `proxy-client` sandbox on the machine goes
through: on their internal network it's their only way out. A VM of it wouldn't work, and would break
them:

- **The proxy wouldn't start.** It starts in the template's `postStartCommand`, at each start of the
  container. A VM runs a login shell as its main process, and runs no lifecycle command: it would be a
  shell with no proxy in it.
- **The clients would lose the proxy.** `sandbox enter --vm` needs the normal container stopped, and that
  container is the running proxy. Every client sandbox would lose its way out, for as long as the VM ran.

So the template says so with the `no-vm` policy, and `sandbox new --vm` and `sandbox enter --vm` refuse
it, as they would any config with a `postStartCommand`. The policy keeps it refused if the proxy's start ever moves out of
`postStartCommand`. Client sandboxes can run as VMs: a `proxy-client` VM stays behind the proxy (below).

## A VM sandbox

A sandbox becomes a VM sandbox with `sandbox new --vm` or `sandbox enter --vm`, and stays one, also
after `sandbox rm`. `sandbox` records that in `$SANDBOX_DIR/.state/NAME.json`, outside every mount: a
sandbox's own folder can be its workspace, writable inside, and an agent that could change the record
could have the next `enter` run it as a plain container. A record whose folder you deleted counts as
gone.

- `sandbox enter NAME` attaches to its VM, starts it, or makes it (again, after `sandbox rm`).
- `sandbox exec NAME` refuses. A VM has one terminal and no exec, and starting the normal container
  instead would run things somewhere else than the VM.
- To make it a container sandbox again: `sandbox rm NAME` (volumes are kept), then `sandbox enter
  --container NAME`. `--container` refuses while the VM exists, so a VM and a container never both exist
  from different setups.
- `sandbox stop NAME` stops the VM at once (`podman stop --time 0`). Signals reach the VM's host process,
  not the guest, and it ignores SIGTERM, so a gentler stop would only wait and then kill it. What the guest
  had written is already on the host (its files are shared through virtio-fs), so the kill loses what it
  loses in a plain container. `exit` in the VM's shell is cleaner: the VM stops when its shell ends.
- `sandbox rm NAME` removes the VM and the normal container, and keeps the volumes, as before; the sandbox
  stays a VM sandbox.
- `sandbox list` shows the VM next to its sandbox, as `VM of NAME`; `sandbox list --removed` shows each
  removed sandbox's kind. `sandbox inspect NAME` adds a line for the VM: its state, when it was made, and
  how to make it again. Its measurements inside (capabilities, seccomp) are of the normal container, when
  it runs: they can't be taken in a VM.
- `sandbox build NAME` doesn't change the VM: it keeps the image it was made from. Make it again with
  `sandbox rm NAME`, then `sandbox enter NAME`.

## Attaching

`sandbox enter` attaches your terminal to the VM's shell. Press Enter for a prompt: the shell
printed its first one before you attached. **Ctrl-] detaches** (as in telnet), leaving the VM and what
runs in it (a long agent session) running; the next `sandbox enter NAME` attaches to the same
shell. `sandbox` sets that key for its attach: Podman's default, Ctrl-P Ctrl-Q, would take Ctrl-P,
bash's previous-command key, while you're attached. A plain `podman attach NAME-vm` still uses Podman's
keys. Two terminals attached at once share the one shell, like `screen -x`; they aren't two shells.

## The environment

The VM's environment is the container's (`containerEnv` in the config), plus the config's `remoteEnv`.
The Dev Containers CLI sets `remoteEnv` at each exec; the VM has no exec, so `sandbox` sets it once, when
the VM is made. A `remoteEnv` value that names the container's environment (`${containerEnv:…}`) can't
be known then and is left out. Without a `remoteEnv`, the VM gets `TERM`, `USER` and `LOGNAME`. The
bundled templates' `remoteEnv` is just those three. The shell starts in the config's `workspaceFolder`.

## What it protects, and what it doesn't

Measured with krun 1.30.1 and libkrun 1.19.6, first with the prototype this command follows (lab 34),
then with `sandbox enter --vm` itself (`test/integration/vm.sh`, which passes: every rule above,
detaching and reattaching, two `enter --vm` at once, a `--workspace` sandbox, the `claude` template):

- **The kernel is the guest's:** `uname -r` in the VM is the guest kernel (6.12.109), not the host's.
- **The options confine the VM's host process, not the guest.** `--cap-drop=all`, `no-new-privileges`
  and the seccomp profile apply to the process on the host that runs the VM (no capabilities,
  `NoNewPrivs: 1`, `Seccomp: 2`). Inside the guest there are all capabilities, `NoNewPrivs: 0` and no
  seccomp. What stands between the guest and your machine is KVM and that confined host process.
- **Read-only mounts hold against root in the guest:** they're enforced on the host side. Remounting one
  read-write in the guest "succeeds", but writes are still refused and the host file is unchanged.
- **A `--workspace` sandbox keeps its protection in the VM:** its git repositories' `.git/hooks` and
  `.git/config` are read-only and `--hide` paths read empty, for the user. (Root in the guest wasn't
  reached to try them: `sudo` doesn't work in the VM, next point.)
- **A custom seccomp profile works:** `claude-containers`' VM starts with its profile (`seccompAllow`) on
  the VM's host process.
- **It runs as your UID only with `--userns=keep-id` and a user** (`containerUser` in the config, as in
  every template but `mitm-proxy`): uid 1000 in the guest, files owned by you on the host.
- **Root in the guest gets no more of your files than you have.** The guest's files, its root filesystem
  included, are shared through virtio-fs: the VM's host process opens them, as you, without capabilities.
  So a setuid program in the image doesn't help much: in an image with `sudo` for the user (no password),
  `sudo` fails with "unable to open /etc/sudoers: Permission denied", a file owned by root with mode 0440.
  The setuid `newuidmap` fails too, and with it Podman inside the VM (below); whether for the same reason
  isn't known.
- **Memory:** a VM gets 1 GiB by default. Both `"runArgs": ["--annotation", "krun.ram_mib=4096"]` and
  `"runArgs": ["--memory", "4g"]` in the config set the guest's RAM (2 GiB and 3 GiB measured).
- **Networking stays as it was:** krun's default networking (TSI) connects from Podman's network namespace.
  A `proxy-client` sandbox's VM stays behind its proxy: allowlisted hosts through it, no DNS and no route
  out by IP around it. Claude Code ran in such a VM, signed in from the home volume.
- **Start-up** takes about 0.8 s, against about 0.2 s for a plain container.

Doesn't work:

- **Podman inside the VM** (`claude-containers`): the VM starts, but an inner container doesn't. Rootless
  Podman needs `newuidmap` to set up its user namespace, and in the VM it fails ("write to uid_map
  failed: Operation not permitted"). Use `claude-containers` as a container.

## Limits

- VS Code and plain `podman start` don't know about the VM or the lock that `sandbox` takes. Starting the
  normal container while the VM runs makes both use the same home volume; `sandbox enter --vm` checks
  just before it starts or makes a VM, but can't stop VS Code doing it later.
- `sandbox exec --vm`, a channel into the guest for commands (an sshd or an agent over vsock), and passt
  networking aren't there.
