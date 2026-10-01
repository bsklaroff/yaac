# Remote hosting: yaac on an always-on server

One developer, one always-on machine running the whole stack, and thin
clients that reach it over a private [Tailscale](https://tailscale.com)
tailnet. Workspaces keep running when every client disconnects.

```
SERVER MACHINE (on the tailnet)
  containerless: host process on 127.0.0.1:8787, fronted by `tailscale serve`
  k8s:           server pod, fronted by the Tailscale operator's Ingress

LAPTOP (on the tailnet, logged in as a tailnet user)
  yaac CLI          ── RPC + terminal WebSockets ─► server
  browser           ── https://srv.<tailnet>.ts.net
  yaac auth server  ── outbound WS ─► server  (runs tool sign-ins locally)

PHONE: browser only. Full webapp, but no tool sign-in (that needs the CLI).
```

No client holds a credential. The server works out who is calling from the
request (see "Security model"): a request to the machine's own loopback is
**local**, and a request through `tailscale serve` is from the **tailnet
user** serve names. Nothing in the CLI or webapp assumes the server is on the
same machine.

## Server setup

A **containerless** server is a host process behind the machine's own
`tailscale serve`:

```sh
yaac server start
tailscale up
tailscale serve --bg https / http://127.0.0.1:8787   # `serve`, never `funnel`
export YAAC_ALLOWED_HOSTS=srv.<tailnet>.ts.net       # admit the tailnet name
yaac server restart
```

`YAAC_ALLOWED_HOSTS` must be in the server process's environment, so put it
in a systemd unit or shell profile (a detached restart does not inherit an
interactive `export`). Setting it turns on remote access, and every request
to that name must then come through `serve`.

A **k8s** server is published by the Tailscale Kubernetes operator, and
install sets the allowed host itself:

```sh
yaac cluster install --tailnet && yaac cluster check      # this machine's kind cluster
yaac cluster install --byo --rwx-storage-class <nfs-class> \
  && yaac cluster check                                   # a cluster you bring
```

`--tailnet` publishes the server through a `tailscale`-class Ingress
(docs/server-in-cluster.md "Reachability"), sets `YAAC_ALLOWED_HOSTS` on the
Deployment, and registers `https://yaac.<tailnet>.ts.net` as the server's
origin. On kind this replaces `127.0.0.1`, so every client, including this
machine's CLI, uses the tailnet name and must be logged in as a tailnet
user (install warns when it is not). `--byo` (docs/cluster-setup.md "Bring
your own cluster") always uses this fronting, since a cloud cluster has no
loopback to publish on.

The operator's Ingress proxy is the same code as `tailscale serve`: it
terminates TLS and stamps the caller's identity the same way. Install the
operator once, with HTTPS certificates enabled for the tailnet; install
refuses, printing this command, until it is present:

```sh
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --namespace=tailscale --create-namespace \
  --set-string oauth.clientId=… --set-string oauth.clientSecret=…
```

**Decide who on the tailnet may use it.** Anyone whose device can reach the
server's device (or the operator's Ingress device) has full access. On a
tailnet that is yours alone, there is nothing to do. On a shared one, add an
ACL grant that lets only the intended users reach that device (or its tag)
on port 443. That grant is the whole access list.

**Optional: reach forwarded dev-server ports from other tailnet devices.**
The server offers port mappings but binds no ports itself
(docs/port-forward-tunnel.md). Run a forwarder on the server machine and
tell the webapp which address it binds:

```sh
export YAAC_FORWARD_BIND=<the server's tailnet IP>   # from `tailscale ip -4`
yaac server restart                                  # containerless
yaac cluster install                                 # k8s: install copies it into the Deployment
yaac forward --bind <the server's tailnet IP>        # holds the listeners
```

A forwarded port `19500` is then `http://srv.<tailnet>.ts.net:19500/` from
any tailnet device, and the webapp's port chips link there. Any tailnet
device can reach it (it bypasses `serve`, so no identity check applies), and
it works only while `yaac forward` runs, so give that a systemd unit too.

Alternatively, a client holds the listeners and gets its own
`localhost:19500`: `yaac forward` on a laptop tunnels over the same
identified WebSocket, so only the server's HTTPS port needs to be reachable.
The desktop app does this automatically once attached to the remote, and its
preview pane uses it.

## Client setup

```sh
yaac remote set https://srv.<tailnet>.ts.net   # prints who the server says you are
yaac workspace list                             # talks to the server
```

`yaac remote off` deselects the remote without forgetting it, `yaac remote
on` selects it again, and `yaac remote status` shows the configuration.
With nothing selected, a client reaches no server, not even one on the same
machine (docs/server-selection.md).

The device must be logged in to the tailnet as a user. A **tagged** device
(enrolled under an ACL tag rather than a person) has no user, so `serve`
adds no identity and the server refuses its requests, as it does Funnel
traffic. `yaac remote set` reports this.

On a phone, just open the server's origin. To revoke a lost device, remove
it from the tailnet in the Tailscale admin console; nothing on the server
changes.

## What works remotely

Everything goes through the server, so the CLI and webapp behave the same
against a local or remote server:

- **Workspaces**: create, list, attach, shell, restart, stop. The terminal
  uses the server's PTY WebSocket (`C-b d` detaches).
- **Config editing**: `yaac config edit` and its siblings fetch the file
  from the server, open your local `$EDITOR`, and save back through the
  server's validation.
- **Tool credentials**: `yaac auth update` runs the Claude/Codex browser
  sign-in on your machine through the auth server (a local helper that runs
  the vendors' login CLIs and starts automatically), then sends the result
  to the server. The webapp's sign-in cards use the same flow.
- **Git credentials**: managed in the webapp and assigned per project. An
  SSH key is generated and stored encrypted by the server; you register its
  public half with the git host (docs/git-credentials.md).
- **Project environment and secrets**: edited in the webapp (Settings →
  Project Config → Environment) and stored with the project, secrets
  encrypted at rest. Under `k8s` a secret's value never enters a workspace;
  the egress proxy injects it in flight.

Things to keep in mind:

- **Nothing you configure names a path on the server.** Nothing mounts a
  host directory into a workspace; use `cacheVolumes` for a directory that
  should persist across workspaces.
- **The git identity workspaces commit under is a server setting.** The auth
  server seeds it from your machine's git config when it starts and the
  server has none. The auth server starts with the desktop app, `yaac auth
  server start`, and the browser sign-in of `yaac auth update`, but not with
  `yaac server start`, `yaac cluster install` or an API-key login. A
  CLI-only user sets it with `yaac config git-identity --name <name> --email
  <email>` (or Settings → General). Until then, workspace create is refused
  with that instruction.
- **Workspaces run in your time zone, not the server's.** The web app, the
  auth server and `yaac workspace create` report the device's zone, and
  workspaces launch with it as `TZ`. With devices in several zones the last
  report wins, unless a zone is pinned in Settings → General.
- **Machine-scoped commands** act on the machine they run on and ignore the
  remote setting: `yaac server *`, `yaac cluster *`, and `yaac auth server
  *`.
- **A phone alone cannot sign in to tools**, since that needs the auth
  server and so the CLI. Set credentials up from a laptop once.
- A client/server version mismatch prints a one-time warning (the server
  reports its build id on every response). Upgrade whichever side is behind.

## Security model

- **The tailnet is the trust boundary.** Only enrolled devices can reach the
  `*.ts.net` name. WireGuard encrypts the traffic and `serve` adds TLS.
  Never use `tailscale funnel`. The tailnet's ACLs decide who may reach the
  server, and everyone who can has full access.
- **The caller's identity comes from the request** (`identify()` in
  `api/http/web-auth.ts`), checked after the Host, Origin and Sec-Fetch-Site
  guards:

  | The request | Is treated as |
  |---|---|
  | came through serve (has `X-Forwarded-For` or a `Tailscale-User-Login`/`-Name` header) and has `Tailscale-User-Login` | that tailnet user |
  | came through serve, but has no `Tailscale-User-Login` | refused (a tagged device, or Funnel) |
  | did not come through serve, and has a loopback `Host` | local |
  | did not come through serve, and has any other `Host` | refused, or local inside a workspace (below) |

  Every route a client calls, HTTP and WebSocket, is under `/api` (docs
  name routes relative to it: `GET /whoami` means `/api/whoami`); the rest
  is the SPA. `/api/health`, `/` and `/assets/*` need no identity, so an
  unidentified browser can still load the app and be told why it was
  refused. `GET /whoami` returns what the server decided, and the request
  log names the tailnet user on every line.
- **There is no "this server is fronted" switch to forget.** A non-loopback
  name is admitted only if listed in `YAAC_ALLOWED_HOSTS`, and every request
  to such a name must carry serve's identity headers. Any other front (an
  nginx that sets no identity, a plain TCP exposure, Funnel) is refused.
