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
  is refused for now. **This doesn't cover everything git reads.** From inside, the agent can move
  `.git` away, together with the read-only parts, and make a new one, or write `.git/commondir`. And
  when git on your machine rewrites `.git/config` (`git config`, `git branch`, `git push -u`), the
  sandbox loses that mount. See [Where a mount's protection ends](security-model.md#where-a-mounts-protection-ends).
- **`--policy git-readonly`** makes every repo's whole `.git` read-only instead. Each folder
  between the project and a `.git` is also mounted onto itself, so the agent can't move a repo away
  with its read-only `.git` and copy it back writable. That closes the ways above, for the repos
  there are at `sandbox new`. Git inside can then only read (`status`,
  `log`, `diff`); `add`, `commit`, `branch` and `checkout` fail. Use it when the commits are made
  outside the sandbox. `--policy` writes it into the sandbox's `devcontainer.json`, in
  `"customizations": {"podman-agent-sandbox": {"policies": ["git-readonly"]}}`, where a template of
  your own or a project's config ([A project's own sandbox config](project-config.md)) can list it
  too. The `enter` check then wants each `.git` read-only as a whole, and the folders above it
  mounted.
- **`sandbox enter` checks this again** before it starts: a repo added since `sandbox new` is
  reported, and the sandbox has to be made again (`sandbox rm`, remove its folder, `sandbox new`).
  It compares with the mounts the container was made with, so it doesn't see a mount the sandbox
  lost when a file was replaced on your machine (`podman restart NAME` brings those back).
- **What isn't protected: your secrets.** The agent can read and change everything else in the
  project. `--hide PATH` (relative to the project) hides a file (it reads as empty) or a folder (an
  empty one in its place); `--readonly PATH` makes a path read-only. Neither can be added later:
  make the sandbox again. A hidden file that git tracks shows up as modified inside (it reads as
  empty there); committing it from inside would record it empty, not reveal it. **Both are mounts
  on one path:** a hidden or read-only *file* that a program on your machine replaces (by saving a
  new file over it) is visible or writable inside from then on. And a `--readonly` path whose folder
  is writable can be moved away from inside and made again. Prefer hiding a folder to hiding the
  files in it; see [Where a mount's protection ends](security-model.md#where-a-mounts-protection-ends).
- **`sandbox new` warns about files whose names suggest secrets** and that you didn't hide: `.env`
  files (not `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, SSH keys (`id_rsa`, `id_ed25519`,
  ...), `.netrc` and `credentials.json`. It's a hint from names only: a secret can be in any file.
  Folders you can't read are skipped; the agent, running as you, can't read them either.
- Templates that refer to `/workspace` themselves (like `mitm-proxy`'s `allowlist.txt`) need it to be
  the workspace; use them without `--workspace`. The template's `devcontainer.json` must be plain
  JSON (no comments), since `sandbox new` rewrites it.

`sandbox rm` removes only the container: the project is untouched.

`--hide` and `--readonly` can't be changed later, and the list is easy to get wrong by hand: keep it
in a small script **outside the project** (or read-only inside it), so the agent can't edit its own
protections for the next time the sandbox is made.

Next: [Your project behind the egress proxy](behind-the-proxy.md), with no route out except
through a proxy that allows only the hosts you list.
