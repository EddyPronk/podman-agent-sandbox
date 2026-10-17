# A sandbox in a microVM

`sandbox enter --vm NAME` runs a sandbox in a small KVM virtual machine instead of a plain container,
so the agent no longer shares your kernel ([How a sandbox is isolated](security-model.md#what-it-doesnt-protect)).
It uses krun: crun built with libkrun, which runs a container's processes in a microVM with their own
Linux kernel (libkrunfw). The rest stays as it is: `sandbox new`, the template, the image build, the
lifecycle commands, the mounts.

## Requirements

- **krun on `PATH`**, built with libkrun: `krun --version` lists `+LIBKRUN`. Debian doesn't package it;
  [podman-krun-debian](https://github.com/EddyPronk/podman-krun-debian) builds it (crun 1.30.1, libkrun
  1.19.6, libkrunfw 5.6.2, guest kernel 6.12.109).
- **`/dev/kvm`**, readable and writable for you (usually through the `kvm` group).
- **util-linux `flock`**, which every `sandbox enter`, `exec`, `stop` and `rm` now uses to keep two
  commands on one sandbox apart.

Without them, `sandbox enter --vm` refuses and says what's missing.

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

`sandbox enter --vm NAME`, in this order:

1. **The VM runs:** attach to its shell.
2. **The normal container runs:** refuse; `sandbox stop NAME` first. `--vm` never opens the normal
   container.
3. **The VM exists, stopped:** start it, attach.
4. **No VM, but the normal container exists:** refuse, saying when it was made. A VM would copy its image,
   mounts and settings as they were then. For a fresh sandbox, `sandbox rm NAME` (volumes are kept), then
   `sandbox enter --vm NAME`. To make the VM from that container anyway: `sandbox enter --vm
   --from-existing NAME`.
5. **Nothing exists:** make the normal container, stop it, make the VM, attach.

On every path it runs the same checks as `sandbox enter`: an `--inplace` project's config must be the one
you trusted, and with `--workspace`, every git repository's hooks and config must be read-only. That is
checked against the VM's own mounts once it exists, so a repository added to the workspace after the VM
was made is caught.

Refused first, before any of these: no usable krun or `/dev/kvm`; a config with the `no-vm` policy
([A project's own sandbox config](project-config.md)); a config with a `postStartCommand` or
`postAttachCommand`, since the VM runs neither (they run in a container at each start and each attach).
The `mitm-proxy` template is refused for both reasons: its proxy starts in `postStartCommand`. These are
read from the config as the Dev Containers CLI merges it, Features included, again once the image exists.

## A VM sandbox

Once its VM exists, a sandbox is a VM sandbox, running or not, until `sandbox rm NAME`.

- `sandbox enter NAME` (without `--vm`) and `sandbox exec NAME` refuse. A VM has one terminal and no
  exec, and starting the normal container instead would run things somewhere else than the VM.
  `sandbox rm NAME` makes it a container sandbox again.
- `sandbox stop NAME` stops the VM at once (`podman stop --time 0`). Signals reach the VM's host process,
  not the guest, and it ignores SIGTERM, so a gentler stop would only wait and then kill it. What the guest
  had written is already on the host (its files are shared through virtio-fs), so the kill loses what it
  loses in a plain container. `exit` in the VM's shell is cleaner: the VM stops when its shell ends.
- `sandbox rm NAME` removes the VM and the normal container, and keeps the volumes, as before.
- `sandbox list` shows the VM next to its sandbox, as `VM of NAME`. `sandbox inspect NAME` adds a line
  for the VM: its state, when it was made, and how to make it again. Its measurements inside (capabilities,
  seccomp) are of the normal container, when it runs: they can't be taken in a VM.
- `sandbox build NAME` doesn't change the VM: it keeps the image it was made from. Make it again with
  `sandbox rm NAME`, then `sandbox enter --vm NAME`.

## Attaching

`sandbox enter --vm` attaches your terminal to the VM's shell. Press Enter for a prompt: the shell
printed its first one before you attached. **Ctrl-P Ctrl-Q detaches**, leaving the VM and what runs in it
(a long agent session) running; the next `sandbox enter --vm NAME` attaches to the same shell. Podman's
detach keys take Ctrl-P, bash's previous-command key, while you're attached: change them with
`detach_keys` in `containers.conf`. Two terminals attached at once share the one shell, like `screen -x`;
they aren't two shells.

## The environment

The VM's environment is the container's (`containerEnv` in the config), plus the config's `remoteEnv`.
The Dev Containers CLI sets `remoteEnv` at each exec; the VM has no exec, so `sandbox` sets it once, when
the VM is made. A `remoteEnv` value that names the container's environment (`${containerEnv:…}`) can't
be known then and is left out. Without a `remoteEnv`, the VM gets `TERM`, `USER` and `LOGNAME`. The
bundled templates' `remoteEnv` is just those three. The shell starts in the config's `workspaceFolder`.

## What it protects, and what it doesn't

Measured with krun 1.30.1 and libkrun 1.19.6 in lab 34, with the prototype this command follows:

- **The kernel is the guest's:** `uname -r` in the VM is the guest kernel (6.12.109), not the host's.
- **The options confine the VM's host process, not the guest.** `--cap-drop=all`, `no-new-privileges`
  and the seccomp profile apply to the process on the host that runs the VM (no capabilities,
  `NoNewPrivs: 1`, `Seccomp: 2`). Inside the guest there are all capabilities, `NoNewPrivs: 0` and no
  seccomp. What stands between the guest and your machine is KVM and that confined host process.
- **Read-only mounts hold against root in the guest:** they're enforced on the host side. Remounting one
  read-write in the guest "succeeds", but writes are still refused and the host file is unchanged.
- **It runs as your UID only with `--userns=keep-id` and a user** (`containerUser` in the config, as in
  every template but `mitm-proxy`): uid 1000 in the guest, files owned by you on the host. Any `sudo` or
  setuid binary in the image makes the guest's user root in the guest. Read-only mounts still hold then.
- **Networking stays as it was:** krun's default networking (TSI) connects from Podman's network namespace.
  A `proxy-client` sandbox's VM stays behind its proxy: allowlisted hosts through it, no DNS and no route
  out by IP around it. Claude Code ran in such a VM, signed in from the home volume.
- **Start-up** takes about 0.8 s, against about 0.2 s for a plain container.

Not tested yet:

- `sandbox enter --vm` itself, from this branch, on a host with krun: `test/integration/vm.sh` covers
  every rule above, a `--workspace` sandbox's read-only `.git` and hidden paths from inside the VM, and the
  `claude` template; until it has run, the list above is the prototype's.
- **Memory:** a VM gets 1 GiB by default. libkrun reads `krun.ram_mib` from the container's annotations
  (`"runArgs": ["--annotation", "krun.ram_mib=4096"]` in the config); whether `--memory` changes the
  guest's RAM isn't known.
- **`claude-containers`** (Podman inside the VM) and a custom seccomp profile (`seccompAllow`) on the VM's
  host process.

## Limits

- VS Code and plain `podman start` don't know about the VM or the lock that `sandbox` takes. Starting the
  normal container while the VM runs makes both use the same home volume; `sandbox enter --vm` checks
  just before it starts or makes a VM, but can't stop VS Code doing it later.
- `sandbox exec --vm`, a channel into the guest for commands (an sshd or an agent over vsock), and passt
  networking aren't there.
