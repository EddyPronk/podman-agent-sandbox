# A project's own sandbox config

A project can keep its sandbox config in `.devcontainer/` and commit it like any other code. Everyone
who clones the project gets the same sandbox.

## Use one

```sh
git clone <project-url> project && cd project
sandbox new --workspace . --inplace       # NAME defaults to the folder's name
sandbox enter project
```

- **The first time, you confirm the config.** `sandbox new` lists what it asks for, most important
  first:
  - commands that run on your machine;
  - capabilities and devices;
  - mounts of your files;
  - the network;
  - Features and lifecycle commands.

  It offers to show the files, then asks. `--yes` skips the questions, for scripts.
- **Only a sandbox config is accepted.** It must contain this block in `devcontainer.json`:
  ```json
  "customizations": {
    "podman-agent-sandbox": { "version": 1, "policies": [] }
  }
  ```
  A dev container config written for VS Code has no such block, and `--inplace` refuses it. Make a
  sandbox from a template around such a project instead:
  `sandbox new --workspace . --template claude`.
- **`--hide` and `--readonly` work as with `--workspace`**
  ([A sandbox around an existing project](sandbox-around-an-existing-project.md)). The project's
  `.devcontainer/` is always read-only inside.

## Make one

- **From a template:**
  ```sh
  sandbox new --workspace . --inplace --template claude
  ```
  This writes the template into the project's `.devcontainer/`, and makes the sandbox from it. Review
  the files and commit them.
- **From a sandbox you have changed** (made with `--workspace`, e.g. with tools added to its
  Containerfile):
  ```sh
  sandbox export NAME
  ```
  - It writes the sandbox's config, with your changes, into the project's `.devcontainer/`.
  - It leaves out what `sandbox` added for your machine: the project's path, the mounts for git
    hooks, `--hide` and `--readonly`, and the generated seccomp profile.
  - It lists what it left out, and warns if a line still names a path of yours.
  - From then on, the sandbox uses the project's config. If its container is running, make it again
    (`sandbox rm NAME`, then `sandbox enter NAME`), so that the new `.devcontainer/` is read-only
    inside.

Add the command to the project's README, e.g. "To work in a sandbox: `sandbox new --workspace .
--inplace`".

## When the config changes

`sandbox` never runs the project's files. It runs the copy you confirmed, kept in
`~/sandboxes/NAME/trusted`, with your machine's settings added.

- **When the project's config differs from that copy, `enter`, `exec` and `build` refuse.** At a
  terminal they offer to show the difference (`diff -ru`).
- **`sandbox trust NAME` shows the difference and asks.** On yes, the new version is used. Then make
  the container again.
- **Why:** the project's `.devcontainer/` is read-only inside, but an agent can still change it
  through git. It can commit a new version without touching the files, and a `git pull` or
  `git reset` outside brings that commit in. The check doesn't depend on how a change arrives.
- **How a version is identified:** by git's tree id of `.devcontainer/`, which is the same as
  `git ls-tree HEAD .devcontainer` when the folder is committed. git must be installed; the project
  needn't be a git repository.

## What the config may contain

- **Everything it uses must be inside `.devcontainer/`:** the Containerfile, the build context and
  local Features. Symlinks and Docker Compose are refused.
- **`initializeCommand` runs on your machine.** It's allowed, and shown first when you confirm a
  config. It may not name a file in the project outside `.devcontainer/`, because a change to that
  file wouldn't show up in the check.
- **Plain JSON, no comments:** `sandbox` adds your machine's settings to it.
- **Extra system calls for the seccomp profile** go in the block above, as
  `"seccompAllow": ["sethostname", "setdomainname"]`. `sandbox` generates the profile from your
  Podman's default.

## Removing

`sandbox rm NAME` removes the container. `~/sandboxes/NAME` stays, with the copy you confirmed, so
`sandbox enter NAME` makes the container again without asking. To start over, remove that folder too.

## VS Code

VS Code's "Reopen in Container" also reads the project's `.devcontainer/`, but runs it without
`sandbox`: no check, no read-only git hooks, no generated seccomp profile. Attach to the running
sandbox instead; see [VS Code and sandboxes](vscode.md).
