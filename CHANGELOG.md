# Changelog

What each release changed for you, newest first. A sandbox is made from a copy of its template, so
template changes reach only sandboxes made after the release; where that matters, a release says
what to do about sandboxes you already have. To update, run the [one-line install](INSTALL.md)
again; `sandbox --version` shows what you have.

## 0.9.0 (Unreleased)

- **Claude Code starts without asking whether to trust your project.** In a sandbox, the sandbox is
  what contains what Claude Code runs, so the "Do you trust this folder?" question only repeated a
  choice you'd made. It also blocked sessions started without a terminal, such as
  `claude --remote-control`, which waited for an answer nobody could give. To keep the question,
  make the sandbox with `--option trustWorkspace=0`.
- **Sandboxes behind the egress proxy hold phantom tokens by default.** Claude Code's real sign-in
  stays in the proxy's vault, and a sandbox gets tokens that work only through the proxy, so an
  agent can't take your sign-in with it. Only the first sandbox has to sign in. To keep the real
  tokens in the sandboxes, make the proxy with `--option credentialVault=0`.

Sandboxes made earlier still ask once; answer it, or make the sandbox anew. A proxy made earlier
keeps the setting it was made with; make it anew to get phantom tokens (its certificate and
allowlist stay).

## 0.8.3 (2026-10-28)

An early release of work in progress behind the egress proxy, to try it out:

- **Sign in once for all your sandboxes behind the proxy.** With the proxy's credential vault, a
  new sandbox behind it gets Claude Code's sign-in from the proxy and starts signed in.
- **Each sandbox behind the proxy can have an identity of its own** (`--option clientAuth=1`,
  on the proxy and on its sandboxes), so the proxy serves only sandboxes you made for it, and you can
  cut one off on its own.

Not finished: making sandboxes this way is still manual in places, and existing sandboxes need to
be made anew to take part. [Your project behind the egress proxy](docs/behind-the-proxy.md),
steps 4 and 5, has the details.

## 0.8.2 (2026-10-27)

- **Claude Code's sign-in can stay out of your sandboxes.** Made with
  `--option credentialVault=1`, the egress proxy keeps Claude Code's tokens, and sandboxes behind it
  hold only phantom tokens, useless anywhere else. An agent can still use your account through
  the proxy, but it can't take the sign-in with it.
- **`sandbox inspect` and `sandbox list` show a VM sandbox as its VM**, with its state, how it
  was started, and the image it runs.
- **`sandbox rm` says which kept volume is the sandbox's own** (its home, safe to remove) and which
  others still use, so you don't delete one that breaks other sandboxes.

To get the credential vault, make the proxy anew with the option; its certificate and allowlist stay.

## 0.8.1 (2026-10-20)

- **The egress proxy's traffic log no longer records your sign-in.** Claude Code's tokens, account
  ids, email address and name are blanked out before anything is logged.

Make the proxy anew to get this; its certificate and allowlist stay.

## 0.8.0 (2026-10-20)

- **Run a sandbox in its own virtual machine** (`sandbox new --vm`, `sandbox enter --vm`), so the
  agent no longer shares your machine's kernel. It needs krun and `/dev/kvm`. A sandbox stays a VM
  sandbox until you say otherwise. See [VM sandboxes](docs/microvm.md).
- **A sandbox with no network at all** (`--template offline`), for running code you don't trust,
  such as someone else's tests or a script you were sent.
- **Warnings before you expose secrets:** `sandbox new --workspace` lists files whose names suggest
  secrets (`.env`, keys, credentials) that the sandbox could read, so you can hide them with
  `--hide`.
- **See what a removed sandbox left behind:** `sandbox list --removed`, and `sandbox inspect` on a
  sandbox without a container, show its config and the volumes it keeps, with their sizes.
  `sandbox inspect` also shows how much disk containers inside a sandbox use.
- **No more advice that deletes your work:** when a sandbox's folder already exists, `sandbox new`
  suggests moving it aside rather than `rm -r` where the folder holds your work, and never suggests
  removing a project. `sandbox export` and `sandbox new --inplace` put everything back when they fail.
- **`sandbox stop` and `rm` touch only containers that `sandbox` made**, so they can't remove a
  container another tool made in the same folder.
