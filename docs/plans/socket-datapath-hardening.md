# Hardening the socket egress datapath

A proposal, not built. The socket datapath (docs/workspace-egress.md) left
four gaps. This plan gives a fix for each, ordered by value for cost, so
that any prefix of the list can ship and the rest wait. Whatever is chosen
ships as one PR.

## Where each gap stands

kind and `infra/hetzner-k3s` run Calico, which enforces a policy from a
pod's first packet and does not pass traffic when it fails. Under it, three
of the gaps are a second barrier that is missing behind a policy that
holds. Gap 3 is different: no policy was ever in front of it.

| # | Fix | Gap | What stands in front today | Cost | Under Pamir |
|---|---|---|---|---|---|
| A | netshim connects into the sandbox from the pod's address | 3: a release sees every visitor as `127.0.0.1` | nothing, on any CNI | a few lines of Go, docs | carries: netshim is reused |
| B | the relay checks a unit's shape | 2: site traffic follows an annotation alone; 4: the relay serves a labelled pod on any runtime | the server writing the right objects | about 30 lines of Go, no rollout step | gone with the relay |
| C | admission ties the sandbox labels to `gvisor-nonet` | 4 | the server never making such a pod | one policy, an apiserver test | gone: a unit has no network by construction |
| D | the stream dial proves both ends | 1: the server sends the master secret to a cached pod IP | `yaac-server-egress` | about 150 lines of Go and TypeScript, a round trip per dial, one shim | gone: Pamir carries streams |
| E | the router authenticates to the relay | 2: the site port takes no secret | `yaac-netd-ingress` | the largest: the route table splits, install reorders, one shim | gone: Pamir names the caller |

**Recommendation.** Do A and B now. A closes the one gap that is open
today, and B is cheap and needs no rollout step. C is worth doing with
them if there is appetite, since what it guards is the gVisor boundary
itself. D and E buy a second barrier behind policies Calico enforces, and
both are discarded by the Pamir driver (docs/plans/pamir.md), so they can
wait for one of the triggers below.

**What raises the stakes.**

- **A CNI that lets a pod's first packets through, or passes traffic while
  its daemon is down** (the default CNIs of docs/plans/socket-egress.md).
  D and E then stop being second barriers. netd's site port is open at
  every netd restart, and the server's first dials after a restart leave
  before its egress policy applies. Gap 4 gets worse too: a sandbox the
  server made on runc by mistake has a real interface, and
  `yaac-egress-world-deny` is all that holds it. Gap 3 and the label half
  of gap 2 do not move with the CNI.
- **A byo cluster shared with other workloads.** Foreign pods have
  interfaces and can hold a reused address, so D and E matter as soon as
  that cluster's policy engine is weaker than Calico. D also matters there
  under any engine when the pod range is public address space, since the
  server's egress floor cuts only non-public ranges. A runc sandbox of
  gap 4 has more to reach there.
- **Pamir** (docs/plans/pamir.md, docs/plans/off-kubernetes.md). Policy
  goes away, and so do the relay, pod addresses and admission. Only A
  carries over as code. B, D and E become requirements on Pamir's socket
  carrying: it names the calling unit, the router reaches only a release of
  the site it names, and the server sends no secret to a peer that has not
  proved itself.

## How an upgrade rolls

`yaac cluster install` rolls netd, then the site edge, then the server.
The new server rolls the proxy when it first needs it, and applies netd
again. The netd DaemonSet goes one node at a time, so old and new relays
serve side by side for a while. A new relay therefore meets the old server
and the route table it wrote, and each fix below says which side tolerates
the other.

These windows are crossed only by an install that already runs the socket
datapath. No release carries it yet (v0.1.5 predates it), so today that
means installs tracking main.

## A. Site connections come from the pod's address (gap 3)

netshim connects each `ingress.sock` connection to `127.0.0.1:<port>`, so
an app sees its peer as loopback. Apps commonly give loopback peers more:
debug consoles, admin and metrics pages, "local request" checks. Before
the socket datapath the peer was the router's pod address.

