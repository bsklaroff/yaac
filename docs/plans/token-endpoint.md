# Token endpoint: reaching the server without the tailnet

A third listener on the yaac server that admits a caller by bearer token
alone, so a program on a machine that is not on the tailnet (another VM in
the same GCP VPC or Hetzner private network) can use the API over HTTP. A token
acts as the user it is bound to, as a delegate: never as a person, never
with the admin role, and held to what an agent may do through `yaac-mama`.

Delegates are already built (docs/multi-user.md "Authorization"): the
`Delegate` principal, the `delegate` access level, the ceiling, the launch
cap, and `delegateApp`, the API behind a gate that admits only a delegate.
A workspace's `yaac-mama` call is the one kind there is. This plan adds
the second: the token bindings, and the listener that exposes them.

The listener is bound to one address the admin names. There is no default
address and no wildcard bind on any substrate.

## Today

Verified in the code, since the design leans on it:

- **The main listener** (`buildApp` in `main/server.ts`) runs, in order:
  `requestLogger`, the build-id header, `hostHeaderCheck`, `denyBrowserCors`,
  `originHeaderCheck`, `fetchSiteCheck`, `identify(access)`. The WebSocket
  routes are registered on the same app, so an upgrade passes the same
  chain. `identify` reads only headers: a request with no
  `X-Forwarded-For` or `Tailscale-User-*` header and a loopback `Host` is
  the built-in user. Nothing about the socket is consulted, so `identify`
  must never run on a listener reachable from a network.
- **The mama listener** (`buildMamaRelayApp`, started from
  `WorkspaceDriver.mamaRelay`, k8s only) mounts the workspace routes alone,
  with no guard and no `identify`; those routes check the proxy's secret and
  the workspace's own token.
- **`delegateApp(resolve, deps)`** (`main/server.ts`) mounts the API's HTTP
  routes behind `delegateGate`. `resolve` is handed the request and answers
  a `Delegate` or nothing, and nothing is a 401 with `WWW-Authenticate:
  Bearer`. No route is public, `/api/health` included, and it serves no
  WebSocket route and no SPA. Its one caller today is `yaac-mama`'s
  in-process dispatch. A delegate with no `projectId`, which is what a
  token is, skips the gate's scoped-read check and reads what any user
  reads.
- **The admin socket** is a unix socket that checks no caller.
- **Workspaces cannot reach a cloud metadata server.** A workspace pod's
  egress is default-deny bar the proxy. The proxy refuses every non-public
  address (`NON_PUBLIC_V4` in `k8s/proxy/upstream.ts` holds 169.254.0.0/16
  and Azure's 168.63.129.16) unless the project's allowlist has an exact
  entry, and the network floor (`wideEgress`, `NON_PUBLIC_V4` in
  `cluster/policy-manifests.ts`) drops the dial anyway unless an operator's
  own NetworkPolicy opens it. The floor's one link-local allowance is port
  53. Builders and the server sit on the same floor, and IPv6 metadata (ULA)
  is outside it. `yaac cluster check` probes 169.254.169.254 from under the
  server's policy. Two cases remain, and the docs must name them (see
  "Docs"): an operator who opens the metadata server to the proxy, as
  docs/workspace-egress.md shows for GCP, lets every workspace whose
  allowlist names it mint that node's service-account tokens for any
  audience; and a containerless workspace is a host process with no floor at
  all.

## The listener

The token listener serves `delegateApp` with this plan's resolver and
nothing else. The resolver reads `Authorization: Bearer` off the request
and hands the token to `resolveBearer`, which answers the delegate of the
user a binding names, or nothing, which the gate refuses. Where the reason
helps the caller (an expired token, an OIDC token with the wrong subject)
`resolveBearer` throws `UNAUTHENTICATED` with that message instead, as
the gate allows a resolver to. So on this port:

- `Host`, `Tailscale-*` and `X-Forwarded-*` are never read, and a request
  cannot be `local`.
- Every route needs a token, `/api/health` included. There is no SPA.
- It works in both access modes. The mode governs the main listener only.
- It is started once startup has settled, as the relay listener is, so a
  refused start never opens it. A server nested in a workspace
  (`YAAC_WORKSPACE_ID`) refuses `--token-listen`.
- A token is read from the `Authorization` header only, never from a query
  string, and the header is never logged.
- **There are no WebSocket routes.** `delegateApp` is HTTP only, and the
  sockets a delegate could open are `/events` and `/acp/observe`, which no
  CLI command a delegate may run uses. With none, deleting a binding
  refuses its very next request and there is no open socket to close.