- **The only ways to reach the server are loopback and `serve`.** A request
  that did not come through serve and names a loopback Host is treated as
  the owner, so no other path may exist. A host server refuses to start with
  a non-loopback `YAAC_BIND_ADDR`. For the in-cluster server, the ingress
  NetworkPolicies do this job, which makes them part of authentication
  (docs/server-in-cluster.md "The ingress policy is the wall").

  A local process can forge any of these headers and gains nothing: it
  already owns the data dir. For the same reason, a machine shared with
  other OS users is not a supported shared setup, since they would count as
  local too. Serve it over the tailnet instead. A server started with
  `YAAC_REQUIRE_AUTH` set refuses to start and says so.
- **A browser sends its identity with every request**, at loopback and over
  the tailnet. Three guards protect it from malicious sites, on every
  request including WebSocket upgrades. The browser sets these headers and
  page JavaScript cannot forge them:
  - `Host` must be loopback or an allowed name (stops DNS rebinding).
  - `Origin` must exactly match the origin the request was sent to: scheme,
    host and port.
  - `Sec-Fetch-Site` must not be `cross-site`.

  The port check matters because some pages share the server's hostname
  and run untrusted repo code: a workspace's forwarded dev server (at
  `127.0.0.1:<port>` or `srv.<tailnet>.ts.net:19500`) and the desktop
  preview pane. Refusing `OPTIONS` stops a cross-origin page from adding a
  custom header such as a forged `Tailscale-User-Login` or
  `X-Forwarded-Proto`, since that needs a CORS preflight.
