# Workspace egress

Every workspace pod is denied network access by default and reaches the
internet only through the yaac MITM proxy, which enforces a per-workspace
allowlist. The one exception is the install's npm cache (below), which serves
public npm packages directly.

Two components share the work:

- **Calico** (pinned by checksum in `k8s/calico/`, installed by
  `yaac cluster install`) is the CNI and the policy engine. It enforces every
  allow and deny, written as plain `networking.k8s.io/v1` NetworkPolicy.
- **netd** (`k8s/netd/`, a DaemonSet) only *redirects*: it steers a
  workspace's outbound 443, 80, SSH-sentinel and DNS-sinkhole traffic into
  the proxy. It
  decides nothing about what is allowed. (It also writes each pod's swap
  bound, a job unrelated to egress: docs/cluster-setup.md "Memory
  pressure".)

This split is the security argument. netd's rules can only add a path toward
the proxy, so if netd is down, late or wrong, workspaces lose egress rather than
gain it. Denies come from Felix (Calico's node agent) and kernel netfilter,
audited upstream code.

## The datapath

For a workspace pod whose host-side veth is `caliXXXX`, netd programs one chain
in the node's root network namespace:

```
nat YAAC_RDR_<install>:
  -d <podCIDR>                               -j RETURN     (once per CIDR)
  ...
  -i caliXXXX -p tcp --dport 443             -j DNAT --to <node>:<H>
  -i caliXXXX -p tcp --dport 80              -j DNAT --to <node>:<T>
  -i caliXXXX -p tcp -d 198.18.0.2 --dport 10259
                                             -j DNAT --to <node>:<S>
  -i caliXXXX -p tcp -d 198.18.0.1           -j DNAT --to <node>:<T>
```

The pod-CIDR RETURNs come first, so in-cluster traffic leaves the chain before
any DNAT rule matches. They are separate RETURN rules rather than `! -d` on each
rule because iptables allows one destination per rule and a cluster can have
several pod CIDRs.

`H`, `T` and `S` are the node-local **listener trio**: three ports, one trio per
install, shared by every pod it redirects. A co-located Envoy recovers the
original destination with the `original_dst` listener filter (`SO_ORIGINAL_DST`,
from conntrack) and forwards to the proxy's transparent port, prefixed with a
PROXY protocol v2 header carrying the pod's real source IP. The proxy maps that
IP to a workspace through its pod watch, then routes by TLS SNI or Host header.

The last rule is for plain HTTP on other ports (`http://box:8080`). The
proxy's DNS stub answers every name but the install's own Services
("In-cluster names" below) with the sinkhole `198.18.0.1` (`DNS_SINKHOLE`),
a benchmark-range address nothing lives at, so a pod dials a name on any
port as a connection to the sinkhole. The rule sends that to the plain-HTTP
listener, which takes its destination, port included, from
the Host header, exactly as for port 80. It adds no reach: a request on port
80 with `Host: box:8080` already gets there, and the allowlist and the
non-public guard apply unchanged. It comes after the 443 and 80 rules, so
those ports still reach their own listeners. A connection to a real address
on another port matches nothing and is dropped as before. Anything other
than HTTP sent to the sinkhole fails at the listener when the client speaks
first. A client that waits for the server to speak first, as ssh, MySQL and
SMTP do, hangs until it gives up: the listener sets no headers timeout, and
netd's Envoy closes an idle connection only after an hour.

Identity comes from **which veth the packet arrived on**, not its source IP,
because a sandboxed workload cannot forge the interface. A gVisor guest cannot
emit raw frames at all, and under runc Felix's per-endpoint anti-spoofing and
`rp_filter` cover it.

netd finds a pod's veth from the host route Calico installs for each workload
(`<podIP> dev caliXXXX scope link`); the `WorkloadEndpoint` resource needs the
optional Calico apiserver, which yaac does not install.

The `cali` prefix is configurable (`NETD_VETH_PREFIX`, set by the server from
`YAAC_CNI_VETH_PREFIX`), because policy-only Calico over the AWS VPC CNI uses
`eni*`. An empty or unusable value falls back to `cali`, never to "any device":
a prefix that matches nothing only costs egress, while a wildcard could let a
malformed routing table redirect a node interface.

## Why DNAT and not TPROXY

**netd must never compete with Felix for iptables chain position.** Felix
re-inserts its jumps at the top of each base chain it manages on every
reprogram, so a yaac rule that must run before `cali-*` is pushed down at the
next resync. (After a `calico-node` restart, a mangle PREROUTING TPROXY rule and
a filter INPUT accept both ended up below the Calico jumps, and every workspace
lost egress.) A TPROXY'd flow is delivered locally, so it takes the
workload-to-host INPUT path (`cali-INPUT -i cali+ -g cali-wl-to-host →
cali-from-wl-dispatch → cali-fw-<iface>`), where the pod's *egress* policy drops
it unless an accept sits above `cali-INPUT`, which is that same fight.

`nat PREROUTING` has no such conflict. Calico's `cali-PREROUTING` there is an
empty floating-IP DNAT chain that terminates nothing, so netd simply
**appends** its jump. NAT also applies only to a flow's first packet; conntrack
replays the translation and reverses it on replies. That removes all the TPROXY
plumbing (fwmark, `-m socket`, policy route, `accept_local`, `src_valid_mark`).

Appending also places the jump after kube-proxy's `KUBE-SERVICES`, whose DNAT
terminates, so ClusterIP traffic never reaches the redirect. With the pod-CIDR
RETURNs, that limits the redirect to traffic bound outside the cluster.

## Fail-closed

A workspace's NetworkPolicy has exactly one rule toward the outside: the node,
on netd's reserved listener port range. There is no rule for 443 or 80 to the
internet. A pod whose redirect netd has not yet programmed keeps its original
destination, takes the FORWARD path, matches no allow, and is dropped.

At pod birth Felix blocks traffic on its own: until it has programmed a
workload's endpoint, traffic on that veth hits the `"Unknown interface" -j DROP`
in `cali-from-wl-dispatch`.

Allowing the listener range opens no hole. Those ports reach Envoy, which stamps
the connection's real peer address however it arrived, so a pod dialing a
listener directly gets exactly what its redirected traffic would get and cannot
impersonate another workspace. The proxy's transparent ports accept only the
**node CIDRs**, so pods cannot reach them and only Envoy can send PROXY protocol
headers.

**Probe egress with real requests, not connects.** Because 443 and 80 are
DNAT'd, a bare TCP connect to any address on those ports succeeds (against the
node's Envoy), as does one to any name on any port, since names resolve to
the sinkhole. `nc -z 1.1.1.1 443` therefore reports a false "reachable".
Assert on a completed request (the proxy refuses a host no allowlist admits).
To test the NetworkPolicy layer, use a real address on a port that is not
redirected, where the default-deny answers.

## The direct pod→proxy dial

One flow addresses the proxy pod directly instead of being redirected: **DNS**,
udp/53. The proxy's split-horizon stub is the pod's only resolver
(`dnsPolicy: None`), and the workspace policy allows the dial by selector
(`podSelector: app=yaac-proxy`), not through the node's listener range. It
does not reach outside the cluster or bypass the allowlist.

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

A grant with `readOnly` passes only the requests known to read under its
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
`GIT_SSH_COMMAND` that reaches the proxy's tunnel listener through the
sentinel, as before, offers no identity, and trusts one host key under one
name (`HostKeyAlias=yaac-proxy`): the proxy's, which it mints once, keeps in
the `yaac-proxy-ca` Secret and the server publishes as `ssh_known_hosts` in
the ConfigMap every pod mounts beside the CA. The workspace holds no key and
no agent socket. A pod's ssh settings are fixed at launch, so one that
trusts anything else needs a restart (docs/legacy-compat-shims.md "Pods
whose ssh trusts the git host").

For a `CONNECT` to port 22 of a host the workspace's project has an ssh grant
on, after the allowlist and the non-public guard, the proxy answers as the
ssh server. The workspace is already identified by its source address, so
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

## The npm cache: an exception to the allowlist

One more pod can be dialed directly: the install's npm cache
(`drivers/k8s/cluster/npm-cache.ts`, docs/workspace-storage.md "Package
installs"), on tcp/4873, which netd does not redirect. The cache fetches from
`registry.npmjs.org` itself, not through the proxy, so what it serves reaches a
workspace outside that workspace's allowlist.

Why that is acceptable: it only brings npm content **in**. What goes out is
package names (and `npm audit` bodies, and requests for npm's signing keys and
attestations) sent to npmjs. Verdaccio serves a tarball
only from a URL its upstream's own metadata named, forwards no credentials
upstream, and accepts no publishes.

Access is per project, so it is not in the install-wide workspace policy. The
cache's own policies (egress on the workspace side, ingress on the cache) allow
only workspace pods labelled `yaac.npm-cache`, which the server sets at launch.
A workspace pod holds no API credential, so it cannot add the label itself. A
pod gets the label unless its project sets `npmCache: false`, its allowlist
leaves out `registry.npmjs.org`, or its project authenticates to npmjs through
a proxied secret. Without the label, the pod can neither reach the cache nor is
configured to use it; its pnpm uses npmjs through the proxy like any other host.

A prewarmed spare is re-checked when it is claimed. If its project's current
config no longer allows the cache, the claim removes the cache from its
`~/.npmrc` and removes the label, so a narrowed allowlist takes effect for new
connections. The reverse is not re-checked: a spare warmed without the label
stays on npmjs, which is only slower.

## What the proxy is told, and how

The proxy pod mounts nothing from the host and keeps no state of its own. It
learns everything from Kubernetes objects it watches, and reports everything as
objects the server watches. All live in the install namespace, are labelled
`app: yaac-proxy`, and have exactly one writer and one reader:

| object | kind | writer | reader | content |
|---|---|---|---|---|
| `yaac-proxy-credentials` | Secret | server | proxy informer | per owner, keys prefixed `<owner>.`: `claude.json`, `codex.json`, `opencode.json`, `pi.json`, `omp.json` (each tool's host-store file verbatim, plus `apiHost` for opencode, pi and omp: the provider host the key is swapped in on; a signed-out tool has no key), `git-tokens.json` (`[{token, grants}]`) and `ssh-keys.json` (`[{privateKey, publicKey, grants}]`, the private key OpenSSH-encoded from the sealed seed). Each grant is `{projectId, repoId, host, path, readOnly, ghToken}`, an ssh key's with its `knownHostsEntry` (see "Git credentials") |
| `yaac-proxy-secrets-<project id>` | Secret, one per project | server | proxy informer | `values.json`: `{ "<project id>/<NAME>": value }`, the secret values behind that project's `secretRef` rules |
| `yaac-proxy-reg-<workspaceId>` | ConfigMap, one per workspace | server | proxy informer | `registration.json`: rules with `secretRef`s (never values), allowed hosts, project, owner, `identity` (the project owner's tailnet login and name; see "Tailnet sites"), test redirects |
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
driver on the launch intent and the claim's registration: a workspace
spends its project owner's credentials. A user's key is their user id,
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
- A registration is written before the workspace's Job, after `ensureRunning`
  (so a create never registers against a proxy that cannot see it). It is
  rewritten to widen it (the webapp's allow-host click, applied to all of the
  project's registrations by label) and rewritten whole when a prewarmed spare
  is claimed, from the project's current config, so edits since warm-up apply
  as they would to a cold create. It is deleted at teardown, and swept once its
  workspace is gone and it is an hour old.

**When a registration changes**, the proxy re-checks the workspace's open
tunnels and in-flight plain-HTTP requests (it checks the allowlist and picks
injection rules only once per tunnel or request). A connection whose host is no
longer allowed, or whose rules, redirect or exact entry (which alone admits
a non-public address) changed, is dropped and reconnects under the new
registration. Others stay up, so widening drops little, while a
warm-time process holding a tunnel across a narrowing claim loses it. The npm
cache is the exception: its policy keeps an established flow after the label is
removed, and that flow only brings npm content in.

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

Which endpoints a cluster workspace can reach follows from the datapath:

- `http://<name>:<any port>` and `https://<name>` on 443 work, given the
  allowlist entry (and, for a non-public address, the opening below).
- `https://<name>` on another port does not: the name resolves to the
  sinkhole, whose rule sends the TLS handshake to the plain-HTTP listener.
- An IP-literal URL never touches the sinkhole, so only ports 80 and 443
  are redirected, and HTTPS to an IP fails as described below. Use a name.

**RBAC.** RBAC cannot scope `create` by name, so the server pre-creates the
three outputs empty and the proxy's Role grants `update`/`patch` on exactly
those names. Its reads are `get`/`list`/`watch` on Secrets and ConfigMaps
namespace-wide, which is why the install namespace holds only yaac's own
objects. The HTTP control API on the proxy's port is only `/healthz`.

## yaac-mama

A workspace pod's `yaac-mama` calls POST to `http://yaac.internal/api/workspace/mama`
over its transparent HTTP egress. The proxy routes on the Host header before
the allowlist check, so the call always works, and relays it to the server's
mama listener (`MAMA_RELAY_URL`, the `yaac-server-mama` Service). It names
the caller in `x-yaac-workspace-id`, from the source pod IP as for any
egress, and authenticates with its auth secret, which the server compares
against the `yaac-proxy-auth` Secret. That listener serves nothing else, so
the server's ingress policy can admit the proxy to it without admitting the
proxy, and the workspace traffic it forwards, to the API
(docs/server-in-cluster.md "The ingress policy is the wall"). The server
alone decides what a command may do (`runMamaCommand`); the proxy checks
nothing about it.

The same relay carries a pod's git to the remote of a project the server
hosts, at `http://yaac.internal/api/workspace/git/<project id>.git`
(docs/hosted-projects.md). The proxy forwards only those smart-HTTP paths,
with the headers git needs (`yaac-relay.ts`). The server checks that the
named workspace belongs to that project.

A public site's release reaches neither. The proxy answers 403 to any
`yaac.internal` request from a pod labelled `yaac.site-id`, and the server
refuses a relayed call naming a release, so code facing the internet never
acts on yaac (docs/public-sites.md).

## Tailnet sites

A tailnet site (docs/public-sites.md "Tailnet sites") is served under the
install's site domain, which a workspace pod can neither resolve nor reach:
it is not on the tailnet. The proxy carries its requests to the site
router's tailnet listener instead and says who the workspace's owner is,
so an agent reaches the same URL a person opens and acts as its owner. The
server hands the proxy the domain and the listener's address (`SITE_DOMAIN`,
`SITE_ROUTER`) when it deploys it.

For a name under the domain the proxy (`k8s/proxy/dispatch.ts`):

1. checks the allowlist. A project reaches a tailnet site only if an entry
   names it or the whole zone (`*.apps.example.com`), because the request
   will carry its owner's identity: the entry is the owner's consent, as
   allowing `github.com` is consent to spend their git credential there. A
   bare `*` is not such an entry, so an unrestricted project reaches the
   internet but not its owner's tailnet apps. A refused attempt shows on the
   blocked-hosts badge, where one click allows it.
2. ends the workspace's TLS with a leaf for the hostname, on whatever port
   the connection named, and sends each request and WebSocket upgrade as
   plain HTTP to the router's 8081 with `Host` unchanged. The destination
   is the server's choice, so the non-public guard does not apply, as for
   the mama relay. It never takes a direct dial.
3. drops every `Tailscale-*` and `X-Forwarded-*` header the workspace
   sent, then sets `Tailscale-User-Login` and `Tailscale-User-Name` from the
   registration's `identity`. It does this after every injection, so a
   project secret's rule naming one of these headers cannot override it.

A workspace with no identity (a release, or a workspace whose owner has no
tailnet login) gets a 403 from the proxy, which dials nothing. A plain-HTTP
request to a tailnet site is refused with a 403 naming its `https://` URL,
since the login would travel unencrypted. `#domain/workspaces` hands the
identity down with the rest of the registration, and a workspace
registered before an owner had a login gets it at its next restart.

**The reserved port.** The proxy is admitted to the router's 8081 (its
egress policy names router pods there by selector), and it also dials
whatever a workspace's allowlist names. A project whose allowlist held an
exact entry for the router's address could otherwise dial `<router>:8081`
itself and send any `Host` and any login, and policy cannot tell that dial
from the site route, since both come from the proxy. So `resolveUpstream`
refuses a non-public address on that port whatever the allowlist says, on
every dial path. Only the site route, whose target the proxy names itself,
reaches it.

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
workspace can steer (transparent HTTPS, tunneled or MITM'd; plain HTTP; the
SSH tunnel's CONNECT), the proxy resolves the destination once and refuses it
if any address is not publicly routable. That is anything in the IANA IPv4
special-purpose registry (private, CGNAT, loopback, link-local,
documentation, benchmarking, multicast and the rest), plus Azure's
WireServer at 168.63.129.16, a metadata service on a public address. The
dial then goes to exactly the addresses checked, so a name that answers
differently the second time (DNS rebinding) cannot slip past.

A refused CONNECT or plain-HTTP request gets a 403 with the reason, and
transparent TLS, which has nowhere to put one, is dropped. Both are logged.
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
upstream redirect's target, the mama relay, the stream relay into a workspace
pod, and the proxy's own apiserver and DNS traffic. Under `USE_TOR`, a
destination Tor carries is not resolved locally, since that would leak the
name, and Tor dials from its exit, off the cluster's network. Internal names
and non-public addresses skip Tor and are checked like any direct dial.

**The network floor** (`wideEgress` in `drivers/k8s/cluster/policy-manifests.ts`)
is shared by the proxy's, the builder pods' and the server's egress policies
(the server's peers are in docs/server-in-cluster.md "The server's own
egress"). It allows
public addresses only: 0.0.0.0/0 less the same special-purpose ranges and
168.63.129.16, and IPv6 global unicast (2000::/3) less its special-purpose
blocks. That leaves out ULA, where AWS (fd00:ec2::254, and EKS Pod Identity
at fd00:ec2::23) and GCE (fd20:ce::254) serve IPv6 metadata, and
link-local. Every address a node answers on is cut as well, each from its
own family's block: its InternalIP, Calico tunnel address and ExternalIPs
(`nodeAddressBlocks`). A cloud node's ExternalIP is public, and a pod
dialing its own node's is delivered locally, past any cloud firewall. The
policies are re-rendered as nodes join (node-sync). The floor allows back
only what yaac needs:

- DNS on port 53: the cluster resolver by selector (`k8s-app: kube-dns` in
  `kube-system`), that Service's own ClusterIP, and 169.254.0.0/16. The last
  two are for NodeLocal DNSCache. In kube-proxy-iptables mode it answers on
  the ClusterIP and skips kube-proxy's DNAT, so no selector matches; in IPVS
  mode it answers on a link-local address;
- for the proxy, the nodes, on every port but NFS and the kind fronting's
  (docs/server-in-cluster.md "The ingress policy is the wall"), so that an
  allowlist entry may name one. Builders reach no node address;
- for the proxy, the server's mama listener and workspace pods' streamd by
  selector, and the apiserver its watches read, at the real endpoints the
  `kubernetes` Service's EndpointSlices list (re-read by node-sync, so a
  moved control plane is followed);
- for builders, the main registry by selector, which their parent pulls,
  pushes and step cache all use.

Selector rules also match a dial to a Service address, because policy sees
the destination after kube-proxy's DNAT. The gateway Calico gives every pod
(169.254.1.1, and an fe80:: address on IPv6) is a next hop, not a
destination, so the floor does not affect it.

The proxy's three allowances above that are not selectors are where
"takes both" does not hold. An exact allowlist entry naming a node address
reaches it, on any port but NFS and the fronting's, with no operator
opening; a CONNECT on the SSH tunnel listener chooses its port, so that
includes the kubelet and, on kind and k3s, the apiserver. An exact entry
naming the apiserver reaches it on its port wherever it runs, off the nodes
too (as on EKS): its Service name (`kubernetes.default.svc.cluster.local`),
its ClusterIP or one of its endpoint addresses, since policy sees the
endpoint after kube-proxy's rewrite. A workspace holds no API
credential, so it reaches the apiserver only as an anonymous client. An
exact entry naming a DNS address reaches port 53 on it. Under `*` the proxy
refuses all three, as it does every non-public address.

**What this changes for an existing install.** A `*` workspace is refused a
public name that resolves privately, and builders can no longer reach
private addresses at all. A name that worked silently before now fails:
AWS interface VPC endpoints with private DNS (ECR, S3, STS and the rest),
Azure Private Link, corporate mirrors and git servers. Each needs an exact
allowlist entry and an operator opening, below.

### IPv4 only

The proxy dials IPv4 only. It refuses an IPv6 destination outright, so
`http://[fd00::5]/` or a CONNECT to `[2606:4700::1111]:22` gets a 403. A
name is resolved to its IPv4 addresses only. An allowlist cannot name an IPv6
address either: an entry may hold only letters, digits, `.`, `-`, `_` and
`*`. The datapath could not deliver IPv6 anyway: netd redirects IPv4 only,
and the proxy's DNS stub answers A queries only, so a workspace never
learns an IPv6 address to dial.

### HTTPS to an IP address

A request to `https://10.20.0.5/` does not work, whatever the allowlist
says. TLS clients send no SNI for an IP address, and the transparent HTTPS
listener routes by SNI alone, so it drops a ClientHello without one. Plain
HTTP (routed by the Host header) and SSH (by the CONNECT target) reach an
allowlisted address. For HTTPS, allowlist a hostname that resolves to it, in
the proxy's DNS, and use that name.

An allowlist entry and the destination are compared in one spelling: the
destination is read as a URL parser reads it, so `0x0a.20.0.5` or
`169082885` match the entry `10.20.0.5`, and names are lowercased.

### In-cluster names

The proxy's DNS stub resolves a real address for one set of names: Services
in the install's own namespace (`<name>.<namespace>.svc.cluster.local`).
The server hands workspaces one of them, the npm cache, which a workspace
dials directly under its own label-scoped policies. Every Service there is
yaac's, and a dial to one no such policy admits is dropped.

Every other name gets the sinkhole, in-cluster names included. So
`http://internal-web.other.svc.cluster.local/` goes through the proxy like
`git.corp.example`: refused and recorded as a blocked host when no entry
covers it, refused as non-public under `*` or a wildcard, and dialed under
an exact entry, reaching the Service once the operator opens it to the
proxy (below). A real ClusterIP would be dialed past the proxy instead:
kube-proxy rewrites it to a pod address, which netd does not redirect, and
the workspace's egress policy drops it, a timeout no allowlist entry could
fix. As for any name, only HTTP on any port, HTTPS on 443 and SSH through
the tunnel listener get through; a database on its own protocol does not.

### Opening an internal destination

Only the network operator can open one, by applying a NetworkPolicy of their
own in yaac's namespace. NetworkPolicy allows add up across every policy that
selects a pod, so a separate policy selecting the proxy (`app: yaac-proxy`),
builders (`yaac.role: builder`) or the server (`app: yaac-server`) widens
their egress without touching yaac's. yaac never writes, prunes or deletes a policy it does not own, so the
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
[yaac-proxy, yaac-server]}]}`. Builds that need an
internal package mirror get the same kind of policy with `podSelector:
{matchLabels: {yaac.role: builder}}`. Builds do not pass through the proxy,
so the opening alone admits them.

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
hands the node, so open it only where that is what is wanted. Never open it
on Hetzner, where a worker's metadata holds the cluster join token
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
addresses. Port 8080 needs nothing more, by the sinkhole rule above. yaac
never writes CoreDNS, so on kind the edit survives `yaac cluster install`.
k3s re-applies its packaged CoreDNS on restart; put the block in the
`coredns-custom` ConfigMap there instead, under a key like `tailnet.server`.
With `infra/hetzner-k3s`, list the zone in its `tailnet_dns_zones`
variable, which writes that key into the ConfigMap its `cluster.tf` owns.
With `infra/aws-eks`, add it to the `corefile` its `main.tf` gives the
CoreDNS add-on, which replaces any edit made in the cluster.

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

## Which pods are redirected

netd has exactly **one** rule, recomputed on every relevant watch event: a
workspace pod (label `yaac.workspace-id`, never the proxy itself) in **this
install's own namespace** is redirected to this install's proxy. Nothing else
on the node is redirected.

netd watches only its own namespace, by label selector, so installs that share
a node stay out of each other's traffic and netd needs no cluster-wide access:
a namespaced Role grants it `get`/`list`/`watch` on pods and Services there,
where every object is created by yaac and no workspace can write one.

The redirect target is the proxy **Service's ClusterIP**, read from that same
namespace. Until the Service exists netd redirects nothing.

Envoy admits a connection by matching its source pod IP against the listener's
filter chain (`filter_chain_match.source_prefix_ranges`). All three listeners
are shared by every workspace pod, so pods come and go without moving a port.
That matters because conntrack pins a flow's DNAT destination on its first
packet, and moving a port under a live flow would strand it. A source netd has
not programmed matches no filter chain, and Envoy closes the connection, the
same result as a missing DNAT rule.

netd chooses its trio once per netd pod. It probes ports in a hash-derived order
over the reserved range, takes the first trio nothing else on the node holds,
and saves the choice next to the Envoy config, so a restarted netd container
cannot move to a different trio while its Envoy still holds the old one.

## What this datapath requires of a CNI

The redirect is netfilter, so the CNI must let pod egress **reach host
netfilter at the veth peer**, and kube-proxy must still handle ClusterIP
translation (netd's Envoy dials the proxy's ClusterIP from the host network
namespace). So:

- **Cilium is incompatible.** Its eBPF host routing (`bpf_redirect_peer`) skips
  the host stack, so packets never reach host netfilter and netd's rule never
  sees them, with no error. `bpf.hostLegacyRouting` restores netfilter, but
  Cilium's tc-ingress `from-container` program still runs before PREROUTING and
  may consume the packet, and `kubeProxyReplacement` breaks the ClusterIP dial.
  No supported configuration guarantees the redirect sees all pod egress.
- **kindnet is unusable** for a different reason: its NetworkPolicy engine
  allows all traffic at pod birth until policy is applied, so a workspace would
  start with a window of unrestricted egress.
- **Calico's own eBPF dataplane** (`FelixConfiguration.bpfEnabled`, or
  `FELIX_BPFENABLED` on the calico-node container) bypasses iptables for pod
  traffic just as Cilium does, and can be enabled on a Calico install that
  otherwise looks usable.

The **policy** half has no such constraint: plain NetworkPolicy is enforced
natively by every engine, including Cilium. Only the redirect depends on the
CNI.

`yaac cluster install --byo` (installing into a cluster whose CNI yaac did not
install) refuses eBPF mode outright, along with a replaced kube-proxy, an empty
pod-CIDR set, and a veth prefix that matches no workload route. Each is a
refusal rather than a warning because each fails *silently*, as "workspaces
have no egress" or as a chain that counts packets and never takes effect. The
full list is in docs/cluster-setup.md, "The CNI gate".

## Managed-cloud portability

netd is the same everywhere; what varies is who runs the policy engine.

| Platform | Policy engine | Notes |
|---|---|---|
| local kind | **our Calico** (CNI + policy) | what `yaac cluster install` installs |
| GKE Standard, Dataplane V1 | **Google-managed Calico** (`--enable-network-policy`) | don't install our own. Dataplane V2 is opt-in at cluster creation, so a Standard cluster created without it uses the netfilter dataplane and works as-is |
| EKS (AWS VPC CNI) | **our Calico, policy-only mode** | do *not* use AWS's network-policy agent: it enforces via TC eBPF before netfilter, which would force allowing 443/80 to the internet in the workspace policy and lose the guarantee that a late netd means no egress. Its default mode also allows all traffic at pod birth |
| AKS (Azure CNI, non-Cilium) | **Microsoft-managed Calico** (`--network-policy calico`) | plain NetworkPolicy enforced natively |
| GKE Dataplane V2 / Autopilot, AKS-Cilium, DOKS | none | **out of scope**: they require Cilium (DOKS's cannot be replaced), which breaks the veth redirect. Autopilot also blocks the privileged DaemonSet netd needs |

Every row but the first is a `--byo` install, which leaves the cluster's CNI
alone after verifying the dataplane it will depend on (docs/cluster-setup.md).

## Plain NetworkPolicy only

yaac installs no Calico custom resources and depends on no CRD-based policy.
The provider-managed Calicos above treat Calico CRDs as unsupported, so relying
on one would split the policy model per provider.

Where plain NetworkPolicy cannot select a peer by label, it uses an `ipBlock`
CIDR resolved at apply time (`cluster-cidrs.ts`):

- "the node", for anything arriving from the host network namespace (netd's
  Envoy, kubelet probes, containerd registry pulls);
- the apiserver's real **endpoint** addresses, never its Service VIP, because
  NetworkPolicy matches the destination after DNAT.

## Operational notes

- **Pod CIDRs are discovered, not assumed.** `clusterPodCidrs()` unions
  explicit config (`YAAC_POD_CIDRS`), Calico's IPPools, and every node's
  `spec.podCIDR`, and passes the list to netd. IPPools matter because Calico
  allocates /26 blocks anywhere in its pool, so a pod's IP is often outside its
  node's `spec.podCIDR`; the config source is for a foreign IPAM that
  publishes neither. Too narrow is the dangerous direction (a pod IP outside the
  list has its pod-to-pod 443/80 redirected into the proxy), so sources are
  unioned, `disabled` IPPools are included (their pods keep their addresses),
  an unusable `YAAC_POD_CIDRS` entry is reported rather than dropped, and netd
  refuses an empty list. CIDRs are resolved at apply time, so one added to a
  live cluster needs a re-apply.
- **iptables backend.** netd detects at startup which backend (legacy or nft)
  holds Calico's chains; a kind node's `iptables` points at **legacy**. Writing
  to the wrong backend produces a chain that exists and counts packets but is
  never consulted, which looks exactly like a broken redirect.
- **Readiness means programmed.** netd writes its readiness marker only after a
  reconcile reaches the dataplane, and removes it on failure, so
  `yaac cluster check`'s `datapath` check cannot pass while netd is failing.
- **Several installs can share a node** (the real `yaac` install and each e2e
  run's `yaac-test-<run-id>` install each run a netd). Each owns its own nat
  chain (`YAAC_RDR_<hash of namespace>`, logged at startup) and PREROUTING
  jump, so they never flush each other's rules. Their Envoys use
  `--use-dynamic-base-id` and a unix-socket admin endpoint in their own config
  volume, since host-network siblings cannot all claim base-id 0 or one
  loopback port. Listener trios are bind-probed with
  `enable_reuse_port: false` (Envoy defaults to true, which would let two
  installs bind one trio and split its connections); a rejected listener is
  caught by the check below, and netd probes for another trio.
- **Reconcile is stateless.** Every pass recomputes the whole chain and Envoy
  config from cluster state and writes only on change, so there is no
  incremental state to drift, and a deleted pod simply stops appearing. The
  write-on-change memo records what netd *wrote*, not what the kernel *kept*,
  so a pass every 30 seconds discards it and rewrites. That, plus re-checking
  the PREROUTING jump every pass, repairs an external flush or deleted jump.
- **Envoy confirms before traffic moves.** Each pass reads `/config_dump` on the
  admin socket and waits until `ListenersConfigDump.version_info` (the version
  Envoy last applied) equals the one netd wrote and every listener on the trio
  is bound; only then does it touch netfilter and write the readiness marker.
  The per-listener `active_state.version_info` is not used: Envoy updates filter
  chains in place and leaves it at the creation version, so it would stall on
  every later pod change. A rejected listener is reported with Envoy's
  `error_state` details.
- **Triage.** `kubectl -n <ns> logs ds/yaac-netd -c netd` shows each
  pass's changes, the chain name and watch errors. On the node,
  `iptables-legacy -t nat -S <chain>` shows what is actually programmed, and
  `-S PREROUTING` shows which chain this install jumps to.
