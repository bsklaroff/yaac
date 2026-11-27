# Hardening the socket egress datapath

A proposal, not built. The socket datapath (docs/workspace-egress.md) left
five gaps:

1. The server sends the master proxy secret to a netd pod IP from its
   cache, to a relay that proves nothing.
2. The relay routes site traffic by a Service annotation alone, and its
   site port takes no secret.
3. A site release sees every visitor as `127.0.0.1`.
4. Nothing ties the workspace and build labels to the no-network runtime.
5. The router sends a visitor's request to a netd pod IP from that same
   cache: a site's EndpointSlice holds one address, which the server takes
   from the informer the stream dial uses.

This plan gives a fix for each, ordered by value for cost, so that any
prefix of the list can ship and the rest wait. Whatever is chosen ships as
one PR.

## Where each gap stands

kind and `infra/hetzner-k3s` run Calico. The ordering below rests on two
properties of it: it enforces a policy from a pod's first packet, and it
does not pass traffic when its daemon fails. Neither is recorded in yaac's
docs, so both are on the list to confirm at the end. If either is wrong, D
and E move up beside A.

Under those properties, gaps 1, 2, 4 and 5 are each a second barrier that
is missing behind a policy that holds. Gap 3 is different: no policy was
ever in front of it.

| # | Fix | Gap | What stands in front today | Cost | Under Pamir |
|---|---|---|---|---|---|
| A | netshim connects into the sandbox from the pod's address | 3 | nothing, on any CNI | a few lines of Go, docs | carries: netshim is reused |
| B | the relay checks a unit's shape | 2 (the annotation), 4 (the relay half) | the server writing the right objects | about 30 lines of Go, no rollout step | gone with the relay |
| C | admission ties the sandbox labels to `gvisor-nonet` | 4 | the server never making such a pod | one policy, an apiserver test | gone: a unit has no network by construction |
| D | the stream dial proves both ends | 1 | `yaac-server-egress` | about 150 lines of Go and TypeScript, a round trip per dial, one shim | gone: Pamir carries streams |
| E | mutual TLS between the router and the relay | 2 (the site port), 5 | `yaac-netd-ingress` for the port, `yaac-site-router-egress` for the dial | the largest: two key pairs, TLS in the relay and the route table, one shim | gone: Pamir names the caller |

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
  every netd restart, and the first dials of a restarted server or router
  leave before its egress policy applies. Gap 4 gets worse too: a sandbox
  the server made on runc by mistake has a real interface, and
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

**A rollback** is the older install run over the newer one, in the same
order, so the old relay rolls first and meets the new server and its route
table. A and B need nothing. What C, D and E do then is in each section.

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
- **Scoped to namespaces that opt in.** The binding's `namespaceSelector`
  matches a label yaac puts on its own namespace. The relay reads only its
  own namespace, so this covers exactly the pods it could serve.
- **Every writer of the Namespace carries the label.** `applyObject` is a
  forced apply under one field manager, so a writer that leaves the label
  out removes it. Two functions write the install's Namespace:
  `ensureNamespace`, and `ensureMainRegistry`, whose registry namespace
  (`yaac`) is also the default install namespace. Both take their labels
  from one shared set, which holds the opt-in beside the Pod Security
  labels. `ensureBuilderRoleGuard` calls `ensureNamespace` itself, so the
  label and the binding land together, before install rolls netd.

Neither rule is a shim, though older installs are part of why each exists.
Checking only label changes is the right width in any case: controllers
update pods all the time, and `runtimeClassName` cannot change after
create. The opt-in keeps a cluster-wide rule on two label keys off
namespaces yaac does not own, which a shared byo cluster needs whatever
version its other installs run.

Every pod yaac labels this way already names the class: workspace Jobs,
builders, the check's sandbox probe (`install/check.ts`), the mountd gate
and the e2e test pods. The startup relabel of older objects adds only
`yaac.install-id`, so it is an update the guard does not check.

**Files.** `cluster/proxy-manifests.ts` (the policy and binding),
`cluster/proxy-apply.ts` (`ensureBuilderRoleGuard`, `ensureNamespace`),
`cluster/main-registry.ts` (the shared label set), the `vap` gate's
wording in `install/check.ts`, docs/workspace-egress.md "The runtime".

**Rollout.** Install applies the guard, with the namespace label, before
it rolls netd, the site edge or the server. Nothing running is refused. A
server from before the socket datapath that creates a workspace in the
minutes before it is replaced has that pod refused; the new server stops
those workspaces anyway.