- **A yaac server inside a workspace (`YAAC_WORKSPACE_ID` set) treats any
  request that did not come through serve as local, whatever its Host.** It
  inherits the outer install's `YAAC_ALLOWED_HOSTS` and is reached as
  `srv.<tailnet>.ts.net:<port>` through the outer install's port forward, a
  path the strict rule would refuse. Requests through serve are still
  identified, and still refused without a user.
- Tool credentials travel only over the identified API (`PUT /auth/:tool`),
  never through the stream relay or the browser.

### What `tailscale serve` does

The rules above rely on this behavior, observed with tailscale 1.102 (and
the operator's `tailscale`-class Ingress proxy, operator 1.102) from both
user-owned and tagged devices, on plain requests and WebSocket upgrades:

- From a user-owned device it sets `Tailscale-User-Login` (e.g. an email
  address), `Tailscale-User-Name` (the display name) and
  `Tailscale-User-Profile-Pic`, replacing any client-supplied copies. From a
  tagged device it strips them and adds nothing.
- It sets `X-Forwarded-For` to the device's tailnet address on every
  request, replacing any client value, and `X-Forwarded-Proto: https`. The
  Origin guard reads the latter as the browser's scheme; without it, every
  browser write and WebSocket over the tailnet would be refused.
- It keeps the client's `Host`. A forged `Host: 127.0.0.1` arrives as sent,
  but with the forwarding headers beside it, so the server treats it as
  proxied, never local.
- A device's request to its own ts.net name also goes through serve.

The server decodes RFC 2047 encoded words (`=?utf-8?q?…?=`), the form a
non-ASCII display name takes in a header.

## Not yet covered

- **Surviving a reboot** (a systemd unit for the server, restarting the
  cluster on boot). For now, after a reboot run `yaac server start`
  (containerless) or `yaac cluster install` (k8s).
- **Per-user access**: every identified user has full access
  (docs/plans/multi-user-deployment.md).
- **Tagged devices as callers**: resolving a tagged device's address through
  the tailscaled socket (`whois`) would let the server admit it.
