# Containers inside a sandbox

Some work needs containers: building images, running a project's integration tests, or trying out
sandboxes themselves. The `claude-containers` template is `claude` plus rootless Podman and the
`sandbox` command inside, so the agent can do that itself. It gives up some of the isolation the
other templates have ([How a sandbox is isolated](security-model.md)); what, and why, is below.

```sh
sandbox new myproject --template claude-containers --workspace ~/workspace/myproject --hide .env
sandbox enter myproject
# inside: podman build/run, and sandbox new/enter for sandboxes of its own
```

Inside gets the same `sandbox` version as outside (the release of that version, installed when the
sandbox is made). Containers inside can't get more rights than the sandbox itself has, and the
`mitm-proxy` and `proxy-client` templates work inside as they do outside, on networks of their own.
A `claude-containers` sandbox can be made inside another one, e.g. to test a project that itself
makes sandboxes.

**What it costs.** Rootless Podman inside a rootless container needs four rights the `claude`
template doesn't give:

| Right | Why | What it weakens |
|---|---|---|
| `--device=/dev/net/tun` | `pasta`, the network for rootless containers, builds it with a TUN device | network interfaces in the sandbox's own network namespace; on its own this doesn't reach the host's network |
| `--security-opt=unmask=/proc/*` | a container's new `/proc` can only be mounted where `/proc` isn't partly covered | the sandbox's `/proc` loses Podman's covers; host-wide files (`kcore`, `sysrq-trigger`) still need privileges a rootless container never has, so what opens up is mostly the sandbox's own view |
| its own seccomp profile | containers inside set their own host name | your Podman's default profile, plus `sethostname` and `setdomainname` without `CAP_SYS_ADMIN`; both change only the caller's own UTS namespace |
| no `--cap-drop=all`, no `no-new-privileges` | `newuidmap`/`newgidmap` map the user's subordinate IDs with their file capabilities (`cap_setuid`, `cap_setgid`; the image has them instead of setuid); without these rights inner containers fail with `operation not permitted` | a program with file capabilities or setuid can gain rights up to Podman's default set (still no `CAP_SYS_ADMIN`), inside the sandbox's user namespace |

Kept as with `claude`: `--userns=keep-id` (you, not root), the rest of the seccomp profile.

**Use `claude` unless the agent needs containers.** This template is for your own projects and an
agent you'd let run containers on your machine anyway; not for untrusted code. Its network is as
open as `claude`'s: only *inner* `proxy-client` sandboxes are behind a proxy.

- **The seccomp profile** is written at `sandbox new` into the sandbox's
  `.devcontainer/seccomp.json`, from your Podman's default (`podman info` →
  `SECCOMPProfilePath`). If your Podman has no profile file, a copy of Podman 5.4's default that
  comes with the template is used, with a warning.
- **Host:** `/dev/net/tun` must exist (`ls -l /dev/net/tun`). If you log out and the sandbox stops,
  so does everything inside it: turn on lingering (`loginctl enable-linger`) on machines you use
  over SSH.
- **Disk:** each level keeps its own images and volumes, inside the sandbox's home volume: a
  `claude` sandbox inside is about 1.3 GB more. Clean up inside with `podman image prune` and
  `sandbox rm`.
