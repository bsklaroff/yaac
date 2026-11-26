# Workspace egress

Every workspace and builder pod runs in a gVisor sandbox with no network
interface but loopback. Everything that crosses its boundary goes through
unix sockets in one directory its node mounts into it, and every outbound
connection ends at the yaac MITM proxy, which enforces a per-workspace
allowlist and injects credentials. The two exceptions the proxy itself
dials for a sandbox, the install's npm cache and the main registry, are
below.

This is the security argument: nothing in a sandbox is routable, so deny by
default needs no policy, a connection's identity cannot be forged, and
nothing in the cluster (the server, the apiserver, the node, other
sandboxes) has an address a sandbox can dial. It asks nothing of the
cluster's CNI.

## The contract

Each sandbox has one directory on its node, under the install's socket
root: `/var/lib/yaac/sockets/<install key>/<pod dir>`, beside the
node-mounts root. A workspace pod's directory has its node-mounts
directory's name (`<workspace id>.<random>`); a builder's is
`<build id>.<random>`. It is a fixed part of the pod's shape (the
`sockets` hostPath volume, `socketVolume` in `#drivers/k8s/substrate`), and
only the pod's netshim container mounts it, at `/run/yaac`:

| Socket | Bound by | Carries |
|---|---|---|
| `egress.sock` | netd's relay, on the node | every outbound connection the sandbox makes |
| `ingress.sock` | netshim, inside the sandbox | every connection into it: the server's streams to streamd (docs/stream-relay.md) and the site router's requests to a release (docs/public-sites.md "The router") |

Three properties follow from there being no interface:

- **Deny by default needs no policy.** Nothing is routable, so there is no
  NetworkPolicy to apply late and no firewall rule to lose.
- **Identity cannot be forged.** A connection belongs to the sandbox whose
  directory it arrived in, and nothing inside one can reach another's
  directory. Code a project wrote never sees `egress.sock`, since only
  netshim's container mounts it, so it cannot plant a link there either.
- **Nothing in the cluster is reachable.** With no listener on
  `egress.sock`, a dial to the internet, the server, the apiserver, the
  kubelet and another sandbox all fail.

Any new kind of pod that runs code yaac did not write must take this shape.
The policies around yaac's own pods assume every pod with an interface is
one yaac wrote.

## What a sandbox sees

Egress is transparent. No proxy variables are set, and a process dials
`github.com:443` as usual.

- **DNS.** netshim answers every A query with the sinkhole address
  (`DNS_SINKHOLE`, 198.18.0.1, in the benchmark range, so it names
  nothing) and every other query with an empty answer, whichever resolver
  address the query was sent to. The pod's `dnsConfig` names the sinkhole.
  No name resolves to a real address, the install's own Services included,
  and nothing real is learned through DNS, which keeps it from carrying
  data out.
- **Every address is local.** Loopback carries a default route, and one NAT
  rule sends every TCP connection that is not to `127.0.0.0/8` to netshim,
  which reads the address the client dialed. A dial to a name, a literal
  internet address or a cluster address all arrive at netshim, on any port.
  A connect always succeeds; what happens next is the proxy's answer.
- **Routing by name.** The proxy routes by TLS SNI on port 443, by the SSH
  sentinel for git's `CONNECT`, and by the Host header on every other port.
  Plain HTTP to an allowlisted name or literal address works on any port.
  HTTPS on a port other than 443, and HTTPS to a bare address, fail (below).
- **UDP.** Port 53 reaches netshim's stub. Anything else goes nowhere.
- **IPv6.** Only `::1` has a route, so an IPv6 dial fails at once, as the
  proxy would refuse it ("IPv4 only").
