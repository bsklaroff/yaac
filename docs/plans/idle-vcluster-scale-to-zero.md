# Idle vcluster scale-to-zero (born-at-zero, wake-on-access)

Proposal. A `virtualCluster` session's per-session vcluster should run **zero
apiserver and zero CoreDNS pods — and so consume ~no memory — until the first
thing tries to access its API**, then cold-start on demand in a few seconds and
stay up for the rest of the session.

This is "Tier A": reclaim the control plane of a vcluster that has been created
but not yet used. Re-sleeping a vcluster that has already done work ("Tier B")
needs a quiescence detector and is out of scope here (see the end).

## Why — the idle cost being reclaimed

Each `virtualCluster` session gets its own vcluster: one control-plane pod
(kube-apiserver + kube-controller-manager + kine/SQLite + the vcluster syncer)
plus a CoreDNS pod, running for the session's entire lifetime with no
idle/sleep logic anywhere. Measured on a live idle vcluster in-session:

- apiserver **RSS ≈ 180 MB**, ~2190 goroutines, `GOGC=100`, `GOMEMLIMIT` unset,
  yet only **~249 stored objects** — i.e. the footprint is fixed Go-runtime
  baseline (API type registry, OpenAPI specs, admission, P&F), not data.
- Idle datastore write churn **≈ 0.58 writes/s**, of which **~86 % is KCM
  leader-election lease renewal** (every ~2 s) — pure overhead on an idle
  cluster.

So an idle vcluster's control plane is almost entirely overhead. Born-at-zero
reclaims the whole ~180 MB apiserver + the rest of the control-plane pod +
CoreDNS, per unused vcluster, until something actually needs the API.

(Flag/env tuning — `--leader-elect=false`, trimmed controllers, `GOGC`,
disabling prewarm/image-prewarm when nested — is a complementary "reduce the
always-on floor" lever, tracked separately; it helps vclusters that *can't*
sleep. This doc is the reclaim-it-entirely lever.)

## Current shape (verified in-session unless noted)

- **The control plane renders as a `Deployment`, not a StatefulSet.** The chart's
  `vcluster.kind` helper picks a Deployment whenever `volumeClaim` is off and
  embedded-etcd is off — exactly this embedded-SQLite setup. `getVclusterStatus`
  reads `deployment/<name>` for readiness. So "scale to zero" is
  `kubectl scale deployment <name> --replicas=0`.
- **The PKI lives at `/data/pki`, and is mirrored in a Secret.** The chart mounts
  a `certs` emptyDir at `/pki` and a `data` emptyDir at `/data`, but `/pki` is
  **empty** — vestigial. The real PKI (`ca.crt`/`ca.key`, `sa.key`, the leaves,
  the embedded-etcd CA) is under `/data/pki`, alongside `state.db`. vcluster also
  writes the whole PKI to a `<name>-certs` Secret (29 keys) in the host
  namespace, and **restores it from there on boot** — so the emptyDir does *not*
  mean a fresh pod mints a new CA.
- **The kubeconfig is a static file**, captured once at session-create
  (`waitForVclusterKubeconfig`), written to the session dir and dir-mounted at
  `~/.kube`. Its server is the API-host FQDN
  `https://<name>.<vc-ns>.svc.cluster.local:8443`, and it embeds a **CA + a
  `system:masters` client cert + key** (all three minted at the single boot).
  It does not change when the control plane restarts.
- **The API host resolves via the *host* cluster's CoreDNS** to the
  control-plane Service ClusterIP (a `10.96.x` address), independent of the
  vcluster's own CoreDNS pod (a `10.244.x` pod IP). Confirmed by resolving it
  from inside the session. → Scaling the *vcluster's* CoreDNS to 0 does not
  break API-host resolution.
- **CoreDNS is a Deployment inside the vcluster**, synced to a host pod. →
  Scaling the virtual `coredns` Deployment to 0 makes the syncer drop the synced
  host pod.

## Identity across a `0 → 1` reboot — a non-problem

Born-at-zero means scaling the control plane `0 → 1` on demand, which raised the
worry that a fresh pod would mint a **new CA** and invalidate the already-mounted
kubeconfig. **It does not.** Measured on the real cluster with a plain `emptyDir`
`/data` (nothing persisted on disk): after `0 → 1`, `ca.crt`, `ca.key` and
`sa.key` are byte-identical, the exported kubeconfig Secret's CA and client cert
are unchanged, and the pre-sleep kubeconfig still authenticates as
`kubernetes-super-admin` in `system:masters` with the *same* credential ID.
vcluster restores the PKI from the `<name>-certs` Secret.

So **no volume persistence is required for Tier A**, and the post-render volume
rewrite below is dropped.