**It is a network-facing port, and is hardened as one.** The main listener
never needed this, behind loopback and the tailnet:

- its own `serve()`, with Node's finite header and request timeouts, not
  the main listener's `requestTimeout: 0`;
- a limit on failed authentications per source address, answered with 429,
  and a cap on open connections;
- a refusal is logged with its source address and reason, and nothing
  else of the request.

**TLS ends in the server, and there is no plaintext option.** `serve()`
gets `createServer: https.createServer`. The certificate and key are
`tls.crt` and `tls.key` in one directory, re-read every 30 s and swapped in
with `setSecureContext` when they changed, are whole and match, keeping the
last good pair otherwise: tailgate's rule, in a copy of its own, since
tailgate imports nothing from the server. Until a first pair loads, the
listener is not bound, and the log says what it waits for.

**yaac generates the certificate.** This plan has one kind: self-signed,
for the listen address. A certificate for a DNS name, from an issuer, is
docs/plans/self-hosted-site-edge.md's `--token-name`. The command that
turns the listener on (`yaac server start`, `yaac cluster install`) looks
in the directory, or the Secret behind it:

- **Nothing there:** it generates an ECDSA P-256 key and a self-signed
  certificate naming the listen address as an IP subject alternative name,
  valid for ten years, and stores the pair: a 0600 `token-tls/` directory
  in the data dir's server-local tier on containerless, the
  `yaac-server-token-tls` Secret on k8s.
- **A pair yaac generated** (told by the fixed subject name it gives its
  own): kept. It is reissued on the same key only when the listen address
  changed or it is within 30 days of expiry. It is never regenerated,
  since a new key would break every caller that pinned it. A caller that
  trusts the file rather than the pin needs the reissued file.

The command prints the SHA-256 fingerprint of the certificate's public key
(the form `curl --pinnedpubkey` takes) and where the certificate is, and
`yaac server status` and `yaac cluster status` print them again. The pin is
on the key so that a reissue keeps it. A caller either pins that
fingerprint, or trusts the certificate file as its CA (`curl --cacert`),
which works because the certificate names the address. Node makes the key
but cannot sign a certificate, so one small library is pinned for that in
the `catalog:` (`@peculiar/x509` or `selfsigned`, chosen when it is
built). One function in `@yaac/shared` does the generating for both
commands.

**Configuration** is two variables, read in `packages/shared/src/env.ts`:
`YAAC_TOKEN_LISTEN` (`<addr>:<port>`; unset means no listener) and
`YAAC_TOKEN_TLS_DIR` (the Secret's mount in the pod; the data dir's
`token-tls/` otherwise). The driver contract does not change: unlike the mama
relay, nothing about this listener differs by substrate once the two
variables are set. An address or port that cannot be bound fails the
start; neither is ever changed for the admin.

## Exposure

One setting on every substrate: `--token-listen <addr>:<port>`, on `yaac
server start|restart` and on `yaac cluster install`. There is no default.
`<addr>` is an IP literal that the machine or a node already holds, and
the token endpoint answers at that address and port and nowhere else. One
parser in `@yaac/shared` serves both commands and the server's variable.
It refuses a missing address, a wildcard (`0.0.0.0`, `::`), a hostname and
an interface name: a name can resolve to several addresses, and the point
of the setting is that the admin states the one.

What `<addr>` can be:

| Substrate | `<addr>` | What holds the port |
|---|---|---|
| containerless | an address of an interface on the host: a private (VPC) address, loopback, a tailnet address, a public one | the server process binds it |
| kind | the same, on the machine running kind | podman binds it, as the published port of a forwarder container beside the node |
| byo, Hetzner k3s | an address a node reports (`status.addresses`), normally a node's InternalIP | kube-proxy, on packets addressed to it |

Loopback is useful for tests and an SSH tunnel. A public address is
allowed because it is stated, never implied. On k8s the address is IPv4.

### containerless

`yaac server start|restart --token-listen <addr>:<port>`, given on every
start like `--tailnet`. The CLI checks the address, generates the
certificate if the data dir holds none, and passes the listen variable to
the server it spawns, which binds exactly that address. An address no
interface holds fails the start with the bind error. The refusal of a
non-loopback `YAAC_BIND_ADDR` is unchanged and keeps covering the main
listener.