**Rollback.** An older install removes the label the first time it writes
the Namespace, which turns the guard off for that namespace. In the default
namespace that is its registry step, ahead of everything else. Until then
the guard refuses a labelled pod on `gvisor`, which matters only for a
rollback to a release from before the socket datapath. If workspaces fail
to start after one, remove the label by hand; the rollback note names the
command.

**Tests.** `test/apiserver/` gets a file that runs the policy on the real
apiserver (the pinned envtest serves the v1 API): a labelled pod with no
class or another class is refused, one on `gvisor-nonet` is admitted, a
label added to a runc pod is refused, an update of a labelled `gvisor` pod
that keeps its labels is admitted, and a pod in a namespace without the
opt-in label is untouched. One case writes the Namespace the way
`ensureMainRegistry` does, after the guard, and then expects a labelled
pod with no RuntimeClass to be refused. Only this tier can catch a lost
label: the e2e tiers run in `yaac-test-<run id>` namespaces, which are
never the registry's. `proxy-apply.test.ts` covers that both guards and
the label are applied. `socket-egress-suite`: applying a labelled pod with no
RuntimeClass fails.

## D. The stream dial proves both ends (gap 1)

`relayDial` takes the netd pod's address from the server's informer and
writes `{token: <master secret>, workspaceId}` and the workspace's streamd
token in one go. The relay proves nothing. Whatever holds that address
gets the secret that is also the relay's key to the proxy, the proxy's key
to the server's mama listener, and the HMAC key behind every streamd
token.

Today `yaac-server-egress` is the barrier: inside the cluster the server
may dial only pods labelled as netd on the stream port, and its floor cuts
non-public ranges.

**D removes one of three paths the master secret travels as a bearer.**

| Hop | How it is sent | Peer chosen by | In front |
|---|---|---|---|
| server to relay | first line of every stream dial | the server's informer, a pod IP | `yaac-server-egress` |
| relay to proxy | TLV `0xE1` on every sandbox connection | the proxy's Service | `yaac-netd-egress` |
| proxy to the server's mama listener | `Authorization: Bearer` on every relayed call | the mama Service | `yaac-proxy-egress` |

The two Service dials are not safe, only narrower. Their peer is whatever
the endpoints controller and kube-proxy last programmed, so the stale
window is the cluster's own, not that of a cache yaac keeps, and the
address behind each changes only when the proxy or the server is replaced.
Under the triggers above they are the same kind of exposure, and the
relay's hop is the busiest of the three. They stay open in this plan. Closing them
means a key per hop and a peer that proves itself on each, and the proxy
would have to roll before netd, which install's order does not give.

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
  UID. The readiness half also narrows gap 5, since a site's EndpointSlice
  is written from the same entries, and it is a few lines that can ship
  without the rest of D.

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
  presents it to the proxy (the table above).
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
holds the master secret can derive the key. On an upgrade a new server
does not meet an old relay, since install waits for netd's rollout before
it deploys the server.

**Rollback.** Every rollback has the new server meet the old relay, from
netd's roll until the server's. The old relay closes silently on a first
line with no `token`, so the server sees transport failures for those
minutes, which read as `unknown` and reap nothing.

Entry for docs/legacy-compat-shims.md, "The stream dial's bearer line":

- **What it reads.** A `token` field in a stream dial's first line.
- **What breaks silently if it goes too early.** From netd's roll to the
  server's in one upgrade, every stream dial of the old server is closed.
  Terminals, status streams and workspace creates fail as `unknown` for
  those minutes, and nothing is reaped.
- **When it is safe to remove.** Once no supported upgrade starts from a
  server that sends the bearer line. It is a wire format, so no object on
  a cluster shows whether it is still needed.

**Tests.** `relay_test.go` `TestStreams`: the exchange, a wrong HMAC closed
silently, the old line accepted. `stream-relay.test.ts` `relayDial`: the
streamd token is not written before the relay's proof, and a proof with a
wrong HMAC or another pod's UID fails the dial. `cluster-cache.test.ts`:
UID and readiness. `socket-egress-suite`: the stream-refusal case speaks
the new exchange and checks the proof names the netd pod's UID.

## E. Mutual TLS between the router and the relay (gaps 2 and 5)

Two things are open on the router's hop to the relay.

- **The site port takes no secret** (gap 2). It reads a PROXY header naming
  a site and nothing else. `yaac-netd-ingress` keeps everything but the
  router off it, and admits by label. Whoever reaches the port can send a
  site any headers, `Tailscale-User-Login` included, so the promise of
  docs/public-sites.md "Headers an app may trust" rests on that policy
  alone.
- **The router dials a cached pod IP** (gap 5). A site's EndpointSlice
  holds the netd pod address the server last read from its informer. If
  that address goes stale and is reused, a visitor's request, with its
  cookies and the tailnet login headers, goes to whatever holds it now.
  Only `yaac-site-router-egress` stands in front.