What the `emptyDir` *does* lose is `state.db` — the vcluster's own object store.
On wake the syncer re-bootstraps a clean vcluster (namespaces and the `coredns`
Deployment come back, recreated). For Tier A that is exactly the intent — the
vcluster is asleep *because nothing has used it* — but it makes one rule
load-bearing: **nothing may write to the vcluster between the create-time boot
and the sleep**, or that write is silently lost. Persisting `/data` becomes
necessary for Tier B, and if it is ever added the Deployment's
`RollingUpdate` strategy (`maxSurge: 1`, `maxUnavailable: 0`) must change to
`Recreate` — otherwise a rollout briefly runs two kine/SQLite writers against
one file.

## Design

```
create → apply manifests (replicas field stripped so yaac owns it) →
         control plane boots ONCE →
         waitForVclusterKubeconfig → write kubeconfig into the session mount →
         scale CoreDNS to 0, then control-plane to 0
           │  steady state: 0 apiserver, 0 CoreDNS, ~0 MB
           ▼
first access → session pod dials API ClusterIP:8443 → activator catches the
         connection → signals the outer server → scale control-plane (+CoreDNS)
         to 1 → boot restores PKI from the certs Secret (kubeconfig still
         valid) → waitForVclusterReady → connection handed off → stays up
```

### 1. (dropped — no volume work needed)

The PKI survives a `0 → 1` reboot on its own (see above), so there is no
post-render volume rewrite, no hostPath, and no PVC. The chart's shape is left
alone and the control plane stays a Deployment.

### 2. Let yaac own replicas out-of-band — post-render step

Extend the existing post-render transform (`addYaacLabels` in
`renderVclusterManifests`, which already parses every rendered doc) to strip
`spec.replicas` from the control-plane Deployment (the chart renders
`replicas: 1`). The first `apply` then defaults to 1 (the create-time boot);
afterwards `kubectl scale` sets 0/1 and later re-applies (server restart,
re-ensure) won't stomp the value because the field is absent from the applied
config. **Verified on the real cluster**: with `replicas` stripped, scale to 0
followed by a full re-apply of the rendered manifests leaves `spec.replicas: 0`
and zero pods.

### 3. `sleepVcluster` / `wakeVcluster` (in `vcluster.ts`)

- **Sleep**: scale the *virtual* `coredns` Deployment → 0 (via the vc
  kubeconfig) **first**, wait for the syncer to drop its host pod, and only then
  scale the control-plane Deployment → 0. The order is load-bearing: once the
  control plane is down the vcluster API is unreachable, so the virtual CoreDNS
  can no longer be scaled, and the synced host pod is left orphaned —
  **observed**: with the control plane at 0 the synced `coredns-…-x-kube-system`
  host pod stays `Running` indefinitely, burning the memory the sleep was
  supposed to reclaim. (It is not a correctness leak — on wake the syncer
  garbage-collects the stale pod and creates a fresh one — but it defeats the
  point until then.)
- **Wake**: scale control-plane → 1, `waitForVclusterReady`, restore virtual
  `coredns` → 1, re-run `reconcileInnerRedirects` for the vcluster.

### 4. `create.ts` — born-at-zero end state

After `waitForVclusterKubeconfig` and writing the kubeconfig file, call
`sleepVcluster`. This is the "boot once at create, then 0".

### 5. The activator (the one genuinely new component)

A single, always-on pod shared across the install (fixed cost — one pod total,
not per-vcluster, so the per-idle-vcluster footprint stays zero). While a
vcluster is asleep, its API Service points at the activator. On the session
pod's first connection to the API ClusterIP:8443, the activator triggers
`wakeVcluster` and holds the client until the apiserver is ready. It
**terminates TLS** and re-originates to the woken control plane preserving the
caller's identity — a pure TCP passthrough cannot cover the measured cold start
(see below).

**Interception: use a yaac-managed EndpointSlice — verified working.** With the
control plane scaled to 0, a hand-written EndpointSlice labelled
`kubernetes.io/service-name: <vc>` plus
`endpointslice.kubernetes.io/managed-by: yaac.dev` redirects the API ClusterIP
to the activator pod on the real Cilium datapath; the built-in endpointslice
controller leaves the foreign-`managed-by` slice alone, and deleting the slice
restores normal Service routing. No Cilium CEC redirect is needed.

One sharp edge: the slice must enumerate **all three of the Service's named
ports** (`yaac-api` → 8443, `https` → 443, `kubelet` → 10250), each targeting the
activator's port. Endpoint ports are matched to Service ports **by name**, so a
slice that names only `https` silently redirects port 443 and leaves 8443 — the
port that actually matters — unrouted.

Also verified: while asleep with no endpoints at all, a client does **not** hang
— it gets `ECONNREFUSED` in ~1s. So interception is genuinely required; "scale to
0 and let clients retry" surfaces hard connection errors.

