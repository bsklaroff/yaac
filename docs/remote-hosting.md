# Remote hosting: yaac on an always-on server

One developer, an always-on server, thin clients. The server runs the whole
stack — cluster, podman, server — so worktrees keep running when every client
disconnects. The laptop and phone talk to it over a private
[Tailscale](https://tailscale.com) tailnet.

```
SERVER (on the tailnet)
  kind cluster ← kubectl ← yaac server (127.0.0.1:8787 — bind unchanged)
  tailscale serve https → 127.0.0.1:8787   (TLS, tailnet-only, never Funnel)

USER MACHINE (laptop, also on the tailnet, logged in as a tailnet user)
  yaac CLI  ── RPC + terminal WebSockets ─►  server   (serve stamps who)
  browser   ── https://srv.<tailnet>.ts.net
  yaac auth server ── outbound WS ─► server   (runs Claude/Codex sign-ins
                                               locally, ships the bundle back)

PHONE — browser only: full webapp, but no tool sign-in (needs the CLI).
```

No client holds a credential. The server asks who is calling, not whether a
credential is valid, and the answer is derived from the request (see
"Security model"): at this machine's loopback the caller is **local**, and
through `tailscale serve` it is the **tailnet user** serve says it is. The
local case is the same topology with `baseUrl` pointing at `127.0.0.1` —
nothing in the CLI or webapp assumes the server is on the same machine.

## Server setup

The two placements get onto the tailnet differently. A **containerless**
server is a host process, fronted by the machine's own `tailscale serve`:

```sh
yaac server start
tailscale up
tailscale serve --bg https / http://127.0.0.1:8787   # tailnet-only: `serve`, never `funnel`
export YAAC_ALLOWED_HOSTS=srv.<tailnet>.ts.net       # admit the tailnet hostname
yaac server restart
```

`YAAC_ALLOWED_HOSTS` is the server process's environment, so it belongs in
a systemd unit or shell profile — a detached restart does not inherit an
interactive `export`. Setting it is what opts a server into remote access,
and remote access is identity-only: every request to that name has to come
through `serve`.

A **k8s** server is published by the Tailscale Kubernetes operator, and
install states the allowed host itself — no `serve`, no export:

```sh
yaac cluster install --tailnet && yaac cluster check                 # this machine's kind cluster
yaac cluster install --byo --rwx-storage-class <nfs-class> \
  && yaac cluster check                                              # a cluster you bring
```

`--tailnet` publishes the server through a `tailscale`-class Ingress
(docs/server-in-cluster.md "Reachability"), sets `YAAC_ALLOWED_HOSTS` on the
Deployment from the name the operator publishes, and registers
`https://yaac.<tailnet>.ts.net`. On kind that origin **replaces**
`127.0.0.1` rather than adding a second one, so every client — this
machine's CLI included — reaches the server the same way. A byo install
(docs/cluster-setup.md "Bring your own cluster") is remote-hosted from the
start: `--byo` implies the same fronting, since a cloud cluster has no
loopback to publish at. The operator's Ingress proxy is `tailscale serve`
running in the cluster: it terminates TLS with the tailnet's certificate
and stamps the caller's identity exactly as a host `serve` does. Install
the operator once (`helm upgrade --install tailscale-operator
tailscale/tailscale-operator --namespace=tailscale --create-namespace
--set-string oauth.clientId=… --set-string oauth.clientSecret=…`), with
HTTPS certificates enabled for the tailnet; install refuses, naming that
command, until it is there. With no loopback path, the machine that ran
install reaches its server through the Ingress like any other device — it
has to be logged in as a tailnet user, and install warns when it is not.

**Decide who on the tailnet may use it.** Anyone whose device can reach the
server's device (or the operator's Ingress device) is a full-access user of
it — the trust boundary is the tailnet. On a tailnet that is yours alone
there is nothing to do. On a shared one, add an ACL grant that lets only
the intended users reach that device (or its tag) on port 443; that grant
is the whole of the access list.

Optional — make forwarded dev-server ports reachable from other tailnet
devices. The server offers the mappings but binds nothing
(docs/port-forward-tunnel.md), so this is two things: a forwarder running
on that machine, and telling the webapp where it binds.

```sh
export YAAC_FORWARD_BIND=<the server's tailnet IP>   # from `tailscale ip -4`
yaac server restart                                  # containerless
yaac cluster install                                 # k8s: the Deployment carries it, from the install shell
yaac forward --bind <the server's tailnet IP>        # holds the listeners
```