**On this substrate a token is code execution on the host, from the
network the address is on.** A workspace is a process running as the
server's OS user with real credentials, and a token caller can start one
with a prompt of its choosing. The binding's ceiling decides only whether
that agent asks before it runs a command. Today nothing but loopback and
`tailscale serve` reaches a containerless server, so this is new reach,
not only a missing separation between users. The start prints this, and
the docs say it. Every workspace can also read the key, the database and
any token file (docs/multi-user.md "Trust model").

### k8s: what every backend shares

`yaac cluster install --token-listen <addr>:<port>` is the only switch.
It:

- renders the `yaac-server-token` Service onto `SERVER_TOKEN_PORT` (a
  constant in `proxy-constants.ts`, 8789, beside `SERVER_POD_PORT` and
  `SERVER_MAMA_PORT`), in the backend's shape (below);
- applies a third ingress policy, `yaac-server-ingress-token`, admitting any
  source to `SERVER_TOKEN_PORT` and nothing else, before the Service, as
  the other two are applied. The pod sees a caller's real address, which no
  policy could predict (docs/server-in-cluster.md "On kind: a forwarder"),
  and this port needs no prediction because the token is the wall;
- writes the `yaac-server-token-tls` Secret when the namespace has none
  (see "The listener"), sets the two variables on the Deployment
  (`0.0.0.0:8789` and a mount path) and mounts the Secret there. The
  pod's own bind is the pod network's, where the policy is the wall; the
  address the admin named is enforced one hop out.

**The live cluster is the record.** A later install without the flag keeps
what is there, and `yaac cluster start|restart|status` print it.
`--no-token-listen` deletes the Service and the policy and drops the
variables and the mount.

`yaac cluster check` gains one gate: with the Service present, the Secret
must hold a matching pair that has not expired, and the policy must be
applied and name the token port alone.

### kind

The node is a container that only this machine can reach, so something on
the machine has to hold `<addr>:<port>` and pass connections in. That is a
forwarder container, `yaac-token-front`, which install runs with podman on
the kind network beside the node:

- it publishes `<addr>:<port>` (`podman run -p <addr>:<port>:…`), so podman
  binds exactly the address the admin named;
- it is the Envoy image install already pulls to this machine, with the
  TCP-proxy config the kind fronting uses, pointed at the node;
- inside the cluster the Service is `type: NodePort` with the node port
  left to the API server, which install reads back and gives the
  forwarder. The admin's port is free of the node-port range, and two
  installs on one cluster never ask for the same node port.

The kind node's own port mappings are not used, because kind writes them
only when it creates a cluster. With the forwarder, enabling the endpoint
on an existing install, changing its address and removing it are each one
`yaac cluster install`, and running workspaces are untouched. An address
the machine has lost stops the forwarder and nothing else, where a node
port mapping bound to it would stop the node from starting.

The container is the record of `<addr>:<port>`: install reads it back
with `podman port`, replaces it when the flag or the node port differs,
and starts it again when it is not running, which is also what brings it
back after a reboot. `--no-token-listen` and `yaac cluster delete` remove
it. A taken port or an address the machine lacks is podman's bind error,
which install reports with the `ss -ltnp` line that shows a holder; the
port is never changed.

### byo and Hetzner k3s

The Service is a ClusterIP with `externalIPs: [<addr>]` and `port:
<port>`. kube-proxy then delivers a packet to the server only when it is
addressed to `<addr>:<port>`, on whichever node holds that address; the
node's other addresses, a public one included, do not answer. The Service
is the record, and a changed flag is the Service applied again.

Install refuses, before applying anything:

- an address no node reports, listing the addresses they do;
- an `<addr>:<port>` another Service already names, with that Service
  (`<namespace>/<name>`): the API server does not check external addresses
  for clashes;
- a port a node uses itself (22, 111, 2049, 6443, 10250 and the node-port
  range), because kube-proxy's rule takes a packet before a process
  listening on that address would. Nothing in the cluster can list a
  node's listeners, so the docs tell the admin to pick an unused port.

A cluster that rejects `externalIPs` (the `DenyServiceExternalIPs`
admission plugin) fails the apply; install reports it as that.

On Hetzner the address is the control node's fixed private one
(`local.control_ip`): `--token-listen 10.0.1.2:8443`. The firewall filters
public interfaces only, and the public address does not answer in any
case. `infra/hetzner-k3s` needs no resource change: its README gains the
flag and how a caller on the private network trusts the certificate.

