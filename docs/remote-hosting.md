# Remote hosting: yaac on an always-on server

One always-on machine running the whole stack, and thin clients that
reach it over a private [Tailscale](https://tailscale.com) tailnet.
Workspaces keep running when every client disconnects. Several teammates
can share the machine, each as their own user (docs/multi-user.md).

```
SERVER MACHINE (on the tailnet)
  containerless: host process on 127.0.0.1:8787, fronted by `tailscale serve`
  k8s on kind:   server pod published at 127.0.0.1:8787, fronted by `tailscale serve`,
                 or by the Tailscale operator's Ingress
  k8s --byo:     server pod, fronted by the Tailscale operator's Ingress

LAPTOP (on the tailnet, logged in as a tailnet user)
  yaac CLI          ── RPC + terminal WebSockets ─► server
  browser           ── https://srv.<tailnet>.ts.net
  desktop app       ── the webapp, plus its auth daemon's outbound WS ─► server
                       (runs the webapp's tool sign-ins locally)

PHONE: browser only. Full webapp, but no tool sign-in (that needs a laptop).
```

No client holds a credential. The server works out who is calling from the
request (see "Security model"): in a `tailnet` install every request comes
through `tailscale serve`, from the **tailnet user** serve names. Nothing in
the CLI or webapp assumes the server is on the same machine.

## Access modes

An install runs in exactly one access mode. The mode is recorded in the
install's database and checked on every start, so a forgotten flag or env
var cannot change who the server admits.

| Mode | Admits | Users |
|---|---|---|
| `local` | loopback only; anything through `serve` is refused | one built-in user with no login, owning everything |
| `tailnet` | only `serve` with a tailnet identity; plain loopback is refused | a user per tailnet login, created on first sight |

- **A fresh install** takes the mode of the command that first starts it:
  `yaac server start` and `yaac cluster install` give `local`; `yaac server
  start --tailnet <host>` and `yaac cluster install --tailnet [<host>]` (or
  `--byo`) give `tailnet`. An install upgraded from before access modes counts as
  `local` if it holds any data.
- **Every later start must ask for the recorded mode.** `yaac server start`
  and `restart` take the same `--tailnet <host>` each time. A start asking
  for another mode is refused with the command that fixes it, and a refusing
  server stops (host) or keeps answering `/health` with the reason, which
  `yaac cluster install` prints (k8s).
- **`local` → `tailnet` is one-way and needs `--owner <login>`** on that
  start. It gives the built-in user that tailnet login, so the owner keeps
  every project, credential and setting the install had. A fresh `tailnet`
  install has nothing to claim and needs no `--owner`; once an install is
  `tailnet`, `--owner` is ignored.
- **`tailnet` → `local` is refused.**
- **A yaac server nested in a workspace is always `local`**: it is reached
  through its outer workspace's forward, which only that workspace's owner
  can open. `--tailnet` there is refused.
- **One loopback exception in `tailnet` mode**: a containerless workspace's
  `yaac-mama` posts `/workspace/mama` over loopback with the workspace's
  bearer token, which that route checks. (Under k8s it arrives on the egress
  proxy's own relay listener.)

`GET /whoami` returns the caller, with its user id, and the install's users.

## Server setup

A **containerless** server is a host process behind the machine's own
`tailscale serve`:

```sh
tailscale up
tailscale serve --bg http://127.0.0.1:8787            # `serve`, never `funnel`
yaac server start --tailnet srv.<tailnet>.ts.net       # a fresh install
yaac server restart --tailnet srv.<tailnet>.ts.net \
  --owner you@example.com                              # a local install with data
```

`tailscale serve --bg <target>` serves `https://<this machine's MagicDNS
name>/` on port 443. Changing serve needs root, or a one-time `sudo
tailscale set --operator=$USER`. `--tailnet` names that MagicDNS name. The
server admits that name, and `yaac server start` registers its `https://`
origin as this machine's server, so the CLI here goes through `serve` too
and must run as a tailnet user. Give every later `yaac server start` and
`restart` the same `--tailnet` (in a systemd unit, say).

A **kind** server can be published the same way, by the machine's own
`tailscale serve` in front of the port kind publishes it on:

```sh
tailscale serve --bg http://127.0.0.1:8787            # the kind install's port
yaac cluster install --tailnet srv.<tailnet>.ts.net \
  --owner you@example.com                              # --owner for a local install with data
```

Install runs the server in `tailnet` mode admitting that name, waits for
`https://srv.<tailnet>.ts.net` to answer, and registers it, so every client,
this machine's CLI included, goes through serve. It does not configure serve
itself; if the name never answers it prints the `tailscale serve` command
for the cluster's port. Later `yaac server start|restart` read the name back
from the server Deployment, so they need no flag; a later `yaac cluster
install` takes the same `--tailnet <host>`, as every install of a `tailnet`
server must.

A kind or **byo** server can instead be published by the Tailscale
Kubernetes operator, at its own tailnet device:

```sh
TS_OAUTH_CLIENT_ID=… TS_OAUTH_CLIENT_SECRET=… \
  yaac cluster install --tailnet && yaac cluster check   # this machine's kind cluster
yaac cluster install --byo --rwx-storage-class <nfs-class> \
  && yaac cluster check                                  # a cluster you bring
```

`--tailnet` publishes the server through a `tailscale`-class Ingress
(docs/server-in-cluster.md "Reachability"), runs it in `tailnet` mode, and
registers `https://yaac.<tailnet>.ts.net` as the server's origin. Switching
an existing `local` install needs `--owner <login>` as above. On kind this
replaces `127.0.0.1`, so every client, including this machine's CLI, uses
the tailnet name and must be logged in as a tailnet user (install warns when
it is not). `--byo` (docs/cluster-setup.md "Bring your own cluster") always
uses this fronting, since a cloud cluster has no loopback to publish on.

The operator's Ingress proxy is the same code as `tailscale serve`: it
terminates TLS and stamps the caller's identity the same way. It needs an
OAuth client with the tags its proxies use
(https://tailscale.com/kb/1236/kubernetes-operator), and HTTPS certificates
enabled for the tailnet. On kind, install sets the operator up itself from
its pinned manifest (`install/tailscale-operator.ts`), given the client in
`TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET`, and converges it on later
runs; an operator it did not put there, or its leftover CRDs and
IngressClass, is left as it is, and install refuses rather than replace it. On a byo cluster
the operator is the cluster owner's: install only checks for it, and
refuses, printing this command, until it is present:

```sh
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --namespace=tailscale --create-namespace \
  --set-string oauth.clientId=… --set-string oauth.clientSecret=…
```

**Decide who on the tailnet may use it.** Anyone whose device can reach the
server's device (or the operator's Ingress device) becomes a user of the
install on their first request. On a tailnet that is yours alone, there is
nothing to do. On a shared one, add an ACL grant that lets only the intended
users reach that device (or its tag) on port 443. That grant is the whole
access list.

**Optional: reach forwarded dev-server ports from other tailnet devices.**
The server offers port mappings but binds no ports itself
(docs/port-forward-tunnel.md). Run a forwarder on the server machine and
tell the webapp which address it binds:

```sh
export YAAC_FORWARD_BIND=<the server's tailnet IP>   # from `tailscale ip -4`
yaac server restart --tailnet srv.<tailnet>.ts.net   # containerless
yaac cluster install --tailnet [<host>]              # k8s: install copies it into the Deployment
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
  sign-in on your machine, then sends the result to the server. The
  webapp's sign-in cards relay the same sign-in to the desktop app's auth
  daemon (a helper inside the app that runs the vendors' login CLIs), so
  they work only while the desktop app runs on the machine with the
  browser. In a plain browser without it, sign in with `yaac auth update`
  or paste a token.
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
- **The git identity workspaces commit under is a per-user setting on the
  server.** The desktop app and the browser sign-in of `yaac auth update`
  seed yours from your machine's git config when you have none; `yaac
  server start`, `yaac cluster install` and an API-key login do not. A
  CLI-only user sets it with `yaac config git-identity --name <name> --email
  <email>` (or Settings → General). Until then, workspace create is refused
  with that instruction.
- **Workspaces run in your time zone, not the server's.** The web app, the
  desktop app and `yaac workspace create` report the device's zone, and
  workspaces launch with it as `TZ`. With devices in several zones the last
  report wins, unless a zone is pinned in Settings → General.
- **Machine-scoped commands** act on the machine they run on and ignore the
  remote setting: `yaac server *` and `yaac cluster *`.
- **A phone alone cannot sign in to tools**, since that needs the desktop
  app or the CLI. Set credentials up from a laptop once.
- A client/server version mismatch prints a one-time warning (the server
  reports its build id on every response). Upgrade whichever side is behind.

## Security model

- **The tailnet is the trust boundary.** Only enrolled devices can reach the
  `*.ts.net` name. WireGuard encrypts the traffic and `serve` adds TLS.
  Never use `tailscale funnel`. The tailnet's ACLs decide who may reach the
  server, and everyone who can is a user, who may read every other user's
  data and change only their own (docs/multi-user.md).
- **The caller's identity comes from the request** (`identify()` in
  `api/http/web-auth.ts`), checked after the Host, Origin and Sec-Fetch-Site
  guards, and then held against the access mode:

  | The request | Is treated as |
  |---|---|
  | came through serve (has `X-Forwarded-For` or a `Tailscale-User-Login`/`-Name` header) and has `Tailscale-User-Login` | that tailnet user in `tailnet` mode; refused in `local` mode |
  | came through serve, but has no `Tailscale-User-Login` | refused (a tagged device, or Funnel) |
  | did not come through serve, and has a loopback `Host` | the built-in user in `local` mode; refused in `tailnet` mode, bar `yaac-mama` (see "Access modes") |
  | did not come through serve, and has any other `Host` | refused, or local inside a workspace (below) |

  A tailnet user's row is written on first sight and at most hourly after,
  not on every request.

  Every route a client calls, HTTP and WebSocket, is under `/api` (docs
  name routes relative to it: `GET /whoami` means `/api/whoami`); the rest
  is the SPA. `/api/health`, `/` and `/assets/*` need no identity, so an
  unidentified browser can still load the app and be told why it was
  refused. `GET /whoami` returns what the server decided, and the request
  log names the tailnet user on every line.
- **There is no "this server is fronted" switch to forget.** The access mode
  is recorded, not configured per start. A non-loopback name is admitted
  only if it is the install's tailnet name, and every request to such a name
  must carry serve's identity headers. Any other front (an nginx that sets
  no identity, a plain TCP exposure, Funnel) is refused.
- **The only ways to reach the server are loopback and `serve`.** In a
  `local` install a request that did not come through serve and names a
  loopback Host is treated as the owner, so no other path may exist. A host server refuses to start with
  a non-loopback `YAAC_BIND_ADDR`. For the in-cluster server, the ingress
  NetworkPolicies do this job, which makes them part of authentication
  (docs/server-in-cluster.md "The ingress policy is the wall").

  A local process can forge any of these headers and gains nothing: it
  already owns the data dir. For the same reason, a machine shared with
  other OS users is not a supported shared setup, since they would count as
  local too. Serve it over the tailnet instead.
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
  is always `local`, and may be reached as `srv.<tailnet>.ts.net:<port>`
  through the outer install's port forward (with that name in its
  `YAAC_ALLOWED_HOSTS`), a path the strict rule would refuse. Requests
  through serve are refused.
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
  cluster on boot). For now, after a reboot run `yaac server start` with the
  install's flags (containerless) or `yaac cluster install` (k8s).
- **Tagged devices as callers**: resolving a tagged device's address through
  the tailscaled socket (`whois`) would let the server admit it.