- **Python and uv in `claude-containers`**, for Python projects.
- **A config can say which `sandbox` it needs**, and an older `sandbox` refuses it with a message
  instead of running it with something missing.
- **Clearer errors:** a malformed config or template is refused with a message saying what's wrong.
- **Check where a release came from** with `gh attestation verify` ([INSTALL.md](INSTALL.md)).

## 0.7.0 (2026-10-13)

- **Commit your project's sandbox config,** so everyone who works on it gets the same sandbox:
  `sandbox new --workspace . --inplace` uses the project's own `.devcontainer/`.
  - **You confirm a config before it's used,** with a summary of what it asks for, and `sandbox`
    runs only the copy you confirmed.
  - **When the config changes,** for example through a commit an agent made, `sandbox` refuses to
    start the sandbox until you've seen the change and accepted it (`sandbox trust`).
  - **`sandbox export`** turns a sandbox you've adjusted into such a config, without your machine's
    paths.

  See [A project's own sandbox config](docs/project-config.md).
- **A tool stuck retrying a refused host no longer floods the egress proxy.** npm used to retry
  hundreds of times a second and fill the logs; now it gives up after about a minute, and the logs
  record it once.

`git` is now required.

## 0.6.0 (2026-10-12)

- **The agent can't change how its next sandbox is made.** A sandbox's own config is read-only
  inside, so an agent can no longer plant a command that would run on your machine the next time the
  container is made.
- **See exactly how a sandbox runs:** `sandbox inspect NAME` shows the command that created it, its
  user, rights, network and mounts, and warns about weaknesses. That includes what VS Code passes in
  while attached, such as your SSH agent and git credentials.
- **Run a command in a sandbox without entering it:** `sandbox exec NAME COMMAND`.
- **Allow a host the egress proxy refused,** after the fact: `sandbox exec proxy approve` goes
  through recent refusals and asks about each. `sandbox help NAME` shows what a sandbox offers.
- **Ubuntu as the base image:** `--image docker.io/library/ubuntu:26.04` for `claude` and the
  sandboxes behind the proxy. Other Debian and Ubuntu images work too, with a warning.
- **`sandbox stop` and `rm` won't touch other containers** unless you pass `--force`.
- **New documentation:** installing, the security model, VS Code, and a project behind the egress
  proxy.

Sandboxes made earlier have a writable config inside, and `sandbox inspect` warns about it; make
them anew.

## 0.5.2 (2026-10-09)

- **Nothing in a sandbox can gain rights.** Sandboxes run without any capabilities and with
  no-new-privileges, so setuid and similar programs can't raise anyone's rights inside.
  `claude-containers` is the exception: Podman inside it needs those.

Sandboxes made earlier lack this; [How a sandbox is
isolated](docs/security-model.md#no-way-to-gain-rights) says how to add it.

## 0.5.1 (2026-10-09)

- **The egress proxy's log names the host it refused**, instead of `None:None`.

## 0.5.0 (2026-10-08)

- **Let the agent run containers:** `--template claude-containers` gives it rootless Podman and
  `sandbox` inside its sandbox, to build images, run tests in containers, or make sandboxes of its
  own. This weakens the sandbox; [Containers inside a
  sandbox](docs/containers-inside-a-sandbox.md) says how.
- **`USER` and `LOGNAME` are set** in sandbox shells, for tools that rely on them.

## 0.4.0 (2026-10-05)

- **Put a sandbox around a project you already have:** `sandbox new --workspace PATH`. Nothing is
  written into the project. Its git hooks and config are read-only inside, so the agent can't make
  git on your machine run something, and `--hide` and `--readonly` keep files out of its reach.

## 0.3.0 (2026-10-04)

- **Keep the agent off the Internet except where you allow it:** an egress proxy, and sandboxes
  that can reach the outside only through it (`--template proxy-client`). The proxy lets through
  only the hosts on its allowlist, and logs the rest.
- **`sandbox --version`.**
- **The installer always gets the latest release**, and tells you when another `sandbox` on your
  `PATH` would run instead.

## 0.2.0 (2026-10-04)

- **Use your own templates:** `sandbox new --template ./path/to/template`.

## 0.1.0 (2026-10-03)

- **First release:** `sandbox new`, `enter`, `list`, `stop` and `rm`, with the `claude` template
  (Claude Code in a rootless Podman container that runs as you), and a one-line install.