- **`ip addr` shows only `lo`**, carrying `127.0.0.1` and the pod's own
  address. kubelet writes the pod's address into `/etc/hosts` beside the
  hostname, so netshim puts it on loopback: a program that binds or dials
  its own hostname (a JVM's `getLocalHost`, an Erlang node) works, and dev
  servers list it as their network address. The pod's address carries no
  traffic off the sandbox. `lo` also carries a link-local IPv6 address,
  `fe80::1`: getaddrinfo's `AI_ADDRCONFIG`, which Node's `net.connect`
  passes, answers `localhost` with `::1` only while some IPv6 address other
  than `::1` is configured, so without it a server bound to `::1` (a dev
  server listening on `localhost`) is unreachable by that name, a
  forward included.
- **Nothing of netshim is visible** but its listening ports on loopback. It
  runs in a container of its own, so the workspace's processes cannot see or
  signal it, and root in the workspace cannot change addresses, routes or
  NAT rules (it lacks `CAP_NET_ADMIN`) or open a raw socket (the workspace
  container drops `CAP_NET_RAW`).
- **A client that waits for the server to speak first** (ssh to a port other
  than the sentinel's, MySQL, SMTP) hangs on any address until it gives up:
  the connect succeeds, and the proxy waits for a TLS ClientHello or an HTTP
  request head that never comes.

## The runtime

Every sandboxed pod uses the `gvisor-nonet` RuntimeClass, whose containerd
handler `runsc-nonet` the gVisor installer registers with its own flag file
(`install/gvisor-runtime.ts`). Beside the flags every sandbox gets, it sets:

- `network = "none"`: a netstack with loopback only.
- `net-raw = "true"`: netshim's `iptables` writes its rules through a raw
  socket, and without the flag runsc takes `CAP_NET_RAW` from every
  container. With no interface a raw socket reaches nothing but the
  sandbox's own loopback.

`net-raw` applies to the whole sandbox, so every container keeps whatever
`CAP_NET_RAW` its spec grants. The workspace container drops it and the
builder container does not ask for it, which leaves both with no raw
sockets. The builder keeps `NET_ADMIN`: BuildKit gives a `RUN` step none,
and a step that had it could only cut its own network.

The handler is its own, not changed flags on another, because a handler is
node-wide and installs on other releases share nodes. Salvage and import
pods and the check's file probes need no network and get no netshim. A pod
still has a CNI address, which nothing uses: every probe and hook of these
pods is an exec.

## netshim

`k8s/mountd/cmd/netshim`, a static Go program in the mountd image, which
every sandboxed pod runs as its first init container with `restartPolicy:
Always`, so it is up before anything else in the pod starts and kubelet
restarts it if it exits (`netshimContainer` in `#drivers/k8s/substrate`).
It ships in yaac's image, not the workspace's, so a project's own
Dockerfile gets it too. It runs as root with only `NET_ADMIN` and `NET_RAW`,
and its root filesystem stays writable, since `iptables` takes a lock under
`/run`. Its startup probe waits for `ingress.sock`, the last thing it binds.

At start it runs:

```
ip route replace 0.0.0.0/0 dev lo
ip -6 addr replace fe80::1/64 dev lo
ip addr replace $POD_IP/32 dev lo
iptables-legacy -t nat -F OUTPUT
iptables-legacy -t nat -A OUTPUT -d $POD_IP/32 -j RETURN
iptables-legacy -t nat -A OUTPUT -p tcp ! -d 127.0.0.0/8 -j REDIRECT --to-ports 10301
iptables-legacy -t nat -A OUTPUT -p udp ! -d 127.0.0.0/8 --dport 53 -j REDIRECT --to-ports 10302
```

The route and rules live in the sandbox's netstack, not the container, so
they survive a netshim restart, and every command is safe to repeat. The
route is written as `0.0.0.0/0` because netstack rejects the `default`
keyword, and gVisor has no nftables, so the legacy backend is the only one.
Then it listens:

- **Out, TCP** (`127.0.0.1:10301`). For each connection it reads the dialed
  destination with `getsockopt(SOL_IP, SO_ORIGINAL_DST)`, connects to
  `/run/yaac/egress.sock`, writes a PROXY protocol v2 header naming that
  destination ("Wire formats") and splices. A failed connect closes the
  client's connection.
- **Out, DNS** (`127.0.0.1:10302` UDP). One question per query: an A query
  gets the sinkhole with a 5 second TTL, anything else an empty NOERROR.
- **In** (`/run/yaac/ingress.sock`). For each connection it reads a two-byte
  port, connects to `127.0.0.1:<port>` and splices.

It is untrusted by position, though it is yaac's code: whatever header it
writes only chooses how the proxy reads the connection, and the relay
stamps the identity of the directory it arrived in. When netshim is down,
dials fail at once with a refused connection and nothing else becomes
reachable. A workspace process that takes port 10301 while netshim is down
keeps it down, which costs that workspace its own network and nothing else.
The server's port detector hides netshim's ports with yaac's other infra
ports (docs/auto-forward-ports.md).

## The relay, and the rest of netd

`yaac-netd` is a DaemonSet with two containers, off the host network
(`cluster/netd.ts`):

- **relay** (`k8s/mountd/cmd/relay`, on the mountd image) carries every
  sandbox connection on its node. Its core, `internal/sockets`, imports
  nothing of yaac or Kubernetes: given a root and the units that exist (a
  directory and an id each), it binds each unit's `egress.sock`, rebinds one
  that goes missing, opens a unit's `ingress.sock` by descriptor, and
  removes the directory of a unit that is gone. `cmd/relay` is the glue: the
  pod and Service watches, the dial to the proxy and the two listeners.
- **netd** (`k8s/netd`, TypeScript) bounds each pod's swap and kills the
  workspace thrashing the node (docs/cluster-setup.md "Memory pressure").

The relay runs as root with every capability dropped, sees this install's
socket root at `/s`, and reads the proxy auth secret from `yaac-proxy-auth`.
The mount point is short on purpose: a unix socket's path is capped at 107
bytes, measured in the binder's own mount namespace, and the node path with
a UUID install key runs past that.

Its units are the pods on its node labelled `yaac.workspace-id` (or
`yaac.build-id`), whose `sockets` volume lies directly beneath its socket
root. It reads them fresh from the API on each change of its node's pods
and every 30 seconds, as mountd does, so an informer that fell behind never
makes a live pod's directory look unowned. A directory is removed only when
it was seen before a list that holds no pod for it.

- **Out.** It binds `egress.sock` in each unit's directory (mode `0600`,
  in a `0700` directory; netshim connects as root). For each connection it
  reads netshim's header within 10 seconds, keeping the destination and
  dropping every TLV, and opens a connection to the proxy's Service on
  `SOCKET_EGRESS_PORT` with a header of its own: the same destination, the
  unit's id and the proxy auth secret. A header that does not parse, or
  arrives late, closes the connection. A running sandbox connects to a
  rebound socket with no restart.
- **In, streams** (`NETD_STREAM_PORT`): docs/stream-relay.md.
- **In, sites** (`NETD_SITE_PORT`): docs/public-sites.md "The router".

`ingress.sock` is opened with `O_PATH | O_NOFOLLOW`, checked to be a socket
with `fstat`, and connected through `/proc/self/fd/<n>`, since a connect by
path follows a link to any socket on the node. The relay is ready once the
socket root is mounted and both listeners are bound.

The DaemonSet rolls one node at a time. A restart of a node's netd pod drops
that node's terminals, forwards and in-flight egress, which reconnect, and
takes that node's sites down until the server has pointed their endpoints at
the new pod (docs/public-sites.md "The router").

## The proxy's ingress

The proxy has one port for sandbox traffic, `SOCKET_EGRESS_PORT`
(`k8s/proxy/socket-ingress.ts`). It reads the relay's header, accepts it only
when the secret TLV matches the proxy auth secret, takes the sandbox's id
from its TLV, and hands the connection to the handler the destination
selects: port 443 to the SNI peek, the SSH sentinel's address and port
(198.18.0.2:10259) to git's `CONNECT` reader, anything else to the
plain-HTTP server.

**Identity is the registration.** A connection whose id has no registration
(fetched once if the watch has not delivered it) is refused, which is also
what keeps a prewarmed spare offline until its claim. Whether an id is a
build or a site release comes from its registration: a build's ConfigMap
carries the `yaac.build-id` label, and a release's says `release: true`.

## The npm cache and the main registry

A registration can name `clusterServices`, a list of `host:port` of the
install's own Services the server lets that sandbox reach by name: the npm
cache for a workspace that may use it, the main registry's pod port for a
build (docs/image-builds.md "Build egress"). A plain-HTTP request to an
exact match is forwarded as named, before the allowlist and past the
non-public guard, like every destination the server names. `~/.npmrc`,
`buildkitd.toml` and the registry auth file name the same hosts as any
pod would.

So that this adds no reach, the proxy refuses any destination named as one
of the install's Services, or the main registry's, unless the registration
holds it (`isInstallServiceName` in `k8s/proxy/upstream.ts`): a single label,
which resolves only through the proxy's search path, and any name ending in
`.<ns>`, `.<ns>.svc` or `.<ns>.svc.cluster.local` for the install's
namespace and the registry's (`yaac`). That holds on every path, TLS and
`CONNECT` included, and nothing is looked up first.

### The npm cache: an exception to the allowlist

The cache (`drivers/k8s/cluster/npm-cache.ts`, docs/workspace-storage.md
"Package installs") fetches from `registry.npmjs.org` itself, not through
the proxy, so what it serves reaches a workspace outside that workspace's
allowlist.

That is acceptable because it only brings npm content **in**. What goes out
is package names (and `npm audit` bodies, and requests for npm's signing
keys and attestations) sent to npmjs. Verdaccio serves a tarball only from a
URL its upstream's own metadata named, forwards no credentials upstream, and
accepts no publishes.

Access is per project. The server names the cache in a workspace's
registration unless its project sets `npmCache: false`, its allowlist leaves
out `registry.npmjs.org`, or its project authenticates to npmjs through a
proxied secret, and only then configures the workspace's pnpm to use it.
Otherwise its pnpm uses npmjs through the proxy like any other host. A
prewarmed spare has no registration until a launch takes it, so it is
decided at the launch like any pod (docs/generic-workspace-pods.md).

## Wire formats

Every header is PROXY protocol v2 (`0D 0A 0D 0A 00 0D 0A 51 55 49 54 0A`,
version and command `0x21`). The relay and netshim share one reader and
writer (`k8s/mountd/internal/pp2`); the proxy parses with `k8s/proxy/pp2.ts`.

| Hop | Family | Addresses | TLVs |
|---|---|---|---|
| netshim to the relay | `0x11` (TCP over IPv4) | source: the client's loopback address and port; destination: the address and port dialed | none; the relay drops any |
| the relay to the proxy | `0x11` | copied | `0xE0`: the workspace or build id; `0xE1`: the proxy auth secret |
| the router to the relay | as Envoy writes it | unused | `0xE0`: the site id |

`ingress.sock` takes a two-byte big-endian port before the stream.

| Constant | Value |
|---|---|
| `SOCKET_EGRESS_PORT` (proxy) | 10261 |
| `NETD_STREAM_PORT` (relay) | 10262 |
| `NETD_SITE_PORT` (relay) | 10263 |
| `NETSHIM_TCP_PORT` | 10301 |
| `NETSHIM_DNS_PORT` | 10302 |
| socket root | `/var/lib/yaac/sockets` (`SOCKETS_NODE_ROOT`) |

## Policies

Workspace and builder pods have no policy of their own:
`yaac-egress-world-deny` covers every pod of the namespace but the proxy and
the server, sandboxes included, and they have no interface to send from
anyway. The policies that matter surround yaac's own pods
(`cluster/policy-manifests.ts`):

| Policy | Admits |
|---|---|
| `yaac-proxy-ingress` | netd's pods on `SOCKET_EGRESS_PORT`; the server's pods and the node (the kubelet's probe) on the control port |
| `yaac-proxy-egress` | the floor (`wideEgress`, "Non-public destinations"), the nodes, the server's mama listener, the apiserver, the npm cache and the main registry's pod port |
| `yaac-netd-ingress` | the server's pods on `NETD_STREAM_PORT`, the site router on `NETD_SITE_PORT` |
| `yaac-netd-egress` | the proxy on `SOCKET_EGRESS_PORT`, the apiserver, DNS |
| `yaac-npm-cache-ingress` | the proxy and the node (kubelet probe) on the cache port |
| `yaac-registry-ingress` | the node on the node port; the proxy and the server, in any namespace, on the pod port |

The relay's site port takes no secret, so the router's identity checks
(docs/public-sites.md "Headers an app may trust") hold only while
`yaac-netd-ingress` keeps everything but the router off it. The proxy's port
admits no one by position alone: the relay presents the proxy auth secret on
every connection.

**Probe egress with real requests, not connects.** Every connect from a
sandbox succeeds, to any address and port, since netshim takes it. Assert on
a completed request: the proxy refuses a host no allowlist admits with a 403,
or drops TLS it cannot route.

## Git credentials

A git credential belongs to a repo, and the proxy uses it for that repo and
nothing else (docs/project-repos.md "Credentials per repo"). The credentials
Secret carries, with each token and ssh key, its **grants**: one per
(project, repo) that may use it, with the repo's host and path
(`owner/repo`) and the link's `readOnly` and `ghToken` flags, and for an ssh
key the host's trusted key. A workspace is served the grants of its
registration's project, from its registration's owner. Grants are read on
every request, so a changed flag or a reassigned credential applies to
running workspaces at once (`k8s/proxy/repo-grants.ts`).

### Git over HTTPS

A host the project has an https repo on is MITM'd. A request whose path is
under a granted repo (`/<owner>/<repo>` or `/<owner>/<repo>.git`, then a
segment boundary, which covers the smart-HTTP endpoints and LFS) leaves with
that repo's token as `Authorization: Basic`. Every other path on the host
passes with no token: a public repo still clones, and a private one the
project does not link answers as it would to anyone.

The match is on the path as the host would resolve it: case folded,
percent-encoding decoded, an encoded or backward slash read as a separator,
`;` parameters dropped, empty and dot segments resolved. A request that only resolves to the repo
(`/acme/x/../repo.git/…`) counts as under it for the read-only rules below but
carries no token, so nothing ambiguous is authenticated.

### `GH_TOKEN`

A workspace's `GH_TOKEN` is a placeholder naming a repo,
`yaac-ph-gh-token-<repo id>`. The proxy swaps it, keeping `gh`'s scheme, for
that repo's token on requests to the API hosts of the repo's git host
(`api.github.com` and `uploads.github.com` for `github.com`), when the
workspace's project holds a grant for the repo with `ghToken` and without
`readOnly`. Any other `Authorization` passes as it came, a user's own token
included. Through the API a token reaches whatever it can at the host, so
this is the one place a token leaves its repo's path, and a read-only repo's
never does.

### Read-only repos

A grant is `readOnly` when the project's link or the repo itself is
read-only, and always for a fork's upstream (docs/repo-forks.md). A grant
with `readOnly` passes only the requests known to read under its
repo's path, and refuses every other with a 403, whichever credential the
request carries. It lists what reads rather than what writes, so a spelling
of a push the proxy does not recognize is refused, not passed. What passes:

- a GET or HEAD, except an `info/refs` asking for any service but
  `git-upload-pack` (the push probe is `service=git-receive-pack`);
- the fetch RPC, a POST to `git-upload-pack`;
- an LFS download: a POST to `info/lfs/objects/batch` is the only request
  body the proxy reads for this, up to 8 MiB, and it passes only a JSON body
  whose `operation` is `download`;
- an LFS lock check, a POST to `info/lfs/locks/verify`.

So fetches pass, including refs outside `refs/heads` and LFS downloads, and
a push, an LFS upload, a lock change and any other POST, PUT, PATCH or
DELETE do not. What this does not stop is a write to the repo that does not
go to that path: the host's API with a token that can write the repo, and
the same host under another name the allowlist admits.

### Git over SSH

The proxy ends ssh sessions to a project's git hosts itself
(`k8s/proxy/ssh-session.ts`). A workspace with an ssh repo gets a
`GIT_SSH_COMMAND` whose `ncat` proxy command dials the sentinel
(198.18.0.2:10259), which the proxy reads as git's `CONNECT`, offers no
identity, and trusts one host key under one
name (`HostKeyAlias=yaac-proxy`): the proxy's, which it mints once, keeps in
the `yaac-proxy-ca` Secret and the server publishes as `ssh_known_hosts` in
the ConfigMap every pod mounts beside the CA. The workspace holds no key and
no agent socket. A pod's ssh settings are fixed at launch, so one that
trusts anything else needs a restart (docs/legacy-compat-shims.md "Pods
whose ssh trusts the git host").

For a `CONNECT` to port 22 of a host the workspace's project has an ssh grant
on, after the allowlist and the non-public guard, the proxy answers as the
ssh server. The workspace is already identified by the relay's header, so
any login is accepted. Then:

- Only an `exec` of a git command passes: `git-upload-pack`,
  `git-receive-pack`, `git-upload-archive`, `git-lfs-authenticate` and
  `git-lfs-transfer`, each naming a path. A shell, a subsystem or any other
  command is answered on stderr with `yaac: …` and exit status 1.
- The path must be one of the project's ssh repos on that host. Any other is
  refused, since ssh has no anonymous access to fall back to.
- A read-only grant refuses `git-receive-pack` and the two LFS commands when
  their operation is `upload`.
- Otherwise the proxy opens its own session to the host, accepting only a
  host key in the grant's `knownHostsEntry`, logs in as the user the
  workspace named with the key granted for that repo, runs the same command
  and joins the two streams, relaying the exit status. `GIT_PROTOCOL` is
  carried to the host; no other variable is.

So a key reaches its own repo and nothing else, and a session on that host
carries only git. A `CONNECT` to port 22 of any other host is a plain tunnel
under the allowlist, with whatever the workspace itself brings.

## What the proxy is told, and how

The proxy pod mounts nothing from the host and keeps no state of its own. It
learns everything from Kubernetes objects it watches, and reports everything as
objects the server watches. All live in the install namespace, are labelled
`app: yaac-proxy`, and have exactly one writer and one reader:

| object | kind | writer | reader | content |
|---|---|---|---|---|
| `yaac-proxy-credentials` | Secret | server | proxy informer | per owner, keys prefixed `<owner>.`: `claude.json`, `codex.json`, `opencode.json`, `pi.json`, `omp.json` (each tool's host-store file verbatim, plus `apiHost` for opencode, pi and omp: the provider host the key is swapped in on; a signed-out tool has no key), `git-tokens.json` (`[{token, grants}]`) and `ssh-keys.json` (`[{privateKey, publicKey, grants}]`, the private key OpenSSH-encoded from the sealed seed). Each grant is `{projectId, repoId, host, path, readOnly, ghToken}`, an ssh key's with its `knownHostsEntry` (see "Git credentials") |
| `yaac-proxy-secrets-<project id>` | Secret, one per project | server | proxy informer | `values.json`: `{ "<project id>/<NAME>": value }`, the secret values behind that project's `secretRef` rules |
| `yaac-proxy-reg-<id>` | ConfigMap, one per workspace or build | server | proxy informer | `registration.json`: rules with `secretRef`s (never values), allowed hosts, project, owner, test redirects, `release` for a site's release, and `clusterServices`; a build's carries the `yaac.build-id` label |
| `yaac-proxy-refreshed` | Secret | proxy | server informer | `<owner>.claude.json`, `<owner>.codex.json`: OAuth bundles the proxy captured from a workspace's token refresh, in the credentials-file shape |
| `yaac-proxy-ca` | Secret | proxy | server (one get) | `ca.key`, `ca.pem`, `ca-bundle.pem`, and the proxy's ssh host key, `ssh-host-key` and `ssh-host-key.pub`. The server copies the public parts into the `yaac-proxy-ca` ConfigMap pods mount |
| `yaac-proxy-state` | ConfigMap | proxy | server informer | `blocked-hosts.json`, `git-auth-failures.json` |

**Owners.** Credentials belong to an owner, an opaque key (letters,
digits, `-`, `_`; the proxy reads a Secret key up to its first `.` as the
owner) that each registration names. Every credential path resolves through
the registration's owner: the sentinel swaps, the OAuth refresh and its
write-back, and the git tokens and ssh keys with their grants. A
workspace never spends another owner's credential, even one assigned to a
project of the same id, and a registration naming an owner the Secret lacks
gets nothing swapped. The server decides the owner and hands it to the
driver on the launch intent: a workspace spends its project owner's
credentials. A user's key is their user id,
except the built-in user's, which is `install`
(`credentialOwnerKey` in `#domain/auth`). The server pushes one bundle per
user who has a tool sign-in or a git credential some project uses.

Inputs carry the label `yaac.proxy-input=<kind>` and outputs
`yaac.proxy-output=<kind>`. Both sides select by label, since `list` and
`watch` cannot be scoped by name.

**When the server writes:**

- The credentials Secret is rewritten whole whenever a credential store change
  alters its contents (a login, a clear, a git credential assigned to a
  project or a project added with one, a refresh the plan-usage poller saved),
  and once per server start, so the objects always converge on the store.
- A project's secret values are rewritten when one of its secrets is edited,
  and deleted with the project.
- A registration is written at launch, before the workspace's Job is
  applied or a taken spare is labelled, after `ensureRunning` (so a create
  never registers against a proxy that cannot see it). It is rewritten to
  widen it (the webapp's allow-host click, applied to all of the project's
  registrations by label). It is deleted at teardown, and swept once its
  workspace is gone and it is an hour old.

**When a registration changes**, the proxy re-checks the workspace's open
tunnels and in-flight plain-HTTP requests (it checks the allowlist and picks
injection rules only once per tunnel or request). A connection whose host is no
longer allowed, or whose rules, redirect or exact entry (which alone admits
a non-public address) changed, is dropped and reconnects under the new
registration. Others stay up, so widening drops little.

**Proxy start and outputs.** The proxy restores itself from its informers'
initial lists, and its readiness probe keeps it out of its Service until they
have loaded, so a replacement never serves a workspace it has not been told
about. A blocked host or a rejected git credential is written to the state
ConfigMap (debounced), which the server's cache turns into the snapshot.

**Token refreshes.** A refresh a workspace drives spends its owner's
credential, and is captured in memory, for that owner only, before the
response is forwarded. It is then written to that owner's keys in the
refreshed Secret by one writer that carries the newest capture and retries
until it lands (a codex rotation is single-use, and the Secret is what a
replacement pod boots from). The server's `credential-adopt` step takes
each owner's captures into that user's store under the same newest-wins
comparison every writer uses, then pushes the credentials Secret again, so
the proxy sees its own capture echoed back and stops preferring it.

Every workspace presents the same placeholder refresh token, and claude's own
refresh lock covers only one config dir, so the proxy serializes refreshes: one
per credential (an owner's bundle for one tool) at a time.

- A refresh arriving while one is in flight joins it.
- One arriving within seconds of a rotation, while that rotation is still the
  held credential, is answered with it instead of spending the credential
  again.
- A caller that outwaits a slow upstream gets a 504, but the flight stays open
  until upstream answers. A rotation that completes late is still captured, and
  a refresh arriving meanwhile joins it instead of spending the old token.

This matters because a second spend returns `invalid_grant`, and claude reacts
by clearing every stored credential holding the refresh token it sent: the
placeholder in the project's shared tool home, which signs out every workspace
of the project at once.

The access-token swap covers `mcp-proxy.anthropic.com` as well as
`api.anthropic.com`. claude's claude.ai connectors send the same bearer token
there, and a placeholder sent there would get a 401 that makes claude force a
refresh on every start.

**opencode, pi and omp keys.** Each tool reads its key from a workspace
variable of its own, `YAAC_<TOOL>_KEY_<PROVIDER>`, which its config in the
project's tool home names (an `OPENCODE_CONFIG` file for opencode, a
`models.json` entry for pi, a `models.yml` one for omp;
`ensureToolApiKeyConfig`), ahead of the provider's own variable. So the
key reaches the tool however it is started, and the tools can hold
different keys for one provider, unaffected by claude's or codex's
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` or a project's own provider variable. Each
carries its own placeholder too, so the proxy picks the key by which
placeholder a request sends, not by the workspace's tool.

The `custom` provider is one of the user's custom endpoints
(docs/custom-endpoints.md), a self-hosted OpenAI-compatible server, for
opencode, pi and omp: the endpoint holds the base URL, key and models, and
yaac writes the whole provider definition into each tool's config. Its
`apiHost` is the URL's host, so a key is swapped in there over HTTPS like any
provider's. Over plain HTTP no key is ever injected, so an endpoint reached
that way must take none; the key is optional for this provider, a keyless
one gets no variable, and under k8s saving an `http://` endpoint with a key
is refused.

**omp's own traffic.** Besides its provider, omp fetches a public
models.dev mirror at startup (`catalog.stencil.so`: a plain GET, carrying
nothing about the workspace, user or prompts). No setting turns it off, so
it is among the install's default allowed hosts, for every workspace as the
other agents' hosts are. A first launch in a project also refreshes the
model lists of providers that need no key (`api.commandcode.ai`,
`api.kilo.ai`, `api.venice.ai`, `coding-intl.dashscope.aliyuncs.com`,
`hyper.charm.land`, `zenmux.ai`), cached for a day in `models.db`. Those are
not allowed by default, so under k8s they are refused and omp keeps its
bundled lists; under containerless they go out. Refusing them does not hold
up a launch or a turn. yaac's launches turn off omp's update check,
marketplace updates and issue reports (`ensureOmpSettings`).

Which endpoints a cluster workspace can reach follows from routing by name:

- `http://<name or address>:<any port>` and `https://<name>` on 443 work,
  given the allowlist entry (and, for a non-public address, the opening
  below).
- `https://<name>` on another port does not: the proxy reads a connection
  to any port but 443 as plain HTTP, so the TLS handshake fails.
- HTTPS to an IP address fails as described below. Use a name.

**RBAC.** RBAC cannot scope `create` by name, so the server pre-creates the
three outputs empty and the proxy's Role grants `update`/`patch` on exactly
those names. Its reads are `get`/`list`/`watch` on Secrets and ConfigMaps
namespace-wide, which is why the install namespace holds only yaac's own
objects. The HTTP control API on the proxy's port is only `/healthz`.

## yaac-mama

A workspace pod's `yaac-mama` calls POST to `http://yaac.internal/api/workspace/mama`
as plain HTTP, like any egress. The proxy routes on the Host header before
the allowlist check, so the call always works, and relays it to the server's
mama listener (`MAMA_RELAY_URL`, the `yaac-server-mama` Service). It names
the caller in `x-yaac-workspace-id`, from the relay's header as for any
egress, and authenticates with its auth secret, which the server compares
against the `yaac-proxy-auth` Secret. That listener serves nothing else, so
the server's ingress policy can admit the proxy to it without admitting the
proxy, and the workspace traffic it forwards, to the API
(docs/server-in-cluster.md "The ingress policy is the wall"). The server
alone decides what a command may do (`runMamaCommand`, on the API's routes
as the workspace's delegate); the proxy checks nothing about it.

The same relay carries a pod's git to the remote of a project the server
hosts, at `http://yaac.internal/api/workspace/git/<project id>.git`
(docs/hosted-projects.md). The proxy forwards only those smart-HTTP paths,
with the headers git needs (`yaac-relay.ts`). The server checks that the
named workspace belongs to that project.

A public site's release reaches neither, nor does an image build. The proxy
answers 403 to any `yaac.internal` request whose registration says
`release` or is a build's, and the server refuses a relayed call naming a
release, so code facing the internet never acts on yaac
(docs/public-sites.md).

## Tailnet sites

A workspace cannot reach a tailnet site (docs/public-sites.md "Tailnet
sites"), just as it cannot reach an unpublished one. Only the tailnet
tunnel stamps a caller's login, and a workspace is not on the tailnet.

The proxy treats a name under the site domain as any other host: the
allowlist applies, and then the name goes wherever it resolves, which is
never the router. A public answer reaches the internet. A tailnet or
private one (a node on the tailnet with split DNS resolves the zone to the
tailnet tunnel's `100.x` address) is refused by the non-public guard unless
an exact entry names it. Even then the dial is dropped by policy: the
proxy's egress policy names no edge pod and its wide rule leaves out every
non-public address, and the router admits only the tailnet tunnel on its
tailnet port. So allowing the router's address exactly opens no way
either; the workspace gets the non-public timeout's 502.

## CA trust in a workspace

A workspace must trust the proxy's MITM CA for the hosts it intercepts, and
the real public roots for the hosts it tunnels untouched. CA settings come in
two incompatible shapes, and `getCaTrustEnv`
(`drivers/k8s/egress/proxy-client.ts`) sets both on every workspace pod:

- **Additive** variables add the proxy CA to the image's roots:
  `SSL_CERT_FILE` (OpenSSL still reads `/etc/ssl/certs`) and
  `NODE_EXTRA_CA_CERTS`. They point at the bare proxy CA.
- **Replacing** variables name a single file that becomes the tool's whole
  trust set: `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`,
  `GIT_SSL_CAINFO`. These are the only settings curl, Python `requests`,
  Cargo and git honor.

Pointing a replacing variable at the proxy CA alone breaks every tunnelled
host (npm, PyPI, crates.io, distro mirrors). Pointing it at the public roots
alone breaks every intercepted host. It needs the union, so the replacing
variables point at a combined bundle of `{public roots} + {proxy CA}`:

- The roots come from the proxy image's `ca-certificates` package, so they
  stay current with no separate upkeep. `combineCaBundle(roots, ca)`
  (`k8s/proxy/ca-bundle.ts`) concatenates them, and the proxy writes the
  result as `ca-bundle.pem` next to its CA in the `yaac-proxy-ca` Secret on
  every boot.
- The server copies `proxy-ca.pem` (bare CA) and `ca-bundle.pem` (combined)
  from that Secret into the `yaac-proxy-ca` ConfigMap that workspace pods
  mount at `/etc/yaac/certs`, skipping the write when nothing changed. A
  roots update needs no image rebuild.

Tools that ignore both the OS store and every CA variable need their own
import: Java (its own `cacerts` keystore), rustls-based clients, and GnuTLS
`wget`.

## One host per MITM'd connection

A MITM'd connection is admitted, and has its credentials chosen, for one
host: the SNI or CONNECT target it arrived with (`k8s/proxy/mitm.ts`). The
proxy answers 421, and logs the refusal, to any request on it whose Host
header does not name that host, and to any absolute-form target
(`POST https://chatgpt.com/...`). Otherwise a request on a `chatgpt.com`
connection carrying `Host: evil.example` could go out with the real token to
a site that shares chatgpt.com's CDN. The upstream dial's TLS SNI and
certificate check are pinned to the admitted host as well, rather than taken
from the Host header.

## Non-public destinations

Two layers keep workspaces and builds off the cluster's internal network and
the cloud's metadata services. Reaching an internal address through the proxy
takes both: an exact entry for it in the project's allowlist, and the network
operator opening it. The two exceptions are below.

**The proxy refuses** (`k8s/proxy/upstream.ts`). Before every upstream dial a
workspace can steer (TLS, tunneled or MITM'd; plain HTTP; the SSH tunnel's
CONNECT), the proxy resolves the destination once and refuses it
if any address is not publicly routable. That is anything in the IANA IPv4
special-purpose registry (private, CGNAT, loopback, link-local,
documentation, benchmarking, multicast and the rest), plus Azure's
WireServer at 168.63.129.16, a metadata service on a public address. The
dial then goes to exactly the addresses checked, so a name that answers
differently the second time (DNS rebinding) cannot slip past.

A refused CONNECT or plain-HTTP request gets a 403 with the reason, and
TLS, which has nowhere to put one, is dropped. Both are logged.
A refusal is not recorded as a blocked host, since the allowlist did admit
it.

The exception is an **exact** allowlist entry for the host, a hostname or an
IPv4 address. Neither `*` nor a wildcard such as `*.corp.example` or
`store*.corp.example` admits a non-public address: a wildcard covers names in
zones others control, and plenty of public names answer privately (an AWS
internal load balancer under `*.amazonaws.com`, or CoreDNS's
`169-254-169-254.default.pod.cluster.local`).
An exact entry works beside `*`: a list holding both `*` and
`git.corp.example` admits any public destination and that one internal one.
A dial admitted this way:

- has a 5-second connect timeout, because the floor below drops it silently
  unless the operator opened it. Its error says so and points here;
- gets a connection of its own, outside the proxy's shared keep-alive pool,
  which is keyed by host and port, not by workspace.

Destinations the server names, not a workspace, are not checked: an e2e
upstream redirect's target, the mama relay, a registration's
`clusterServices`, and the proxy's own apiserver and DNS traffic. Under `USE_TOR`, a
destination Tor carries is not resolved locally, since that would leak the
name, and Tor dials from its exit, off the cluster's network. Internal names
and non-public addresses skip Tor and are checked like any direct dial.

**The network floor** (`wideEgress` in
`drivers/k8s/cluster/policy-manifests.ts`) is shared by the proxy's and
the server's egress policies, and the npm cache's on port 443 (the server's
peers are in docs/server-in-cluster.md "The server's own egress"). It allows public
addresses only: 0.0.0.0/0 less the same special-purpose ranges and
168.63.129.16, and IPv6 global unicast (2000::/3) less its special-purpose
blocks. That leaves out ULA, where AWS (fd00:ec2::254) and GCE
(fd20:ce::254) serve IPv6 metadata and the EKS Pod Identity agent answers
at fd00:ec2::23, and link-local. Every address a node answers on is cut as
well, each from its own family's block: its InternalIP, Calico tunnel
address and ExternalIPs (`nodeAddressBlocks`). A cloud node's ExternalIP is
public, and a pod dialing its own node's is delivered locally, past any
cloud firewall. The policies are re-rendered as nodes join (node-sync). The
floor allows back only what yaac needs:

- DNS on port 53: the cluster resolver by selector (`k8s-app: kube-dns` in
  `kube-system`), that Service's own ClusterIP, and 169.254.0.0/16. The last
  two are for NodeLocal DNSCache. In kube-proxy-iptables mode it answers on
  the ClusterIP and skips kube-proxy's DNAT, so no selector matches; in IPVS
  mode it answers on a link-local address;
- for the proxy, the nodes, on every port but NFS and the kind fronting's
  (docs/server-in-cluster.md "The ingress policy is the wall"), so that an
  allowlist entry may name one;
- for the proxy, the server's mama listener, the npm cache and the main
  registry's pod port by selector, and the apiserver its watches read, at
  the real endpoints the `kubernetes` Service's EndpointSlices list (re-read
  by node-sync, so a moved control plane is followed);
- for the server, the main registry's pod port by selector, for the tag
  checks it makes.

Selector rules also match a dial to a Service address, because policy sees
the destination after kube-proxy's DNAT. The gateway Calico gives every pod
(169.254.1.1, and an fe80:: address on IPv6) is a next hop, not a
destination, so the floor does not affect it.

The proxy's allowances above are where "takes both" does not hold. An exact
allowlist entry naming the *address* of the npm cache or of the registry's
pod port reaches it, since the proxy's policy admits both and the guard's
exact-entry exception applies (by name, `isInstallServiceName` refuses
them). That exposes the cache, which serves public packages, and the
registry's pod port, which serves a protected repo only to a grant. The
three that are not selectors are the others. An exact allowlist entry naming
a node address reaches it, on any port but NFS and the fronting's, with no
operator opening; a CONNECT through the SSH sentinel chooses its port, so that
includes the kubelet and, on kind and k3s, the apiserver. An exact entry
naming the apiserver reaches it on its port wherever it runs, off the nodes
too (as on a managed control plane): its Service name
(`kubernetes.default.svc.cluster.local`), its ClusterIP or one of its
endpoint addresses, since policy sees the endpoint after kube-proxy's
rewrite. A workspace holds no API
credential, so it reaches the apiserver only as an anonymous client. An
exact entry naming a DNS address reaches port 53 on it. Under `*` the proxy
refuses all three, as it does every non-public address.

**What this changes for an existing install.** A `*` workspace is refused a
public name that resolves privately. A name that worked silently before now fails:
AWS interface VPC endpoints with private DNS (ECR, S3, STS and the rest),
Azure Private Link, corporate mirrors and git servers. Each needs an exact
allowlist entry and an operator opening, below.

### IPv4 only

The proxy dials IPv4 only. It refuses an IPv6 destination outright, so
`http://[fd00::5]/` or a CONNECT to `[2606:4700::1111]:22` gets a 403. A
name is resolved to its IPv4 addresses only. An allowlist cannot name an IPv6
address either: an entry may hold only letters, digits, `.`, `-`, `_` and
`*`. A sandbox could not send IPv6 anyway: only `::1` has a route, and
netshim's stub answers A queries only, so a workspace never learns an IPv6
address to dial.

### HTTPS to an IP address

A request to `https://10.20.0.5/` does not work, whatever the allowlist
says. TLS clients send no SNI for an IP address, and the proxy routes TLS
by SNI alone, so it drops a ClientHello without one. Plain
HTTP (routed by the Host header) and SSH (by the CONNECT target) reach an
allowlisted address. For HTTPS, allowlist a hostname that resolves to it, in
the proxy's DNS, and use that name.

An allowlist entry and the destination are compared in one spelling: the
destination is read as a URL parser reads it, so `0x0a.20.0.5` or
`169082885` match the entry `10.20.0.5`, and names are lowercased.

### In-cluster names

Every name resolves to the sinkhole inside a sandbox, in-cluster names
included, so every in-cluster name goes through the proxy. The install's own
Services, and the main registry's, are refused by name unless a
registration's `clusterServices` holds them ("The npm cache and the main
registry"). Any other, such as `http://internal-web.other.svc.cluster.local/`,
is treated like `git.corp.example`: refused and recorded as a blocked host
when no entry covers it, refused as non-public under `*` or a wildcard, and
dialed under an exact entry, reaching the Service once the operator opens it
to the proxy (below). As for any name, only HTTP on any port, HTTPS on 443
and SSH through the sentinel get through; a database on its own protocol
does not.

### Opening an internal destination

Only the network operator can open one, by applying a NetworkPolicy of their
own in yaac's namespace. NetworkPolicy allows add up across every policy that
selects a pod, so a separate policy selecting the proxy (`app: yaac-proxy`)
or the server (`app: yaac-server`) widens their egress without touching
yaac's. Builds go through the proxy like workspaces, so an internal mirror a
build needs is opened for the proxy and named in the project's allowlist,
exactly as for a workspace. yaac never writes, prunes or deletes a policy it does not own, so the
opening survives server restarts and reinstalls (`yaac cluster delete`
removes it with the namespace). Creating one takes kubectl access to the
namespace, which no workspace has.

An opening admits nothing on its own: the project's allowlist must still
hold an exact entry for the destination, which may sit beside `*` but is
not replaced by it or a wildcard. For an internal git server at `git.corp.example` (10.20.0.5):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: operator-git-internal
  namespace: yaac
spec:
  podSelector:
    matchLabels:
      app: yaac-proxy
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock:
            cidr: 10.20.0.5/32
      ports:
        - protocol: TCP
          port: 443
```

and `git.corp.example` in the project's allowlist. The server clones and
fetches the project's remote itself, so for a project whose remote is that
server, the same policy must also select `app: yaac-server`: use
`podSelector: {matchExpressions: [{key: app, operator: In, values:
[yaac-proxy, yaac-server]}]}`.

An in-cluster Service is opened the same way. Policy sees the destination
after kube-proxy's rewrite, so the opening names the Service's pods and
their port, not its ClusterIP and Service port:

```yaml
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: internal
          podSelector:
            matchLabels:
              app: internal-web
      ports:
        - protocol: TCP
          port: 8080
```

with `internal-web.internal.svc.cluster.local` in the allowlist.

On GCP, a project whose workspaces need the metadata server (for workload
credentials, say) opens it for the proxy:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: operator-gce-metadata
  namespace: yaac
spec:
  podSelector:
    matchLabels:
      app: yaac-proxy
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock:
            cidr: 169.254.169.254/32
      ports:
        - protocol: TCP
          port: 80
```

and names `metadata.google.internal` in its allowlist. Every workspace of
every project whose allowlist names it then reads what the metadata server
hands the node, so open it only where that is what is wanted. That includes
minting the node's service-account identity tokens for any audience, so on a
cluster where it is open, never bind a node's service account to a yaac
token binding (docs/remote-hosting.md "Token access"): any of those
workspaces could act as the binding's user. Never open it on Hetzner, where
a worker's metadata holds the cluster join token
(infra/hetzner-k3s/README.md "Security notes").

**A model server on a tailnet.** A custom endpoint at a MagicDNS name such
as `http://gpu-box.tail1234.ts.net:8080/v1` resolves to a `100.x` (CGNAT)
address, so it takes all three of: an exact allowlist entry
`gpu-box.tail1234.ts.net` in the project; a policy like the one above
opening the endpoint's address (or `100.64.0.0/10`) on its port, here 8080;
and a way for the proxy to resolve the name. The proxy resolves through
CoreDNS, which forwards to the node's resolver and does not see MagicDNS, so
add a server block for the tailnet's zone to the `coredns` ConfigMap in
`kube-system`:

```
tail1234.ts.net:53 {
    forward . 100.100.100.100
}
```

This needs `tailscaled` on the host, so the node can route to tailnet
addresses. Port 8080 needs nothing more, since plain HTTP is routed by its
Host header on any port. yaac
never writes CoreDNS, so on kind the edit survives `yaac cluster install`.
k3s re-applies its packaged CoreDNS on restart; put the block in the
`coredns-custom` ConfigMap there instead, under a key like `tailnet.server`.
With `infra/hetzner-k3s`, list the zone in its `tailnet_dns_zones`
variable, which writes that key into the ConfigMap its `cluster.tf` owns.

Where `tailscaled` runs on the node itself rather than outside it (as it
does for kind, through the machine hosting it), Calico's iptables mark bits
must stay off `0xff0000`, which tailscaled claims. With Felix's default mask
(`0xffff0000`), a scratch bit Calico leaves on a pod's packet matches
Tailscale's bypass rule (`fwmark 0x80000/0xff0000 lookup main`), and the
pod's traffic to the tailnet leaves by the public interface and times out.
Set `iptablesMarkMask` on the `default` FelixConfiguration to bits nothing
else on the node uses and that clear bit 31, which the CRD's int32
validation rejects: `infra/hetzner-k3s` sets `0x7f000f00`
(`felix_manifest` in its `cluster.tf`).

The e2e suites open their mock pods to the proxy the same way
(`openToProxy` in `test/support/cluster.ts`).

## Plain NetworkPolicy only

yaac depends on no CRD-based policy: every policy is plain
`networking.k8s.io/v1` NetworkPolicy, which every engine enforces, Cilium
and provider-managed Calicos included. A `--byo` cluster needs only that
NetworkPolicy be enforced, which `yaac cluster check` probes
(docs/cluster-setup.md).

Where plain NetworkPolicy cannot select a peer by label, it uses an `ipBlock`
CIDR resolved at apply time (`cluster-cidrs.ts`):

- "the node", for anything arriving from the host network namespace
  (kubelet probes, containerd registry pulls);
- the apiserver's real **endpoint** addresses, never its Service VIP, because
  NetworkPolicy matches the destination after DNAT.

## Operational notes

- **Several installs can share a node** (the real `yaac` install and each
  e2e run's `yaac-test-<run-id>` install). Each has its own socket root
  (`/var/lib/yaac/sockets/<install key>`) and its own netd, whose relay
  binds sockets only beneath it and whose listeners are pod ports, not node
  ports, so installs never see each other's sandboxes.
- **Triage.** `kubectl -n <ns> logs ds/yaac-netd -c relay` shows refused
  headers, proxy dial failures and reconcile errors; `-c netd` the swap
  bounds and pressure kills. On the node, `ls -l
  /var/lib/yaac/sockets/<install key>/*` shows each sandbox's sockets. Inside
  a sandbox, `ip route` shows `0.0.0.0/0 dev lo`, and netshim's container
  logs show its setup commands.