**Design.** netshim binds the connection's source to the pod's own
address, which it already puts on `lo`, and keeps dialing `127.0.0.1`.
`POD_IP` becomes required: netshim exits without it, and the two
`podIP != ""` branches of `setupCommands` go.

This was checked in a running `gvisor-nonet` sandbox:

| Listener bound to | Dial `127.0.0.1` from the pod address | Dial the pod address from itself |
|---|---|---|
| `127.0.0.1` | accepted, peer is the pod address | refused |
| `0.0.0.0` | accepted, peer is the pod address | accepted, peer equals the local address |
| the pod address | refused | accepted |

Keeping the destination at `127.0.0.1` leaves every app that works today
working, and avoids a peer equal to the local address, which some "is this
request local" checks accept.

The pod's address is used because it is already there, it is the address
`/etc/hosts` gives the hostname, and it is the kind of address an app saw
before. PROXY protocol to the app is rejected: an app must opt in to parse
it, and `X-Forwarded-For` already carries the client. Documenting the
loopback peer and changing nothing is rejected too, because the failure is
silent and comes from framework defaults nobody reads.

**What it changes for authors, and leaves open.**

- A server that trusts forwarded headers only from loopback stops reading
  `X-Forwarded-For` and `-Proto` until told to trust any peer. gunicorn's
  and uvicorn's `forwarded-allow-ips` default and Express `trust proxy:
  'loopback'` are believed to be such settings; confirm them before the
  docs name them. Trusting any peer is safe: beside the release's own
  processes and its owner's forward, only the router's requests reach the
  site port.
- The peer says "not loopback", not "the router". Any process in the
  release can connect from the pod's address too, and an app that treats
  its own address as local still trusts visitors.
- netshim cannot tell a site connection from a stream, so streamd sees the
  pod's address as well. It checks no peer, only its token. A forward still
  reaches the app from loopback, because streamd dials `localhost` itself,
  so a release's admin port keeps its loopback trust for the owner.

**Files.** `k8s/mountd/cmd/netshim` (`ingress`, `setupCommands`, `main`).
Docs: a section in docs/public-sites.md on what a release sees as its
peer, the netshim "In" bullet of docs/workspace-egress.md, and a line in
the `site` part of `builtin-skills/yaac-mama/SKILL.md` (visitors never
arrive from loopback; trust forwarded headers from any peer; keep anything
private on the admin port).

**Rollout.** netshim is a container of each pod, so nothing has to agree
with anything else and there is no window. A release started before the
upgrade keeps its old netshim, and its visitors stay on loopback, until
its next deploy. The plan does not automate that: stopping and replacing
every live release is downtime for every site. The upgrade note says to
redeploy each published site. If that is not enough, the
`outdated-workspaces` step can replace releases that lack a marker label,
at the cost of that downtime and a shim entry.

**Tests.** `netshim_test.go`: `TestIngress` takes the source address from
the config and asserts the peer the listener sees (a second loopback
address stands in for the pod's), and `TestSetupCommands` loses its
no-address case. `test/e2e/socket-egress-suite.test.ts`: the site case's
server answers with its peer address, which must be the pod's.

## B. The relay checks a unit's shape (gaps 2 and 4, relay half)

The relay gives an identity to any pod on its node with a sandbox label
and a `sockets` volume, and sends a site's traffic to whatever workspace
the Service's annotation names. Three checks, all where the relay already
reads the pod (`unitOf`, `list`, `site`, `stream` in `cmd/relay`):

- **A unit is on `gvisor-nonet`.** A pod on any other RuntimeClass is not a
  unit: it gets no `egress.sock`, so no identity at the proxy, and nothing
  reaches its `ingress.sock`. A sandbox the server made on runc by mistake
  then has no working network and fails its launch, where today it would
  run with a real interface behind `yaac-egress-world-deny`.
- **A site's target carries that site's label.** `list` keeps each unit's
  kind (workspace or build) and its `yaac.site-id` label. `site` requires a
  workspace whose label equals the site id in the router's header. This
  restores what the old Service selector required.
- **A build is never a stream or site target.** `stream` and `site` refuse
  a build id.

None of this depends on the CNI. It guards against the server writing a
wrong annotation or a wrong pod, and costs a few comparisons.

**Files.** `k8s/mountd/cmd/relay`. Docs: what a unit is in
docs/workspace-egress.md "The relay, and the rest of netd", the relay's
paragraph in docs/public-sites.md "The router", and the relay section of
docs/stream-relay.md.

**Rollout.** None. Every release pod already carries `yaac.site-id`, every
sandbox pod is on `gvisor-nonet`, and a pod on the older `gvisor` class has
no `sockets` volume, so it was never a unit.

**Tests.** `relay_test.go`: `TestUnitsAndEgress` (a labelled pod on another
class gets no socket), `TestSites` (a target without the label, with
another site's label, and a build are closed), `TestStreams` (a build id is
refused). `socket-egress-suite`: the test pods of the site case gain the
label (`test/support/test-pods.ts` takes extra labels), and a Service that
names an unlabelled workspace gets a close.

## C. Admission ties the sandbox labels to the runtime (gap 4)

The admission policy in `cluster/proxy-manifests.ts` covers only
`yaac.role=builder`. B makes a mislabelled pod useless; this refuses to
create it, so code yaac did not write never starts outside gVisor.

**Design.** A second ValidatingAdmissionPolicy and binding, applied beside
the builder guard. A pod that carries `yaac.workspace-id` or
`yaac.build-id` must name the `gvisor-nonet` RuntimeClass.

- **No creator check.** Workspace pods are created by the Job controller,
  builder pods by the server, and the check's probes and the mountd gate by
  whoever runs the CLI. The rule constrains what a labelled pod is, whoever
  makes it.
- **CREATE, and an UPDATE that adds or changes the label**, so it cannot be
  put on a running runc pod. An update that leaves the two labels alone is
  not checked. The Job controller removes its tracking finalizer with such
  an update, and a pod from before the socket datapath (on the `gvisor`
  class, with the label) could otherwise never finish terminating when the
  `outdated-workspaces` step stops it (docs/legacy-compat-shims.md
  "Workspaces on the gvisor class").
- **Scoped to namespaces that opt in.** The builder guard is cluster-wide,
  and an older install sharing the cluster still makes labelled pods on
  `gvisor`. So `ensureNamespace` labels the install's namespace, and the
  binding's `namespaceSelector` matches that label. The relay reads only
  its own namespace, so this covers exactly the pods it could serve. The
  e2e tiers make their namespaces with `ensureNamespace` too, so the guard
  is live there.

Every pod yaac labels this way already names the class: workspace Jobs,
builders, the check's sandbox probe (`install/check.ts`), the mountd gate
and the e2e test pods. The startup relabel of older objects adds only
`yaac.install-id`, so it is an update the guard does not check.

**Files.** `cluster/proxy-manifests.ts` (the policy and binding),
`cluster/proxy-apply.ts` (`ensureBuilderRoleGuard` applies both,
`ensureNamespace` adds the label), the `vap` gate's wording in
`install/check.ts`, docs/workspace-egress.md "The runtime".

**Rollout.** Install applies the guard before it rolls netd, the site edge
or the server. Nothing running is refused. A server from before the socket
datapath that creates a workspace in the minutes before it is replaced has
that pod refused; the new server stops those workspaces anyway.

**Tests.** `test/apiserver/` gets a file that runs the policy on the real
apiserver (the pinned envtest serves the v1 API): a labelled pod with no
class or another class is refused, one on `gvisor-nonet` is admitted, a
label added to a runc pod is refused, an update of a labelled `gvisor` pod
that keeps its labels is admitted, and a pod in a namespace without the
opt-in label is untouched. `proxy-apply.test.ts` covers that both guards
are applied. `socket-egress-suite`: applying a labelled pod with no
RuntimeClass fails.

## D. The stream dial proves both ends (gap 1)

`relayDial` takes the netd pod's address from the server's informer and
writes `{token: <master secret>, workspaceId}` and the workspace's streamd
token in one go. The relay proves nothing. Whatever holds that address
gets the secret that is also the relay's key to the proxy, the proxy's
control key, and the HMAC key behind every streamd token.

Today `yaac-server-egress` is the barrier: inside the cluster the server
may dial only pods labelled as netd on the stream port, and its floor cuts
non-public ranges.

**Design.**

- **A key for this hop.** `streamKey = HKDF-SHA256(master, "yaac stream
  relay")`, derived by the server and by the relay. The streamd token keeps
  its derivation: running pods hold it.
- **The relay proves itself first, and no secret crosses.** The server
  opens with `{workspaceId, nonce}`. The relay answers with a nonce of its
  own, its pod UID (from the downward API) and an HMAC under `streamKey`
  over both nonces, the workspace id and that UID. The server checks the
  HMAC and that the UID is the one its informer holds for that node, and
  only then sends its own HMAC and the streamd line. The two HMACs are over
  the same fields behind different role labels, so the relay's proof cannot
  be sent back to it as the server's.
- **The relay says nothing about a workspace before the server's proof.**
  It answers the opening line the same way whether or not the workspace is
  on its node. A bad proof still gets a silent close, and `{ok:false}`
  (unknown workspace, ingress dial failed) comes only after a good one, as
  it does behind the token today.
- **The informer's netd entry gains the UID and readiness.** `readNetdPods`
  returns both, and a pod counts as live only when Ready. The UID in the
  proof is what "check the pod on each dial" comes to, with no API call: a
  stale entry names a UID nobody at that address can sign for, and a pod
  that forwards the exchange to a real relay gets a proof for the wrong
  UID.

**What each part costs and leaves open.**

- The derived key alone (sent as a bearer, as today) is the cheap cut,
  about 20 lines: a stray dial then leaks a key good only for this hop,
  plus that one workspace's streamd token. Worth doing alone if the rest
  of D is deferred.
- Proving first costs one round trip more on every dial, each `podExec`
  included, because the streamd line can no longer ride with the first
  write.
- A read of the netd pod from the API on each dial is rejected: it puts
  the apiserver on a path built to avoid it, and still leaves a gap
  between the read and the dial.
- netd still mounts the master secret on every node, since the relay
  presents it to the proxy. That hop is a Service dial and is unchanged.
  Giving it a derived key needs the proxy to roll before netd, which
  install's order does not give.
- Nothing is encrypted, here or on any other hop, so a party on the path
  can still read and alter a stream after the handshake. TLS on this hop
  alone would not change that while the relay sends the master secret to
  the proxy in the clear.

**Files.** `k8s/mountd/cmd/relay` (`stream`, `main`, a `POD_UID` variable
in `cluster/netd.ts`), `substrate/stream-relay.ts` (`relayDial`),
`substrate/cluster-cache.ts`, `cluster/site-edge.ts` (reads the address
from the new shape), docs/stream-relay.md, docs/workspace-egress.md.

**Rollout.** The relay rolls first, so it keeps accepting the old first
line, a `token` equal to the master secret. That costs no security: who
holds the master secret can derive the key. A new server should never meet
an old relay, since install waits for netd's rollout before it deploys the
server. If it does, its dials fail closed, as transport failures that reap
nothing, until netd is rolled: by the next install, or by the server
itself if it also finds the proxy out of date.

Entry for docs/legacy-compat-shims.md, "The stream dial's bearer line":

- *Reads:* a `token` field in a stream dial's first line.
- *Breaks silently if removed early:* from netd's roll to the server's in
  one upgrade, every stream dial of the old server is closed. Terminals,
  status streams and workspace creates fail as `unknown` for those minutes,
  and nothing is reaped.
- *Safe to remove:* once no supported upgrade starts from a server that
  sends the bearer line.

**Tests.** `relay_test.go` `TestStreams`: the exchange, a wrong HMAC closed
silently, the old line accepted. `stream-relay.test.ts` `relayDial`: the
streamd token is not written before the relay's proof, and a proof with a
wrong HMAC or another pod's UID fails the dial. `cluster-cache.test.ts`:
UID and readiness. `socket-egress-suite`: the stream-refusal case speaks
the new exchange and checks the proof names the netd pod's UID.

## E. The router authenticates to the relay (gap 2, router half)

netd's site port takes a PROXY header naming a site and no secret. Only
`yaac-netd-ingress` keeps everything but the router off it, and that
policy admits by label. Whoever reaches the port can send a site any
headers, `Tailscale-User-Login` included, so the promise of
docs/public-sites.md "Headers an app may trust" rests on that policy
alone.

**Design.** `siteKey = HKDF-SHA256(master, "yaac site router")`. Each site
cluster's `added_tlvs` gains TLV `0xE1` carrying it, and the relay
requires it, compared in constant time, before it reads the Service. The
router faces the internet, so it never holds the master secret.

The key is then part of the route table, which is a ConfigMap. `cds.json`
moves to a Secret, `yaac-site-clusters`, and the router mounts it with the
route files through one projected volume. Two things to check before
building it:

- that a projected volume swaps as one, the way the ConfigMap mount does,
  so Envoy's `watched_directory` still sees each change;
- whether a newer Envoy makes the move unnecessary. `TlvEntry` has a
  `format_string` on Envoy's main branch. If a pin newer than v1.34.0 has
  it and it can read an environment variable, the key comes from a Secret
  the router mounts as a variable, and the table stays a ConfigMap.

**Rollout.** This is the one fix where a plain cutover drops every site:
the relay would demand the TLV before the new server has written a table
that sends it. So install does two things, in this order:

1. It applies the site edge before netd. `ensureRouteFiles` creates the
   Secret from the ConfigMap's `cds.json` with the TLV added to every
   cluster, and the router rolls onto it. The old relay ignores the extra
   TLV.
2. It rolls netd. The new relay requires the TLV, which the router already
   sends.

The new server then owns the Secret and stops writing `cds.json` to the
ConfigMap. Until it is up, the old server's cluster writes are not read: a
site created in those minutes answers 503 until the server rolls. Route
changes, an unpublish included, still apply.

Entry for docs/legacy-compat-shims.md, "Site clusters in the routes
ConfigMap":

- *Reads:* `cds.json` in the `yaac-site-routes` ConfigMap, when the Secret
  is absent.
- *Breaks silently if removed early:* the first install over an older one
  rolls the router onto an empty cluster table, and every site answers 503
  until the new server's first site sync.
- *Safe to remove:* once every install's server has written the Secret; on
  a given cluster, once the ConfigMap holds no `cds.json`.

**Files.** `cluster/site-edge.ts` (the route tables, `ensureRouteFiles`,
the router's volume), `install/install.ts` (the order), `cmd/relay`
(`site`), `substrate/proxy-constants.ts`, docs/public-sites.md ("The
router", the objects table, "Network policy") and docs/workspace-egress.md
("Wire formats", "Policies").

**Tests.** `site-edge.test.ts`: `syncSiteObjects` writes the clusters to
the Secret with the TLV, and `ensureSiteEdge` seeds it from an older
table. `relay_test.go` `TestSites`: a header with no secret, or a wrong
one, is closed. `test/e2e-cli/site-suite.test.ts` already reaches a
release through the real router, so it proves Envoy writes the TLV.
`socket-egress-suite` builds its header by hand, so it gains the TLV and a
case without it.
