# Remote hosting: yaac on an always-on server

One developer, an always-on server, thin clients. The server runs the whole
stack — cluster, podman, server — so worktrees keep running when every client
disconnects. The laptop and phone talk to it over a private
[Tailscale](https://tailscale.com) tailnet.

```
SERVER (on the tailnet)
  kind cluster ← kubectl ← yaac server (127.0.0.1:8787 — bind unchanged)
  tailscale serve https → 127.0.0.1:8787   (TLS, tailnet-only, never Funnel)

USER MACHINE (laptop, also on the tailnet)
  yaac CLI  ── RPC + terminal WebSockets (durable token) ─►  server
  browser   ── https://srv.<tailnet>.ts.net (session cookie)
  yaac auth server ── outbound WS ─► server   (runs Claude/Codex sign-ins
                                               locally, ships the bundle back)

PHONE — browser only: full webapp, but no tool sign-in (needs the CLI).
```

The local case is the same topology with `baseUrl` pointing at
`127.0.0.1` — nothing in the CLI or webapp assumes the server is on the
same machine.

## Server setup

```sh
# 1. Install yaac + the cluster (see README "Install"), then:
yaac cluster install && yaac cluster check
yaac server start

# 2. Join the tailnet and serve the server over TLS — tailnet-only
#    (`serve`, never `funnel`):
tailscale up
tailscale serve --bg https / http://127.0.0.1:8787

# 3. Tell the server to admit its tailnet hostname and trust the proxy's
#    TLS signal (put these in the server's environment permanently, e.g.
#    a systemd unit or shell profile, then restart it):
export YAAC_ALLOWED_HOSTS=srv.<tailnet>.ts.net
export YAAC_TRUST_PROXY=1
yaac server restart

# 4. Mint a durable token for each client device (printed exactly once):
yaac auth token create laptop
```

Optional — make forwarded dev-server ports reachable from other tailnet
devices (they bind the server's loopback by default):

```sh
export YAAC_FORWARD_BIND=<the server's tailnet IP>   # from `tailscale ip -4`
```

With that set, a worktree's forwarded port `19500` is
`http://srv.<tailnet>.ts.net:19500/` from any tailnet device, and the
webapp's port chips link there automatically. Two caveats: the port is
reachable by any tailnet device (not yaac-token-gated), and it is no longer
reachable from the server's own loopback.

## Client setup

```sh
yaac remote set https://srv.<tailnet>.ts.net --token <token-from-step-4>
yaac worktree list                   # talks to the server
yaac open                            # prints/opens an authed webapp URL
```

`yaac remote off` switches back to a local server without forgetting the
token; `yaac remote status` shows what is configured. A revoked or rotated
token (`yaac auth token revoke laptop` on the server) fails with
instructions to re-run `yaac remote set`.

On the phone: run `yaac open` on the laptop and open the printed
`https://…/?token=<token>` URL there (the token is single-use; mint a
fresh one any time with another `yaac open`).

## What works remotely

Everything goes through the server, so the CLI and webapp behave the same
against a local or remote server:

- Worktrees: create, list, attach, shell, stream, restart, delete — the
  terminal rides the server's PTY WebSocket (`C-b d` detaches, exactly like
  a local attach).
- Config editing: `yaac config edit*` fetches the file from the server,
  opens your local `$EDITOR`, and saves back through the server's
  validation.
- Credentials: `yaac auth update` runs Claude/Codex browser sign-ins **on
  your machine** (via the auto-started auth server — the broker that owns
  the vendor login CLIs) and ships the captured bundle to the server. The
  webapp's sign-in cards drive the same flow; if no auth server is running
  they say what to start.

Semantics to keep in mind:

- **Paths are server-host paths.** A project's `bindMounts` host paths
  and the SSH credential's private-key path refer to the server's
  filesystem.
- **Machine-scoped commands** operate wherever they run and ignore the
  remote setting: `yaac server *`, `yaac cluster *`,
  `yaac auth server *` (the auth server is by design the local machine's
  broker).
- **Phone-only clients can't mint tool credentials** — sign-in needs the
  auth server, which needs the CLI. Set credentials up from a laptop once;
  everything else works from the phone.
- A version mismatch between client and server prints a one-time warning
  (the server reports its build id on every response); upgrade whichever
  side is behind.

## Security model

- **Trust boundary = the tailnet.** Only enrolled devices can reach the
  `*.ts.net` name; WireGuard encrypts the wire and Serve adds real TLS
  (so the session cookie is `Secure`). Never use `tailscale funnel`.
- **Remote access is opt-in.** Without `YAAC_ALLOWED_HOSTS` /
  `YAAC_TRUST_PROXY` and a `tailscale serve`, the server binds loopback only
  and no client credential is required (see below).
- **A loopback-only server requires no credential.** When neither
  `YAAC_ALLOWED_HOSTS` nor `YAAC_TRUST_PROXY` is set, the deployment is
  local-only and the bearer/cookie check is skipped — a browser or CLI on the
  same machine talks to it with no token, which is what makes local testing
  frictionless. What still defends it against a malicious website you visit is
  three browser-enforced, JS-unforgeable guards on every request *including*
  WebSocket upgrades: the `Host` header must be loopback (DNS-rebind defense),
  and the `Origin` host and `Sec-Fetch-Site` must not be cross-site (CSRF /
  resource-isolation defense — the cookie is no longer carrying that load).
  A local *process* is trusted (it can already reach loopback). Set
  `YAAC_REQUIRE_AUTH=1` to force the credential back on — for a shared machine,
  or to exercise the auth path. Configuring remote hosting (either var above)
  re-enables the credential automatically.
- **A yaac running inside a worktree (`YAAC_WORKTREE_ID`) also skips the
  credential**, even when it picks up the outer install's
  `YAAC_ALLOWED_HOSTS` / `YAAC_TRUST_PROXY` through the project's
  `envPassthrough`. Those are ambient env, not a remote-fronting of the inner
  server — nothing outside the machine addresses it unmediated. Under `k8s`
  that is literal: the inner server is reachable only through the outer
  server's port-forward, already tailnet-gated like any forwarded port (and
  never token-gated). Under `containerless` the worktree is a host process and the
  inner server binds the host's own loopback, so any local process or user can
  reach it; the conclusion holds for the reason the bullet above gives — a
  local process is already trusted, and an unsandboxed worktree agent can read
  the outer install's data dir regardless, so the token never defended against
  it. The worktree id is what marks this, and `createWorktree` stamps it on
  every worktree under both drivers.
  `YAAC_REQUIRE_AUTH=1` forces it on if you want the inner server
  independently gated.
- **Beware a fronted server started from inside a worktree.** Because the
  signal is the mere presence of `YAAC_WORKTREE_ID`, a server you deliberately
  front by this doc's own setup silently drops the token gate if you start it
  from a shell inside a worktree — and a yaac-dev worktree is exactly that
  shell. The tailnet boundary and the three browser guards still hold, so this
  is not an open door, but per-device token revocation no longer applies to it.
  Set `YAAC_REQUIRE_AUTH=1` on any server you front deliberately.
- **Tokens are durable and revocable** per device: a lost laptop is
  `yaac auth token revoke laptop` on the server — no restart, no effect on
  other clients or browser worktrees. Browser worktrees are tokens too
  (`kind: web` in `yaac auth token list`), so a leaked cookie is revoked
  the same way.
- Credentials always travel over the authenticated RPC channel (`PUT
  /auth/:tool`), never through the relay socket or the browser.

## Not yet covered

- **Reboot durability** (systemd unit for the server, cluster restart on
  boot) — run `yaac cluster install && yaac server start` after a
  server reboot for now.
- `yaac port-forward`-style tunnels that preserve `localhost:<port>` on the
  client.
- Multi-user access.
