# Contributing

## Setup

Needs what the README's Prerequisites list (rootless Podman, Node.js 20.12 or newer).

```sh
git clone https://github.com/EddyPronk/podman-agent-sandbox.git ~/development/podman-agent-sandbox
cd ~/development/podman-agent-sandbox
npm install
npm test
```

## Running a development version

Run the checked-out code directly. An alias keeps it apart from the installed `sandbox`:

```sh
alias sandbox-dev='node ~/development/podman-agent-sandbox/bin/sandbox.js'
sandbox-dev --version
sandbox-dev new try --template claude
```

- **It runs whatever branch is checked out,** with the repo's own `node_modules`.
- **It runs the build in `dist/`, not `src/`.** Run `npm run build` after each change, or keep
  `npx tsc --watch` running in another terminal. `--watch` doesn't remove the output of a file
  deleted from `src/`; `npm run build` does.
- **It uses the same `SANDBOX_DIR` as the installed `sandbox`.** Give test sandboxes a folder of their
  own: `SANDBOX_DIR=~/sandboxes-dev sandbox-dev new …`.
- **It reports the version in `package.json`,** which is the release it was branched from. Use the
  name, not `--version`, to tell the two apart.
- **Don't use `npm link` or `npm install -g .` for this.** Both replace the installed `sandbox` until
  you install the release again with the README's one-liner.

## Tests

- **Unit tests:** `npm test` (Node's test runner). They build no images and start no containers.
- **TypeScript tests** (`test/*.test.ts`, new ones may be written so): `npm test` builds them first
  (`tsc -p test`, into `test-build/`), against `dist/` and its `.d.ts` files. They import
  `../dist/x.js`, like the JavaScript tests. They run from `test-build/`, so a file in
  `test/fixtures/` or `test/fake-podman/` is `new URL('../test/fixtures/…', import.meta.url)`. A type
  a test relies on is checked when it builds: `test/json.test.ts` doesn't build if a check stops
  narrowing.
- **Integration tests** in `test/integration/` need rootless Podman. They build images, so they take
  minutes:
  - `nested.sh TARBALL [LOG_DIR]` makes a `claude-containers` sandbox, installs the `npm pack` tarball
    in it, and runs T1–T22 there. Inside, it runs `proxy-network.sh` for the proxy tests. The `podman`
    workflow runs it on GitHub.
  - `proxy-network.sh` can also run on its own, against a running proxy and client:
    `PROXY=NAME CLIENT=NAME test/integration/proxy-network.sh`. T22 adds a line to the proxy's
    allowlist, and removes it again.
  - `vscode-forwarding.sh` needs a desktop VS Code attached to a running sandbox. No workflow runs it;
    run it by hand with `VSCODE_SANDBOX=NAME` (see its header).

## Pull requests

- Work on a branch from `main`, and open a pull request.
- CI (`.github/workflows/ci.yml`) runs the unit tests on Node 20.12, 22 and 24, and checks the
  `npm pack` tarball.
- The `podman` workflow runs the integration tests when templates, integration tests or the code
  behind `new`, `enter` and `exec` change.
- Releases are tagged `vX.Y.Z` on `main` after the merge. The tag must match `version` in
  `package.json`.
- The PR that sets a new `version` adds its section to `CHANGELOG.md`, headed
  `## X.Y.Z (Unreleased)`, with the date filled in once it's released. Write it for users: what they
  can do now, or what got safer, and what to do about sandboxes made earlier. CI refuses a version
  without a section, and the release's notes are that section, followed by the merged PRs.