The endpoint depends on the node that holds the address, though not on
where the server pod runs. An address that moves with a load balancer (a
`LoadBalancer` Service and its annotations, as for a GKE internal LB) is
later work, and so is an address routed to the nodes rather than held by
one.

**Why `externalIPs`.** It is one object, it is exact about the address,
and it leaves the server pod free to move. The alternatives each cost
more: a NodePort answers on every address of every node unless the whole
cluster's kube-proxy is reconfigured (`--nodeport-addresses`), which a byo
install cannot do; a `hostPort` with `hostIP` on the server pod pins the
server to one node; a host-network forwarder like the kind fronting's is a
real bind and would report a taken port, at the price of a pinned
Deployment and its config.

### After Kubernetes

docs/plans/off-kubernetes.md replaces the `k8s` driver with one whose
server is a unit on the host's network, on the one control machine, binding
its own ports. There `--token-listen` is the containerless path: the
server binds `<addr>:<port>` itself, and `yaac engine install` takes the
flag. The listener and its two variables are what carry over. Everything
under "k8s", "kind" and "byo" above is an adapter for the present driver
and is deleted with it: the forwarder container with kind, the Services
and the policy with the driver.

The certificate carries over too: it is a pair of files in the data dir
there, as on containerless, so an install that moves keeps its key by
copying them.

What keeps that move, and any other change of machine, out of callers'
sight:

- **The address is one the server's own machine holds.** On Hetzner that
  is the control node, where the server runs today and where the control
  side of that plan will run, so the address does not change.
- **Callers pin the key, and the key is kept.** A caller that dials the
  address and pins the fingerprint sees no change while both are kept.
- **A DNS name makes a change of address invisible as well.** That is the
  site-edge plan's `--token-name`.

A load balancer is not part of either plan for this endpoint. There is one
server, so there is nothing to balance.

## Identity

Two kinds of binding, both created by the user they act as, in Settings and
with the CLI. `resolveBearer` tells them apart by shape: a token starting
`yaac_pat_` is a personal access token, anything else is parsed as a JWT.

### Schema

One table, `token_bindings`, and one column, in one migration
(`drizzle-kit generate --name add_token_bindings`):

| Column | |
|---|---|
| `id` | uuid |
| `owner` | `users.id`, cascade on delete |
| `kind` | `pat` or `oidc` |
| `label` | unique per owner; what logs and the webapp show |
| `ceiling` | the most permissive permission mode it may start or message an agent in |
| `token_hash` | `pat`: SHA-256 hex of the token, unique |
| `expires_at` | optional, for either kind |
| `issuer`, `subject` | `oidc`: exact strings |
| `claims` | `oidc`: further claims a token must carry, each an exact string |
| `audience` | `oidc`: server-generated, unique |
| `refused_subject`, `refused_at` | `oidc`: the last wrong `sub` a valid token carried |
| `created_at`, `last_used_at` | `last_used_at` refreshed at most hourly, as `users.last_seen_at` is |

`workspaces.created_via` (text, null for a person) records `via.label`
when a delegate creates a workspace, so the label outlives the binding. The store is `db/token-binding-store.ts`, on the `#db` barrel.

### Personal access tokens

`yaac_pat_` plus 32 random bytes in base64url, shown once at creation. Only
the hash is stored; a plain SHA-256 suffices for a 256-bit random secret,
as it does for `mamaTokenHash`. Lookup is by hash, then the expiry check.
These work on every substrate and are built first: a Hetzner VM or a laptop
has no workload identity to bind.

### When a binding stops working

A binding is read from its row on every request and never cached, so each
of these holds from the next request:

- **It is deleted**, by its owner or by an admin (see "API").
- **It expires**, when it was given an expiry.
- **Its owner's row is deleted**, which cascades.

Removing someone from the tailnet changes nothing on the server, so a
departed user's bindings keep working until an admin deletes them. That
is what the admin's revoke is for, and an expiry set at creation bounds it
without anyone acting.

### OIDC bindings

The user enters an issuer URL, an exact subject and a label. There are no
wildcards, no issuer allowlist and no paste-a-token shortcut.

- **On save** the server checks the issuer. It must be `https` with no
  userinfo, query or fragment, and its host a public DNS name: an IP
  literal, a single-label name and anything under `.svc` or
  `.cluster.local` are refused. That last rule keeps out Kubernetes'
  default issuer, which every cluster shares and which, from the server
  pod, resolves to yaac's own API server. The server then fetches the
  discovery document (one trailing `/` stripped from the issuer, then
  `/.well-known/openid-configuration`; 5 s, no redirects, a size cap),
  whose `issuer` must equal the URL as entered and whose `jwks_uri` must be
  `https`. The issuer is stored as entered, since `iss` is compared as a
  string.
