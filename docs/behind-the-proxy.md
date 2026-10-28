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
network name `proxy`. It runs as a container, never as a VM: `sandbox enter --vm proxy` refuses, since
a VM wouldn't start the proxy, and its clients would lose their way out
([why](microvm.md#why-the-proxy-cant-run-as-a-vm)). The clients can run as VMs.

The decrypted-traffic log keeps request and response bodies, never headers. The credentials and
identity that Claude Code's own endpoints carry in their bodies (OAuth tokens, account and
organisation ids, the email address) are logged as `[REDACTED]`; agent-mitm-proxy's README lists
each one. What the agent sends as content, such as a key pasted into a prompt, is logged as it is,
so the log is still sensitive. A proxy made before 0.8.1 builds agent-mitm-proxy 1.1.0, without the
redaction; one made before 0.8.2 builds 1.2.0, without the credential vault (step 4); one made before
0.8.3 builds 1.3.0, without the credentials fetch (step 4) and client names (step 5). To bring it
up to date and keep its CA (in `proxy-home`), recreate it under the same name: `sandbox rm proxy`,
move `~/sandboxes/proxy` aside (copy its `allowlist.txt` back if you changed it),
`sandbox new proxy --template mitm-proxy`.

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

## 4. Keep Claude Code's tokens out of the sandbox

Claude Code keeps its OAuth tokens in `~/.claude/.credentials.json`, in the sandbox's home volume,
where the agent and anything it runs can read them: enough to use your account from anywhere, for
weeks. With **phantom tokens**, the sandbox holds only stand-ins: tokens that look like Claude
Code's, but that only the proxy can turn into the real ones. The real tokens stay in the proxy's
**credential vault**. A proxy made since 0.9.0 does this by default; one made earlier needed
`--option credentialVault=1`. To keep the real tokens in the sandboxes instead, make the proxy with
`--option credentialVault=0`.

Nothing changes in the client sandboxes: Claude Code signs in as usual (`/login`), but stores
phantom tokens (`agent-mitm-proxy-oat-…`/`agent-mitm-proxy-ort-…`), and the proxy swaps them for
the real tokens on the way to Anthropic (only to Anthropic's own hosts). Anywhere else, a phantom
token is worthless. A client that signed in before is taken over at its next refresh. The agent can
still *use* your account through the proxy, as before; it just can't take a credential with it.

The name is borrowed from the [phantom token
pattern](https://curity.io/resources/learn/phantom-token-pattern) of OAuth gateways, and other
agent sandboxes use it for the same idea.

**Only one sign-in.** Once one client has signed in, the next ones don't need to: a `proxy-client`
made since 0.8.3 fetches its credentials file (the phantom tokens) from the proxy when its container
is made, and Claude Code starts signed in. In a client made earlier, or after deleting the file,
run `proxy-credentials fetch` (`--force` replaces a file that's there). Without a sign-in in the
vault yet, it says so, and you sign in once with `/login`.

The real tokens are in the proxy's home volume (`~/proxy-data/credential-vault.json`, private), and
`~/proxy-data/vault.jsonl` logs what the vault did, without token values. The vault follows
Claude Code's sign-in, which Anthropic doesn't document: if that changes, the symptom is a 401 in
Claude Code; recreate the proxy with `credentialVault=0` meanwhile. agent-mitm-proxy's README has
the details. A proxy made before 0.9.0 without the option gets the vault by being recreated, as in
step 1 (its CA stays).

## 5. A name and token per client

Without it, any sandbox on `agent-proxy-net` can use the proxy, and, with the vault, fetch the
phantom tokens and use your account through it: fine for one person whose sandboxes all may. To tell
them apart, make the proxy and each client with `clientAuth=1`:

```sh
sandbox new proxy --template mitm-proxy --option clientAuth=1
sandbox new your-project --template proxy-client --option clientAuth=1 --workspace ~/development/your-project
```

- **Enrolling is automatic.** The first time the client starts (`sandbox enter`), it asks the
  proxy for a name and token of its own (`vault enroll NAME` in the proxy; the name is the
  sandbox's) and keeps them in its proxy URL, `http://NAME:TOKEN@proxy:8899`, in `proxy.env` in
  the sandbox folder (mode 0600). The proxy must be running then. The client is also granted the
  vault's sign-in, so it starts signed in.
- **Anything else gets 407**, including clients made without the option, or before 0.8.3: make
  recreate them with it (`sandbox rm NAME`, move the folder aside, `sandbox new … --option clientAuth=1`).
- **In the proxy:** `sandbox exec proxy vault clients` lists the enrolled names; `vault unenroll
  NAME` ends a client's token at once, open connections too; `vault grant NAME` gives it the
  sign-in; `vault entries` lists the sign-ins, without tokens.
- The token is a credential for the proxy, and the sandbox can read it in its own environment: an
  agent can use the proxy as that sandbox, as before, but not as another one, and nothing else on
  the network can use it at all.

## 6. Approve hosts from your phone

With step 3, a refused host waits until you run `approve` or edit the allowlist. With the proxy's
**gatekeeper**, the agent asks while it works: it calls `request_allowlist` with the host and why,
you get a DM on Buzz, and your 👍 adds the host (👎 refuses it). The agent sees
the answer with `get_request_status`, and carries on.

The gatekeeper is an identity of its own on your Buzz relay: a key that you attest with yours
(NIP-OA), so the relay admits it as your agent. Set it up once, in the proxy:

```sh
sandbox exec proxy gatekeeper init --relay wss://NAME.communities.buzz.xyz   # prints its npub
# on your own machine, with your own key: an attestation of that npub (NIP-OA, e.g. 90 days)
sandbox exec proxy gatekeeper attest < auth-tag.json
sandbox exec proxy gatekeeper dm DM_ID       # your DM with the npub, opened in the Buzz app
sandbox exec proxy /opt/agent-mitm-proxy/scripts/start-gatekeeper.sh
sandbox exec proxy gatekeeper status
```

- **The key is made in the proxy and stays there** (`~/proxy-data/gatekeeper/`, private); only its
  npub is printed. To keep an identity you already have: `gatekeeper import-key --relay URL <
  key-file`, instead of `init`.
- **Only your reactions count:** `attest` takes your pubkey from the attestation, and a reaction
  must carry your signature. Someone with the gatekeeper's key could send DMs as it, but couldn't
  approve anything.
- **It starts with the proxy** from then on. `status` says whether it runs, and warns two weeks
  before the attestation expires: attest again then.
- **Sandboxes:** a `proxy-client` made while the gatekeeper runs gets it as Claude Code's MCP server
  `allowlist`, and its `CLAUDE.md` tells the agent to ask with it. In one made before the gatekeeper
  ran, run `proxy-gatekeeper connect` in it, and restart Claude Code; one made before 0.9.0 has
  neither: recreate it.
- **Any sandbox on `agent-proxy-net` can ask,** with or without `clientAuth`, and the DM doesn't say
  which one asked. Asking is all it can do: the limits are three open requests and ten an hour, and
  never IP addresses or private ones.

A proxy made before 0.9.0 builds agent-mitm-proxy 1.4.0, without the `gatekeeper` command; recreate
it as in step 1.
