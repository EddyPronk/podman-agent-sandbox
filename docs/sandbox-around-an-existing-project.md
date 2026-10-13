# A sandbox around an existing project

`sandbox new` normally makes a new folder that is the workspace. To work on a project you already
have, give `--workspace`:

```sh
sandbox new myproject --template claude --workspace ~/workspace/myproject \
    --hide .env --hide secrets --readonly ci
sandbox enter myproject
```

- The project is mounted at **its own path**, which is the working folder inside: git output,
  error messages and caches mean the same inside and out. NAME defaults to the folder's name.
- **Nothing is written into the project.** The sandbox's config stays in `~/sandboxes/myproject`,
  outside the project, so the agent can't change how its own container is made. If the config
  folder is inside the project anyway (a `SANDBOX_DIR` in it), it is mounted read-only. To keep the
  config in the project instead, for everyone who works on it, see
  [A project's own sandbox config](project-config.md).
- **Every git repo in the project** (any `.git` folder, also nested ones; not in `node_modules` or
  `.venv`) gets `.git/hooks` and `.git/config` read-only: git on the host runs what they name
  (hooks, `core.hooksPath`, `core.fsmonitor`, aliases), so a writable one would let the agent run
  code outside the sandbox. A `.git` *file* (a worktree or submodule, whose git folder is elsewhere)
  is refused for now.
- **`sandbox enter` checks this again** before it starts: a repo added since `sandbox new` is
  reported, and the sandbox has to be made again (`sandbox rm`, remove its folder, `sandbox new`).
- **What isn't protected: your secrets.** The agent can read and change everything else in the
  project. `--hide PATH` (relative to the project) hides a file (it reads as empty) or a folder (an
  empty one in its place); `--readonly PATH` makes a path read-only. Neither can be added later:
  make the sandbox again. A hidden file that git tracks shows up as modified inside (it reads as
  empty there); committing it from inside would record it empty, not reveal it.
- Templates that refer to `/workspace` themselves (like `mitm-proxy`'s `allowlist.txt`) need it to be
  the workspace; use them without `--workspace`. The template's `devcontainer.json` must be plain
  JSON (no comments), since `sandbox new` rewrites it.

`sandbox rm` removes only the container: the project is untouched.

`--hide` and `--readonly` can't be changed later, and the list is easy to get wrong by hand: keep it
in a small script **outside the project** (or read-only inside it), so the agent can't edit its own
protections for the next time the sandbox is made.

Next: [Your project behind the egress proxy](behind-the-proxy.md), with no route out except
through a proxy that allows only the hosts you list.
