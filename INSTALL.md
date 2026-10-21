# Install

First check the [prerequisites](README.md#prerequisites): rootless Podman, and Node.js 20.12 or later
with npm.

## Install script

```sh
curl -fsSL https://raw.githubusercontent.com/EddyPronk/podman-agent-sandbox/main/install.sh | sh
```

[`install.sh`](install.sh):
1. checks the prerequisites;
2. points npm at `~/.local` if it can't write to npm's global folder (see
   [Manual install](#manual-install) for why);
3. installs the release tarball, built by CI with `npm pack`, with `npm install -g`.

- **Update:** run it again; it installs the latest release.
- **A specific release:** set `PAS_VERSION`:
  ```sh
  curl -fsSL https://raw.githubusercontent.com/EddyPronk/podman-agent-sandbox/main/install.sh | PAS_VERSION=0.8.2 sh
  ```
- **A branch or tag, from source:** `PAS_REF=<branch or tag>` instead.

## Check where a release came from

Each release tarball, from 0.8.0 on, has a provenance attestation: a signed statement that this
repository's CI built it, from the tag's commit. Check it with the [GitHub CLI](https://cli.github.com/):

```sh
curl -fsSLO https://github.com/EddyPronk/podman-agent-sandbox/releases/latest/download/podman-agent-sandbox.tgz
gh attestation verify podman-agent-sandbox.tgz --repo EddyPronk/podman-agent-sandbox
npm install -g ./podman-agent-sandbox.tgz
```

`install.sh` doesn't check it: it would need `gh`, signed in.

## Manual install

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
