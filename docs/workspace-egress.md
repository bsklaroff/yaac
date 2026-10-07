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
  workspace's outbound 443, 80 and SSH-sentinel traffic into the proxy. It
  decides nothing about what is allowed.

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
node's Envoy). `nc -z 1.1.1.1 443` therefore reports a false "reachable".
Assert on a completed request (the proxy refuses a host no allowlist admits).
To test the NetworkPolicy layer, use a port that is not redirected, where the
default-deny answers.

## The two direct pod→proxy dials

Two flows address the proxy pod directly instead of being redirected. The
workspace policy allows them by selector (`podSelector: app=yaac-proxy`), not
through the node's listener range:

- **DNS**, udp/53: the pod's only resolver (`dnsPolicy: None`), answered by the
  proxy's split-horizon stub.
- **ssh-agent**, tcp/10261: the proxy speaks the ssh-agent protocol here and
  relays to an agent running in its own pod. A workspace whose project has an
  SSH remote runs a socat forwarder (started by `yaac-workspace-init`) that
  exposes it as the UNIX socket `SSH_AUTH_SOCK` names, so the pod's ssh client
  is unmodified. Private keys stay in the proxy's memory.

How the agent is scoped:

- Each key is loaded once, with one `ssh-add -h <host>` per host any of its
  grants names. That is the union over every owner and project holding the
  key, so the agent's own constraint is only an outer bound.
- The relay parses both directions and narrows that bound to the workspace's
  grants: the keys its owner assigned to its project, each for the hosts that
  assignment names. An identities answer is rewritten to list just those
  keys. The relay records the host key of every `session-bind@openssh.com`
  the connection sends, and a sign request gets `SSH_AGENT_FAILURE` without
  reaching the agent unless its key is one of those, the connection has bound,
  and every bound host key is in that key's grant (matched against the
  grant's `knownHostsEntry`). Grants are read per message, so a reassignment
  applies to an open connection's next request.
- Besides list and sign, the relay allows only the session bind, which every
  OpenSSH client since 8.9 sends before asking for a signature. Add, remove,
  lock and every other extension are refused, so one workspace cannot lock or
  empty the agent every other workspace shares.
- The proxy checks each connection's source pod IP against its pod watch and
  refuses one it cannot place, or one whose workspace registered a non-SSH
  remote (the same condition under which the server sets `SSH_AUTH_SOCK`).

Neither dial reaches outside the cluster or bypasses the allowlist:
git-over-SSH still goes through the proxy's transparent tunnel listener like
any other egress. The agent port is allowed from the workspace selector only,
not from the node CIDRs. It is TCP rather than a UNIX socket on a shared host
directory because that would only work when the proxy and the workspace share a
node, which nothing guarantees.

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
| `yaac-proxy-credentials` | Secret | server | proxy informer | per owner, keys prefixed `<owner>.`: `claude.json`, `codex.json`, `opencode.json`, `pi.json` (each tool's host-store file verbatim, plus `apiHost` for opencode and pi: the provider host the key is swapped in on; a signed-out tool has no key), `git-tokens.json` (`[{token, projects}]`) and `ssh-keys.json` (`[{privateKey, publicKey, projects: [{projectId, host, knownHostsEntry}]}]`, the private key OpenSSH-encoded from the sealed seed). `projects` lists the ids of the projects a credential is assigned to: a token goes only to its project's https remote host (and, for github.com, `api.github.com`), and a workspace's agent connection sees only its project's keys |
| `yaac-proxy-secrets-<project id>` | Secret, one per project | server | proxy informer | `values.json`: `{ "<project id>/<NAME>": value }`, the secret values behind that project's `secretRef` rules |
| `yaac-proxy-reg-<workspaceId>` | ConfigMap, one per workspace | server | proxy informer | `registration.json`: rules with `secretRef`s (never values), allowed hosts, repo URL, tool, project, owner, test redirects |
| `yaac-proxy-refreshed` | Secret | proxy | server informer | `<owner>.claude.json`, `<owner>.codex.json`: OAuth bundles the proxy captured from a workspace's token refresh, in the credentials-file shape |
| `yaac-proxy-ca` | Secret | proxy | server (one get) | `ca.key`, `ca.pem`, `ca-bundle.pem` |
| `yaac-proxy-state` | ConfigMap | proxy | server informer | `blocked-hosts.json`, `git-auth-failures.json` |

**Owners.** Credentials belong to an owner, an opaque key (letters,
digits, `-`, `_`; the proxy reads a Secret key up to its first `.` as the
owner) that each registration names. Every credential path resolves through
the registration's owner: the sentinel swaps, the OAuth refresh and its
write-back, the git token pool, and the ssh keys the agent relay shows and
the hosts it lets them sign for. A
workspace never spends another owner's credential, even one assigned to a
project of the same id, and a registration naming an owner the Secret lacks
gets nothing swapped. The server decides the owner and hands it to the
driver on the launch intent and the claim's registration; today every
workspace names the install's one owner (`INSTALL_CREDENTIAL_OWNER`), since
the host store holds one credential set.

Inputs carry the label `yaac.proxy-input=<kind>` and outputs
`yaac.proxy-output=<kind>`. Both sides select by label, since `list` and
`watch` cannot be scoped by name.

**When the server writes:**

- The credentials Secret is rewritten whole whenever a host-store change
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
longer allowed, or whose rules or redirect changed, is dropped and reconnects
under the new registration. Others stay up, so widening drops nothing, while a
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
replacement pod boots from). The server's `credential-adopt` step takes the
install owner's captures into the host store under the same newest-wins
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

**opencode and pi keys.** Each tool reads its key from a workspace variable of
its own, `YAAC_<TOOL>_KEY_<PROVIDER>`, which its config in the project's tool
home names (an `OPENCODE_CONFIG` file for opencode, a `models.json` entry for
pi; `ensureToolApiKeyConfig`), ahead of the provider's own variable. So the
key reaches the tool however it is started, and the two tools can hold
different keys for one provider, unaffected by claude's or codex's
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` or a project's own provider variable. Each
carries its own placeholder too, so the proxy picks the key by which
placeholder a request sends, not by the workspace's tool.

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