With both, a worktree's forwarded port `19500` is
`http://srv.<tailnet>.ts.net:19500/` from any tailnet device, and the
webapp's port chips link there automatically. Two caveats: the port is
reachable by any tailnet device (it does not pass through `serve`, so no
identity gates it), and it is only reachable while `yaac forward` runs —
give it a systemd unit beside the server's.

A client device can hold the listeners instead, and get `localhost:19500`
of its own: `yaac forward` on a laptop pointed at the remote (`yaac remote
set`) tunnels over the same identified WebSocket, so nothing but the
server's HTTPS port has to be reachable. That is also what the desktop app
does automatically once it is attached to the remote, and it is what its
preview pane loads. Both work against either placement: under
`containerless` the ports are bound on the server's machine by the
worktree's own processes, which from a laptop is exactly as far away as a
pod (docs/port-forward-tunnel.md).

## Client setup

```sh
yaac remote set https://srv.<tailnet>.ts.net   # prints who the server says you are
yaac worktree list                             # talks to the server
```

`yaac remote off` deselects it without forgetting it, and `yaac remote on`
selects it again; `yaac remote status` shows what is configured. With
nothing selected a client reaches no server at all — including a server on
this very machine, which is in the same list and selected the same way
(docs/server-selection.md).

The device has to be logged in to the tailnet as a user. A **tagged**
device (one enrolled under an ACL tag rather than a person) carries no user,
so `serve` stamps no identity on its requests and the server refuses them,
saying so — as does `yaac remote set`. Funnel traffic is refused the same
way.

On the phone: open the server's origin. There is nothing to paste.

A lost device is revoked by removing it from the tailnet in the Tailscale
admin console; nothing on the server needs to change.

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
  they say what to start. Git credentials are managed in the webapp and
  assigned per project; an SSH one is a key the SERVER generates and keeps
  encrypted, and you only ever see the public half, which you register with
  the git host (docs/git-credentials.md).
- Project environment and secrets: edited in the webapp, stored with the
  project, secrets encrypted at rest. Under `k8s` a secret's value never
  enters a worktree — the egress proxy injects it in flight.

Semantics to keep in mind:

- **Nothing you configure names a path on the server.** A project's
  environment variables and its proxied secrets are stored with the project
  and edited in the webapp (Settings → Project Config → Environment). An SSH
  git credential is generated on the server, so there is no key on your
  machine for it to name. Nothing mounts a host directory into a worktree;
  `cacheVolumes` covers a directory that should persist across them.
- **The git identity worktrees commit under is a server setting.** The auth
  server seeds it from your own machine's git config when it starts and the
  server has none. It starts under the desktop app, `yaac auth server start`,
  and the browser sign-in of `yaac auth update` for Claude or Codex — not
  under `yaac server start`, `yaac cluster install`, or an api-key login —
  so a CLI-only user sets it with `yaac config git-identity --name <name>
  --email <email>` (or in Settings → General); until then a create is
  refused with that instruction.
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
  `*.ts.net` name; WireGuard encrypts the wire and Serve adds real TLS.
  Never use `tailscale funnel`. Which tailnet users may reach the server is
  the tailnet's ACLs (step 5 above); every user who can is a full-access
  user of it.
- **Who a request is from is derived from the request** (`identify()` in the
  server's http layer), after the Host, Origin and Sec-Fetch-Site guards:

  | The request | Is |
  |---|---|
  | carries `X-Forwarded-For` or a `Tailscale-User-*` header, with `Tailscale-User-Login` | that tailnet user |
  | carries them without `Tailscale-User-Login` | refused: a tagged device or Funnel |
  | carries neither, and names a loopback `Host` | local |
  | carries neither, and names any other `Host` | refused — or local, inside a worktree (below) |

  Every route a client calls, HTTP and WebSocket, is mounted under `/api`
  (docs name them relative to it: `GET /whoami` is `/api/whoami`); the rest
  is the SPA. `/api/health`, `/` and `/assets/*` are exempt, so an
  unidentified browser can still load the app and be told why. `GET
  /whoami` answers what the server decided; the webapp and `yaac remote
  set` show it, and the request log names the tailnet user on every line.
- **It fails closed.** There is no setting that says "this server is
  fronted" to leave off by mistake. A name other than loopback can only be
  admitted by `YAAC_ALLOWED_HOSTS`, and any request to such a name has to
  carry serve's identity — so a front that is not `serve` (an nginx that
  sets no identity, an L4 exposure, Funnel) is refused rather than trusted.