- **Each binding gets its own audience**, `yaac:` plus 16 random bytes,
  shown to the user. There is no uniqueness constraint on (issuer,
  subject): two users may bind the same identity, and the audience a token
  names picks whose binding it is. A user cannot claim another's binding
  because they cannot choose its audience.
- **Further claims.** A binding may list claims a token must also carry,
  each compared as an exact string (`claims`, given as `--claim
  name=value`). Some issuers need them, because their `sub` is built from
  names that can be registered again by someone else. For
  `https://token.actions.githubusercontent.com` a binding is refused unless
  it pins `repository_id` and `repository_owner_id`, which do not change
  when a repository is renamed or its name reused. Google's `sub` is a
  unique id and needs none.
- **On a request**, in this order, so that nothing is fetched for a token
  that names no binding:
  1. Refuse a token over 8 KiB, one in five parts (encrypted), and one
     with a `crit` header.
  2. Decode it unverified and read `aud`: one string, or an array of one.
     Find the binding by audience. None is the uniform 401, with no
     network I/O.
  3. Require `iss` to equal the binding's issuer.
  4. Verify with `jose.jwtVerify` against that issuer's keys:
     `algorithms: ['RS256', 'ES256']`, the issuer, the audience, `iss`,
     `sub`, `aud`, `exp` and `iat` required, and 60 s of clock tolerance.
  5. Refuse an `iat` in the future and a lifetime (`exp` − `iat`) over one
     hour, a constant that covers Google and GitHub. The library checks
     neither.
  6. Compare `sub`, then each pinned claim, exactly.
- **A valid token with the wrong `sub`** is refused and the binding records
  the subject it carried, which Settings shows beside the expected one. It
  is written only after the signature verified.
- **Keys** come from `jose.createRemoteJWKSet` per saved issuer, held in
  memory, so the cache is no larger than the table: refetched on an unknown
  `kid` at most once per cooldown, through a fetch that caps the body, and
  failing closed. A fetched body never goes into an error message. `jose`
  is pinned with `pnpm --filter @yaac/server add -E jose`. The root
  manifest needs it too, since the bundled CLI resolves the server's
  dependencies from there, so the pin moves to the `catalog:` and both
  manifests reference it.

Removing a binding stops every token at once. What lags is the other
direction: an identity disabled at its issuer keeps working here until the
tokens it already minted expire, which the one-hour bound limits.

**Who can mint a bound identity.** Anyone who can run a workflow on a
bound GitHub ref can, and that includes a workspace's agent that can push
there with its owner's git credential. It gains what the binding grants,
which is an agent's reach across all of its user's projects at the
binding's ceiling. The Settings text says to bind an `environment` with
required reviewers rather than a branch.

"The same guard clone URLs get" is, under k8s, the pod's egress policy
(docs/server-in-cluster.md "The server's own egress"), not a check in code.
The discovery and key fetches run in the server process and get it with no
new code, and a public issuer needs nothing opened. A containerless server
has no floor, for these fetches as for clones; only a person can name an
issuer, and on that substrate a person can already run code on the host.

### Authorization

`#domain/access` gains `tokens.ts` and four barrel verbs:

- `listTokenBindings`, `createTokenBinding` and `deleteTokenBinding`, which
  take the user whose bindings they are. Their routes get that id from
  `personId(principal)`, as every route on the caller's own data does: it
  answers for a person and refuses a delegate. So an agent
  cannot mint a token for its owner, and a token can neither mint, delete
  nor list its user's bindings. An admin may list and delete any user's,
  so a leaked token can be cut off without its owner; `requireAdmin`
  decides, and no delegate passes it.
- `resolveBearer`, which answers `{ kind: 'delegate', userId, login, via:
  { kind: 'token', id, label: 'token <label>' }, ceiling }` with no
  `projectId`. The user and their login come from the binding's owner row,
  in the one query that finds the binding. `token` joins `workspace` in
  the `Delegate` type's `via`, and the type's comment stops saying a
  workspace is the only one.

**The ceiling** is chosen by the person creating the binding and stored on
it. It defaults to the driver's default mode: `bypass` under `k8s`,
`accept-edits` under `containerless`. A binding is tied to no tool, so the
per-tool exception in `defaultPermissionMode` (pi is always `bypass`) does
not apply. A containerless token left at the default therefore cannot
launch pi, and cannot give a workspace inline steps or `--run` commands,
which need a ceiling of `bypass`; the person mints it with
`--permission-mode bypass` to get them.

