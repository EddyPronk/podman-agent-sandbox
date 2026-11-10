# Changelog

What each release changed for you, newest first. A sandbox is made from a copy of its template, so
template changes reach only sandboxes made after the release; where that matters, a release says
what to do about sandboxes you already have. To update, run the [one-line install](INSTALL.md)
again; `sandbox --version` shows what you have.

## 0.11.0 (2026-11-10)

- **Without a policy, `.git` can't be moved away any more.** `sandbox new --workspace` binds each
  `.git` onto itself (read-write, under its read-only `hooks` and `config`), and each folder between
  the project and a nested `.git`, as `--policy git-readonly` does for the folders above. Before, `mv
  .git .git.old` inside carried the read-only parts away and left room for a writable `.git` that git
  on your machine would use. Git inside still commits, branches and checks out.
  - **Sandboxes you already have** work on without these mounts, and `enter` doesn't ask for them.
    To get them, make the sandbox again: `sandbox rm NAME`, remove its folder (after saving any edits
    to its config), and `sandbox new` with the same options (they're in its `sandbox.json`).
- **`enter`, `exec` and `inspect` warn about a `commondir` or a rebase in progress** in a repository
  of a `--workspace` project without `git-readonly`, and show the rebase to-do list's `exec` lines:
  `git rebase --continue` on your machine would run them. Look before you run git there.
- **`sandbox export` leaves out the folders bound onto themselves**, of `git-readonly` sandboxes too.
  Before, it kept them in the exported config, as paths of this machine.
- **The `claude` template is now `open-network`.** Its agent is a choice since 0.10.0 (`--agent`),
  so the name said too little: what sets it apart from `proxy-client` and `offline` is its network,
  open to the Internet, your LAN and services on your machine that don't listen only on 127.0.0.1.
  Its description and the docs ([Network](docs/security-model.md#network)) now say so. `--template
  claude` still works and makes the same sandbox; sandboxes you already have are unchanged.
- **Docs:** [Default or git-readonly](docs/security-model.md#default-or-git-readonly) compares the two
  modes, attack by attack, and says what each one detects. The README's `--agent codex` example uses
  `nested-containers`, where Codex can run commands with its own sandbox.

## 0.10.0 (2026-11-06)

- **`/tmp` is writable again with podman 5.6 and newer.** Their image builds can leave `/tmp` at
  mode 755 after a Dev Container Feature is installed
  ([buildah#6503](https://github.com/podman-container-tools/buildah/issues/6503)), so the user
  couldn't write there: `mktemp`, podman inside and npm failed. Every template now mounts a tmpfs
  at `/tmp` with mode 1777 (`--tmpfs=/tmp:rw,exec,nosuid,nodev,mode=1777`). `/tmp` is then in
  memory and starts empty at each start. Sandboxes made earlier keep their `/tmp`: make one again
  (`sandbox rm`, remove its folder, `sandbox new`) if `stat -c %a /tmp` inside says 755.
- **`sandbox list --removed` is now `sandbox list --all`.** Plain `sandbox list` shows only the
  sandboxes that have a container, so one made with `sandbox new` and not entered yet was missing
  from it, which looked as if `new` had failed. `--all` shows those too, after the others, and says
  that `sandbox enter NAME` creates them; `--removed` is refused with a pointer to `--all`. The help
  and the README now say what plain `list` leaves out.
- **Choose the agent: `sandbox new … --agent codex`** (or `claude-code`, the default, or `none`).
  Claude Code is no longer built into the `claude`, `claude-containers` and `proxy-client`
  templates: it is an agent the package ships as a Feature, with the auto-updater off and the
  workspace trusted, and the templates have it by default, so `sandbox new --template claude` gives
  what it did. `--agent codex` gives OpenAI Codex CLI instead (tested in `claude` and
  `nested-containers`, open network). Its own sandbox (bubblewrap) runs in `nested-containers`, not
  in `claude` or `proxy-client` (README, "The agent"). `--option trustWorkspace=0` still keeps the
  trust question. Sandboxes made earlier keep Claude Code as they have it.
- **`claude-containers` is now `nested-containers`**: containers inside the sandbox, with Claude
  Code by default or another agent (`sandbox new work --template nested-containers --agent codex`).
  The old name still works. It now has `jq` too.
- **The agent's managed policy: `sandbox new … --agent-policy DIR`.** Claude Code's `CLAUDE.md` and
  `managed-settings.json`, mounted read-only at `/etc/claude-code`, above the workspace's own
  settings and out of the agent's reach. Kept in `.devcontainer/agent/claude-code/policy` (README,
  "The agent's managed policy").
- **Every `.git` read-only: `sandbox new --workspace PATH --policy git-readonly`.** Each repository's
  whole `.git` is one read-only mount, instead of its hooks and config. Each folder between the
  project and a `.git` is mounted onto itself, so it can't be renamed from inside: otherwise
  `mv libs libs.old` takes `libs/.git`'s mount along, and a copy puts a writable `.git` back.
  Git inside can then read (`status`, `log`, `diff`) but not commit, stage or switch branches.
  `enter` and `exec` check for both, and say why a path is listed ("writable", or "could be moved
  away with the .git in it"). `--policy NAME` (comma-separated or repeated) writes the config's `"policies"`, the list that
  already held `no-vm`: `sandbox new … --policy no-vm,git-readonly` gives
  `"policies": ["git-readonly", "no-vm"]`. A template or a project's own config can list
  `git-readonly` itself. With `--inplace`, `--policy` needs `--template`; otherwise the project's
  config lists its policies.
- **`enter`, `exec` and `inspect` look at the mounts really there** while the sandbox runs (its
  `/proc/1/mountinfo`), not only at podman's record, which keeps listing a mount the kernel dropped
  or that moved. `enter` and `exec` refuse while a protected path has lost its mount, and say that
  a restart brings it back. `inspect` warns about each mount podman lists that isn't there.
- **The limits of the read-only and hidden paths are documented** (docs/security-model.md, "Where a
  mount's protection ends"). Git's hooks and config, `--readonly` and `--hide` are mounts on single
  paths, and can be got around:
  - a program on your machine replacing the file (an atomic save; `git config` and `git branch`
    rewrite `.git/config`) drops the mount in the sandbox, which `podman inspect` doesn't show;
  - the agent can move the folder around a protected path away, `.git` included, and make it again;
  - the agent can redirect git with `.git/commondir`;
  - repositories made after `sandbox new` aren't covered.

  If you run git on your machine in a project a sandbox works on, restart the sandbox after git
  changes its config, or use `--policy git-readonly`.
- **Add tools with `sandbox new … --feature REF`.** Any published Dev Container Feature, by its
  reference, with options as JSON after `=`; repeatable, e.g. `--feature
  ghcr.io/devcontainers/features/aws-cli:1`. The template stays as it is: the Features are kept in
  `.devcontainer/sandbox-features.json` and added at every build. On Podman every build installs
  them again, so prefer Features that install packages over ones that compile (README, "Adding
  tools").

## 0.9.0 (2026-10-29)

- **Claude Code starts without asking whether to trust your project.** In a sandbox, the sandbox is
  what contains what Claude Code runs, so the "Do you trust this folder?" question only repeated a
  choice you'd made. It also blocked sessions started without a terminal, such as
  `claude --remote-control`, which waited for an answer nobody could give. To keep the question,
  make the sandbox with `--option trustWorkspace=0`.
- **Sandboxes behind the egress proxy hold phantom tokens by default.** Claude Code's real sign-in
  stays in the proxy's vault, and a sandbox gets tokens that work only through the proxy, so an
  agent can't take your sign-in with it. Only the first sandbox has to sign in. To keep the real
  tokens in the sandboxes, make the proxy with `--option credentialVault=0`.
- **Approve hosts from your phone.** An agent behind the egress proxy can ask for a host it needs
  while it works; you get a DM on Buzz, and your 👍 adds it to the allowlist. Set up the proxy's
  gatekeeper once with `sandbox exec proxy gatekeeper init` (its key is made in the proxy and stays
  there); from then on it starts with the proxy, and new sandboxes behind it can ask.
- **`sandbox exec proxy vault …` works.** Since 0.8.3, the help and the guide showed it, but the
  proxy didn't have the command on its path.

Sandboxes made earlier still ask once; answer it, or recreate the sandbox. A proxy made earlier
keeps the setting it was made with, and has neither the gatekeeper nor `vault` on its path; recreate
it to get them (its certificate and allowlist stay). A sandbox made earlier behind the proxy can't
ask; recreate it. [Your project behind the egress proxy](docs/behind-the-proxy.md), step 1, says how
to recreate the proxy.

## 0.8.3 (2026-10-28)

An early release of work in progress behind the egress proxy, to try it out:

- **Sign in once for all your sandboxes behind the proxy.** With the proxy's credential vault, a
  new sandbox behind it gets Claude Code's sign-in from the proxy and starts signed in.
- **Each sandbox behind the proxy can have an identity of its own** (`--option clientAuth=1`,
  on the proxy and on its sandboxes), so the proxy serves only sandboxes you made for it, and you can
  cut one off on its own.

Not finished: making sandboxes this way is still manual in places, and existing sandboxes need to
be recreated to take part. [Your project behind the egress proxy](docs/behind-the-proxy.md),
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

To get the credential vault, recreate the proxy with the option; its certificate and allowlist stay.

## 0.8.1 (2026-10-20)

- **The egress proxy's traffic log no longer records your sign-in.** Claude Code's tokens, account
  ids, email address and name are blanked out before anything is logged.

Recreate the proxy to get this; its certificate and allowlist stay.

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

Sandboxes made earlier have a writable config inside, and `sandbox inspect` warns about it;
recreate them.

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
