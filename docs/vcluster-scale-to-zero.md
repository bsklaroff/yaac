# vcluster scale-to-zero (born-at-zero, wake-on-access)

A `virtualCluster` session's per-session vcluster runs zero control-plane
pods — and so consumes ~no memory — from the moment it is created until the
first thing accesses its API, then cold-starts on demand and stays up for the
rest of the session. An idle control-plane pod (kube-apiserver + KCM +
kine/SQLite + syncer) plus its synced CoreDNS pod cost 350–600 MB of pure
overhead per vcluster; born-at-zero reclaims all of it for every vcluster
created but not yet used. Only a **fresh, unused** vcluster is ever slept
("Tier A") — re-sleeping one that has done work would need a quiescence
detector and is not implemented.

## Sleep (`sleepVcluster`, called from session create)

The control plane renders as a Deployment (embedded-SQLite, no PVC), so sleep
is a scale to 0. Right after `waitForVclusterKubeconfig` captures the exported
kubeconfig, the create flow — only when `ensureSessionVcluster` reports the
vcluster was freshly created, never on a re-ensure over a live one:

1. **Intercepts the API Service**: applies a `yaac-sleep-<vc>` EndpointSlice
   pointing the vcluster's API ClusterIP at the activator pod. Applied BEFORE
   the scale-down so no client ever sees a black-holed ClusterIP (with no
   endpoints at all, clients get ECONNREFUSED, not a hold). The slice carries
   `kubernetes.io/service-name: <vc>` to attach to the Service and a foreign
   `endpointslice.kubernetes.io/managed-by: yaac.dev` so the built-in
   endpointslice controller leaves it alone. It must enumerate **all three
   named Service ports** (`yaac-api`, `https`, `kubelet`) — endpoint ports
   match Service ports by name, and a slice naming only `https` would leave
   8443, the port that matters, unrouted.