- **Every path onto the bind is loopback or `serve`.** A request that did
  not pass through serve and names a loopback Host is the owner, so no other
  path may exist: a host server refuses to start on a non-loopback
  `YAAC_BIND_ADDR`, and the in-cluster server's ingress NetworkPolicy
  admits only the nodes and the fronting's proxy, with the pods that may
  dial node addresses kept off the kind forwarder's port — which makes
  those policies load-bearing for authentication (docs/server-in-cluster.md
  "The ingress policy is the wall"). A local
  process can forge any of these headers and gains nothing: it is the owner
  already, able to read the data dir and hold the lock. For the same reason
  a host shared with other OS users is not a supported shared deployment —
  they would be local too. Serve it over the tailnet and let each person
  reach it by its ts.net name; a server started with `YAAC_REQUIRE_AUTH`
  set refuses to start and says so.
- **A browser's identity is ambient**, at loopback as over the tailnet: any
  request it makes carries it. What defends it against a malicious website
  is three browser-enforced, JS-unforgeable guards on every request
  *including* WebSocket upgrades: the `Host` must be loopback or allowed
  (DNS-rebind defense), the `Origin` must be exactly the origin the request
  was sent to — scheme, host and port — and `Sec-Fetch-Site` must not be
  cross-site. The port is what keeps out the pages that share the server's
  hostname: a worktree's forwarded dev server at `127.0.0.1:<port>` or
  `srv.<tailnet>.ts.net:19500`, and the desktop preview pane, all run
  untrusted repo code. The `OPTIONS` refusal keeps a cross-origin page from
  adding a custom header such as a forged `Tailscale-User-Login` or
  `X-Forwarded-Proto`, since that needs a preflight.
- **A yaac running inside a worktree (`YAAC_WORKTREE_ID`) takes an unproxied
  request as local whatever Host it names.** It inherits the outer
  install's `YAAC_ALLOWED_HOSTS`, and it is reached as
  `srv.<tailnet>.ts.net:<port>` through the outer install's forward — a
  direct path with no serve on it, which the strict rule would refuse.
  Serve-proxied traffic to it is still identified, and still refused without
  a user. So a server deliberately fronted from a shell inside a worktree
  loses only the fail-closed guard against fronts that are not `serve`.
- Credentials always travel over the identified RPC channel (`PUT
  /auth/:tool`), never through the relay socket or the browser.

### What `tailscale serve` does, which the rule rests on

Observed against tailscale 1.102, from a user-owned device and from a tagged
one, on plain requests and WebSocket upgrades alike:

- From a user-owned device it sets `Tailscale-User-Login` (the login, e.g.
  an email address) and `Tailscale-User-Name` (the display name), plus
  `Tailscale-User-Profile-Pic`. Client-supplied copies are replaced, and
  from a tagged device they are stripped with nothing put back.
- It sets `X-Forwarded-For` to the device's tailnet address on every request
  it proxies, tagged or not, replacing a client-supplied one, and
  `X-Forwarded-Proto: https` for the TLS it terminated — which the Origin
  guard reads as the scheme the browser used, so without it every browser
  mutation and WebSocket over the tailnet would be refused.
- It preserves the client's `Host` — a forged `Host: 127.0.0.1` arrives as
  sent, but with the forwarding headers beside it, so the server judges it
  proxied and never local.
- A node's request to its own ts.net name goes through serve like any
  other.

The server also decodes an RFC 2047 encoded word (`=?utf-8?q?…?=`), the
form a non-ASCII display name would take in a header. The Tailscale
Kubernetes operator's `tailscale`-class Ingress proxy (operator 1.102) is
the same serve code and was observed to behave identically: a user-owned
device is identified, a tagged one is not, and forged identity, forwarding
and `Host` headers are handled as above.

## Not yet covered

- **Reboot durability** (systemd unit for the server, cluster restart on
  boot) — run `yaac cluster install && yaac server start` after a
  server reboot for now.
- Per-user access: every identified user has full access
  (docs/plans/multi-user-deployment.md).
- Tagged devices as callers: resolving a tagged device's address to its
  node through the tailscaled socket (`whois`) would admit it.