**Design.** The router and the relay each prove a key to the other in a
TLS handshake, and the request travels inside it.

- **Two key pairs, made once.** Self-signed, as the token endpoint's
  certificate is (`@yaac/shared/token-tls`), and kept in two Secrets so
  neither pod holds the other's key: the relay's pair with the router's
  certificate, which netd mounts, and the router's pair with the relay's
  certificate, which the router mounts. `ensureNetd` and `ensureSiteEdge`
  create them when absent. Neither is derived from the master secret,
  which the router, facing the internet, never holds.
- **The router.** Each site cluster's transport socket becomes the PROXY
  header over TLS: Envoy presents the router's certificate and trusts only
  the relay's. The table names files, so it stays a ConfigMap with no
  secret in it.
- **The relay.** After the header it runs the handshake, requires the
  router's certificate, and only then reads the Service.

The header still crosses in the clear ahead of the handshake, and carries
only the site id. A pod at a stale address gets that and a ClientHello,
never the request. A caller without the router's key cannot finish the
handshake.

A bearer secret in the header is rejected. It would be sent to a relay that
has proved nothing, so under this fix's own triggers the pod at a stale
address would collect the key and the request together, and could then
reach the site port as the router. It would also put a secret in the route
table. Checking readiness when the EndpointSlice is written (see D) narrows
gap 5 and does not close it.

**What it costs and leaves open.** TLS on every site connection at the
relay. A compromised router is still the router. As a side effect this hop
is encrypted, which no other hop is.

**Rollout.** The route table is written by the server, and the relay rolls
before the server does. So the relay accepts both forms for a window: a
connection whose first byte after the header opens a TLS handshake must
complete it, and anything else is spliced as today.

1. Install rolls netd. The new relay speaks both forms.
2. Install applies the site edge. The router gains its key mount; its
   table is unchanged, so it goes on sending plaintext.
3. The new server writes the clusters with TLS. Each cluster changes over
   when Envoy loads it, with no moment when the two sides disagree.

No site drops. Gap 5 is closed from step 3. The site port goes on accepting
plaintext from whatever the policy admits until the shim is removed, so
that half of gap 2 closes one release later. Closing it sooner needs a
signal that Envoy has loaded the new table, which the server does not
have; marking each site's Service instead would drop each site for the
seconds between the mark and the load.

**Rollback.** The old relay rolls first and knows no TLS, so it splices
the router's handshake into the app. Every site fails from netd's roll
until the old server's first site sync rewrites the table, a matter of
minutes. The rollback note says to expect it.

Entry for docs/legacy-compat-shims.md, "Plaintext on netd's site port":

- **What it reads.** The first byte after the router's header on a site
  connection.
- **What breaks silently if it goes too early.** On an upgrade from a
  server that writes plaintext clusters, every site is refused from netd's
  roll until the new server's first site sync.
- **When it is safe to remove.** Once no supported upgrade starts from such
  a server; on a given cluster, once every cluster in `kubectl get
  configmap yaac-site-routes -o jsonpath='{.data.cds\.json}'` names a TLS
  transport socket.

**Files.** `cluster/site-edge.ts` (the clusters, the router's mount, the
keys), `cluster/netd.ts` (the relay's mount and flags), the certificate
helper in `@yaac/shared/token-tls`, `cmd/relay` (`site`, `main`),
docs/public-sites.md ("The router", the objects table, "Network policy")
and docs/workspace-egress.md ("Wire formats", "Policies").

**Tests.** `site-edge.test.ts`: `syncSiteObjects` writes each cluster with
TLS inside the PROXY transport, and `ensureSiteEdge` makes the keys once
and keeps them. `netd.test.ts`: the relay's mount. `relay_test.go`
`TestSites`: a handshake with the router's certificate passes, one with
another certificate or none is closed, and plaintext passes while the shim
stands. `test/e2e-cli/site-suite.test.ts` already reaches a release through
the real router, so it proves Envoy and the relay agree.
`socket-egress-suite` builds its connection by hand, so it speaks TLS with
the router's key and gains a case with a key of its own.

## To confirm before building

- **Calico's two properties** (the premise of the ordering): that a
  policy applies from a pod's first packet, in both directions, and that
  rules stay in force while calico-node is down. Confirm against Calico's
  documentation for the pinned version, and on a kind cluster by dialing
  a new pod during its first second and with calico-node stopped.
- **E:** that the pinned Envoy writes the PROXY header before the TLS
  handshake when the PROXY transport wraps a TLS one, which is what the
  relay's read order assumes.
- **A:** the gunicorn, uvicorn and Express defaults, before the site docs
  name them.