2. **Scales the control-plane Deployment to 0** and waits for its pod to
   terminate (matched by the chart labels minus the syncer-stamped
   `managed-by`, the control-plane policy's unforgeable-exclusion trick).
3. **Deletes the vcluster's synced host pods** (CoreDNS). The syncer is down
   and cannot GC them; left alone the synced CoreDNS pod would run forever,
   burning the memory the sleep was meant to reclaim. They are plain Pods with
   no host owner, so nothing recreates them.

The chart's `spec.replicas` is stripped post-render (`stripControlPlaneReplicas`)
so yaac owns the count out-of-band: the first apply defaults to 1 (the
create-time boot), `kubectl scale` sets 0/1 afterwards, and re-applies (server
restart, re-ensure) never stomp the live value.

**Identity survives the 0 → 1 reboot without any volume work.** vcluster
mirrors its whole PKI into the `<vc>-certs` Secret and restores it on boot, so
`ca.crt`/`sa.key`/the leaves are byte-identical after a wake and the
already-mounted kubeconfig stays valid. What the emptyDir `/data` loses is
kine's `state.db` — the vcluster's own object store. On wake the syncer
re-bootstraps a clean vcluster (namespaces and CoreDNS come back, recreated).
For a never-used vcluster that is exactly the intent, but it makes one rule
load-bearing: **nothing may write to the vcluster between the create-time boot
and the sleep** — anything written is silently lost. Hence the
`freshlyCreated` gate, and hence sleep runs immediately after the kubeconfig
export. (If `/data` is ever persisted, the Deployment's RollingUpdate strategy
must become Recreate — a rollout would briefly run two kine/SQLite writers
against one file.)

## The activator (`yaac-vc-activator`)

One always-on install-wide pod (in `k8s/proxy/activator.ts`, shipped in the
proxy sidecar image under a separate entrypoint — no second image pipeline)
fronts every asleep vcluster, so the per-idle-vcluster footprint stays zero.
On a session pod's first connection to its API ClusterIP:8443, the activator
scales the control plane back to 1 itself (no dependency on the yaac server
process, which may not be running while sessions live), parks the request
until the apiserver answers, deletes the EndpointSlice, and responds **307
to the same URL** with `Connection: close`. The client re-dials — a fresh
connection, which now routes to the real endpoint — and authenticates itself
there natively: cert users re-handshake with their own client cert, token
users re-send their own header. The activator never verifies, forwards, or
mints CLIENT identity and never proxies a byte of API traffic. Concurrent
first-touch across clients and vclusters shares one wake per vcluster.

**It terminates TLS; a pure TCP passthrough cannot work.** Cold start
measures ~12–20 s, but Go's `http.Transport` has a fixed 10 s
`TLSHandshakeTimeout` that client-go never raises — a passthrough that holds
the TCP handshake trips it (measured: a 3 s hold passes, a 15 s hold fails).
Terminating TLS and holding the *HTTP request* keeps clients on their
per-request timeout (32 s for kubectl discovery, longer for informer
list/watch) — comfortably clear. Live client-go informers survive a wake:
their broken watches reconnect and the reconnect itself triggers (or joins)
the wake. `Connection: close` on the 307 is load-bearing: without it Go
reuses the same keep-alive connection (same host) for the retry and loops
back into the activator.

Per-vcluster TLS identity is selected **by SNI**: the kubeconfig's server is
`<vc>.<vc-ns>.svc.cluster.local` (resolved via host CoreDNS to the Service
ClusterIP — independent of the vcluster's own CoreDNS), so the SNI names the
vcluster. The serving cert is **minted per wake**: the cert the real
endpoint serves on 8443 (the syncer's proxy cert carrying the extraSANs
FQDN) is generated at boot inside the pod and never exported — the Secret's
`apiserver.crt` has only the in-vcluster SANs, which clients pinning the
FQDN reject. The server CA's key IS in the `<vc>-certs` Secret, so the
activator mints a short-lived leaf for the SNI host exactly as the syncer
does at boot; clients pin that CA in their kubeconfig, so the chain
validates. The SNI→vcluster binding is strict (name and namespace must agree
on the session id and carry this install's namespace prefix), and there is
no default cert: any other servername fails its handshake. The wake's
readiness probe dials the control-plane **pod IP** (found by chart labels
minus `managed-by`, so a tenant pod forging `app=vcluster` is never
selected) — never the Service, which mid-wake still points at the activator
itself.

One caveat of the redirect: client-go's SPDY/websocket round-trippers are
deliberately conservative about redirects, so an `exec`/`port-forward` as
the very first touch of an asleep vcluster may error once and succeed on
retry — by then the vcluster is awake and routed directly. Plain REST,
discovery, and list/watch (every realistic first touch) follow the 307
transparently.

### Containment

The activator holds each vcluster's server-CA key while a wake is in flight
(enough to impersonate that vcluster's API endpoint), so it is deliberately
narrow:

- Trusted yaac infra on runc in the install namespace (like the proxy and the
  control plane, the sentry buys no containment for yaac-shipped code).
- **RBAC is per-vcluster, not standing**: `ensureSessionVcluster` applies a
  Role + RoleBinding in each vcluster's namespace (get on the one certs
  Secret, get/patch on the one Deployment's scale, pod reads, delete on the
  one slice), torn down with the namespace. No cluster-wide grant exists.
- Its NetworkPolicy locks ingress to session pods + the node (kubelet probe) on 8443,
  and egress to exactly the wake surface: the host apiserver and control-plane
  pods on 8443. The explicit egress allow is also load-bearing: the
  install-wide world-deny policy selects the activator, and any policy with
  an Egress type flips a pod into egress default-deny.
- The per-session vcluster NetworkPolicy admits the session pod to the
  activator on 8443 — required because NetworkPolicy is evaluated on the
  **post-DNAT** endpoint identity, so while the ClusterIP is intercepted the
  first touch lands on the activator's identity, not the control plane's.

## Status, reconcile, teardown

- `getVclusterStatus` derives a `phase` for `SessionDetail.virtualCluster`:
  `asleep` (replicas 0), `waking` (scaled up, not serving — a wake that fails
  surfaces as persistent `waking` rather than a hang), `ready`.
- `healVclusterSleepState` (in the vcluster reconcile) converges the slice
  with reality each tick: asleep → the slice must exist and target the LIVE
  activator pod IP (an activator pod replacement would otherwise strand every
  asleep vcluster); awake and serving → a leftover slice is deleted (covers a
  failed activator delete); waking → left alone, the activator still needs it.
- Everything sleep-related lives in the vcluster's namespace and dies with it;
  session teardown needs no extra steps. Sleeping a vcluster that still has
  live API clients is self-healing rather than destructive: their reconnects
  hit the interception slice and wake it right back (the sleep's pods-gone
  wait then times out harmlessly).

## The nested server defers its cluster attach

A `yaac server start` run from a session's initCommands would otherwise wake
the vcluster seconds after the create-time sleep: server boot ensures the
namespace/registry, starts the informer caches, and runs the reconciler —
all API touches. A NESTED server with no sessions of its own therefore arms
its cluster boot instead of running it (the deferred-boot latch in
`#platform/k8s`), and
the first real use fires it: session create awaits it explicitly (the
namespace must exist before anything is applied into it), and any kubectl
call kicks it as a fire-and-forget backstop. While the attach is pending the
cluster reads feeding the web app's first snapshot answer without touching
the cluster — the session list answers empty and the project list reports
zero session counts, both true by construction since there are no session
pods yet, and blocking either would hold the whole snapshot on the vcluster
wake — while still kicking the attach, so connecting the web app wakes the
cluster in the background but renders instantly. A restarting nested server that
already has session dirs attaches eagerly — its sessions need the caches and
reconciler, and its vcluster is already awake. The outer server never arms
the latch, so every hook is a no-op there. Server readiness is DB-gated, not
cluster-gated, so a deferred server still reports healthy.

## Limits

- The vcluster stays up after its first wake — no re-sleep ("Tier B" needs a
  quiescence predicate and `/data` persistence).
- The containment objects (VAP guard, per-vcluster egress floor, the
  redirects) are host objects that persist through sleep, and nothing runs
  while asleep, so the security floor is unaffected.