What a token caller may then do is what docs/multi-user.md
"Authorization" gives the `delegate` level: every read, and the writes an
agent has through `yaac-mama`, in any of its user's projects. That
includes messaging a running agent (`POST /workspace/:id/send`). Its
launches in flight are capped per binding, since `withLaunchSlot` keys on
`via`. There is no read-only or per-project scope; a per-project token
would be a binding that sets `projectId`.

**Attribution.** The request log prints `<login> via token <label>`
(`actorLabel`), read from the delegate itself. `GET /whoami`
answers the delegate with its login, which is how a caller checks what
its token resolves to. The webapp shows a workspace's `created_via` where
it shows a spawning workspace, and Settings shows each binding's last use.

## API

Three routes, in `routes/tokens.ts`, mounted at `/token`. They answer the
same under both drivers, so each route-matrix row has one answer in both
columns and no `why`:

| Route | Empty server |
|---|---|
| `GET /token` | 200, `{ fingerprint, bindings }` |
| `POST /token` | 200; a `pat` body returns the token once, an `oidc` body the audience |
| `DELETE /token/:id` | 404 |

All three act on the caller's own bindings and are marked `callerScoped`
in the matrix, where every such row expects 403 from a delegate. `GET
/token?user=<id>` lists another user's, and `DELETE` removes another
user's, for an admin only.

`fingerprint` is the token listener's key fingerprint, or null when this
server has no token listener, so Settings can show what a caller pins and
say when a binding has nowhere to be used. To anyone but an admin, another
user's binding id is `NOT_FOUND`: bindings are not among the things every
user may read.

## Callers

A caller is a program that speaks HTTP: a script, a CI job, a backend. It
sends `Authorization: Bearer <token>` on each request to
`https://<addr>:<port>/api/…`, and `GET /api/whoami` tells it who the token
resolves to. It trusts the listener by pinning the key fingerprint or by
using the certificate file as its CA (see "The listener").

**The `yaac` CLI is not a token caller.** It, the desktop app, its auth
daemon, the iPhone app and the browser stay on loopback and the tailnet,
and `server.json` and `yaac remote` do not change. Teaching the CLI to
fetch a token (a per-server token command) is later work, and worth doing
only together with the commands a delegate may run.

## CLI

The CLI manages bindings and the listener, for a person on loopback or the
tailnet. It does not call the token endpoint.

| Command | |
|---|---|
| `yaac token list` | the caller's bindings, with last use and, for `oidc`, the audience |
| `yaac token create <label> [--expires <duration>] [--permission-mode <mode>]` | prints the token once |
| `yaac token bind <label> --issuer <url> --subject <sub> [--claim <name>=<value>]… [--expires <duration>] [--permission-mode <mode>]` | prints the audience |
| `yaac token delete <label>` | |
| `yaac --user <user> token list\|delete` | another user's, for an admin (the existing global option) |
| `yaac server start\|restart --token-listen <addr>:<port>` | prints the key fingerprint |
| `yaac cluster install --token-listen <addr>:<port>` / `--no-token-listen` | prints the key fingerprint |

## Settings

A "Tokens" section in Settings → General (`settings/Tokens.tsx`), beside
the git credentials: the caller's bindings with kind, label, last use and
expiry; "New token" (label, expiry, permission mode), which shows the token
once; "New identity" (issuer, subject, label, permission mode), which shows
the audience and how to mint a token for it; delete. The section shows the
listener's key fingerprint. A binding with a recorded `refused_subject`
shows it. Admins
see every user's bindings under Settings → Users, with delete. Help text is keyed off well-known issuers and
is only text:

- `https://accounts.google.com`: the subject is the service account's
  unique ID, from `gcloud iam service-accounts describe <email>
  --format='value(uniqueId)'`.
- `https://token.actions.githubusercontent.com`: the subject is
  `repo:<owner>/<repo>:environment:<name>` or
  `repo:<owner>/<repo>:ref:refs/heads/<branch>`, and whoever can run a
  workflow there can act as you. The form asks for the repository id and
  owner id, which the binding needs.

## Tests