#### The cold-start budget problem (unresolved)

The plan assumed the activator could be a pure TCP **passthrough** that "holds
the connection" while the vcluster wakes, so the client sees a slow connect
rather than a failure, and needs no TLS cert. **Measurement says that doesn't
work.**

- Cold start, `replicas=1` → API port accepting, measured 3× on the real
  cluster: **19.5 s** (very tight variance). Breakdown: ~1 s schedule, 4 s
  `kubernetes` init container (binary copy), ~1 s syncer start, then **~12 s of
  kube-apiserver boot**.
- Go's `http.Transport` default `TLSHandshakeTimeout` is **10 s**, and client-go
  does not raise it. Tested end-to-end through a hold-then-passthrough proxy with
  a real `kubectl`: a **3 s hold succeeds**; a **15 s hold fails** with
  `net/http: TLS handshake timeout`, and kubectl gives up after its retries.

So a passthrough activator cannot cover a 19.5 s wake — the client's handshake
deadline expires at 10 s. Even removing the init container entirely leaves
apiserver boot (~12 s) over budget, so the gap can't be closed by trimming.

**The activator therefore terminates TLS.** Once it owns the TLS session it
holds the *HTTP request* rather than the TCP handshake, so the 10 s
`TLSHandshakeTimeout` clock never starts. The governing deadline becomes the
client's per-request timeout — 32 s for kubectl discovery, longer for informer
list/watch — comfortably clear of the measured 19.5 s.

#### Activator shape

1. **Terminate TLS on 8443**, selecting the serving cert **by SNI**. The
   kubeconfig's server is `<name>.<vc-ns>.svc.cluster.local`, so the SNI name
   identifies the vcluster; the activator loads that vcluster's real
   `apiserver.crt`/`apiserver.key` from its `<name>-certs` Secret. Serving the
   vcluster's own cert is mandatory — the client pins the CA embedded in its
   kubeconfig. One shared pod thus fronts every asleep vcluster, each under its
   own identity.
2. **Verify the client cert** against `client-ca.crt` from the same Secret, and
   reject anonymous callers, matching what the real endpoint does (measured: a
   caller with no client cert gets **403**).
3. **Trigger `wakeVcluster`** (idempotent per vcluster) and park the request.
4. **Forward via the front-proxy (requestheader) path** once the control plane is
   ready: dial the now-live endpoint with `front-proxy-client.crt`/`.key` from the
   certs Secret and set `X-Remote-User` / `X-Remote-Group` from the *verified*
   client cert's CN / O.

Step 4 is what makes identity survive termination — the activator cannot replay
the client's cert (it has no client private key), and the apiserver is already
configured to accept an authenticating proxy: `--requestheader-client-ca-file`,
`--requestheader-allowed-names=front-proxy-client`, `--requestheader-username-headers`,
`--requestheader-group-headers`.

Verified end-to-end on the real cluster, through the vcluster's `:8443` endpoint
(which is the **syncer's** proxy, not kube-apiserver directly — the syncer passes
requestheader auth through):

- front-proxy-client cert + `X-Remote-User: alice` + `X-Remote-Group: system:masters`
  → `SelfSubjectReview` reports `username: alice`, groups `[system:masters,
  system:authenticated]`. Identity is **forwarded**, not flattened to the
  activator's own.
- The same headers **without** the front-proxy client cert → **403**. The header
  channel is not a spoofing hole.

**Bearer tokens** are the one case that skips step 4: a token can be replayed, so
if the client authenticates with the kubeconfig's `token` the activator passes the
`Authorization` header through unchanged and sets **no** requestheader headers,
letting the apiserver authenticate it directly. Setting both would be a
privilege-confusion bug.

#### Handoff and teardown

- On successful wake, delete the yaac EndpointSlice so *new* connections route
  straight to the control plane.
- Connections already parked on the activator must be proxied to completion, not
  dropped — and that proxy has to handle HTTP/2 and connection upgrades (SPDY /
  websocket for `exec`, `port-forward`, `logs`) and streaming watches, so it
  cannot buffer whole responses.
- Concurrent first-touch is expected (several clients racing one wake); all
  parked requests release together when readiness is reached.

#### What this costs

The activator holds, for any vcluster whose certs Secret it can read, the ability
to mint **any identity in that vcluster**. It is a single install-wide pod, which
makes it a high-value target in a system whose entire point is containment.
Mitigations to design in from the start:

- run it host-side on runc, never reachable from a session except through the
  intercepted ClusterIP;
- RBAC limited to `get` on `*-certs` Secrets in vcluster namespaces;
- a strict SNI→vcluster binding, so a connection for X can never be proxied to Y
  under Y's credentials;
