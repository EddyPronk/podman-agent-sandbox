# Your project behind the egress proxy

A `claude` sandbox can reach the whole Internet, your LAN and services on your machine. Behind the
egress proxy, the agent reaches only the hosts you allow, and every request is logged. This page
picks up where [A sandbox around an existing project](sandbox-around-an-existing-project.md) ends,
with `proxy-client` in place of `claude`.

## 1. Start the proxy

One proxy serves every client sandbox on the machine. Make it once:

```sh
sandbox new proxy --template mitm-proxy
sandbox enter proxy          # builds and starts it; exit again, it keeps running
```

It publishes its CA certificate for the clients, which trust it, so it can see inside HTTPS requests
and check them against its allowlist. Its private data (CA keys, the decrypted-traffic log, the
refusals) stays in its home volume, `proxy-home`. Only one proxy can run at a time: it takes the
network name `proxy`.

## 2. Your project behind it

```sh
sandbox new your-project --template proxy-client --workspace ~/development/your-project
sandbox enter your-project
claude
```

This is the same sandbox as with `claude`, except for the network: only the proxy's internal one,
with no route out. All HTTP(S) goes through `http://proxy:8899`. `sandbox inspect your-project`
shows `network  agent-proxy-net (internal: no route out)`.

## 3. The allowlist

A new proxy allows only what Claude Code needs: its API, sign-in, downloads and the MCP proxy.
Anything else is refused with `403 Forbidden`. A client that keeps retrying a refused host (npm does,
hundreds of times a second) gets its connections reset for a while instead, so it gives up, and the
logs record the burst once. To allow more:

- **Approve what was refused:**
  ```sh
  sandbox exec proxy approve               # the last 5 minutes; --since 1h looks further back
  ```
  For each refused host, `y` adds it, and Enter or `n` skips it. It asks only at a terminal, and
  never offers IP addresses or names that resolve to private addresses (such as cloud metadata).
- **Or edit it directly:** `~/sandboxes/proxy/allowlist.txt`, one `host:port` per line. The proxy
  applies changes without a restart.

`sandbox help proxy` lists these, and where the proxy's logs are.