- **Unit** (`packages/server/test/…`, mirroring `src/`):
  `domain/access/tokens.test.ts` with one `describe` per barrel verb,
  `fetch` mocked at the process boundary and keys made with `jose`, driving
  the OIDC internals through `createTokenBinding` and `resolveBearer`:
  - on save: an `http` issuer, an IP literal, a `.svc` name, a discovery
    document naming another issuer, and a GitHub binding without the two
    id claims are each refused;
  - on a request: an unknown audience makes no fetch; wrong issuer; wrong
    `sub`, recorded; a pinned claim that differs; `alg: none` and HS256; no
    `exp`, no `iat`, an `iat` in the future, a lifetime over an hour; an
    oversized, an encrypted and a `crit` token; an unknown `kid` refetched
    once; an unreachable issuer failing closed;
  - an expired binding, and an admin deleting another user's.

  Also the store under `db/`; the Service, policy, Deployment, Secret and
  forwarder under `drivers/k8s/…`, with the refusals and the forwarder's
  create, replace and remove driven through install against `fakeCluster`
  and a faked `podman`; and the certificate generator in
  `packages/shared/test/` (the address in the certificate, a reissue
  keeping the key and so the fingerprint).
- **API** (`test/api/`): three route-matrix rows, which the matrix's
  `describeDelegate` already drives as a delegate with no project of its
  own, the shape a token has; and one in-process file that drives
  `delegateApp` with the bearer resolver: no token, a loopback `Host` and
  forged `Tailscale-*` headers all get 401; a token in a query string is
  ignored; a PAT gets its delegate from `/whoami`; `GET` and `POST /token`
  are 403; an expired and a deleted binding are 401; repeated failures
  from one address get 429.
- **E2e, containerless** (`test/e2e-containerless/token-suite.test.ts`, one
  server for the file, started with `--token-listen` on a free loopback
  port): the start prints a fingerprint and the host-execution warning,
  and a second start prints the same fingerprint; every `yaac token`
  argument and option, run against the main origin as a person, `--user`
  as an admin included; then plain HTTPS requests to the token origin,
  trusting the generated certificate as the CA: a PAT's `/whoami`, a list
  and a workspace create, a create above the binding's ceiling refused,
  `GET /token` refused, a request with no token refused; a wildcard
  `--token-listen` and one inside a workspace refused; a mock issuer for
  `token bind` with `--claim`, and an OIDC call; `token delete`, after
  which the next call is 401, last.
- **E2e, k8s**: `--token-listen` and `--no-token-listen` get their flag
  refusals in `test/e2e-cli/cluster-cli.test.ts`, and against its fake
  cluster the refusals of an address no node reports and of an address and
  port another Service names. The real datapaths are two cases in one k8s
  e2e file, whose `spawnYaacServer` takes a token endpoint and applies the
  Service, policy and mount that install renders:
  - *kind's*: the NodePort Service and the forwarder container, run by the
    same function install calls, on a free loopback port and carrying
    `testContainerOwnerLabel()`. The test calls `/whoami` with a PAT from
    the host through it. The shared test cluster needs nothing new, since
    the API server picks each file's node port.
  - *byo's*: the `externalIPs` Service with the kind node's InternalIP as
    the address, called from inside the node (`podman exec <node> curl`).
    The API server does not refuse two Services naming one external
    address and port, so a helper picks a port no Service in the cluster
    names and passes it explicitly.
  - *the wall*: a probe pod in another namespace, which no egress policy
    holds back, dials the server pod. The token port answers TLS and the
    API port does not answer, so the any-source rule opened one port.

Not covered by e2e, and said so in the change that ships each:

- a non-loopback address for the forwarder, which a test machine cannot be
  assumed to have. One manual run on Linux and one on macOS, where the
  published port goes through the podman machine's forwarder;
- `externalIPs` on k3s with a second node. One manual run on the Hetzner
  cluster, calling the endpoint from another VM on the private network at
  the private address and at the public one, which must not answer.

## Docs

- `docs/remote-hosting.md`: a "Token access" section (setup per substrate,
  the generated certificate and how a caller trusts it, when a binding
  stops working); "No client holds a credential" and
  "The only ways to reach the server are loopback and `serve`" each gain
  the token listener, with why it cannot be mistaken for loopback; the
  identity table gets its row; and the access-mode table's "`local`:
  loopback only" gains the exception.
- `docs/server-in-cluster.md`: the Service and the third policy in "What
  install deploys" and "The ingress policy is the wall"; the two Service
  shapes and why in "Reachability"; the harness's token endpoint in "The
  e2e tiers run against this".