- read the Secret only during an in-flight wake, holding no standing credential
  for an awake vcluster.

It is also materially more code than a passthrough: TLS termination, SNI routing,
and a correct upgrade-aware reverse proxy.

### 6. Status + reconcilers

Add `asleep` / `waking` to the `SessionDetail.virtualCluster` status block, and
make `reconcileVclusters` and `reconcileInnerRedirects` skip asleep vclusters
(their apiserver is intentionally down). Wake must never leave a session stranded
on a cluster that failed to come back: on wake failure (PVC lost, apiserver
won't boot) surface it in the status block rather than hang.

## Wake semantics, latency, races

- Sleep is a controlled scale, not a crash: the outer session pod is untouched,
  and any client of the vcluster API pauses (connection held) rather than
  erroring.
- Cold start is **~19.5 s**, not "a few seconds" — measured, and consistent
  across runs. This is over Go's 10 s TLS-handshake budget and is the main open
  problem (see the activator section).
- "Outer agent idle before first use" is the only sleep trigger in Tier A, and
  the vcluster stays up after the first wake — no re-sleep, so no wake/sleep
  thrash mid-session.
- The containment objects (VAP guard, per-vcluster fallback CNP, projected
  redirects) are host objects that persist through sleep, and nothing runs while
  asleep, so the security floor is unaffected.

## Verification status

Verified in-session (this doc's "Current shape" claims):

- kubeconfig structure and its CA + `system:masters` client-cert dependency;
- API-host resolves via host CoreDNS to a `10.96.x` Service ClusterIP,
  independent of the vcluster's own CoreDNS pod;
- CoreDNS is an in-vcluster Deployment synced to a host pod;
- apiserver RSS ≈ 180 MB and idle write churn ≈ 0.58/s (≈86 % KCM
  leader-election);
- control plane is a Deployment (chart `vcluster.kind` + the readiness code).

Verified host-side against the live kind cluster, on a throwaway vcluster
rendered from the same chart + values (live sessions untouched):

- **Linchpin, resolved the other way**: a `0 → 1` reboot with a plain `emptyDir`
  `/data` reuses the CA. `ca.crt`/`ca.key`/`sa.key` byte-identical, exported
  kubeconfig's CA and client cert unchanged, and the pre-sleep kubeconfig still
  authenticates as `system:masters` with the same credential ID. The PKI is
  restored from the `<name>-certs` Secret, so **no persistence step is needed**.
- **PKI path**: `/pki` is empty; the PKI is at `/data/pki` beside `state.db`.
- **hostPath ownership**: moot — the syncer container runs as `runAsUser: 0`,
  and no volume work is needed anyway. (A `standard` local-path storageClass does
  exist on the cluster should Tier B want a PVC.)
- **Replicas strip** makes scale-to-0 survive a full re-apply.
- **Activator interception** via a `managed-by`-labelled EndpointSlice works on
  the real Cilium datapath, provided all three named Service ports are listed.
- **Held-connection passthrough does *not* work**: 19.5 s cold start vs Go's
  10 s `TLSHandshakeTimeout` (3 s hold passes, 15 s hold fails) — hence the
  TLS-terminating activator.
- **Identity forwarding via front-proxy headers works** through the `:8443`
  syncer proxy: front-proxy-client cert + `X-Remote-User`/`X-Remote-Group`
  authenticates as the named user; the same headers without that cert, and
  anonymous callers, both get 403.
- **Idle footprint** is larger than the doc first claimed: the control-plane pod
  cgroup measures **330–390 MB** (kube-apiserver RSS 177–243 MB, KCM 49–102 MB,
  syncer 58–102 MB) across three live vclusters — plus the CoreDNS pod. So
  born-at-zero reclaims appreciably more than the ~180 MB originally cited.

Still unverified:

- That a real **client-go informer** (not just `kubectl`) survives a 19.5 s
  parked request without tripping some other deadline of its own.
- **Concurrent first-touch** — several clients racing one wake.
- That an **upgrade-based** request (`exec`, `port-forward`, `logs`) proxied
  through the activator mid-wake completes correctly; only plain REST calls were
  exercised.

## Out of scope

- **Tier B** — re-sleeping a vcluster that has done work, which requires a
  quiescence predicate (no pods but control-plane + CoreDNS), an idle timer, and
  handling the persistent inner `yaac-proxy` Deployment (which today never scales
  down). Tier A's persisted `/data` is a stepping stone.
- Making the inner yaac server defer its apiserver watches until it has work (an
  adjacent optimization; without it, a session whose init starts an inner server
  wakes its vcluster immediately).
- The always-on-floor flag/env tuning (leader-election off, `GOGC`,
  prewarm/image-prewarm off when nested).