- `docs/cluster-setup.md`: the two flags; "The tailnet is the only way in"
  becomes the tailnet plus an opt-in address and port that only a token
  opens.
- `docs/multi-user.md`: bindings under "Users and owners", with the
  admin's revoke; under "Trust model", that a token on
  containerless is code execution on the host from a network, and that an
  agent able to push to a bound GitHub ref can mint that identity; and in
  "Authorization", a token as the second kind of delegate, beside a
  workspace's `yaac-mama` call.
- `docs/workspace-egress.md`: beside the GCP metadata opening, that it lets
  workspaces mint the node's identity, so never bind a node's service
  account on such a cluster.
- `docs/containerless-driver.md`: the same exposure, where the substrate's
  limits are listed.
- `docs/cli.md`, `docs/environment-variables.md`,
  `infra/hetzner-k3s/README.md` and the firewall comment in its `main.tf`.

When this ships, its current-state material moves into those references and
this file is deleted.

## Other plans

- **docs/plans/self-hosted-site-edge.md** builds on two pieces of this one
  and adds to a third. Its edge reaches the cluster the way this
  endpoint does: the forwarder container on kind, a node-held address on
  byo. Its `--token-name` puts an issued certificate where this plan puts
  a generated one, which the listener's re-read picks up. And once the
  token port admits any source, what keeps the edge and the releases
  behind it away from that port is their own egress policies and the
  token, so that plan's rule that the edge's egress never reaches the
  server covers this port too.
- **docs/plans/off-kubernetes.md**: see "After Kubernetes".

## Order of work

One pull request, built in this order. Nothing it depends on is
outstanding.

1. **PATs on containerless, end to end.** The migration and store, the
   access verbs with the admin's revoke, the routes
   and matrix rows, the listener mounting `delegateApp(resolveBearer)`
   with its timeouts and failure limit, the certificate generator and the
   TLS reload, `--token-listen`, `yaac token list|create|delete`, the
   Settings section, the containerless suite.
2. **k8s exposure.** The constant, the Service, policy, Secret, mount and
   variables, `--token-listen` and `--no-token-listen` with their refusals,
   the byo Service, the kind forwarder container, the check gate, the e2e
   cases and the manual runs, the Hetzner README.
3. **OIDC.** `jose`, issuer validation, `yaac token bind` with `--claim`,
   verification and its bounds, the refused-subject record, the Settings
   form and hints.

Each step updates the docs it makes untrue.

## Open points

- **`externalIPs` is the untested part.** It is standard kube-proxy
  behaviour and the e2e case runs it on kind, but this plan has not run it
  on k3s with Calico, and some managed clusters reject it. If it fails
  there, the fallback is the host-network forwarder, which costs a pinned
  Deployment and changes the ingress rule from any source to node
  addresses.
- **The kind forwarder is the first container install runs on the host
  besides the node.** It reaches the node by its name on the kind network;
  if podman's network there does not resolve names, install passes the
  node's address and replaces the container when that changes. Whether a
  podman machine on macOS publishes a non-loopback address is the other
  thing to check by hand.
- **A token is for programs, not people.** A delegate is held to
  `yaac-mama`'s reach, and no `yaac` client speaks to the token endpoint,
  so a user without the tailnet has no terminal, forward, settings or CLI
  there. Reaching the whole of yaac without the tailnet would take a
  different kind of caller.
- **No WebSockets means no live view over a token.** A script polls. If
  following `/events` or a conversation by token is wanted, the listener
  registers those two routes behind the same resolver, and deleting a
  binding must then close the sockets it opened.
- **A workspace can reach the endpoint through the egress proxy** when its
  project's allowlist holds an exact entry for the node address, since the
  proxy may dial node addresses. It still needs a token, which no agent can
  mint. A person who hands a workspace a PAT widens it from its own project
  to all of theirs, at the token's ceiling; the docs say not to. Excluding
  the port in the proxy's egress policy, beside NFS and the kind fronting,
  would close it.
- **Minting still needs the tailnet once.** A byo install is always
  `tailnet`, and creating a binding is a person's, so each user signs in
  over the tailnet to mint their first token. An admin creating a binding
  for another user is later work.
- **Source addresses are approximate on k8s.** A call that crosses nodes
  arrives from a node's address, so the failure limit and the refusal log
  may see several callers as one. That errs toward refusing.
- **The one-hour lifetime bound is a guess at what issuers mint.** Google
  and GitHub fit. An issuer with longer tokens would need the constant
  raised, which lengthens how long a disabled identity keeps working.
